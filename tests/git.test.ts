import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readExistingPreset } from "../lib/git";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("preset repository initialization", () => {
  it("treats a repository with no preset files as uninitialized", async () => {
    const directory = await mkdtemp(join(tmpdir(), "preset-sync-git-test-"));
    temporaryDirectories.push(directory);

    await expect(readExistingPreset(directory)).resolves.toBeNull();
  });

  it("refuses to replace a partially initialized preset", async () => {
    const directory = await mkdtemp(join(tmpdir(), "preset-sync-git-test-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, "preset"));
    await writeFile(join(directory, "preset", "settings.json"), "{}\n", "utf8");

    await expect(readExistingPreset(directory)).rejects.toThrow(
      "Preset repository is incomplete",
    );
  });
});
