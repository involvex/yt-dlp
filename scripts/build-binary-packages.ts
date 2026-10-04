/**
 * Stages one publishable package per native platform target.
 *
 * Native payloads ship in `@involvex/yt-dlp-binary-<dir>` optional dependencies rather than in the
 * main package, so a consumer downloads ~17-39 MB instead of 214 MB and npm skips every platform
 * that cannot apply. Only the arch-independent `any` zipapp stays in the main package, because it is
 * what Android/Termux and unsupported architectures fall back to.
 *
 * The asset map comes from `src/binary-targets.ts` and the checksum verification from
 * `scripts/binary-download.ts` - the same modules `build-binaries.ts` uses, so there is exactly one
 * answer to "which upstream asset belongs in this directory".
 *
 * Output: build/binary-packages/<package name>/ containing package.json, README.md and the payload,
 * plus build/binary-packages/index.json describing the whole set for the publish step.
 *
 * Usage:
 *   bun run build:binpkg                            # every native target
 *   bun run build:binpkg -- --only linux-x64
 *   bun run build:binpkg -- --force                 # re-download even if the hash matches
 *   bun run build:binpkg -- --version 2026.08.19
 *   bun run build:binpkg -- --list
 */

import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  MAIN_PACKAGE,
  TARGETS,
  packageDirName,
  packageNameFor,
  subPackageManifest,
  targetForDir,
} from "../src/binary-targets.js";
import {
  ensureBinary,
  fetchChecksums,
  makeExecutable,
  parseCommonArgs,
  reportFailure,
  resolveVersion,
  sha256File,
  type EnsureResult,
} from "./binary-download.js";

const OUT_DIR = "build/binary-packages";
const MAIN_PACKAGE_VERSION = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
).version as string;

function readme(target: { dir: string; asset: string }): string {
  return [
    `# ${packageNameFor(target.dir)}`,
    "",
    `The yt-dlp \`${target.asset}\` binary for **${target.dir}**, published as an optional`,
    `dependency of [\`${MAIN_PACKAGE}\`](https://www.npmjs.com/package/${MAIN_PACKAGE}).`,
    "",
    "Install it through the wrapper rather than directly:",
    "",
    "```sh",
    `npm install ${MAIN_PACKAGE}`,
    "```",
    "",
    "npm selects this package automatically from its `os`/`cpu` fields, so users on other",
    "platforms never download it. There is no executable entrypoint here by design - the wrapper",
    "owns the command line and resolves the payload at runtime.",
    "",
  ].join("\n");
}

interface Staged extends EnsureResult {
  name: string;
  dir: string;
  filename: string;
  os: string[];
  cpu: string[];
  libc: string[] | null;
  path: string;
}

/** One row of `index.json`, read back off disk by {@link writeIndex}. */
interface IndexEntry {
  name: string;
  version: string;
  stagingDir: string;
  file: string;
  os: string[];
  cpu: string[];
  libc: string[] | null;
  ytDlpVersion: string | null;
  sha256: string;
  bytes: number;
}

/**
 * Put the verified payload in place.
 *
 * Prefers the already-verified `binaries/<dir>/` tree so a release build does not re-download
 * 214 MB, but only after re-checking the hash: a stale sibling from an older tag is copied as a
 * download would be, never trusted.
 */
async function stage(
  target: NonNullable<ReturnType<typeof targetForDir>>,
  ytDlpVersion: string,
  checksums: Map<string, string>,
  force: boolean,
): Promise<Staged> {
  const name = packageNameFor(target.dir);
  if (!name) throw new Error(`${target.dir} has no sub-package`);

  const packageDir = join(OUT_DIR, packageDirName(name));
  await mkdir(packageDir, { recursive: true });
  const payload = join(packageDir, target.filename);

  const expected = checksums.get(target.asset);
  if (!expected) {
    throw new Error(
      `${target.asset} is not listed in SHA2-256SUMS for ${ytDlpVersion}`,
    );
  }

  let result: EnsureResult;
  const sibling = join("binaries", target.dir, target.filename);
  if (
    !force &&
    existsSync(sibling) &&
    (await sha256File(sibling)) === expected
  ) {
    await copyFile(sibling, payload);
    // `copyFile` preserves the source mode, but the source may itself be a stale non-executable
    // file, and this payload is what ships. Hash the staged bytes rather than assuming the copy
    // matched: a copy interrupted by a full disk, or a sibling rewritten concurrently by
    // `build:bin --force`, would otherwise record a hash that describes a file nobody published.
    const stagedHash = await sha256File(payload);
    if (stagedHash !== expected) {
      await rm(payload, { force: true });
      throw new Error(
        `staged copy of ${payload} does not match ${target.asset}\n` +
          `  expected ${expected}\n  actual   ${stagedHash}\n` +
          `  the copy was deleted rather than published`,
      );
    }
    await makeExecutable(payload);
    result = {
      asset: target.asset,
      dest: payload,
      status: "cached",
      sha256: stagedHash,
      bytes: (await stat(payload)).size,
    };
  } else {
    result = await ensureBinary({
      asset: target.asset,
      dest: payload,
      version: ytDlpVersion,
      checksums,
      force,
      exists: existsSync,
      log: console.log,
    });
  }

  const manifest = subPackageManifest(target, {
    version: MAIN_PACKAGE_VERSION,
    ytDlpVersion,
  });
  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  await writeFile(join(packageDir, "README.md"), readme(target));

  return {
    ...result,
    name,
    dir: target.dir,
    filename: target.filename,
    os: [...target.os!],
    cpu: [...target.cpu!],
    libc: target.libc ? [...target.libc] : null,
    path: payload,
  };
}

/**
 * Rebuild `index.json` by scanning the staging directories.
 *
 * Derived from disk rather than from this run's results, which matters for two reasons. A partial
 * `--only` build still describes the full staged set, so the publish gate can pass after a targeted
 * rebuild instead of failing on an index that only remembers one package. And the index can never be
 * stale in a way that hides a problem: anything that disagrees with `package.json` or with the
 * payload on disk is exactly what `verify-package.mjs` looks for, rather than something this file
 * quietly papers over.
 */
async function writeIndex(): Promise<IndexEntry[]> {
  const entries: IndexEntry[] = [];
  for (const entry of await readdir(OUT_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(OUT_DIR, entry.name);
    const manifestPath = join(dir, "package.json");
    if (!existsSync(manifestPath)) continue;

    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const files: string[] = manifest.files ?? [];
    if (files.length !== 1) continue;
    const payload = join(dir, files[0]);
    if (!existsSync(payload)) continue;

    entries.push({
      name: manifest.name,
      version: manifest.version,
      stagingDir: entry.name,
      file: files[0],
      os: manifest.os ?? [],
      cpu: manifest.cpu ?? [],
      libc: manifest.libc ?? null,
      ytDlpVersion: manifest.ytDlpVersion ?? null,
      sha256: await sha256File(payload),
      bytes: (await stat(payload)).size,
    });
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));

  await writeFile(
    join(OUT_DIR, "index.json"),
    JSON.stringify(
      {
        wrapper: { name: MAIN_PACKAGE, version: MAIN_PACKAGE_VERSION },
        packages: entries,
      },
      null,
      2,
    ) + "\n",
  );
  return entries;
}

async function main(): Promise<void> {
  const args = parseCommonArgs(process.argv.slice(2));
  const version = args.version ?? resolveVersion();

  const native = TARGETS.filter((t) => packageNameFor(t.dir) !== null);

  if (args.list) {
    console.log(`yt-dlp ${version}\n`);
    console.log("package".padEnd(46) + "os / cpu / libc");
    console.log("-".repeat(84));
    for (const t of native) {
      const manifest = subPackageManifest(t, {
        version: MAIN_PACKAGE_VERSION,
        ytDlpVersion: version,
      });
      console.log(
        String(manifest.name).padEnd(46) +
          `${(manifest.os as string[]).join(",")} / ${(manifest.cpu as string[]).join(",")}` +
          `${manifest.libc ? ` / ${(manifest.libc as string[]).join(",")}` : ""}`,
      );
    }
    console.log(
      `\n${native.length} sub-packages + ${MAIN_PACKAGE} (wrapper, ships binaries/any only)`,
    );
    return;
  }

  const selected = native.filter(
    (t) =>
      args.only.length === 0 ||
      args.only.includes(t.dir) ||
      args.only.includes(t.asset) ||
      args.only.includes(packageNameFor(t.dir) ?? ""),
  );
  if (selected.length === 0) {
    throw new Error(
      `--only ${args.only.join(",")} matched none of: ${native.map((t) => t.dir).join(", ")}`,
    );
  }

  console.log(`Fetching checksums for yt-dlp ${version}...`);
  const checksums = await fetchChecksums(version);

  // A full run starts from an empty tree so directories for targets that no longer exist cannot
  // accumulate; a partial run leaves the others alone, since the index below is rebuilt by scanning.
  if (args.only.length === 0)
    await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const staged: Staged[] = [];
  for (const target of selected) {
    const result = await stage(target, version, checksums, args.force);
    staged.push(result);
    console.log(`  ${result.status.padEnd(8)} ${result.name}`);
  }

  const entries = await writeIndex();

  const total = staged.reduce((sum, s) => sum + s.bytes, 0);
  console.log(`\n${OUT_DIR}`);
  console.log("package".padEnd(46) + "size".padEnd(11) + "sha256");
  console.log("-".repeat(84));
  for (const s of staged) {
    console.log(
      s.name.padEnd(46) +
        `${(s.bytes / 1048576).toFixed(2)} MB`.padEnd(11) +
        s.sha256.slice(0, 16) +
        "...",
    );
  }
  console.log("-".repeat(84));
  console.log(
    `${entries.length} package(s) staged (${staged.length} rebuilt this run), ` +
      `${(total / 1048576).toFixed(1)} MB of payload fetched this run.`,
  );
  console.log(
    "Run `node scripts/verify-package.mjs` to validate manifests, architectures and tarballs.",
  );
}

main().catch(reportFailure);
