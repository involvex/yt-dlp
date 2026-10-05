/**
 * Single source of truth for which yt-dlp payload each platform gets.
 *
 * This module is deliberately dependency-free and free of I/O so that three consumers can share it
 * without inheriting each other's concerns:
 *
 *   - `src/binary.ts`        runtime resolution (needs the directory and sub-package name)
 *   - `scripts/build-binaries.ts`        downloads (needs the upstream asset name)
 *   - `scripts/build-binary-packages.ts` packaging (needs npm `os`/`cpu`/`libc`)
 *
 * The bug this table exists to prevent: the downloader once used a single URL for every target, so
 * five platform directories held byte-identical copies of the python zipapp. Nothing about that was
 * caught by reading the code - only by checking each binary's real architecture against its label.
 * Keeping one row per target means a wrong `asset`/`cpu` pairing is visible in one place and is
 * asserted by `scripts/verify-package.mjs`.
 */

/** Pinned by default so published contents are reproducible. Override with `YT_DLP_VERSION`. */
export const DEFAULT_VERSION = "2026.08.19";

export const UPSTREAM_REPO = "yt-dlp/yt-dlp";

export const MAIN_PACKAGE = "@involvex/yt-dlp";

/** Sub-packages are `<prefix><dir>`, so the directory name is also the package's identity. */
export const BINARY_PACKAGE_PREFIX = "@involvex/yt-dlp-binary-";

export interface BinaryTarget {
  /**
   * Directory under `binaries/`, and the suffix of the sub-package name.
   *
   * This is also the last segment `verify-package.mjs` uses to decide which architecture the
   * payload must actually be, so it must name the architecture rather than the distribution.
   */
  readonly dir: string;

  /** Upstream release asset filename, resolved against a pinned yt-dlp tag. */
  readonly asset: string;

  /** Filename as stored in `binaries/<dir>/` and in the sub-package. */
  readonly filename: string;

  /**
   * True when the payload is the upstream pure-Python zipapp rather than a native executable.
   *
   * A zipapp is a `#!/usr/bin/env python3` script, so it must be handed to an interpreter instead
   * of spawned directly, and it is the only viable payload for Android/Termux because upstream
   * publishes no Bionic build.
   */
  readonly script: boolean;

  /**
   * npm `os` / `cpu` / `libc` for the sub-package, or null when the payload stays in the main
   * package.
   *
   * The `any` zipapp stays put because it is arch-independent, is what Android/Termux and
   * unsupported architectures (armv7) fall back to, and costs 2.9 MB.
   */
  readonly os: readonly string[] | null;
  readonly cpu: readonly string[] | null;
  readonly libc: readonly string[] | null;
}

export const TARGETS: readonly BinaryTarget[] = Object.freeze([
  {
    dir: "windows-x64",
    asset: "yt-dlp.exe",
    filename: "yt-dlp.exe",
    script: false,
    os: ["win32"],
    cpu: ["x64"],
    libc: null,
  },
  {
    // Node reports 32-bit x86 as `ia32`; upstream names the asset `_x86`. Only the npm field differs.
    dir: "windows-x86",
    asset: "yt-dlp_x86.exe",
    filename: "yt-dlp.exe",
    script: false,
    os: ["win32"],
    cpu: ["ia32"],
    libc: null,
  },
  {
    dir: "windows-arm64",
    asset: "yt-dlp_arm64.exe",
    filename: "yt-dlp.exe",
    script: false,
    os: ["win32"],
    cpu: ["arm64"],
    libc: null,
  },
  {
    dir: "linux-x64",
    asset: "yt-dlp_linux",
    filename: "yt-dlp",
    script: false,
    os: ["linux"],
    cpu: ["x64"],
    libc: ["glibc"],
  },
  {
    dir: "linux-arm64",
    asset: "yt-dlp_linux_aarch64",
    filename: "yt-dlp",
    script: false,
    os: ["linux"],
    cpu: ["arm64"],
    libc: ["glibc"],
  },
  {
    // Alpine and other musl distributions have no glibc and cannot load yt-dlp_linux.
    // `libc` lets npm 11+ skip the glibc build there. Toolchains that ignore `libc` install both
    // and `src/binary.ts` still picks correctly by target key - only the download is larger.
    dir: "linux-musl-x64",
    asset: "yt-dlp_musllinux",
    filename: "yt-dlp",
    script: false,
    os: ["linux"],
    cpu: ["x64"],
    libc: ["musl"],
  },
  {
    // One Mach-O fat binary covers both macOS architectures, so it is stored and shipped once
    // rather than duplicated per arch.
    dir: "macos-universal2",
    asset: "yt-dlp_macos",
    filename: "yt-dlp",
    script: false,
    os: ["darwin"],
    cpu: ["x64", "arm64"],
    libc: null,
  },
  {
    // Arch-independent zipapp: stays in the main package as the universal fallback.
    dir: "any",
    asset: "yt-dlp",
    filename: "yt-dlp",
    script: true,
    os: null,
    cpu: null,
    libc: null,
  },
]);

const BY_DIR: ReadonlyMap<string, BinaryTarget> = new Map(
  TARGETS.map((t) => [t.dir, t]),
);

export function targetForDir(dir: string): BinaryTarget | undefined {
  return BY_DIR.get(dir);
}

/** npm package name for a target's payload, or null when it stays in the main package. */
export function packageNameFor(dir: string): string | null {
  const target = BY_DIR.get(dir);
  if (!target || target.os === null) return null;
  return BINARY_PACKAGE_PREFIX + dir;
}

/** Every sub-package that must be published, in a stable order. */
export function subPackageNames(): string[] {
  return TARGETS.map((t) => packageNameFor(t.dir))
    .filter((n): n is string => n !== null)
    .sort();
}

/**
 * Filesystem-safe staging directory name for a package.
 *
 * `join(outDir, "@involvex/yt-dlp-binary-linux-x64")` would nest the package under an `@involvex`
 * directory, which npm does not care about but every local tool - verify, tests that fake an
 * install, a human looking in the tree - has to know about. The package's real name lives in its
 * manifest, so the directory only needs to be unique and sortable.
 */
export function packageDirName(name: string): string {
  return name.replace(/^@/, "").replace(/\//g, "-");
}

/**
 * Runtime resolution key (`<platform>-<arch>`) -> payload directory.
 *
 * `macos-x64` and `macos-arm64` deliberately share `macos-universal2`. There is deliberately no
 * `android-arm64` entry: Termux is served by the `any` zipapp through the universal fallback, which
 * is the same payload and keeps a second identical copy out of the tree.
 */
export const TARGET_KEY_DIRS: Readonly<Record<string, string>> = Object.freeze({
  "windows-x64": "windows-x64",
  "windows-x86": "windows-x86",
  "windows-arm64": "windows-arm64",
  "linux-x64": "linux-x64",
  "linux-arm64": "linux-arm64",
  "linux-musl-x64": "linux-musl-x64",
  "macos-x64": "macos-universal2",
  "macos-arm64": "macos-universal2",
});

/** Directory holding the arch-independent zipapp that ships in the main package. */
export const UNIVERSAL_DIR = "any";

/**
 * `package.json` for one sub-package.
 *
 * `version` is the *wrapper's* version, deliberately not the yt-dlp tag. The two differ
 * (`2026.8.21` vs `2026.08.19`), and letting them drift apart is how a wrapper ends up pinning an
 * optional dependency that resolves to a stale - or nonexistent - binary. Deriving the sub-package
 * version from the wrapper makes that skew structurally impossible: `optionalDependencies` can pin
 * an exact version that is guaranteed to exist, because both are published from one version.
 *
 * The yt-dlp release the payload came from is recorded separately, in the description and in
 * `build/binary-packages/index.json`.
 *
 * Note the absence of a `bin` field, which the original plan sketched. Declaring one would put a
 * second `yt-dlp` on the consumer's PATH from a package they never asked for, able to shadow a
 * system yt-dlp; the wrapper already provides `yt-dlp-cli`. These packages are payloads, not
 * entrypoints, and are only ever reached through the wrapper's resolution order.
 */
export function subPackageManifest(
  target: BinaryTarget,
  options: { version: string; ytDlpVersion: string },
): Record<string, unknown> {
  const name = packageNameFor(target.dir);
  if (!name) throw new Error(`${target.dir} has no sub-package (os is null)`);

  const manifest: Record<string, unknown> = {
    name,
    version: options.version,
    description:
      `yt-dlp ${options.ytDlpVersion} binary for ${target.dir}. Installed automatically as an ` +
      `optional dependency of ${MAIN_PACKAGE}; not intended to be depended on directly.`,
    license: "Unlicense",
    homepage: `https://github.com/involvex/yt-dlp#readme`,
    repository: {
      type: "git",
      url: "https://github.com/involvex/yt-dlp",
    },
    // Not a field npm knows, so it is inert on install, but it records which upstream release the
    // payload came from. `build/binary-packages/index.json` is rebuilt by scanning the staging
    // directories, so this is where provenance survives a partial `--only` rebuild.
    ytDlpVersion: options.ytDlpVersion,
    // Only the payload, so npm does not also ship this manifest's siblings.
    files: [target.filename],
    os: [...target.os!],
    cpu: [...target.cpu!],
  };
  if (target.libc) manifest.libc = [...target.libc];
  return manifest;
}
