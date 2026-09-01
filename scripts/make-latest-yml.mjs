// Generates the electron-updater "latest" feed files (latest.yml / latest-mac.yml)
// from the just-built installer artifacts. electron-builder only writes these during
// the publish step, which we skip (`--publish never`), so we compute them here to
// keep the in-app Update button working with manual `gh release create` uploads.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const version = pkg.version;
const releaseDir = resolve(root, "release");
const releaseDate = new Date().toISOString();

function sha512Base64(filePath) {
  const buf = readFileSync(filePath);
  return createHash("sha512").update(buf).digest("base64");
}

function makeFeed(file, url) {
  const sha512 = sha512Base64(file);
  const size = readFileSync(file).length;
  return [
    `version: ${version}`,
    `files:`,
    `  - url: ${url}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${url}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releaseDate}'`,
    ``,
  ].join("\n");
}

const targets = [
  { out: "latest.yml", file: `MultiBot-Desktop-${version}-x64-setup.exe`, url: `MultiBot-Desktop-${version}-x64-setup.exe` },
  { out: "latest-mac.yml", file: `MultiBot-Desktop-${version}-mac.zip`, url: `MultiBot-Desktop-${version}-mac.zip` },
];

let wrote = 0;
for (const t of targets) {
  const file = resolve(releaseDir, t.file);
  if (!existsSync(file)) continue;
  writeFileSync(resolve(releaseDir, t.out), makeFeed(file, t.url));
  wrote++;
  console.log(`wrote ${t.out} (${t.file}, ${version})`);
}

if (wrote === 0) {
  console.error("make-latest-yml: no installer artifact found in release/ — build first");
  process.exit(1);
}
