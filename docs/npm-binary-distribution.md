# npm binary distribution: decision and plan

**Status:** decided, not yet implemented. Implementation lands in its own commit *after*
`fix/npm-packaging-and-binaries` is merged, so the unblocking fix is not held up.

## Problem

`@involvex/yt-dlp` currently ships every platform's yt-dlp executable inside the single main
package. After the binaries were corrected to be real, architecture-matched release assets, the
tarball measured **214 MB compressed / 217 MB unpacked**.

| Package | Contents | Unpacked |
| --- | --- | --- |
| `binaries/windows-x64/yt-dlp.exe` | `yt-dlp.exe` | 17.0 MB |
| `binaries/windows-x86/yt-dlp.exe` | `yt-dlp_x86.exe` | 12.6 MB |
| `binaries/windows-arm64/yt-dlp.exe` | `yt-dlp_arm64.exe` | 20.2 MB |
| `binaries/linux-x64/yt-dlp` | `yt-dlp_linux` | 38.6 MB |
| `binaries/linux-musl-x64/yt-dlp` | `yt-dlp_musllinux` | 38.7 MB |
| `binaries/linux-arm64/yt-dlp` | `yt-dlp_linux_aarch64` | 38.3 MB |
| `binaries/macos-universal2/yt-dlp` | `yt-dlp_macos` (universal2) | 35.4 MB |
| `binaries/any/yt-dlp` | upstream `yt-dlp` (python3 zipapp) | 2.9 MB |
| `binaries/android-arm64/yt-dlp` | upstream `yt-dlp` (python3 zipapp) | 2.9 MB |

PyInstaller one-file executables barely compress — they already contain a compressed archive — so
gzipping the tarball saves almost nothing. Every consumer therefore downloads roughly 214 MB to run
one 17–39 MB binary, and pays it again on every upgrade that changes a binary.

The 2.9 MB `yt-dlp` zipapp is a separate concern: it is arch-independent, needs only `python3`, and
is what makes Android/Termux work at all. It should stay in the main package.

## Options considered

### 1. Per-platform `optionalDependencies` (**chosen**)

Publish one small package per platform and let npm install only the matching one:

```
@involvex/yt-dlp                      ~10 KB   wrapper + dist + the `any` zipapp
@involvex/yt-dlp-binary-win-x64       ~17 MB
@involvex/yt-dlp-binary-win-x86       ~13 MB
@involvex/yt-dlp-binary-win-arm64     ~20 MB
@involvex/yt-dlp-binary-linux-x64     ~39 MB
@involvex/yt-dlp-binary-linux-musl-x64~39 MB
@involvex/yt-dlp-binary-linux-arm64   ~38 MB
@involvex/yt-dlp-binary-macos-universal2 ~35 MB
```

Each sub-package declares `os` and `cpu` so npm and Bun skip the ones that cannot apply:

```json
{
  "name": "@involvex/yt-dlp-binary-linux-x64",
  "version": "2026.8.21",
  "os": ["linux"],
  "cpu": ["x64"],
  "files": ["yt-dlp"],
  "bin": { "yt-dlp": "./yt-dlp" }
}
```

**Why this one.** A user on Windows x64 downloads 17 MB instead of 214 MB — a ~92% reduction — and
unrelated platforms are never fetched at all. It also composes with the existing resolution order:
`src/binary.ts` already prefers a bundled binary and falls back to `PATH`, so losing a sub-package
degrades to the system `yt-dlp` rather than failing. npm handles the platform matching, so no
runtime platform sniffing is added.

**Costs.** Eight more packages to version and publish; they must be released in lockstep with the
wrapper, and a version skew means a missing or stale binary. Release automation becomes effectively
mandatory. `optionalDependencies` must never be a hard `dependencies` entry, or installs fail
outright when one platform's package is unavailable.

### 2. Download the matching binary in `postinstall`

Ship no binaries; `postinstall` fetches the asset for the host and verifies it against upstream's
`SHA2-256SUMS`. Smallest tarball (~40 KB), and users only ever download their own binary.

**Rejected:** requires network at install time, breaks offline and air-gapped installs, and npm
blocked `postinstall` by default in npm 12 unless the consumer opts in via `allowScripts`. It also
means no integrity guarantee beyond the checksum we re-verify ourselves.

### 3. Leave it as one package (**current behaviour**)

**Rejected:** 214 MB per install is a hard adoption blocker and an upgrade tax, for no benefit over
option 1.

## Plan

1. Add `scripts/build-binary-packages.ts` to emit one package directory per target, reusing the
   asset map and checksum verification already in `scripts/build-binaries.ts`. Extract the shared
   asset table and checksum logic so there is one source of truth.
2. Publish the eight sub-packages first, at the current version.
3. Convert the main package's `optionalDependencies` to the eight names and drop `binaries` from
   `files`, keeping only `binaries/any/yt-dlp`.
4. Teach `src/binary.ts` to also look inside `node_modules/@involvex/yt-dlp-binary-<target>/`,
   since resolution will no longer be a sibling directory. Keep the sibling path first so a local
   `bun run build:bin` tree still works.
5. Extend `scripts/verify-package.mjs` to resolve sub-packages via `require.resolve` and assert each
   one's `os`/`cpu` matches its directory, so a mislabelled platform cannot ship.
6. Add a publish script that releases all nine packages in dependency order and verifies each.

## Invariants to preserve

* Resolution order stays `bundled -> universal zipapp -> PATH`, and the PATH fallback must keep
  working — a missing or skipped sub-package must never be fatal.
* The `any` zipapp stays in the main package: it is what Android/Termux relies on.
* The publish gate keeps asserting that each binary's real architecture matches its label. That
  check is what caught the original duplicate-asset bug and must not be lost in the split.
* Keep `yt-dlp` version and the upstream release tag in lockstep, pinned, never `latest`.