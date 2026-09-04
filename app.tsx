import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRealtime, useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type {
  ApplyResult,
  CaptureResult,
  PushResult,
  SyncPlan,
  SyncStatus,
} from "./lib/preset";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";

type PendingAction = "pull" | "push" | "fresh-push" | null;

function shortSha(value: string): string {
  return value.slice(0, 12);
}

function readableDate(value: string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value === "unknown") return "legacy snapshot";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function StatusBadge({
  status,
  configured,
}: {
  status: SyncStatus | null;
  configured: boolean;
}) {
  if (!configured) {
    return <span className="text-xs text-muted-foreground">Setup required</span>;
  }
  if (status === null) {
    return <span className="text-xs text-muted-foreground">Not checked</span>;
  }
  const clean = status.changeCount === 0;
  return (
    <span
      className={
        clean
          ? "rounded-full bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground"
          : "rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-foreground"
      }
    >
      {clean ? "In sync" : `${status.changeCount} pending`}
    </span>
  );
}

function ResultNotice({ children }: { children: string }) {
  return (
    <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground">
      {children}
    </div>
  );
}

function PresetSyncSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const pluginSettings = useSettings();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [plan, setPlan] = useState<SyncPlan | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);

  const repository =
    typeof pluginSettings.values?.repositoryUrl === "string"
      ? pluginSettings.values.repositoryUrl.trim()
      : "";
  const configured = repository !== "";
  const branch =
    typeof pluginSettings.values?.branch === "string"
      ? pluginSettings.values.branch
      : "main";

  const reportError = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);

  const refreshStatus = useCallback(async () => {
    if (!configured) {
      setStatus(null);
      setPlan(null);
      setError(null);
      return;
    }
    setBusy("status");
    try {
      const next = await rpc.call("sync_status");
      setStatus(next);
      setError(null);
    } catch (cause) {
      reportError(cause);
    } finally {
      setBusy(null);
    }
  }, [configured, reportError, rpc]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus, repository, branch]);
  useRealtime("preset-sync-changed", () => {
    void refreshStatus();
  });

  const preview = async (): Promise<SyncPlan | null> => {
    setBusy("preview");
    try {
      const next = await rpc.call("sync_preview");
      setPlan(next);
      setError(null);
      setNotice(
        next.changes.length === 0
          ? "This machine already matches the Git preset."
          : `Previewed ${next.changes.length} changes; nothing has been applied.`,
      );
      return next;
    } catch (cause) {
      reportError(cause);
      return null;
    } finally {
      setBusy(null);
    }
  };

  const capture = async () => {
    setBusy("capture");
    try {
      const result: CaptureResult = await rpc.call("sync_capture");
      setNotice(
        `Staged ${result.pluginCount} plugins and ${result.pluginSettingCount} non-secret plugin settings.`,
      );
      setError(null);
      await refreshStatus();
    } catch (cause) {
      reportError(cause);
    } finally {
      setBusy(null);
    }
  };

  const openPullConfirmation = async () => {
    const nextPlan = plan ?? (await preview());
    if (nextPlan !== null && nextPlan.changes.length > 0) setPendingAction("pull");
  };

  const confirmAction = async () => {
    const action = pendingAction;
    setPendingAction(null);
    if (action === null) return;
    setBusy(action);
    try {
      if (action === "pull") {
        const result: ApplyResult = await rpc.call("sync_pull", { confirmed: true });
        setNotice(
          result.ok
            ? `Applied ${result.applied.length} changes from GitHub.`
            : `Applied ${result.applied.length} changes with ${result.errors.length} errors.`,
        );
        setError(result.errors.length === 0 ? null : result.errors.join(" · "));
        setPlan(null);
      } else {
        const result: PushResult = await rpc.call("sync_push", {
          fresh: action === "fresh-push",
        });
        setNotice(
          result.pushed
            ? `Pushed ${result.changedFiles.length} files at ${shortSha(result.head)}.`
            : `Git preset is already current at ${shortSha(result.head)}.`,
        );
        setError(null);
      }
      await refreshStatus();
    } catch (cause) {
      reportError(cause);
    } finally {
      setBusy(null);
    }
  };

  const disabled = busy !== null;
  const confirmationTitle =
    pendingAction === "pull"
      ? "Apply preset to this BB installation?"
      : pendingAction === "push"
        ? "Push the staged preset to GitHub?"
        : "Capture this machine and push to GitHub?";
  const confirmationDescription =
    pendingAction === "pull"
      ? "This can install full-trust plugins and update BB settings. Local plugins absent from the preset will remain installed."
      : "The managed preset JSON files in the configured branch will be committed and pushed. Other repository files are preserved.";

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <CardTitle className="flex items-center gap-2 text-base">
                <Icon name="Github" className="size-4" />
                Git preset
              </CardTitle>
              <CardDescription className="mt-1 break-all">
                {configured ? `${repository} · ${branch}` : "Repository not configured"}
              </CardDescription>
            </div>
            <StatusBadge status={status} configured={configured} />
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2 text-sm sm:grid-cols-3">
            <div>
              <div className="text-xs text-muted-foreground">Remote commit</div>
              <div className="font-mono">{status ? shortSha(status.remoteHead) : "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Remote capture</div>
              <div>{readableDate(status?.remoteCapturedAt)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Local stage</div>
              <div>{readableDate(status?.stagedAt)}</div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={disabled || !configured} onClick={refreshStatus}>
              <Icon name={busy === "status" ? "Spinner" : "ArrowReloadHorizontal"} />
              Check
            </Button>
            <Button variant="outline" size="sm" disabled={disabled || !configured} onClick={() => void preview()}>
              <Icon name="FileDiff" />
              Preview pull
            </Button>
            <Button
              size="sm"
              disabled={disabled || !configured}
              onClick={() => void openPullConfirmation()}
            >
              <Icon name="ArrowDown" />
              Pull & apply
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Publish this machine</CardTitle>
          <CardDescription>
            Capture only portable configuration. Credentials, provider sessions, history, and
            secret plugin settings are excluded.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={disabled} onClick={() => void capture()}>
            <Icon name="FolderExport" />
            Stage current
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || !configured || status?.stagedAt == null}
            onClick={() => setPendingAction("push")}
          >
            <Icon name="ArrowUp" />
            Push staged
          </Button>
          <Button size="sm" disabled={disabled || !configured} onClick={() => setPendingAction("fresh-push")}>
            <Icon name="Cloud" />
            Capture & push
          </Button>
        </CardContent>
      </Card>

      {!configured ? (
        <ResultNotice>
          Set Preset repository in Settings → Plugins → Preset Sync, then return here to sync.
        </ResultNotice>
      ) : null}
      {notice === null ? null : <ResultNotice>{notice}</ResultNotice>}
      {error === null ? null : (
        <div role="alert" className="rounded-md border border-destructive/50 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {plan === null ? null : (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Pull preview</CardTitle>
            <CardDescription>
              {plan.changes.length} pending changes from {shortSha(plan.remoteHead)}. No changes
              have been applied.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {plan.changes.length === 0 ? (
              <p className="text-sm text-muted-foreground">Everything is already in sync.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {plan.changes.map((change, index) => (
                  <li key={`${change.kind}-${change.target}-${index}`} className="flex gap-2">
                    <span className={change.risk === "full-trust" ? "text-destructive" : "text-muted-foreground"}>
                      {change.risk === "full-trust" ? "!" : "+"}
                    </span>
                    <span>{change.summary}</span>
                  </li>
                ))}
              </ul>
            )}
            {plan.warnings.length === 0 ? null : (
              <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
                {plan.warnings.map((warning) => (
                  <div key={warning}>• {warning}</div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Dialog open={pendingAction !== null} onOpenChange={(open) => !open && setPendingAction(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirmationTitle}</DialogTitle>
            <DialogDescription>{confirmationDescription}</DialogDescription>
          </DialogHeader>
          {pendingAction === "pull" && plan !== null ? (
            <div className="max-h-56 overflow-y-auto rounded-md border border-border p-3 text-sm">
              {plan.changes.map((change, index) => (
                <div key={`${change.kind}-${change.target}-${index}`} className="py-1">
                  {change.risk === "full-trust" ? "! " : "+ "}
                  {change.summary}
                </div>
              ))}
            </div>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button onClick={() => void confirmAction()}>
              {pendingAction === "pull" ? "Apply changes" : "Commit & push"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PresetSyncPage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl p-4 md:p-6">
        <PresetSyncSettings />
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "preset-sync",
    title: "Preset Sync",
    description: "Synchronize portable BB configuration through a Git repository.",
    component: PresetSyncSettings,
  });
  app.slots.navPanel({
    id: "preset-sync",
    title: "Preset Sync",
    icon: "Cloud",
    path: "preset-sync",
    component: PresetSyncPage,
  });
});
