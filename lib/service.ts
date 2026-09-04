import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  buildPullPlan,
  errorMessage,
  isPortableInstallSource,
  isPortableMarketplaceSource,
  isSensitiveSettingKey,
  lastOperationSchema,
  presetSnapshotSchema,
  sameJson,
  settingSafetyIssue,
  SELF_PLUGIN_ID,
  type LastOperation,
  type PluginSettingPresetEntry,
  type PresetSnapshot,
  type SyncPlan,
} from "./preset";
import { pushRemotePreset, readRemotePreset } from "./git";

export interface SyncSettings {
  repositoryUrl: string;
  branch: string;
  githubToken?: string;
  gitAuthorName: string;
  gitAuthorEmail: string;
  includePluginSettings: boolean;
}

interface CapturedPreset {
  snapshot: PresetSnapshot;
  warnings: string[];
}

interface StagedPreset extends CapturedPreset {
  stagedAt: string;
}

const STAGED_KEY = "staged-preset-v1";
const LAST_OPERATION_KEY = "last-operation-v1";
const MAX_STAGED_BYTES = 240 * 1024;

type SystemConfig = Awaited<ReturnType<BbPluginApi["sdk"]["system"]["config"]>>;

function pluginInstallSpec(plugin: Awaited<ReturnType<BbPluginApi["sdk"]["plugins"]["list"]>>["plugins"][number]): string {
  if (plugin.source.startsWith("builtin:")) return plugin.source;
  if (plugin.catalogEntryId !== undefined && plugin.catalogMarketplaceName !== undefined) {
    return `${plugin.catalogEntryId}@${plugin.catalogMarketplaceName}`;
  }
  return plugin.source;
}

function settingValueMatchesDescriptor(
  descriptor: { type: string; options?: string[] },
  value: string | boolean,
): boolean {
  if (descriptor.type === "boolean") return typeof value === "boolean";
  if (typeof value !== "string") return false;
  if (descriptor.type === "select") return descriptor.options?.includes(value) ?? false;
  return descriptor.type === "string" || descriptor.type === "project";
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export class PresetSyncService {
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly bb: BbPluginApi,
    private readonly getSettings: () => Promise<SyncSettings>,
  ) {}

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async readStaged(): Promise<StagedPreset | null> {
    const value = await this.bb.storage.kv.get<StagedPreset>(STAGED_KEY);
    if (value === undefined) return null;
    return {
      snapshot: presetSnapshotSchema.parse(value.snapshot),
      warnings: Array.isArray(value.warnings) ? value.warnings.map(String) : [],
      stagedAt: String(value.stagedAt),
    };
  }

  private async readLastOperation(): Promise<LastOperation | null> {
    const value = await this.bb.storage.kv.get<LastOperation>(LAST_OPERATION_KEY);
    if (value === undefined) return null;
    const parsed = lastOperationSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }

  private async writeLastOperation(operation: LastOperation): Promise<void> {
    await this.bb.storage.kv.set(LAST_OPERATION_KEY, operation);
    this.bb.realtime.publish("preset-sync-changed", operation);
  }

  private async remoteSettings(): Promise<SyncSettings> {
    const settings = await this.getSettings();
    const repositoryUrl = settings.repositoryUrl.trim();
    if (repositoryUrl === "") {
      throw new Error(
        'Preset repository is not configured. Set "Preset repository" in Settings → Plugins → Preset Sync.',
      );
    }
    return {
      ...settings,
      repositoryUrl,
      branch: settings.branch.trim() || "main",
    };
  }

  private async captureSnapshot(signal?: AbortSignal): Promise<CapturedPreset> {
    const [config, pluginList, marketplaces, version] = await Promise.all([
      this.bb.sdk.system.config({ signal }),
      this.bb.sdk.plugins.list({ signal }),
      this.bb.sdk.plugins.marketplaces.list({ signal }),
      this.bb.sdk.system.version({ force: false, signal }),
    ]);
    const settings = await this.getSettings();
    const warnings: string[] = [];

    const plugins = pluginList.plugins.flatMap((plugin) => {
      if (plugin.id === SELF_PLUGIN_ID) return [];
      const install = pluginInstallSpec(plugin);
      if (!isPortableInstallSource(install)) {
        warnings.push(`Skipped local-path plugin ${plugin.id}.`);
        return [];
      }
      return [{ id: plugin.id, install, enabled: plugin.enabled }];
    });

    const portableMarketplaces = marketplaces.flatMap((marketplace) => {
      if (marketplace.official) return [];
      if (!isPortableMarketplaceSource(marketplace.source)) {
        warnings.push(`Skipped local-path marketplace ${marketplace.name}.`);
        return [];
      }
      return [{ name: marketplace.name, source: marketplace.source }];
    });

    const pluginSettings: PluginSettingPresetEntry[] = [];
    if (settings.includePluginSettings) {
      const captured = await Promise.all(
        pluginList.plugins
          .filter((plugin) => plugin.id !== SELF_PLUGIN_ID && plugin.hasSettings)
          .map(async (plugin) => {
            try {
              const response = await this.bb.sdk.plugins.getSettings({
                pluginId: plugin.id,
                signal,
              });
              return Object.entries(response.schema).flatMap(([key, descriptor]) => {
                const value = response.values[key];
                const safetyIssue =
                  typeof value === "string" || typeof value === "boolean"
                    ? settingSafetyIssue(key, value)
                    : null;
                if (
                  ("secret" in descriptor && descriptor.secret === true) ||
                  isSensitiveSettingKey(key) ||
                  safetyIssue !== null
                ) {
                  if (
                    safetyIssue !== null &&
                    !("secret" in descriptor && descriptor.secret === true)
                  ) {
                    warnings.push(
                      `Skipped ${plugin.id}.${key}: ${safetyIssue}.`,
                    );
                  }
                  return [];
                }
                if (typeof value !== "string" && typeof value !== "boolean") return [];
                if (!settingValueMatchesDescriptor(descriptor, value)) return [];
                return [{ id: plugin.id, key, value }];
              });
            } catch (cause) {
              warnings.push(
                `Could not read non-secret settings for ${plugin.id}: ${errorMessage(cause)}`,
              );
              return [];
            }
          }),
      );
      pluginSettings.push(...captured.flat());
    }

    const snapshot = presetSnapshotSchema.parse({
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      bbVersion: version.currentVersion,
      settings: {
        generalSettings: config.generalSettings,
        experiments: config.experiments,
        keybindingOverrides: config.keybindingOverrides,
        appearance: {
          themeId: config.appearance.themeId,
          faviconColor: config.appearance.faviconColor,
        },
      },
      plugins,
      marketplaces: portableMarketplaces,
      pluginSettings,
    });
    return { snapshot, warnings: unique(warnings) };
  }

  private async remoteAndLocal(signal?: AbortSignal): Promise<{
    remote: Awaited<ReturnType<typeof readRemotePreset>>;
    local: CapturedPreset;
    settings: SyncSettings;
  }> {
    const settings = await this.remoteSettings();
    const [remote, local] = await Promise.all([
      readRemotePreset({
        repositoryUrl: settings.repositoryUrl,
        branch: settings.branch,
        githubToken: settings.githubToken,
        signal,
      }),
      this.captureSnapshot(signal),
    ]);
    return { remote, local, settings };
  }

  async preview(signal?: AbortSignal): Promise<SyncPlan> {
    return this.exclusive(async () => {
      const { remote, local, settings } = await this.remoteAndLocal(signal);
      return buildPullPlan({
        repository: settings.repositoryUrl,
        branch: settings.branch,
        remoteHead: remote.head,
        local: local.snapshot,
        remote: remote.snapshot,
        warnings: local.warnings,
      });
    });
  }

  async status(signal?: AbortSignal) {
    return this.exclusive(async () => {
      const { remote, local, settings } = await this.remoteAndLocal(signal);
      const plan = buildPullPlan({
        repository: settings.repositoryUrl,
        branch: settings.branch,
        remoteHead: remote.head,
        local: local.snapshot,
        remote: remote.snapshot,
        warnings: local.warnings,
      });
      const [staged, lastOperation] = await Promise.all([
        this.readStaged(),
        this.readLastOperation(),
      ]);
      return {
        repository: settings.repositoryUrl,
        branch: settings.branch,
        remoteHead: remote.head,
        remoteCapturedAt: remote.snapshot.capturedAt,
        stagedAt: staged?.stagedAt ?? null,
        changeCount: plan.changes.length,
        warnings: plan.warnings,
        lastOperation,
      };
    });
  }

  async capture() {
    return this.exclusive(async () => {
      const captured = await this.captureSnapshot();
      const staged: StagedPreset = {
        ...captured,
        stagedAt: new Date().toISOString(),
      };
      const bytes = Buffer.byteLength(JSON.stringify(staged), "utf8");
      if (bytes > MAX_STAGED_BYTES) {
        throw new Error(
          `Captured preset is ${bytes} bytes; the safe staging limit is ${MAX_STAGED_BYTES} bytes.`,
        );
      }
      await this.bb.storage.kv.set(STAGED_KEY, staged);
      await this.writeLastOperation({
        type: "capture",
        at: staged.stagedAt,
        summary: `Captured ${staged.snapshot.plugins.length} plugins`,
      });
      return {
        capturedAt: staged.snapshot.capturedAt,
        pluginCount: staged.snapshot.plugins.length,
        pluginSettingCount: staged.snapshot.pluginSettings.length,
        marketplaceCount: staged.snapshot.marketplaces.length,
        warnings: staged.warnings,
      };
    });
  }

  async push(args: { fresh: boolean; message?: string; signal?: AbortSignal }) {
    return this.exclusive(async () => {
      const settings = await this.remoteSettings();
      let staged = await this.readStaged();
      if (args.fresh || staged === null) {
        if (!args.fresh && staged === null) {
          throw new Error('No staged preset. Run "bb preset capture" or use "bb preset push --fresh".');
        }
        const captured = await this.captureSnapshot(args.signal);
        staged = {
          ...captured,
          stagedAt: new Date().toISOString(),
        };
        await this.bb.storage.kv.set(STAGED_KEY, staged);
      }
      const pushed = await pushRemotePreset(
        {
          repositoryUrl: settings.repositoryUrl,
          branch: settings.branch,
          githubToken: settings.githubToken,
          authorName: settings.gitAuthorName,
          authorEmail: settings.gitAuthorEmail,
          message: args.message?.trim() || "chore: sync BB preset",
          signal: args.signal,
        },
        staged.snapshot,
      );
      const at = new Date().toISOString();
      await this.writeLastOperation({
        type: "push",
        at,
        summary: pushed.pushed
          ? `Pushed ${pushed.changedFiles.length} preset files`
          : "Preset already matched GitHub",
      });
      return {
        pushed: pushed.pushed,
        head: pushed.head,
        capturedAt: staged.snapshot.capturedAt,
        changedFiles: pushed.changedFiles,
        warnings: staged.warnings,
      };
    });
  }

  async pullAndApply(signal?: AbortSignal) {
    return this.exclusive(async () => {
      const { remote, local, settings } = await this.remoteAndLocal(signal);
      const plan = buildPullPlan({
        repository: settings.repositoryUrl,
        branch: settings.branch,
        remoteHead: remote.head,
        local: local.snapshot,
        remote: remote.snapshot,
        warnings: local.warnings,
      });
      const applied: string[] = [];
      const skipped: string[] = [];
      const errors: string[] = [];
      const warnings = [...plan.warnings];

      const attempt = async (label: string, operation: () => Promise<unknown>) => {
        try {
          await operation();
          applied.push(label);
          return true;
        } catch (cause) {
          errors.push(`${label}: ${errorMessage(cause)}`);
          return false;
        }
      };

      const currentMarketplaces = await this.bb.sdk.plugins.marketplaces.list({ signal });
      const marketplaceMap = new Map(
        currentMarketplaces.map((marketplace) => [marketplace.name, marketplace]),
      );
      for (const marketplace of remote.snapshot.marketplaces) {
        const current = marketplaceMap.get(marketplace.name);
        if (current === undefined) {
          if (!isPortableMarketplaceSource(marketplace.source)) {
            skipped.push(`Skipped local marketplace ${marketplace.name}`);
            continue;
          }
          await attempt(`Added marketplace ${marketplace.name}`, () =>
            this.bb.sdk.plugins.marketplaces.add({ source: marketplace.source }),
          );
        } else if (current.source !== marketplace.source) {
          skipped.push(`Kept marketplace ${marketplace.name} with its existing source`);
        }
      }

      let pluginList = await this.bb.sdk.plugins.list({ signal });
      let installed = new Map(pluginList.plugins.map((plugin) => [plugin.id, plugin]));
      for (const plugin of remote.snapshot.plugins) {
        if (plugin.id === SELF_PLUGIN_ID || installed.has(plugin.id)) continue;
        if (!isPortableInstallSource(plugin.install)) {
          skipped.push(`Skipped local-path plugin ${plugin.id}`);
          continue;
        }
        await attempt(`Installed plugin ${plugin.id}`, () =>
          this.bb.sdk.plugins.install({ source: plugin.install }),
        );
      }

      pluginList = await this.bb.sdk.plugins.list({ signal });
      installed = new Map(pluginList.plugins.map((plugin) => [plugin.id, plugin]));

      const desiredSettings = new Map<string, PluginSettingPresetEntry[]>();
      for (const entry of remote.snapshot.pluginSettings) {
        if (
          entry.id === SELF_PLUGIN_ID ||
          settingSafetyIssue(entry.key, entry.value) !== null
        ) {
          continue;
        }
        const entries = desiredSettings.get(entry.id) ?? [];
        entries.push(entry);
        desiredSettings.set(entry.id, entries);
      }
      const settingsUpdated = new Set<string>();
      for (const [pluginId, entries] of desiredSettings) {
        if (!installed.has(pluginId)) {
          skipped.push(`Skipped settings for missing plugin ${pluginId}`);
          continue;
        }
        try {
          const response = await this.bb.sdk.plugins.getSettings({ pluginId, signal });
          const values: Record<string, string | boolean> = {};
          for (const entry of entries) {
            const descriptor = response.schema[entry.key];
            if (
              descriptor === undefined ||
              ("secret" in descriptor && descriptor.secret === true) ||
              settingSafetyIssue(entry.key, entry.value) !== null ||
              !settingValueMatchesDescriptor(descriptor, entry.value)
            ) {
              skipped.push(`Skipped unsafe or unknown setting ${pluginId}.${entry.key}`);
              continue;
            }
            if (!sameJson(response.values[entry.key], entry.value)) {
              values[entry.key] = entry.value;
            }
          }
          if (Object.keys(values).length > 0) {
            const ok = await attempt(
              `Updated ${Object.keys(values).length} settings for ${pluginId}`,
              () => this.bb.sdk.plugins.updateSettings({ pluginId, values }),
            );
            if (ok) settingsUpdated.add(pluginId);
          }
        } catch (cause) {
          errors.push(`Settings for ${pluginId}: ${errorMessage(cause)}`);
        }
      }

      const desiredPluginMap = new Map(
        remote.snapshot.plugins.map((plugin) => [plugin.id, plugin]),
      );
      for (const [pluginId, desired] of desiredPluginMap) {
        if (pluginId === SELF_PLUGIN_ID) continue;
        const current = installed.get(pluginId);
        if (current === undefined) continue;
        if (current.enabled !== desired.enabled) {
          await attempt(
            `${desired.enabled ? "Enabled" : "Disabled"} plugin ${pluginId}`,
            () =>
              desired.enabled
                ? this.bb.sdk.plugins.enable({ pluginId })
                : this.bb.sdk.plugins.disable({ pluginId }),
          );
        } else if (desired.enabled && settingsUpdated.has(pluginId)) {
          await attempt(`Reloaded plugin ${pluginId}`, () =>
            this.bb.sdk.plugins.reload({ pluginId }),
          );
        }
      }

      if (!sameJson(local.snapshot.settings.generalSettings, remote.snapshot.settings.generalSettings)) {
        await attempt("Updated BB general settings", () =>
          this.bb.sdk.system.updateGeneralSettings(
            remote.snapshot.settings.generalSettings as SystemConfig["generalSettings"],
          ),
        );
      }
      if (!sameJson(local.snapshot.settings.experiments, remote.snapshot.settings.experiments)) {
        await attempt("Updated BB experiments", () =>
          this.bb.sdk.system.updateExperiments(
            remote.snapshot.settings.experiments as SystemConfig["experiments"],
          ),
        );
      }
      if (
        !sameJson(
          local.snapshot.settings.keybindingOverrides,
          remote.snapshot.settings.keybindingOverrides,
        )
      ) {
        await attempt("Updated keyboard shortcuts", () =>
          this.bb.sdk.system.updateKeyboardSettings(
            remote.snapshot.settings
              .keybindingOverrides as SystemConfig["keybindingOverrides"],
          ),
        );
      }
      if (!sameJson(local.snapshot.settings.appearance, remote.snapshot.settings.appearance)) {
        await attempt("Updated BB theme", () =>
          this.bb.sdk.theme.set(remote.snapshot.settings.appearance),
        );
      }

      const at = new Date().toISOString();
      const ok = errors.length === 0;
      await this.writeLastOperation({
        type: "pull",
        at,
        summary: ok
          ? `Applied ${applied.length} changes from GitHub`
          : `Applied ${applied.length} changes with ${errors.length} errors`,
      });
      return {
        ok,
        plan,
        applied,
        skipped,
        errors,
        warnings: unique(warnings),
      };
    });
  }
}
