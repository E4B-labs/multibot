import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { tmpdir } from "node:os";

import {
  RELEASE_REPOSITORY,
  buildReleaseArgs,
  buildUploadArgs,
  releaseAssets,
  releaseTag,
} from "./publish-release.mjs";

test("release publication is pinned to the desktop releases repository", () => {
  assert.equal(RELEASE_REPOSITORY, "E4B-labs/multibot-desktop-releases");
  assert.equal(releaseTag("0.3.10"), "v0.3.10");
  assert.deepEqual(
    buildReleaseArgs("0.3.10", ["release/latest.yml", "release/MultiBot-Desktop-0.3.10-x64-setup.exe"]),
    [
      "release",
      "create",
      "v0.3.10",
      "--repo",
      "E4B-labs/multibot-desktop-releases",
      "--title",
      "MultiBot Desktop v0.3.10",
      "--latest",
      "--generate-notes",
      "release/latest.yml",
      "release/MultiBot-Desktop-0.3.10-x64-setup.exe",
    ],
  );

  assert.deepEqual(
    buildUploadArgs("0.3.10", ["release/latest.yml"]),
    [
      "release",
      "upload",
      "v0.3.10",
      "--repo",
      "E4B-labs/multibot-desktop-releases",
      "--clobber",
      "release/latest.yml",
    ],
  );
});

test("release assets only include files and current updater feeds for the version", () => {
  const directory = mkdtempSync(join(tmpdir(), "multibot-release-test-"));
  try {
    writeFileSync(join(directory, "MultiBot-Desktop-0.3.10-x64-setup.exe"), "installer");
    writeFileSync(join(directory, "MultiBot-Desktop-0.3.10-x64-setup.exe.blockmap"), "blockmap");
    writeFileSync(join(directory, "MultiBot-Desktop-0.3.9-x64-setup.exe"), "old installer");
    writeFileSync(join(directory, "latest.yml"), "version: 0.3.10\n");
    writeFileSync(join(directory, "latest-mac.yml"), "version: 0.3.9\n");
    writeFileSync(join(directory, "MultiBot-Mobile-0.3.6.apk"), "mobile");

    assert.deepEqual(
      releaseAssets("0.3.10", directory).map((file) => basename(file)),
      [
        "MultiBot-Desktop-0.3.10-x64-setup.exe",
        "MultiBot-Desktop-0.3.10-x64-setup.exe.blockmap",
        "latest.yml",
      ],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
