import { spawn } from "child_process";
import { execFile } from "child_process";
import { promisify } from "util";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import { BinaryInfo } from "./types.js";

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Where the bundled yt-dlp for a given platform/arch lives, relative to the package root.
 *
 * The first entry that exists on disk wins. `any` is the arch-independent python3 zipapp and acts
 * as a last-resort bundled fallback; a bare `yt-dlp` on PATH is the final fallback.
 *
 * `macos-universal2` is a single Mach-O fat binary that runs on both macOS architectures, so both
 * macOS entries point at the same file rather than shipping it twice.
 */
const CANDIDATES: Record<string, string[]> = {
  "windows-x64": ["binaries/windows-x64/yt-dlp.exe"],
  "windows-x86": ["binaries/windows-x86/yt-dlp.exe"],
  "windows-arm64": ["binaries/windows-arm64/yt-dlp.exe"],
  "linux-x64": ["binaries/linux-x64/yt-dlp"],
  "linux-arm64": ["binaries/linux-arm64/yt-dlp"],
  // Alpine / other musl-based distributions have no glibc and cannot run yt-dlp_linux.
  "linux-musl-x64": ["binaries/linux-musl-x64/yt-dlp"],
  "macos-x64": ["binaries/macos-universal2/yt-dlp"],
  "macos-arm64": ["binaries/macos-universal2/yt-dlp"],
  // No upstream Bionic build exists; the python3 zipapp is the only viable Android payload.
  "android-arm64": ["binaries/android-arm64/yt-dlp"],
};

/**
 * Arch-independent python3 zipapp, checked when no native binary matches.
 *
 * POSIX only. It is a `#!/usr/bin/env python3` script, and Windows cannot execute a shebang file
 * at all, so on win32 this must be skipped - otherwise it would shadow the PATH fallback and break
 * installs that rely on a system yt-dlp.
 */
const UNIVERSAL_FALLBACK = "binaries/any/yt-dlp";

/** Last resort: resolve `yt-dlp` from PATH. */
const PATH_FALLBACK = "yt-dlp";

/** Platforms whose bundled payload is the python3 zipapp and therefore needs python3. */
const NEEDS_PYTHON = new Set(["android-arm64", "any"]);

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

/** Relative paths that hold the python3 zipapp rather than a native executable. */
const SCRIPT_PAYLOADS = new Set([
  UNIVERSAL_FALLBACK,
  "binaries/android-arm64/yt-dlp",
]);

/**
 * Resolve the yt-dlp to run: bundled native binary -> universal zipapp -> PATH.
 * Throws only when nothing at all could be resolved.
 */
export function resolveBinary(): ResolvedBinary {
  const key = getTargetKey();
  const searched: string[] = [];

  for (const relativePath of CANDIDATES[key] ?? []) {
    searched.push(relativePath);
    const absolute = join(__dirname, "..", relativePath);
    if (existsSync(absolute))
      return {
        path: absolute,
        source: "bundled",
        needsPython: SCRIPT_PAYLOADS.has(relativePath),
        searched,
      };
  }

  // The zipapp fallback needs a POSIX kernel and python3; never usable on Windows.
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

  // Unknown payload: assume it may be a zipapp (e.g. a pip-installed yt-dlp on Termux) and let
  // the ENOEXEC retry in runYtDlp route it through the interpreter.
  return { path: PATH_FALLBACK, source: "path", needsPython: false, searched };
}

/** Backwards-compatible accessor: just the command to execute. */
export function getBinaryPath(): string {
  return resolveBinary().path;
}

function requiresPython(target: string): boolean {
  return NEEDS_PYTHON.has(target);
}

function missingBinaryMessage(resolved: ResolvedBinary): string {
  const key = getTargetKey();
  const hint =
    getPlatform() === "android"
      ? "On Termux install Python first: `pkg install python`, then `pip install -U yt-dlp`."
      : "Install yt-dlp first, e.g. `pip install -U yt-dlp`, or put `yt-dlp` on your PATH.";
  const pythonNote = requiresPython(key)
    ? "\n  Note: the bundled payload for this platform is a python3 zipapp, so python3 must be on PATH."
    : "";
  return (
    `Could not find a yt-dlp binary for ${key}.\n` +
    `  Searched: ${resolved.searched.join(", ")} (relative to the package root)\n` +
    `  ${hint}${pythonNote}`
  );
}

/**
 * Run the resolved payload and return its stdout, trying each Python interpreter candidate for the
 * zipapp payload so a system that only exposes `python` (or only `python3`) still works.
 * Rejects if no candidate succeeds.
 */
export async function execFileCapture(
  resolved: ResolvedBinary,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  if (!resolved.needsPython) {
    return execFileAsync(resolved.path, args, {
      maxBuffer: 1024 * 1024 * 64,
      timeout: 30_000,
      windowsHide: true,
    });
  }

  let lastError: unknown;
  for (const python of pythonCandidates()) {
    try {
      return await execFileAsync(python, [resolved.path, ...args], {
        maxBuffer: 1024 * 1024 * 64,
        timeout: 30_000,
        windowsHide: true,
      });
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
    const { stdout } = await execFileCapture(resolved, ["--version"]);
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

/** Small helper so the command/args pair can be spread into spawnOnce. */
function invoke(resolved: ResolvedBinary, args: string[]): [string, string[]] {
  const { command, args: all } = buildInvocation(resolved, args);
  return [command, all];
}

/**
 * Backwards-compatible spawn API. Prefer `runYtDlp`, which awaits the exit code and routes zipapp
 * payloads through the interpreter; this variant is kept for callers that want the ChildProcess
 * handle.
 */
export function spawnYtDlp(args: string[] = []): ReturnType<typeof spawn> {
  const { command, args: all } = buildInvocation(resolveBinary(), args);
  return spawn(command, all, {
    stdio: ["inherit", "pipe", "pipe"],
    windowsHide: true,
  });
}
