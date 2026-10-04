# npm binary distribution: decision and plan

**Status:** implemented. `fix/npm-packaging-and-binaries` was merged first so the unblocking fix was
not held up; the split then landed as its own change. Seven sub-packages ship today — see
[Deviations from the original plan](#deviations-from-the-original-plan) for the corrections.

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

`binaries/android-arm64/` was a second byte-identical copy of that same zipapp. It is gone: there is
no `android-arm64` entry in the target table, so Termux falls through to the universal fallback. See
[Deviations](#deviations-from-the-original-plan).

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
  "libc": ["glibc"],
  "files": ["yt-dlp"]
}
```

`libc` is what separates the glibc and musl builds, which `os`/`cpu` cannot: both are
`linux`/`x64`, so without it npm installs both on Alpine. Toolchains that ignore `libc` (Bun, older
npm) still install both, but `src/binary.ts` resolves by target key so the right one still runs —
only the download is larger there.

No `bin` field, deliberately: see [Deviations](#deviations-from-the-original-plan).

**Why this one.** A user on Windows x64 downloads 17 MB instead of 214 MB — a ~92% reduction — and
unrelated platforms are never fetched at all. It also composes with the existing resolution order:
`src/binary.ts` already prefers a bundled binary and falls back to `PATH`, so losing a sub-package
degrades to the system `yt-dlp` rather than failing. npm handles the platform matching, so no
runtime platform sniffing is added.

**Costs.** Seven more packages to version and publish; they must be released in lockstep with the
wrapper, and a version skew means a missing or stale binary. `optionalDependencies` must never be a
hard `dependencies` entry, or installs fail outright when one platform's package is unavailable.

The skew risk is mitigated structurally rather than by convention: sub-package versions are derived
from the wrapper's `package.json` version, never from the yt-dlp tag, and `optionalDependencies` pins
them exactly. A wrapper cannot reference a sub-package version that was never published, because
both come from one version number. `scripts/verify-package.mjs` fails on any disagreement.

Still outstanding: the publish script that releases all eight packages in order (plan step 6). Until
that exists, release order is a manual step and the most likely remaining way to get this wrong.

### 2. Download the matching binary in `postinstall`

Ship no binaries; `postinstall` fetches the asset for the host and verifies it against upstream's
`SHA2-256SUMS`. Smallest tarball (~40 KB), and users only ever download their own binary.

**Rejected:** requires network at install time, breaks offline and air-gapped installs, and npm
blocked `postinstall` by default in npm 12 unless the consumer opts in via `allowScripts`. It also
means no integrity guarantee beyond the checksum we re-verify ourselves.

### 3. Leave it as one package (**current behaviour**)

**Rejected:** 214 MB per install is a hard adoption blocker and an upgrade tax, for no benefit over
option 1.

## What was implemented

| Plan step | State |
| --- | --- |
| 1. Extract the shared asset table and checksum logic | done — `src/binary-targets.ts` (one table) + `scripts/binary-download.ts` (download/verify), both used by `build-binaries.ts` and the new `build-binary-packages.ts` |
| 2. Publish the sub-packages | **not done** — still needs a first publish |
| 3. Convert `optionalDependencies`, keep only `binaries/any` | done |
| 4. Resolve sub-packages from `src/binary.ts` | done — sibling tree first, then `require.resolve` into the sub-package, then the zipapp, then `PATH` |
| 5. Verify each sub-package's `os`/`cpu` against its real binary | done, plus payload-vs-`binaries/` hash agreement, cross-package duplicate detection, per-package tarball contents, and version-skew checks (49 → 63 checks) |
| 6. Publish script releasing all packages in order | **not done** — the remaining gap |

## Deviations from the original plan

Three things changed while implementing it:

**Seven sub-packages, not eight.** The native targets are seven; `any` stays in the main package,
so it is not a sub-package. The original count of "eight" counted `any` anyway.

**No `bin` field.** The draft manifest had `"bin": { "yt-dlp": "./yt-dlp" }`. That would put a
second `yt-dlp` on the consumer's `PATH` from a package they never asked for, able to shadow a
system yt-dlp — and it collides with the wrapper's own `yt-dlp-cli`. These packages are payloads,
reached only through the wrapper's resolution order, so they expose no entrypoint.
`verify-package.mjs` asserts `bin` stays absent.

**No `android-arm64` directory.** It held a byte-identical second copy of the `any` zipapp, so
removing it deleted a 2.9 MB duplicate and made `EXPECTED_DUPLICATE_PAIRS` empty — which in turn
means *any* duplicate hash is now a failure. Previously that allowlist would have hidden the real
bug, where one asset was copied into every platform directory.

## Invariants to preserve

* Resolution order stays `bundled -> universal zipapp -> PATH`, and the PATH fallback must keep
  working — a missing or skipped sub-package must never be fatal.
* The `any` zipapp stays in the main package: it is what Android/Termux relies on.
* The publish gate keeps asserting that each binary's real architecture matches its label. That
  check is what caught the original duplicate-asset bug and must not be lost in the split.
* Keep `yt-dlp` version and the upstream release tag in lockstep, pinned, never `latest`.
* Sub-package versions come from the wrapper's `package.json`, not the yt-dlp tag. The two schemes
  differ (`2026.8.21` vs `2026.08.19`); conflating them is how a wrapper ends up pinning an optional
  dependency that resolves to a stale or nonexistent binary.

## Known limitation

The wrapper's own `cpu` is `["x64", "arm64", "ia32"]`. On a 32-bit ARM Linux host (armv7) npm
refuses to install `@involvex/yt-dlp` outright, even though the `any` zipapp would work there with
`python3`. This predates the split and is unchanged by it, but it is worth knowing: the zipapp
fallback is reachable on Android and on unsupported `os` values, not on unsupported `cpu` values.
Removing the restriction is a behaviour change for armv7 users and belongs in its own decision.

## Verifying

```sh
bun run build:bin      # fetch + verify the binaries/ tree
bun run build:binpkg   # stage the sub-packages under build/binary-packages/
bun run typecheck      # covers src/, scripts/ and test/ - see below
node scripts/verify-package.mjs
```

`tsconfig.json` has `rootDir: ./src` and `include: ["src/**/*"]` because it emits into `dist/`, so
`scripts/` and `test/` were never type-checked. `tsconfig.check.json` covers them without emitting,
and `bun run typecheck` runs both. The first draft of the split shipped two `ReferenceError`-class
bugs in `build-binary-packages.ts` that only the new config caught.

`verify-package.mjs` was checked against deliberately broken staging, not just the happy path:
mislabelled `cpu`, the x64 binary staged as the arm64 package, one payload duplicated across two
packages, and a truncated staged copy. Each is caught with a specific message and a non-zero exit.