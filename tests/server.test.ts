import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  experimental_scanPublicSdkOnly,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { backgroundIntervalMs } from "../lib/service";

function createHost() {
  return createFakePluginHost({
    pluginId: "preset-sync",
    sdk: {
      system: {
        config: async () => ({
          generalSettings: {
            defaultProviderId: null,
            providerOrder: [],
            showKeyboardHints: true,
            showUnhandledProviderEvents: false,
            steerActiveThreadOnEnter: true,
            streamerMode: false,
          },
          experiments: {
            changelogPreview: false,
            editMessages: true,
            mobileApp: false,
            timelineWindowing: false,
          },
          keybindingOverrides: [],
          appearance: { themeId: "default", faviconColor: "default" },
        }),
        version: async () => ({ currentVersion: "0.41.0" }),
      },
      plugins: {
        list: async () => ({
          plugins: [
            {
              id: "preset-sync",
              source: "path:/plugin",
              enabled: true,
              hasSettings: true,
            },
            {
              id: "tasks",
              source: "builtin:tasks",
              enabled: true,
              hasSettings: false,
            },
          ],
        }),
        marketplaces: {
          list: async () => [],
        },
      },
    },
  });
}

describe("plugin registration", () => {
  it("registers the preset CLI and stages a secret-safe capture", async () => {
    const { bb, harness } = createHost();
    await plugin(bb);

    expect(harness.inspection.registrations.cli?.name).toBe("preset");
    expect(harness.inspection.registrations.settingsDescriptors.githubToken).toEqual(
      expect.objectContaining({ secret: true }),
    );
    expect(
      harness.inspection.registrations.settingsDescriptors.repositoryUrl,
    ).not.toHaveProperty("default");
    expect(
      harness.inspection.registrations.settingsDescriptors.backgroundCheckInterval,
    ).toEqual(
      expect.objectContaining({
        type: "select",
        default: "5 minutes",
      }),
    );
    expect(harness.inspection.registrations.services.map((service) => service.name)).toEqual([
      "change-check",
    ]);
    await expect(harness.behavior.callRpc("sync_cached_check", null)).resolves.toBeNull();

    const result = await harness.behavior.runCli(["capture", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        pluginCount: 1,
        pluginSettingCount: 0,
        marketplaceCount: 0,
      }),
    );

    await harness.lifecycle.dispose();
  });

  it("parses the supported background check intervals", () => {
    expect(backgroundIntervalMs("Off")).toBeNull();
    expect(backgroundIntervalMs("1 minute")).toBe(60_000);
    expect(backgroundIntervalMs("30 minutes")).toBe(30 * 60_000);
    expect(backgroundIntervalMs("unexpected")).toBe(5 * 60_000);
  });

  it("explains how to configure a repository before remote operations", async () => {
    const { bb, harness } = createHost();
    await plugin(bb);

    const result = await harness.behavior.runCli(["status"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Preset repository is not configured");

    await harness.lifecycle.dispose();
  });

  it("uses only the public plugin SDK", () => {
    const scan = experimental_scanPublicSdkOnly(process.cwd(), {
      allow: [
        /^@\//,
        /^react(?:-dom)?(?:\/.*)?$/,
        /^@radix-ui\/react-(?:checkbox|dialog|slot)$/,
        /^@hugeicons\/(?:core-free-icons|react)$/,
        /^class-variance-authority$/,
        /^clsx$/,
        /^tailwind-merge$/,
        /^@testing-library\/react$/,
        /^vitest(?:\/.*)?$/,
      ],
    });
    expect(scan.privateDependencies).toEqual([]);
    expect(scan.violations).toEqual([]);
  });
});
