import { describe, expect, it } from "vitest";
import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";

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
  });
});
