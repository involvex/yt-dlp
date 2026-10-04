/**
 * Download-and-verify logic shared by `build-binaries.ts` and `build-binary-packages.ts`.
 *
 * Every payload is pinned to an explicit yt-dlp tag and checked against that tag's upstream
 * `SHA2-256SUMS` before it is kept. A mismatch deletes the download rather than leaving an
 * unverified binary on disk, because a silently-wrong binary is the failure mode this whole
 * arrangement exists to prevent.
 */

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { DEFAULT_VERSION, UPSTREAM_REPO } from "../src/binary-targets.js";

export { DEFAULT_VERSION };

export function downloadUrl(version: string, asset: string): string {
  return `https://github.com/${UPSTREAM_REPO}/releases/download/${version}/${asset}`;
}

/**
 * Resolve the yt-dlp version to build from.
 *
 * `latest` is refused outright. Resolving it would make two builds of the same source produce
 * different tarball contents, which is exactly the class of bug the checksum table exists to catch.
 */
export function resolveVersion(explicit?: string): string {
  const version = explicit ?? process.env.YT_DLP_VERSION ?? DEFAULT_VERSION;
  if (version === "latest") {
    throw new Error(
      "refusing to build from 'latest': pin an explicit tag so the package is reproducible " +
        `(use --version ${DEFAULT_VERSION} or set YT_DLP_VERSION)`,
    );
  }
  return version;
}

export async function sha256File(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
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

/** asset filename -> sha256, parsed from a release's `SHA2-256SUMS`. */
export async function fetchChecksums(
  version: string,
): Promise<Map<string, string>> {
  const url = downloadUrl(version, "SHA2-256SUMS");
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(
      `could not fetch ${url} -> HTTP ${response.status} ${response.statusText}`,
    );
  }
  const map = new Map<string, string>();
  for (const line of (await response.text()).split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (match) map.set(match[2], match[1]);
  }
  if (map.size === 0) throw new Error(`${url} contained no checksum lines`);
  return map;
}

export interface EnsureResult {
  asset: string;
  dest: string;
  /** "cached" when the existing file already matched, "downloaded" otherwise. */
  status: "cached" | "downloaded";
  sha256: string;
  bytes: number;
}

/**
 * Make `dest` hold the upstream `asset`, verified.
 *
 * An existing file is trusted only if its hash matches the pinned checksum, so a stale file from an
 * older tag is re-fetched rather than reused.
 */
export async function ensureBinary(options: {
  asset: string;
  dest: string;
  version: string;
  checksums: Map<string, string>;
  force?: boolean;
  exists: (path: string) => boolean;
  log?: (message: string) => void;
}): Promise<EnsureResult> {
  const { asset, dest, version, checksums, force, exists, log } = options;
  const say = log ?? (() => {});

  const expected = checksums.get(asset);
  if (!expected) {
    throw new Error(`${asset} is not listed in SHA2-256SUMS for ${version}`);
  }
  const url = downloadUrl(version, asset);

  if (exists(dest) && !force) {
    const actual = await sha256File(dest);
    if (actual === expected) {
      return {
        asset,
        dest,
        status: "cached",
        sha256: actual,
        bytes: (await stat(dest)).size,
      };
    }
    say(`  stale    ${dest} (hash mismatch, re-downloading)`);
  }

  say(`  get      ${url}`);
  await fetchToFile(url, dest);
  const actual = await sha256File(dest);
  if (actual !== expected) {
    await rm(dest, { force: true });
    throw new Error(
      `checksum mismatch for ${dest}\n  expected ${expected}\n  actual   ${actual}\n` +
        `  the download was deleted; refusing to keep an unverified binary`,
    );
  }
  // The zipapp and the POSIX binaries are executed directly, so they need the executable bit.
  // A no-op on Windows, where the bit is meaningless.
  if (process.platform !== "win32") await chmod(dest, 0o755);

  return {
    asset,
    dest,
    status: "downloaded",
    sha256: actual,
    bytes: (await stat(dest)).size,
  };
}

/** Shared `--only` / `--force` / `--list` / `--version` argument parser. */
export interface CommonArgs {
  only: string[];
  force: boolean;
  list: boolean;
  version: string;
}

export function parseCommonArgs(argv: string[]): CommonArgs {
  const args: CommonArgs = {
    only: [],
    force: false,
    list: false,
    version: resolveVersion(),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") args.force = true;
    else if (arg === "--list") args.list = true;
    else if (arg === "--only") splitList(args, argv[++i]);
    else if (arg === "--version") args.version = resolveVersion(argv[++i]);
    else if (arg.startsWith("--only=")) splitList(args, arg.slice(7));
    else if (arg.startsWith("--version="))
      args.version = resolveVersion(arg.slice(10));
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function splitList(args: CommonArgs, raw: string | undefined): void {
  args.only = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function reportFailure(error: unknown): never {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
