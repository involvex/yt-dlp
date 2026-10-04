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
  /** Absolute path of the bundled directory that was selected, for error messages. */
  searched: string[];
}

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
      return { path: absolute, source: "bundled", searched };
  }

  // The zipapp fallback needs a POSIX kernel and python3; never usable on Windows.
  if (process.platform !== "win32") {
    searched.push(UNIVERSAL_FALLBACK);
    const universal = join(__dirname, "..", UNIVERSAL_FALLBACK);
    if (existsSync(universal))
      return { path: universal, source: "universal", searched };
  }

  return { path: PATH_FALLBACK, source: "path", searched };
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
    const { stdout } = await execFileAsync(resolved.path, ["--version"], {
      timeout: 30_000,
      windowsHide: true,
    });
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

function spawnOnce(
  command: string,
  args: string[],
): Promise<{ code: number | null; spawnError?: Error }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["inherit", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
    child.on("error", (error) => resolve({ code: null, spawnError: error }));
    child.on("close", (code) => resolve({ code }));
  });
}

/**
 * Run yt-dlp.
 *
 * If a direct spawn fails with ENOEXEC the target is a `#!`-script and this platform's execvp does
 * not implement the glibc `/bin/sh` fallback (macOS and Android/Bionic do not), so retry once
 * through a shell. Deliberately not `shell: true` in the normal path - arguments must not be
 * re-parsed by a shell.
 */
export async function runYtDlp(args: string[] = []): Promise<number> {
  const resolved = resolveBinary();

  const direct = await spawnOnce(resolved.path, args);
  if (!direct.spawnError) return direct.code ?? 0;

  const isEnoexec =
    (direct.spawnError as NodeJS.ErrnoException).code === "ENOEXEC";
  if (isEnoexec && process.platform !== "win32") {
    const quoted = [resolved.path, ...args]
      .map((a) => `'${a.replace(/'/g, `'\\''`)}'`)
      .join(" ");
    const viaShell = await spawnOnce("/bin/sh", ["-c", `exec ${quoted}`]);
    if (!viaShell.spawnError) return viaShell.code ?? 0;
  }

  const detail =
    (direct.spawnError as NodeJS.ErrnoException).code === "ENOENT"
      ? missingBinaryMessage(resolved)
      : `Failed to start ${resolved.path}: ${direct.spawnError.message}`;

  console.error(detail);
  return 1;
}

/**
 * Backwards-compatible spawn API. Prefer `runYtDlp`, which awaits the exit code and handles the
 * ENOEXEC fallback; this variant is kept for callers that just want the ChildProcess handle.
 */
export function spawnYtDlp(args: string[] = []): ReturnType<typeof spawn> {
  return spawn(resolveBinary().path, args, {
    stdio: ["inherit", "pipe", "pipe"],
    windowsHide: true,
  });
}
