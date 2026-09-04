// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { SyncStatus } from "../lib/preset";

describe("plugin app registration", () => {
  it("exposes Preset Sync in settings and the sidebar", async () => {
    const app = await loadPluginApp(() => import("../app"));

    expect(app.settingsSections).toEqual([
      expect.objectContaining({ id: "preset-sync", title: "Preset Sync" }),
    ]);
    expect(app.navPanels).toEqual([
      expect.objectContaining({
        id: "preset-sync",
        title: "Preset Sync",
        icon: "Cloud",
        path: "preset-sync",
      }),
    ]);
    expect(app.navPanels[0]?.experimental_sidebarAccessory).toBeTypeOf("function");
  });

  it("shows directional actions and the exact remote and local changes", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const status: SyncStatus = {
      checkedAt: "2026-09-04T08:00:00.000Z",
      repository: "https://github.com/example/preset.git",
      branch: "main",
      remoteHead: "0123456789abcdef",
      remoteCapturedAt: "2026-09-04T07:00:00.000Z",
      localCapturedAt: "2026-09-04T08:00:00.000Z",
      stagedAt: null,
      changeCount: 1,
      pushChangeCount: 1,
      pullChanges: [
        {
          kind: "plugin-install",
          action: "install",
          target: "remote-plugin",
          summary: "Install remote-plugin from remote-plugin@y5k",
          risk: "full-trust",
        },
      ],
      pushChanges: [
        {
          kind: "appearance",
          action: "update",
          target: "Theme",
          summary: "Record theme dark in the preset",
          risk: "configuration",
        },
      ],
      warnings: [],
      lastOperation: null,
    };
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        settings: {
          repositoryUrl: status.repository,
          branch: "main",
          backgroundCheckInterval: "5 minutes",
        },
        rpc: {
          sync_status: () => status,
          sync_cached_check: () => ({
            checkedAt: status.checkedAt,
            status,
            error: null,
          }),
        },
      },
    );

    expect(await slot.findByText("Available sync")).toBeTruthy();
    expect(slot.getByText("Install remote-plugin from remote-plugin@y5k")).toBeTruthy();
    expect(slot.getByText("Record theme dark in the preset")).toBeTruthy();
    expect(slot.getByRole("button", { name: /Pull remote/i })).toBeTruthy();
    expect(slot.getByRole("button", { name: /Push local/i })).toBeTruthy();
    slot.lifecycle.unmount();
  });
});
