import { spawn } from "child_process";
import { execFile } from "child_process";
import { createRequire } from "module";
import { promisify } from "util";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import { BinaryInfo } from "./types.js";
import {
  TARGET_KEY_DIRS,
  UNIVERSAL_DIR,
  packageNameFor,
  targetForDir,
} from "./binary-targets.js";

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Where the native payload for this platform lives, and how to build its argv.
 *
 * Resolution order, highest priority first:
 *
 *   1. a sibling `binaries/<dir>/` - a local `bun run build:bin` tree, which is what makes
 *      development and the test suite work with no install step;
 *   2. the installed `@involvex/yt-dlp-binary-<dir>` optional dependency - the normal path for an
 *      installed consumer, since only `binaries/any` is published in the main package;
 *   3. the arch-independent python3 zipapp in the main package (POSIX only);
 *   4. a bare `yt-dlp` on PATH.
 *
 * Steps 1 and 2 hold the same file, so a missing or skipped sub-package degrades to the zipapp and
 * then to PATH rather than failing the install. Every step is a fallback, never an error.
 */

/**
 * Arch-independent python3 zipapp, checked when no native binary matches.
 *
 * POSIX only. It is a `#!/usr/bin/env python3` script, and Windows cannot execute a shebang file
 * at all, so on win32 this must be skipped - otherwise it would shadow the PATH fallback and break
 * installs that rely on a system yt-dlp.
 *
 * This is also what serves Android/Termux: upstream publishes no Bionic build, so there is
 * deliberately no `android-arm64` entry in TARGET_KEY_DIRS and Termux falls through to here.
 */
const UNIVERSAL_TARGET = targetForDir(UNIVERSAL_DIR);
if (!UNIVERSAL_TARGET)
  throw new Error(`target table is missing the "${UNIVERSAL_DIR}" target`);
const UNIVERSAL_FALLBACK = `binaries/${UNIVERSAL_DIR}/${UNIVERSAL_TARGET.filename}`;

/** Last resort: resolve `yt-dlp` from PATH. */
const PATH_FALLBACK = "yt-dlp";

export class UnsupportedPlatformError extends Error {
  constructor(
    public readonly platform: string,
    public readonly arch: string,
  ) {
    super(`Unsupported platform: ${platform}-${arch}`);
    this.name = "UnsupportedPlatformError";
  }
}

export function getPlatform(): string {
  const platform = process.platform;
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  // Termux reports "android". It must not fall through to "linux": the bundled linux binaries are
  // glibc-linked and will not run against Bionic.
  if (platform === "android") return "android";
  if (platform === "linux") return isMusl() ? "linux-musl" : "linux";
  return platform;
}

/**
 * musl-based distributions (Alpine) ship without glibc, so yt-dlp_linux will not load there.
 * Node only exposes the glibc runtime version on glibc builds, so its absence means musl.
 */
export function isMusl(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const report = process.report?.getReport() as
      | { header?: { glibcVersionRuntime?: string } }
      | undefined;
    return !report?.header?.glibcVersionRuntime;
  } catch {
    return false;
  }
}

export function getArch(): string {
  switch (process.arch) {
    case "x64":
      return "x64";
    case "arm64":
      return "arm64";
    case "ia32":
      return "x86";
    // 32-bit ARM. Upstream publishes no standalone armv7 executable (only a .zip), so there is
    // deliberately no binaries/linux-armv7 entry; this maps to the universal zipapp instead.
    case "arm":
      return "armv7";
    default:
      // Return the raw arch rather than inventing a directory name that cannot exist.
      return process.arch;
  }
}

/** `<platform>-<arch>` key used to look up bundled candidates. */
export function getTargetKey(): string {
  return `${getPlatform()}-${getArch()}`;
}

export interface ResolvedBinary {
  path: string;
  source: "bundled" | "universal" | "path";
  /**
   * True when the payload is the python3 zipapp rather than a native executable, so it must be run
   * through an interpreter instead of relying on the kernel's `#!` handling.
   */
  needsPython: boolean;
  /** Relative paths that were checked, for error messages. */
  searched: string[];
}

/**
 * Interpreters to try for the zipapp payload, in order.
 *
 * `python3` is the norm on macOS/Linux, but a Windows install usually exposes only `python`, and
 * Termux's `python` package has not always shipped a `python3` alias - so both are tried and
 * `YT_DLP_PYTHON` overrides the list entirely.
 */
function pythonCandidates(): string[] {
  const override = process.env.YT_DLP_PYTHON;
  if (override) return [override];
  return process.platform === "win32"
    ? ["python", "python3"]
    : ["python3", "python"];
}

/**
 * Turn a resolved payload plus arguments into the command to actually execute.
 *
 * The zipapp payloads are `#!/usr/bin/env python3` scripts. Spawning one directly only works on
 * glibc, whose `execvp` re-executes `#!` files via `/bin/sh`; macOS and Android/Bionic have no such
 * fallback, so the spawn dies with ENOEXEC. Android is worse still - it has no `/bin/sh` at all
 * (Termux keeps its shell under `$PREFIX/bin/sh`), so a shell-based retry cannot work there either.
 * Invoking the interpreter explicitly is the only approach that is portable across all three.
 */
export function buildInvocation(
  resolved: ResolvedBinary,
  args: string[],
): { command: string; args: string[] } {
  if (resolved.needsPython)
    return { command: pythonCandidates()[0], args: [resolved.path, ...args] };
  return { command: resolved.path, args };
}

/** Resolver anchored at the installed package, so sub-package lookups walk the real node_modules. */
const requireFromPackage = createRequire(join(__dirname, "..", "noop.cjs"));

/**
 * Locate a native payload inside its installed `@involvex/yt-dlp-binary-<dir>` optional dependency.
 *
 * `base` exists so the test suite can point resolution at a temporary node_modules tree instead of
 * needing a real install.
 */
export function resolveSubPackageBinary(
  dir: string,
  base?: string,
): string | null {
  const target = targetForDir(dir);
  if (!target || target.script) return null;
  const pkg = packageNameFor(dir);
  if (!pkg) return null;

  const require = base
    ? createRequire(join(base, "noop.cjs"))
    : requireFromPackage;

  let packageDir: string;
  try {
    // Resolve the manifest, not the payload: a sub-package declares no `exports` map, but resolving
    // `package.json` is immune to one being added later, whereas a payload subpath would then start
    // throwing ERR_PACKAGE_PATH_NOT_EXPORTED and silently fall through to PATH.
    packageDir = dirname(require.resolve(`${pkg}/package.json`));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Not installed for this platform is the expected case, not an error. Anything else - a
    // malformed manifest, a permissions problem - is a real fault and must not be swallowed.
    if (
      code === "MODULE_NOT_FOUND" ||
      code === "ERR_MODULE_NOT_FOUND" ||
      code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
    ) {
      return null;
    }
    throw error;
  }

  const payload = join(packageDir, target.filename);
  return existsSync(payload) ? payload : null;
}

/**
 * Resolve the yt-dlp to run: bundled native binary (sibling tree, then sub-package) -> universal
 * zipapp -> PATH. Never throws for a missing payload, because every step has a fallback.
 */
export function resolveBinary(): ResolvedBinary {
  const key = getTargetKey();
  const searched: string[] = [];

  const dir = TARGET_KEY_DIRS[key];
  const target = dir ? targetForDir(dir) : undefined;
  if (dir && target) {
    // 1. Sibling tree from a local `bun run build:bin`.
    const relativePath = `binaries/${dir}/${target.filename}`;
    searched.push(relativePath);
    const sibling = join(__dirname, "..", relativePath);
    if (existsSync(sibling)) {
      return {
        path: sibling,
        source: "bundled",
        needsPython: target.script,
        searched,
      };
    }

    // 2. Installed optional dependency for this platform.
    const pkg = packageNameFor(dir);
    searched.push(`${pkg ?? dir}/${target.filename}`);
    const installed = resolveSubPackageBinary(dir);
    if (installed) {
      return {
        path: installed,
        source: "bundled",
        needsPython: target.script,
        searched,
      };
    }
  }

  // 3. The zipapp fallback needs a POSIX kernel and python3; never usable on Windows.
  if (process.platform !== "win32") {
    searched.push(UNIVERSAL_FALLBACK);
    const universal = join(__dirname, "..", UNIVERSAL_FALLBACK);
    if (existsSync(universal))
      return {
        path: universal,
        source: "universal",
        needsPython: true,
        searched,
      };
  }

  // 4. Unknown payload: assume it may be a zipapp (e.g. a pip-installed yt-dlp on Termux) and let
  // the ENOEXEC retry in runYtDlp route it through the interpreter.
  return { path: PATH_FALLBACK, source: "path", needsPython: false, searched };
}

/** Backwards-compatible accessor: just the command to execute. */
export function getBinaryPath(): string {
  return resolveBinary().path;
}

function missingBinaryMessage(resolved: ResolvedBinary): string {
  const key = getTargetKey();
  const hint =
    getPlatform() === "android"
      ? "On Termux install Python first: `pkg install python`, then `pip install -U yt-dlp`."
      : "Install yt-dlp first, e.g. `pip install -U yt-dlp`, or put `yt-dlp` on your PATH.";
  // Driven by the payload we actually resolved, so a Termux or armv7 install - both of which get
  // the zipapp - is told about python3 whether or not the failure was a missing interpreter.
  const needsPython = resolved.needsPython || getPlatform() === "android";
  const pythonNote = needsPython
    ? "\n  Note: the bundled payload for this platform is a python3 zipapp, so python3 must be on PATH."
    : "";
  return (
    `Could not find a yt-dlp binary for ${key}.\n` +
    `  Searched: ${resolved.searched.join(", ")} (relative to the package root)\n` +
    `  ${hint}${pythonNote}`
  );
}

/** Shared exec options. `timeout` is omitted unless a caller sets one - see below. */
const CAPTURE_OPTIONS = {
  maxBuffer: 1024 * 1024 * 64,
  windowsHide: true,
} as const;

/** Run one command and capture its output, with an optional deadline. */
function capture(command: string, args: string[], timeout?: number) {
  return execFileAsync(
    command,
    args,
    timeout ? { ...CAPTURE_OPTIONS, timeout } : CAPTURE_OPTIONS,
  );
}

/** Deadline for the `--version` probe: if it has not answered by now the binary is not usable. */
const PROBE_TIMEOUT_MS = 30_000;

/**
 * Run the resolved payload and return its stdout/stderr, trying each Python interpreter candidate for
 * the zipapp payload so a system that only exposes `python` (or only `python3`) still works.
 * Rejects if no candidate succeeds.
 *
 * Deliberately takes no timeout parameter and imposes no deadline. This is the execution path for the
 * programmatic API's `download()`/`getInfo()`, which legitimately run for hours, so any default cap
 * here would SIGTERM long downloads and report them as failures. A probe that does need a deadline
 * uses `probeVersion` instead - keeping the two separate means the download path cannot acquire a cap
 * by accident.
 */
export async function execFileCapture(
  resolved: ResolvedBinary,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  if (!resolved.needsPython) {
    return capture(resolved.path, args);
  }

  let lastError: unknown;
  for (const python of pythonCandidates()) {
    try {
      return await capture(python, [resolved.path, ...args]);
    } catch (error) {
      lastError = error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw (
    lastError ??
    new Error(
      `no Python interpreter found (tried ${pythonCandidates().join(", ")})`,
    )
  );
}

/** Run `args` against the resolved payload with a deadline, for short-lived probes only. */
async function probeVersion(
  resolved: ResolvedBinary,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const command = resolved.needsPython ? pythonCandidates()[0] : resolved.path;
  const argv = resolved.needsPython ? [resolved.path, ...args] : args;
  return capture(command, argv, PROBE_TIMEOUT_MS);
}

/**
 * Best-effort `--version` probe. Never throws: an unavailable binary must not stop the CLI from
 * trying to run yt-dlp, because the PATH fallback may still work.
 */
export async function getBinaryInfo(): Promise<BinaryInfo> {
  const resolved = resolveBinary();
  const info: BinaryInfo = {
    path: resolved.path,
    version: "unknown",
    platform: getPlatform(),
    arch: getArch(),
  };

  try {
    // Bounded: a slow --version means the binary is not usable, so report "unknown" rather than block.
    const { stdout } = await probeVersion(resolved, ["--version"]);
    const version = stdout.trim().split(/\r?\n/).pop() ?? "";
    if (version) info.version = version;
  } catch {
    // Keep version "unknown" and let the caller decide what to do.
  }

  return info;
}

export async function validateBinary(): Promise<boolean> {
  try {
    await getBinaryInfo();
    return true;
  } catch {
    return false;
  }
}

interface SpawnResult {
  code: number | null;
  signal?: NodeJS.Signals | null;
  spawnError?: Error;
}

function spawnOnce(command: string, args: string[]): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["inherit", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
    child.on("error", (error) => resolve({ code: null, spawnError: error }));
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
}

/**
 * Map a finished child to a process exit code.
 *
 * `close` reports `code === null` when the child was killed by a signal (Ctrl-C, SIGTERM, OOM).
 * Treating that as success would make an interrupted download exit 0, so mirror the shell's
 * 128 + signal convention instead.
 */
function exitCodeFor(result: SpawnResult): number {
  if (result.code !== null && result.code !== undefined) return result.code;
  if (result.signal) {
    const numbers: Partial<Record<NodeJS.Signals, number>> = {
      SIGINT: 2,
      SIGTERM: 15,
      SIGKILL: 9,
      SIGHUP: 1,
      SIGQUIT: 3,
      SIGABRT: 6,
    };
    return 128 + (numbers[result.signal] ?? 0);
  }
  return 1;
}

/**
 * Run yt-dlp.
 *
 * Bundled zipapp payloads go through the interpreter up front (see buildInvocation), falling back
 * to the other candidate if that interpreter is not installed. If a direct spawn fails with ENOEXEC
 * the resolved payload turns out to be a `#!`-script after all - as happens for a pip-installed
 * `yt-dlp` - so retry once through the interpreter too. No shell is involved on any path, so
 * arguments are never re-parsed and nothing depends on `/bin/sh` existing (Android has none).
 */
export async function runYtDlp(args: string[] = []): Promise<number> {
  const resolved = resolveBinary();

  if (resolved.needsPython) {
    let last: SpawnResult | undefined;
    for (const python of pythonCandidates()) {
      const attempt = await spawnOnce(python, [resolved.path, ...args]);
      if (!attempt.spawnError) return exitCodeFor(attempt);
      last = attempt;
      if ((attempt.spawnError as NodeJS.ErrnoException).code !== "ENOENT")
        break;
    }
    reportSpawnFailure(resolved, last);
    return 1;
  }

  const direct = await spawnOnce(resolved.path, args);
  if (!direct.spawnError) return exitCodeFor(direct);

  const code = (direct.spawnError as NodeJS.ErrnoException).code;
  if (code === "ENOEXEC" && process.platform !== "win32") {
    let last: SpawnResult | undefined;
    for (const python of pythonCandidates()) {
      const attempt = await spawnOnce(python, [resolved.path, ...args]);
      if (!attempt.spawnError) return exitCodeFor(attempt);
      last = attempt;
      if ((attempt.spawnError as NodeJS.ErrnoException).code !== "ENOENT")
        break;
    }
    reportSpawnFailure(resolved, last);
    return 1;
  }

  reportSpawnFailure(resolved, direct);
  return 1;
}

function reportSpawnFailure(
  resolved: ResolvedBinary,
  result?: SpawnResult,
): void {
  const error = result?.spawnError as NodeJS.ErrnoException | undefined;
  const detail = !error
    ? missingBinaryMessage(resolved)
    : error.code === "ENOENT"
      ? missingBinaryMessage(resolved)
      : `Failed to start ${resolved.path}: ${error.message}`;
  console.error(detail);
}

/**
 * Backwards-compatible spawn API, kept for callers that want the ChildProcess handle.
 *
 * Prefer `runYtDlp`. Two differences matter: `runYtDlp` awaits the exit code and maps a signal death
 * to `128 + signal`, and it retries the remaining interpreter candidates when one is not installed.
 * This variant can only start a process, so for the zipapp payload it commits to the first candidate
 * from `pythonCandidates()` with no way to fall back - set `YT_DLP_PYTHON` if you need a specific
 * interpreter. In practice only Termux and unsupported-architecture systems take that path, where
 * `python3` is the conventional name.
 */
export function spawnYtDlp(args: string[] = []): ReturnType<typeof spawn> {
  const { command, args: all } = buildInvocation(resolveBinary(), args);
  return spawn(command, all, {
    stdio: ["inherit", "pipe", "pipe"],
    windowsHide: true,
  });
}
