/**
 * Downloads the real yt-dlp release binaries into ./binaries/<platform>-<arch>/.
 *
 * Every download is pinned to an explicit yt-dlp tag and verified against that tag's
 * SHA2-256SUMS before being written. Never resolves "latest".
 *
 * Usage:
 *   bun run build:bin                     # everything
 *   bun run build:bin -- --only windows-x64,linux-x64
 *   bun run build:bin -- --version 2026.08.19
 *   bun run build:bin -- --force          # re-download even if the hash already matches
 *   bun run build:bin -- --list           # print the asset map and exit
 */

import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Pinned by default so tarball contents are reproducible. Override with YT_DLP_VERSION. */
const DEFAULT_VERSION = "2026.08.19";

const REPO = "yt-dlp/yt-dlp";

/**
 * asset name -> local destinations.
 *
 * `yt-dlp_macos` is a single universal2 binary, so it is stored once under
 * macos-universal2/ and resolved by both macOS architectures (see src/binary.ts).
 *
 * The upstream `yt-dlp` asset is NOT a native binary: it is a pure-Python zipapp with a
 * `#!/usr/bin/env python3` shebang. It is arch-independent and runs anywhere python3
 * exists, which makes it the only viable payload for Android/Termux (upstream ships no
 * Bionic build) and a usable last-resort fallback everywhere else.
 *
 * linux-armv7 is intentionally absent: upstream only publishes yt-dlp_linux_armv7l.zip,
 * which is a zip rather than a standalone executable.
 */
const ASSETS: Record<string, string[]> = {
  "yt-dlp.exe": ["binaries/windows-x64/yt-dlp.exe"],
  "yt-dlp_x86.exe": ["binaries/windows-x86/yt-dlp.exe"],
  "yt-dlp_arm64.exe": ["binaries/windows-arm64/yt-dlp.exe"],
  "yt-dlp_linux": ["binaries/linux-x64/yt-dlp"],
  "yt-dlp_linux_aarch64": ["binaries/linux-arm64/yt-dlp"],
  "yt-dlp_musllinux": ["binaries/linux-musl-x64/yt-dlp"],
  "yt-dlp_macos": ["binaries/macos-universal2/yt-dlp"],
  "yt-dlp": ["binaries/any/yt-dlp", "binaries/android-arm64/yt-dlp"],
};

interface Args {
  only: string[];
  force: boolean;
  list: boolean;
  version: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    only: [],
    force: false,
    list: false,
    version: process.env.YT_DLP_VERSION || DEFAULT_VERSION,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") args.force = true;
    else if (arg === "--list") args.list = true;
    else if (arg === "--only")
      args.only = (argv[++i] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    else if (arg === "--version") args.version = argv[++i] ?? DEFAULT_VERSION;
    else if (arg.startsWith("--only="))
      args.only = arg
        .slice(7)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    else if (arg.startsWith("--version=")) args.version = arg.slice(10);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (args.version === "latest") {
    throw new Error(
      "refusing to build from 'latest': pin an explicit tag so the package is reproducible " +
        "(use --version 2026.08.19 or set YT_DLP_VERSION)",
    );
  }
  return args;
}

async function fetchToFile(url: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(
      `GET ${url} -> HTTP ${response.status} ${response.statusText}`,
    );
  }
  await pipeline(
    Readable.fromWeb(response.body as never),
    createWriteStream(dest),
  );
}

async function sha256File(path: string): Promise<string> {
  const buf = await readFile(path);
  return createHash("sha256").update(buf).digest("hex");
}

function downloadUrl(version: string, asset: string): string {
  return `https://github.com/${REPO}/releases/download/${version}/${asset}`;
}

async function fetchChecksums(version: string): Promise<Map<string, string>> {
  const url = downloadUrl(version, "SHA2-256SUMS");
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(
      `could not fetch ${url} -> HTTP ${response.status} ${response.statusText}`,
    );
  }
  const text = await response.text();
  const map = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (match) map.set(match[2], match[1]);
  }
  if (map.size === 0) throw new Error(`${url} contained no checksum lines`);
  return map;
}

interface Row {
  dest: string;
  asset: string;
  status: string;
  sha256: string;
  bytes: number;
}

/** Remove binaries/ subdirectories that are no longer part of the asset map. */
async function pruneStale(
  keep: Set<string>,
  prune: boolean,
): Promise<string[]> {
  if (!existsSync("binaries")) return [];
  const removed: string[] = [];
  for (const entry of await readdir("binaries", { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (keep.has(entry.name)) continue;
    if (prune) {
      await rm(join("binaries", entry.name), { recursive: true, force: true });
      removed.push(`binaries/${entry.name}`);
    }
  }
  return removed;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    console.log(`yt-dlp ${args.version}\n`);
    console.log("asset".padEnd(22) + "-> destination");
    console.log("-".repeat(70));
    for (const [asset, dests] of Object.entries(ASSETS)) {
      for (const dest of dests) console.log(asset.padEnd(22) + "-> " + dest);
    }
    return;
  }

  console.log(`Fetching checksums for yt-dlp ${args.version}...`);
  const checksums = await fetchChecksums(args.version);

  // Select destinations, not just assets: the `yt-dlp` zipapp maps to two directories, so
  // filtering at asset granularity alone would make `--only any` also rewrite android-arm64.
  const selected = Object.entries(ASSETS).flatMap(([asset, dests]) =>
    dests
      .filter(
        (dest) =>
          args.only.length === 0 ||
          args.only.includes(dest.split("/")[1] ?? "") ||
          args.only.includes(asset),
      )
      .map((dest) => ({ asset, dest })),
  );
  const wanted = new Set(selected.map((s) => s.asset));
  if (selected.length === 0) {
    throw new Error(
      `--only ${args.only.join(",")} matched none of: ${Object.keys(ASSETS).join(", ")}`,
    );
  }

  const knownDirs = new Set(
    Object.values(ASSETS)
      .flat()
      .map((d) => d.split("/")[1]),
  );
  // Only prune on a full build; a partial --only run must not delete the others.
  const removed = await pruneStale(knownDirs, args.only.length === 0);
  for (const dir of removed) console.log(`  removed stale ${dir}`);

  const rows: Row[] = [];

  for (const { asset, dest } of selected) {
    const expected = checksums.get(asset);
    if (!expected) {
      throw new Error(
        `${asset} is not listed in SHA2-256SUMS for ${args.version}`,
      );
    }
    const url = downloadUrl(args.version, asset);

    {
      if (existsSync(dest) && !args.force) {
        const actual = await sha256File(dest);
        if (actual === expected) {
          rows.push({
            dest,
            asset,
            status: "ok (cached)",
            sha256: actual,
            bytes: (await stat(dest)).size,
          });
          console.log(`  ok       ${dest}`);
          continue;
        }
        console.log(`  stale    ${dest} (hash mismatch, re-downloading)`);
      }

      console.log(`  get      ${url}`);
      await fetchToFile(url, dest);
      const actual = await sha256File(dest);
      if (actual !== expected) {
        await rm(dest, { force: true });
        throw new Error(
          `checksum mismatch for ${dest}\n  expected ${expected}\n  actual   ${actual}\n` +
            `  the download was deleted; refusing to keep an unverified binary`,
        );
      }
      if (process.platform !== "win32") await chmod(dest, 0o755);
      rows.push({
        dest,
        asset,
        status: "downloaded",
        sha256: actual,
        bytes: (await stat(dest)).size,
      });
    }
  }

  console.log(
    "\ndestination".padEnd(38) +
      "status".padEnd(15) +
      "size".padEnd(11) +
      "sha256",
  );
  console.log("-".repeat(104));
  for (const row of rows) {
    console.log(
      row.dest.padEnd(38) +
        row.status.padEnd(15) +
        `${(row.bytes / 1048576).toFixed(2)} MB`.padEnd(11) +
        row.sha256.slice(0, 16) +
        "...",
    );
  }
  console.log(`\nyt-dlp ${args.version}: ${rows.length} file(s) ready.`);
  console.log(
    "Run `node scripts/verify-package.mjs` to validate architectures.",
  );
}

main().catch((error) => {
  console.error(
    `\nbuild:bin failed: ${error instanceof Error ? error.message : error}`,
  );
  process.exit(1);
});
