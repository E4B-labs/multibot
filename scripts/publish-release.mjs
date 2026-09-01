import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RELEASE_REPOSITORY = "E4B-labs/multibot-desktop-releases";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = join(root, "release");

export function releaseTag(version) {
  const normalized = String(version).trim().replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(normalized)) {
    throw new Error(`Invalid desktop release version: ${version}`);
  }
  return `v${normalized}`;
}

export function releaseAssets(version, directory = releaseDir) {
  const normalized = String(version).trim().replace(/^v/, "");
  if (!existsSync(directory)) return [];

  const names = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.startsWith(`MultiBot-Desktop-${normalized}-`));

  const hasWindowsInstaller = names.some((name) => name.endsWith("-setup.exe"));
  const hasMacInstaller = names.some((name) => name.endsWith("-mac.zip") || name.endsWith(".dmg"));
  const feedNames = [
    ...(hasWindowsInstaller && feedMatchesVersion(directory, "latest.yml", normalized) ? ["latest.yml"] : []),
    ...(hasMacInstaller && feedMatchesVersion(directory, "latest-mac.yml", normalized) ? ["latest-mac.yml"] : []),
  ];

  return [...names, ...feedNames]
    .sort()
    .map((name) => join(directory, name));
}

function feedMatchesVersion(directory, name, version) {
  const file = join(directory, name);
  if (!existsSync(file)) return false;
  const contents = readFileSync(file, "utf8");
  return new RegExp(`^version:\\s*${version.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s*$`, "m").test(contents);
}

export function buildReleaseArgs(version, assets) {
  const tag = releaseTag(version);
  return [
    "release",
    "create",
    tag,
    "--repo",
    RELEASE_REPOSITORY,
    "--title",
    `MultiBot Desktop ${tag}`,
    "--latest",
    "--generate-notes",
    ...assets,
  ];
}

export function buildUploadArgs(version, assets) {
  return [
    "release",
    "upload",
    releaseTag(version),
    "--repo",
    RELEASE_REPOSITORY,
    "--clobber",
    ...assets,
  ];
}

function releaseExists(tag) {
  const result = spawnSync("gh", ["release", "view", tag, "--repo", RELEASE_REPOSITORY], { stdio: "ignore" });
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (result.status !== 1) throw new Error(`Could not inspect ${RELEASE_REPOSITORY} release ${tag}.`);
  return false;
}

function main() {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const assets = releaseAssets(pkg.version);
  const hasInstaller = assets.some((asset) => /\.(exe|dmg|zip)$/.test(asset));
  if (!hasInstaller) {
    throw new Error(`No desktop installer found in ${releaseDir}; run the platform package command first.`);
  }

  const tag = releaseTag(pkg.version);
  const existing = releaseExists(tag);
  const args = existing ? buildUploadArgs(pkg.version, assets) : buildReleaseArgs(pkg.version, assets);
  console.log(`${existing ? "Uploading to" : "Publishing"} ${tag} in ${RELEASE_REPOSITORY}`);
  execFileSync("gh", args, { cwd: root, stdio: "inherit" });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
