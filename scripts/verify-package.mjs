#!/usr/bin/env node
/**
 * Publish gate for @involvex/yt-dlp and its per-platform binary packages.
 *
 * Guards against the failure modes that have actually shipped or nearly shipped here:
 *   1. `dist/` silently excluded from the tarball (a nested `dist/.gitignore` is treated as
 *      `dist/.npmignore`), which made every published install die with ERR_MODULE_NOT_FOUND.
 *   2. Bundled binaries that do not match the platform directory they live in, because the
 *      downloader used one URL for every target and copied the same file into all of them.
 *   3. A native payload silently dropped from a sub-package tarball by an ignore file - the same
 *      trap as (1), one level down. The root .gitignore contains `*.exe`, which is exactly the
 *      pattern the Windows payloads need, so this is asserted rather than assumed.
 *   4. A sub-package whose `os`/`cpu` does not describe the binary inside it, so npm would install
 *      a package on the wrong platform.
 *   5. Version skew between the wrapper and its optional dependencies, which would pair a new
 *      wrapper with a stale - or nonexistent - binary.
 *
 * Zero dependencies, plain Node ESM. Exits non-zero with a report on failure.
 *
 * Usage: node scripts/verify-package.mjs [--no-pack]
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

// `import.meta.dirname` only exists on Node >= 20.11, but package.json#engines allows >= 18. Use the
// portable form: this script runs in prepublishOnly, so it must not crash on a supported Node.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BINARIES_DIR = join(ROOT, "binaries");
const SUBPACKAGES_DIR = join(ROOT, "build", "binary-packages");
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

/**
 * Detected binary architecture -> the npm `cpu` values that can run it.
 *
 * A Mach-O universal2 binary satisfies both macOS architectures, which is why the macOS sub-package
 * declares `cpu: ["x64", "arm64"]` and a single file. Note x86 is published as `ia32`, which is what
 * Node reports for 32-bit x86 and therefore what npm matches on.
 */
const ARCH_TO_NPM_CPU = {
  x64: ["x64"],
  x86: ["ia32"],
  arm64: ["arm64"],
  arm: ["arm"],
  universal: ["x64", "arm64"],
};

/**
 * Detected binary format -> the npm `os` value that can run it.
 *
 * The counterpart to ARCH_TO_NPM_CPU. npm trusts `os` exactly as much as it trusts `cpu`, so a
 * package declaring `os: ["win32"]` around a Linux ELF would otherwise ship: `cpu` would be
 * checked against the header, but `os` had no independent signal to check against, and a package
 * whose platform is simply wrong installs nowhere at all.
 *
 * A shebang script maps to no `os` - the zipapp stays in the wrapper and is never a sub-package.
 */
const KIND_TO_NPM_OS = {
  elf: ["linux"],
  pe: ["win32"],
  "mach-o": ["darwin"],
};

/**
 * Directory suffix -> the npm `cpu` values it authorises.
 *
 * The counterpart to KIND_TO_NPM_CPU, and the authority the manifest is checked against.
 *
 * Checking the manifest against the payload alone is not enough: a package named
 * `...windows-x64` holding a Linux x64 ELF with `os: ["linux"], cpu: ["x64"]` is internally
 * consistent, passes every payload-derived check, and is still wrong - it installs on Linux and
 * never on Windows, which is precisely the platform its name promises. The directory suffix is what
 * the resolver and the runtime agree on, so it is what the manifest must match.
 *
 * `universal2` is the one suffix that legitimately spans two architectures.
 */
const DIR_NPM_CPU = {
  x64: ["x64"],
  x86: ["ia32"],
  ia32: ["ia32"],
  arm64: ["arm64"],
  arm: ["arm"],
  universal2: ["x64", "arm64"],
};

/**
 * Directory prefix -> the npm `os` values it authorises.
 *
 * Derived the same way as DIR_NPM_CPU. `linux-musl-x64` is `linux`, `macos-universal2` is `darwin`.
 */
function expectedOsForDir(dir) {
  if (dir.startsWith("windows-")) return ["win32"];
  if (dir.startsWith("linux-")) return ["linux"];
  if (dir.startsWith("macos-")) return ["darwin"];
  return null;
}

/**
 * Directories that hold a `python3` zipapp rather than a native binary.
 *
 * Only `any` remains: it is the arch-independent universal fallback that ships in the main package.
 * There is deliberately no `android-arm64` directory - Termux is served by this same file, so a
 * second copy would be a byte-identical duplicate for no benefit.
 */
const SCRIPT_DIRS = new Set(["any"]);

/**
 * Duplicate sha256 values that are intentional.
 *
 * Empty, and that is the point. The zipapp used to be stored at both `any/` and `android-arm64/`,
 * which had to be allowlisted here - and that allowlist is exactly what would have hidden the real
 * bug, where one asset was copied into every platform directory. With a single zipapp copy and one
 * distinct upstream asset per native target, any duplicate now means the downloader is wrong.
 */
const EXPECTED_DUPLICATE_PAIRS = new Set();

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
// npm pack
// ---------------------------------------------------------------------------

/**
 * File paths npm would include, or null if the command failed.
 *
 * execSync (not execFileSync) so the Windows `npm` shim works without `shell: true`.
 */
function packFileList(cwd) {
  const raw = execSync("npm pack --dry-run --json", {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  // npm 11 returns [{ files: [...] }]; npm 12 returns { "<name>": { files: [...] } }.
  const parsed = JSON.parse(raw);
  const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  return entry.files.map((f) => f.path);
}

// ---------------------------------------------------------------------------
// Check 1: tarball contents
// ---------------------------------------------------------------------------

const REQUIRED = [
  "dist/cli.js",
  "dist/index.js",
  "dist/binary.js",
  // The arch-independent zipapp must stay here: it is what Android/Termux and unsupported
  // architectures fall back to, since no native sub-package covers them.
  "binaries/any/yt-dlp",
];
const FORBIDDEN = [
  /\.whl$/i,
  /\.tar\.gz$/i,
  /^dist\/yt-dlp-cl/i,
  // No native payload may ship in the wrapper. They are optional dependencies now; a stray copy
  // here would silently restore the 214 MB install this split exists to remove.
  /^binaries\/(?!any\/)/,
];

function checkPackContents() {
  if (!existsSync(join(ROOT, "dist", "cli.js"))) {
    record(false, "dist/cli.js on disk", "missing - run `bun run build:ts` first");
    return;
  }
  record(true, "dist/cli.js on disk", "present");

  let files;
  try {
    files = packFileList(ROOT);
  } catch (error) {
    record(false, "npm pack --dry-run", `command failed: ${String(error.message).split("\n")[0]}`);
    return;
  }

  const missing = REQUIRED.filter((p) => !files.includes(p));
  record(
    missing.length === 0,
    "compiled JS + zipapp in tarball",
    missing.length === 0 ? `${REQUIRED.join(", ")} present` : `MISSING from tarball: ${missing.join(", ")}`,
  );

  const leaked = files.filter((p) => FORBIDDEN.some((re) => re.test(p)));
  record(
    leaked.length === 0,
    "no Python artifacts or native payloads in wrapper tarball",
    leaked.length === 0 ? "clean" : `leaked: ${leaked.join(", ")}`,
  );

  console.log(`  wrapper tarball: ${files.length} files`);
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
    const isScriptDir = SCRIPT_DIRS.has(dir);
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
      if (kind !== "mach-o" || arch !== "universal") {
        ok = false;
        note = `expected a Mach-O universal2 binary, found ${kind} ${arch ?? "?"}`;
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
          ? `same as ${prev} (intentional)`
          : `identical sha256 to ${prev} - one asset copied into two platform directories`,
      );
    } else {
      hashes.set(hash, rel);
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Check 4: per-platform sub-packages
// ---------------------------------------------------------------------------

/** `@involvex/yt-dlp-binary-linux-x64` -> `involvex-yt-dlp-binary-linux-x64`. */
function stagingDirName(name) {
  return name.replace(/^@/, "").replace(/\//g, "-");
}

/**
 * `@involvex/yt-dlp-binary-linux-x64` -> `linux-x64`.
 *
 * The directory suffix is the package's identity, which is the whole point of the naming scheme, so
 * it can be recovered without consulting the target table. A name that does not follow the scheme
 * returns the whole string, which then fails to match anything rather than silently matching wrong.
 */
function dirFromPackageName(name) {
  return name.replace(/^@[^/]+\/yt-dlp-binary-/, "");
}

async function checkSubPackages(binaryRows) {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const optional = pkg.optionalDependencies ?? {};
  const names = Object.keys(optional).sort();

  /** `binaries/<dir>/<file>` -> sha256, so a staged copy can be compared to the tree it came from. */
  const treeHashes = new Map(
    (binaryRows ?? [])
      .filter((r) => r.rel.startsWith("binaries/"))
      .map((r) => [r.rel.replace(/\\/g, "/"), r.hash]),
  );

  // A hard dependency would make install fail outright wherever one platform's package is
  // unavailable - e.g. a new architecture before its binary is published.
  record(
    Object.keys(pkg.dependencies ?? {}).length === 0,
    "binaries are optionalDependencies, never dependencies",
    Object.keys(pkg.dependencies ?? {}).length === 0
      ? "no hard dependencies"
      : `hard dependencies present: ${Object.keys(pkg.dependencies).join(", ")}`,
  );

  if (names.length === 0) {
    record(false, "optionalDependencies declared", "none - binaries would not be installed at all");
    return;
  }

  const indexPath = join(SUBPACKAGES_DIR, "index.json");
  if (!existsSync(indexPath)) {
    record(false, "binary sub-packages staged", `${indexPath} missing - run \`bun run build:binpkg\``);
    return;
  }
  const index = JSON.parse(readFileSync(indexPath, "utf8"));

  const staged = index.packages.map((p) => p.name).sort();
  const missing = names.filter((n) => !staged.includes(n));
  const extra = staged.filter((n) => !names.includes(n));
  record(
    missing.length === 0 && extra.length === 0,
    "optionalDependencies match the staged packages",
    missing.length || extra.length
      ? `declared but not staged: [${missing.join(", ")}]; staged but not declared: [${extra.join(", ")}]`
      : `${names.length} packages`,
  );

  const skew = names.filter((n) => optional[n] !== pkg.version);
  record(
    skew.length === 0,
    "sub-packages pinned to the wrapper version",
    skew.length === 0
      ? `all pinned to ${pkg.version}`
      : `version skew: ${skew.map((n) => `${n}@${optional[n]} != ${pkg.version}`).join(", ")}`,
  );

  const rows = [];
  const payloadHashes = new Map();
  for (const name of names) {
    const dir = join(SUBPACKAGES_DIR, stagingDirName(name));
    const manifestPath = join(dir, "package.json");
    if (!existsSync(manifestPath)) {
      record(false, `sub-package ${name}`, "not staged - run `bun run build:binpkg`");
      continue;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    record(
      manifest.name === name,
      `sub-package ${name} manifest name`,
      manifest.name === name ? "ok" : `manifest says ${manifest.name}`,
    );
    record(
      manifest.version === optional[name],
      `sub-package ${name} version`,
      manifest.version === optional[name]
        ? `${manifest.version}`
        : `manifest ${manifest.version} != pinned ${optional[name]}`,
    );
    // A `bin` entry here would put a second `yt-dlp` on the consumer's PATH from a package they
    // never asked for, able to shadow a system install.
    record(
      manifest.bin === undefined,
      `sub-package ${name} declares no bin`,
      manifest.bin === undefined ? "ok" : `declares ${JSON.stringify(manifest.bin)} - would shadow PATH`,
    );

    const declaredFiles = Array.isArray(manifest.files) ? manifest.files : [];
    const payloadName = declaredFiles[0];
    if (!payloadName || declaredFiles.length !== 1) {
      record(
        false,
        `sub-package ${name} payload`,
        `files must name exactly one payload, got ${JSON.stringify(manifest.files)}`,
      );
      continue;
    }
    const payload = join(dir, payloadName);
    if (!existsSync(payload)) {
      record(false, `sub-package ${name} payload`, `${payloadName} missing from ${dir}`);
      continue;
    }

    const { kind, arch, detail } = detect(readHead(payload));
    const size = statSync(payload).size;
    const runnable = ARCH_TO_NPM_CPU[arch ?? ""] ?? [];
    const runnableOs = KIND_TO_NPM_OS[kind] ?? [];

    // The declared platform must describe the binary that is actually inside. This is the check
    // that stops a mislabelled package from shipping: npm trusts os/cpu, so a wrong value means
    // installing the wrong architecture or nothing at all. Both fields are checked against the
    // header - `os` against the format, `cpu` against the machine type - because a wrong `os` makes
    // the package install nowhere at all, which is harder to diagnose than a wrong `cpu`.
    const declaredOs = Array.isArray(manifest.os) ? manifest.os : [];
    const declaredCpu = Array.isArray(manifest.cpu) ? manifest.cpu : [];
    const osOk =
      runnableOs.length > 0 &&
      declaredOs.length > 0 &&
      declaredOs.every((o) => runnableOs.includes(o)) &&
      runnableOs.every((o) => declaredOs.includes(o));
    const cpuOk =
      runnable.length > 0 &&
      declaredCpu.length > 0 &&
      declaredCpu.every((c) => runnable.includes(c)) &&
      runnable.every((c) => declaredCpu.includes(c));
    const mismatch = !osOk || !cpuOk;
    record(
      !mismatch,
      `sub-package ${name} platform matches payload`,
      mismatch
        ? `WRONG PLATFORM: os=${JSON.stringify(declaredOs)} cpu=${JSON.stringify(declaredCpu)} but payload is ${kind} ${arch ?? "?"} (${detail}); expected os=${JSON.stringify(runnableOs)} cpu=${JSON.stringify(runnable)}`
        : `${kind} ${arch} - os=${declaredOs.join(",")} cpu=${declaredCpu.join(",")}${manifest.libc ? ` libc=${manifest.libc.join(",")}` : ""}`,
    );

    // The package's own name is a third, independent claim about what it should contain. It must agree
    // with both the payload and the directory the payload was expected in. Without this, a Linux
    // x64 payload staged as `...windows-x64` with `os: ["linux"], cpu: ["x64"]` is internally
    // consistent and passes every payload-derived check, yet installs on Linux and never on Windows.
    const dirName = dirFromPackageName(name);
    const wantedCpu = DIR_NPM_CPU[dirName.split("-").pop()] ?? null;
    const wantedOs = expectedOsForDir(dirName);
    const nameMismatch =
      wantedCpu === null ||
      wantedOs === null ||
      !wantedCpu.every((c) => declaredCpu.includes(c)) ||
      !declaredCpu.every((c) => wantedCpu.includes(c)) ||
      !wantedOs.every((o) => declaredOs.includes(o)) ||
      !declaredOs.every((o) => wantedOs.includes(o));
    record(
      !nameMismatch,
      `sub-package ${name} platform matches its own name`,
      nameMismatch
        ? `named for "${dirName}" but declares os=${JSON.stringify(declaredOs)} cpu=${JSON.stringify(declaredCpu)}; the name promises os=${JSON.stringify(wantedOs)} cpu=${JSON.stringify(wantedCpu)}`
        : `${dirName} -> os=${declaredOs.join(",")} cpu=${declaredCpu.join(",")}`,
    );

    rows.push({ name, os: declaredOs, cpu: declaredCpu, libc: manifest.libc ?? null, size, arch, ok: !mismatch });

    const hash = await sha256(payload);

    // The payload must be the same file that is in `binaries/<dir>/`, under the name the runtime
    // looks up. `stage()` reaches it either by copying that tree or by downloading straight into the
    // package, so agreement is independent evidence that the packaging step neither truncated nor
    // substituted it.
    //
    // A missing entry here is itself a failure rather than a skip: the staged package cannot be
    // compared, and `resolveSubPackageBinary` looks the payload up by the exact name recorded in the
    // target table. If the two disagree the package installs and then silently fails to resolve,
    // degrading to the zipapp or PATH with no diagnostic anywhere.
    const treeHash = treeHashes.get(`binaries/${dirName}/${payloadName}`);
    record(
      treeHash !== undefined && hash === treeHash,
      `sub-package ${name} payload matches binaries/${dirName}/${payloadName}`,
      treeHash === undefined
        ? `nothing to compare against: binaries/${dirName}/${payloadName} was not found in the binaries/ tree, so the runtime would not be able to resolve this payload by name`
        : hash === treeHash
          ? `${hash.slice(0, 16)}...`
          : `staged payload is ${hash.slice(0, 16)}... but binaries/ has ${treeHash.slice(0, 16)}...`,
    );

    // One upstream asset copied into two packages would ship the wrong architecture to whichever
    // platform npm installs it on - the original bug, one level up.
    const previous = payloadHashes.get(hash);
    record(
      previous === undefined,
      `sub-package ${name} payload is unique`,
      previous === undefined
        ? `${hash.slice(0, 16)}...`
        : `identical sha256 to ${previous}`,
    );
    if (previous === undefined) payloadHashes.set(hash, name);

    // npm must actually include the payload. The root .gitignore contains `*.exe`, which is the
    // exact filename the three Windows packages ship, so this is verified per package rather than
    // assumed from a single spot-check of the wrapper.
    if (!process.argv.includes("--no-pack")) {
      try {
        const files = packFileList(dir);
        const present = files.includes(payloadName);
        record(
          present,
          `sub-package ${name} tarball contains its payload`,
          present ? files.join(", ") : `${payloadName} EXCLUDED from tarball (files: ${files.join(", ")})`,
        );
      } catch (error) {
        record(false, `sub-package ${name} npm pack --dry-run`, String(error.message).split("\n")[0]);
      }
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

function reportSubPackages(rows) {
  if (!rows || rows.length === 0) return;
  const total = rows.reduce((sum, r) => sum + r.size, 0);
  console.log("\n  binary sub-packages");
  console.log("  " + "-".repeat(78));
  console.log("  " + "package".padEnd(46) + "os / cpu".padEnd(20) + "size");
  console.log("  " + "-".repeat(78));
  for (const r of rows) {
    console.log(
      "  " +
        r.name.padEnd(46) +
        `${(r.os ?? []).join(",")} / ${(r.cpu ?? []).join(",")}`.padEnd(20) +
        (r.size / 1048576).toFixed(2) +
        "MB",
    );
  }
  console.log("  " + "-".repeat(78));
  console.log(
    `  ${rows.length} packages, ${(total / 1048576).toFixed(1)} MB total` +
      ` (was 214 MB in a single tarball)`,
  );
}

async function main() {
  console.log("@involvex/yt-dlp package verification\n");

  if (!process.argv.includes("--no-pack")) {
    checkPackContents();
  }
  const rows = await checkBinaries();
  if (rows.length) report(rows);
  const subRows = await checkSubPackages(rows);
  reportSubPackages(subRows);

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