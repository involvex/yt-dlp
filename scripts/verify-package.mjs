#!/usr/bin/env node
/**
 * Publish gate for @involvex/yt-dlp.
 *
 * Guards against the two failure modes that shipped in 2026.8.21:
 *   1. `dist/` silently excluded from the tarball (a nested `dist/.gitignore` is treated as
 *      `dist/.npmignore`), which made every published install die with ERR_MODULE_NOT_FOUND.
 *   2. Bundled binaries that do not match the platform directory they live in, because the
 *      downloader used one URL for every target and copied the same file into all of them.
 *
 * Zero dependencies, plain Node ESM. Exits non-zero with a report on failure.
 *
 * Usage: node scripts/verify-package.mjs [--no-pack]
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

// `import.meta.dirname` only exists on Node >= 20.11, but package.json#engines allows >= 18. Use the
// portable form: this script runs in prepublishOnly, so it must not crash on a supported Node.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BINARIES_DIR = join(ROOT, "binaries");
const HEAD_BYTES = 4096;

const results = [];
let failed = 0;

function record(ok, check, detail) {
  results.push({ ok, check, detail });
  if (!ok) failed += 1;
}

function sha256(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Binary format / architecture detection
// ---------------------------------------------------------------------------

const ELF_ARCH = {
  0x03: "x86",
  0x28: "arm",
  0x3e: "x64",
  0xb7: "arm64",
};

const PE_ARCH = {
  0x014c: "x86",
  0x01c0: "arm",
  0x8664: "x64",
  0xaa64: "arm64",
};

// Directory-name suffix -> the architecture that binary must actually be. The suffix is the last
// dash-separated segment, so multi-part names like `linux-musl-x64` resolve correctly.
const DIR_ARCH = {
  x64: "x64",
  x86: "x86",
  ia32: "x86",
  arm64: "arm64",
  armv7: "arm",
  arm: "arm",
  universal2: "universal",
};

/** Directories that are expected to hold a `python3` zipapp rather than a native binary. */
const SCRIPT_DIRS = new Set(["any", "android-arm64"]);

/**
 * Duplicate sha256 values that are intentional.
 *
 * The arch-independent zipapp is deliberately stored at both `any/` (universal fallback) and
 * `android-arm64/` (Termux), so those two are the same file by design. Any other duplicate means
 * the downloader wrote one asset into several platform directories - the bug this gate exists for.
 */
const EXPECTED_DUPLICATES = [
  ["binaries/any/yt-dlp", "binaries/android-arm64/yt-dlp"],
];
/** Order-insensitive: both sides are sorted before comparison, because `prev` depends on
 *  readdirSync (filesystem) order and must not decide whether the gate fails. */
const EXPECTED_DUPLICATE_PAIRS = new Set(
  EXPECTED_DUPLICATES.map(([a, b]) => [a, b].sort().join(" ")),
);

function readHead(path) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const read = readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function detect(buf) {
  // python3 zipapp / shell script
  if (buf[0] === 0x23 && buf[1] === 0x21) {
    const nl = buf.indexOf(0x0a);
    return { kind: "script", arch: null, detail: buf.subarray(0, nl).toString("latin1").trim() };
  }
  // ELF
  if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
    const machine = buf.readUInt16LE(18);
    return { kind: "elf", arch: ELF_ARCH[machine] ?? null, detail: `e_machine=0x${machine.toString(16)}` };
  }
  // PE / MZ
  if (buf[0] === 0x4d && buf[1] === 0x5a) {
    if (buf.length < 0x40) return { kind: "unknown", arch: null, detail: "truncated MZ" };
    const pe = buf.readInt32LE(0x3c);
    if (pe < 0 || pe + 6 > buf.length) return { kind: "unknown", arch: null, detail: `bad e_lfanew=${pe}` };
    if (buf.readUInt32LE(pe) !== 0x00004550) return { kind: "unknown", arch: null, detail: "missing PE signature" };
    const machine = buf.readUInt16LE(pe + 4);
    return { kind: "pe", arch: PE_ARCH[machine] ?? null, detail: `machine=0x${machine.toString(16)}` };
  }
  // Mach-O (universal binaries use the 0xCAFEBABE big-endian fat header)
  const be = buf.readUInt32BE(0);
  const le = buf.readUInt32LE(0);
  if (be === 0xcafebabe || be === 0xcafebabf) return { kind: "mach-o", arch: "universal", detail: "fat binary" };
  if (le === 0xfeedface || le === 0xfeedfacf) return { kind: "mach-o", arch: "single", detail: "thin binary" };
  if (be === 0xfeedface || be === 0xfeedfacf) return { kind: "mach-o", arch: "single", detail: "thin binary" };
  return { kind: "unknown", arch: null, detail: `magic=0x${be.toString(16)}` };
}

// ---------------------------------------------------------------------------
// Check 1: tarball contents
// ---------------------------------------------------------------------------

const REQUIRED = ["dist/cli.js", "dist/index.js", "dist/binary.js"];
const FORBIDDEN = [/\.whl$/i, /\.tar\.gz$/i, /^dist\/yt-dlp-cl/i];

function checkPackContents() {
  if (!existsSync(join(ROOT, "dist", "cli.js"))) {
    record(false, "dist/cli.js on disk", "missing - run `bun run build:ts` first");
    return;
  }
  record(true, "dist/cli.js on disk", "present");

  let raw;
  try {
    // execSync (not execFileSync) so the Windows `npm` shim works without `shell: true`.
    raw = execSync("npm pack --dry-run --json", {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    record(false, "npm pack --dry-run", `command failed: ${String(error.message).split("\n")[0]}`);
    return;
  }

  let files;
  try {
    // npm 11 returns [{ files: [...] }]; npm 12 returns { "<name>": { files: [...] } }.
    const parsed = JSON.parse(raw);
    const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
    files = entry.files.map((f) => f.path);
  } catch (error) {
    record(false, "npm pack --dry-run", `could not parse JSON: ${error.message}`);
    return;
  }

  const missing = REQUIRED.filter((p) => !files.includes(p));
  record(
    missing.length === 0,
    "compiled JS in tarball",
    missing.length === 0 ? `${REQUIRED.join(", ")} present` : `MISSING from tarball: ${missing.join(", ")}`,
  );

  const leaked = files.filter((p) => FORBIDDEN.some((re) => re.test(p)));
  record(
    leaked.length === 0,
    "no Python build artifacts in tarball",
    leaked.length === 0 ? "clean" : `leaked: ${leaked.join(", ")}`,
  );

  console.log(`  tarball: ${files.length} files`);
}

// ---------------------------------------------------------------------------
// Check 2 + 3: binary architectures and duplicate hashes
// ---------------------------------------------------------------------------

function collectBinaries() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  if (existsSync(BINARIES_DIR)) walk(BINARIES_DIR);
  return out;
}

async function checkBinaries() {
  if (!existsSync(BINARIES_DIR)) {
    record(false, "binaries/ present", "directory does not exist - run `bun run build:bin`");
    return [];
  }

  const files = collectBinaries();
  if (files.length === 0) {
    record(false, "binaries/ present", "no files found - run `bun run build:bin`");
    return [];
  }

  const rows = [];
  const hashes = new Map();

  for (const file of files) {
    const rel = file.slice(ROOT.length + 1).split(sep).join("/");
    const dir = basename(dirname(file));
    const isScriptDir = SCRIPT_DIRS.has(dir) || dir.startsWith("android-");
    const expected = isScriptDir ? null : DIR_ARCH[dir.split("-").pop()];
    const { kind, arch, detail } = detect(readHead(file));
    const hash = await sha256(file);
    const size = statSync(file).size;

    let ok = true;
    let note = `${kind} ${arch ?? "?"} (${detail})`;

    if (isScriptDir) {
      if (kind !== "script") {
        ok = false;
        note = `expected a python3 zipapp, found ${kind}`;
      }
    } else if (expected === "universal") {
      if (kind !== "mach-o") {
        ok = false;
        note = `expected a Mach-O universal2 binary, found ${kind}`;
      }
    } else if (kind === "script") {
      ok = false;
      note = "found a python3 zipapp where a native binary is required";
    } else if (!expected) {
      ok = false;
      note = `cannot determine expected arch from directory "${dir}"`;
    } else if (arch !== expected) {
      ok = false;
      note = `WRONG ARCH: directory says ${expected}, binary is ${arch ?? "unknown"} (${detail})`;
    }

    record(ok, `binary ${rel}`, note);
    rows.push({
      rel,
      kind,
      arch: isScriptDir ? "any" : (arch ?? "?"),
      expected: expected ?? "any",
      size,
      hash,
      ok,
    });

    const prev = hashes.get(hash);
    if (prev) {
      const intentional = EXPECTED_DUPLICATE_PAIRS.has([prev, rel].sort().join(" "));
      record(
        intentional,
        `duplicate binary ${rel}`,
        intentional
          ? `same as ${prev} (intentional: arch-independent zipapp)`
          : `identical sha256 to ${prev} - one asset copied into two platform directories`,
      );
    } else {
      hashes.set(hash, rel);
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function report(rows) {
  console.log("\n  platform binaries");
  console.log("  " + "-".repeat(78));
  console.log("  " + "file".padEnd(40) + "expected".padEnd(11) + "actual".padEnd(11) + "size");
  console.log("  " + "-".repeat(78));
  for (const r of rows) {
    const mb = (r.size / 1048576).toFixed(2) + "MB";
    console.log(
      "  " +
        r.rel.slice(0, 38).padEnd(40) +
        String(r.expected).padEnd(11) +
        (r.ok ? String(r.arch) : String(r.arch) + " !").padEnd(11) +
        mb,
    );
  }
  console.log("  " + "-".repeat(78));
}

async function main() {
  console.log("@involvex/yt-dlp package verification\n");

  if (!process.argv.includes("--no-pack")) {
    checkPackContents();
  }
  const rows = await checkBinaries();
  if (rows.length) report(rows);

  const passed = results.filter((r) => r.ok).length;
  const total = results.length;

  console.log(`\n  ${passed}/${total} checks passed`);
  if (failed > 0) {
    console.log("\nFAILURES:");
    for (const r of results.filter((x) => !x.ok)) console.log(`  - [${r.check}] ${r.detail}`);
    console.log("\nRESULT: FAIL");
    process.exit(1);
  }
  console.log("\nRESULT: PASS");
}

main().catch((error) => {
  console.error("verify-package crashed:", error);
  process.exit(1);
});