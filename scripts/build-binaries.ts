/**
 * Downloads the real yt-dlp release binaries into ./binaries/<platform>-<arch>/.
 *
 * The asset map and the checksum verification live in `src/binary-targets.ts` and
 * `scripts/binary-download.ts`, shared with `build-binary-packages.ts` so there is one answer to
 * "which upstream asset belongs in this directory".
 *
 * `binaries/` is a build artifact, not published content: only `binaries/any/yt-dlp` ships in the
 * main package, and every native payload ships in its own
 * `@involvex/yt-dlp-binary-<dir>` optional dependency. This tree is kept because `src/binary.ts`
 * prefers a sibling directory, which is what makes local development and the test suite work
 * without an install step.
 *
 * Usage:
 *   bun run build:bin                     # everything
 *   bun run build:bin -- --only windows-x64,linux-x64
 *   bun run build:bin -- --version 2026.08.19
 *   bun run build:bin -- --force          # re-download even if the hash already matches
 *   bun run build:bin -- --list           # print the asset map and exit
 */

import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { TARGETS, packageNameFor } from "../src/binary-targets.js";
import {
  ensureBinary,
  fetchChecksums,
  parseCommonArgs,
  reportFailure,
  type EnsureResult,
} from "./binary-download.js";

/** `binaries/<dir>/<filename>` - where a target's payload lives in this tree. */
function destFor(dir: string, filename: string): string {
  return `binaries/${dir}/${filename}`;
}

/** Remove `binaries/` subdirectories that are no longer part of the target table. */
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
  const args = parseCommonArgs(process.argv.slice(2));

  if (args.list) {
    console.log(`yt-dlp ${args.version}\n`);
    console.log("directory".padEnd(20) + "asset".padEnd(24) + "shipped in");
    console.log("-".repeat(78));
    for (const target of TARGETS) {
      const pkg = packageNameFor(target.dir);
      console.log(
        target.dir.padEnd(20) +
          target.asset.padEnd(24) +
          (pkg ?? `${"@involvex/yt-dlp"} (main package)`),
      );
    }
    return;
  }

  console.log(`Fetching checksums for yt-dlp ${args.version}...`);
  const checksums = await fetchChecksums(args.version);

  // Select by target, not by asset: several targets can share one asset, and filtering at asset
  // granularity would make `--only any` rewrite every directory that uses the same zipapp.
  const selected = TARGETS.filter(
    (t) =>
      args.only.length === 0 ||
      args.only.includes(t.dir) ||
      args.only.includes(t.asset) ||
      args.only.includes(packageNameFor(t.dir) ?? ""),
  );
  if (selected.length === 0) {
    throw new Error(
      `--only ${args.only.join(",")} matched none of: ${TARGETS.map((t) => t.dir).join(", ")}`,
    );
  }

  // Only prune on a full build; a partial --only run must not delete the others.
  const removed = await pruneStale(
    new Set(TARGETS.map((t) => t.dir)),
    args.only.length === 0,
  );
  for (const dir of removed) console.log(`  removed stale ${dir}`);

  const rows: EnsureResult[] = [];
  for (const target of selected) {
    const result = await ensureBinary({
      asset: target.asset,
      dest: destFor(target.dir, target.filename),
      version: args.version,
      checksums,
      force: args.force,
      exists: existsSync,
      log: console.log,
    });
    rows.push(result);
    console.log(
      `  ${result.status === "cached" ? "ok      " : "get     "} ${result.dest}`,
    );
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

main().catch(reportFailure);
