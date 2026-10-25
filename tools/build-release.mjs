/**
 * Builds the release package of Pinocchio's Merchants from the development sources.
 *
 * The repository holds the development build (ID `pw-merchant-dev`, title "… (dev)"), so it can
 * be installed next to the release build on a GM's own Foundry. A release is the same code under
 * the release ID: this script copies the module files to `dist/pw-merchant/`, switches the ID and
 * the title, writes the GitHub URLs into module.json and zips the package.
 *
 * Usage: node tools/build-release.mjs [--version 0.55.0] [--repo owner/name]
 *   --version  release version (default: version from module.json)
 *   --repo     GitHub repository for the manifest and download URLs (default: $GITHUB_REPOSITORY)
 *
 * Output:
 *   dist/pw-merchant/      unpacked package
 *   dist/module.json       manifest (the same file as in the package)
 *   dist/pw-merchant.zip   package for the GitHub release
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE_ID = "pw-merchant";
const RELEASE_TITLE = "Pinocchio's Merchants";
const RELEASE_DESCRIPTION =
  "A full merchant sheet for Pathfinder 2e Loot actors in Merchant mode: categories with stock lists, " +
  "a powerful item search with key:value filters, a price modifier, random stock, buying for players " +
  "and selling to the shop with GM offers and counteroffers.";
const DEV_ID = "pw-merchant-dev";

/** Files and folders that go into the package; everything else (tests, tools, docs) stays out. */
const PACKAGE_FILES = ["lang", "scripts", "styles", "templates", "README.md", "CHANGELOG.md", "LICENSE"];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const devManifest = JSON.parse(readFileSync(join(root, "module.json"), "utf8"));
const version = (arg("version") ?? devManifest.version).replace(/^v/, "");
const repo = arg("repo") ?? process.env.GITHUB_REPOSITORY;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid version: ${version}`);
if (devManifest.id !== DEV_ID) throw new Error(`module.json must have the development ID ${DEV_ID}, found ${devManifest.id}`);

const dist = join(root, "dist");
const out = join(dist, RELEASE_ID);
rmSync(dist, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const name of PACKAGE_FILES) {
  const from = join(root, name);
  if (existsSync(from)) cpSync(from, join(out, name), { recursive: true });
}

// Module ID used in code (flags, settings, template paths, socket).
const constantsPath = join(out, "scripts", "constants.js");
const constants = readFileSync(constantsPath, "utf8");
const idLine = `export const MODULE_ID = "${DEV_ID}";`;
if (!constants.includes(idLine)) throw new Error(`scripts/constants.js: "${idLine}" not found`);
writeFileSync(constantsPath, constants.replace(idLine, `export const MODULE_ID = "${RELEASE_ID}";`));

// Manifest of the release.
const manifest = {
  ...devManifest,
  id: RELEASE_ID,
  title: RELEASE_TITLE,
  description: RELEASE_DESCRIPTION,
  version
};
if (repo) {
  manifest.url = `https://github.com/${repo}`;
  manifest.manifest = `https://github.com/${repo}/releases/latest/download/module.json`;
  manifest.download = `https://github.com/${repo}/releases/download/v${version}/${RELEASE_ID}.zip`;
  manifest.bugs = `https://github.com/${repo}/issues`;
  manifest.changelog = `https://github.com/${repo}/blob/main/CHANGELOG.md`;
  manifest.readme = `https://github.com/${repo}/blob/main/README.md`;
}
const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
writeFileSync(join(out, "module.json"), manifestText);
writeFileSync(join(dist, "module.json"), manifestText);

// Package: files at the root of the zip (module.json next to scripts/).
execFileSync("zip", ["-qr", join(dist, `${RELEASE_ID}.zip`), "."], { cwd: out, stdio: "inherit" });

console.log(`Built ${RELEASE_ID} ${version}${repo ? ` for ${repo}` : " (no repository URLs)"} → dist/${RELEASE_ID}.zip`);
