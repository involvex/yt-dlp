import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "bun:test";

import {
  getPlatform,
  getTargetKey,
  resolveBinary,
  resolveSubPackageBinary,
} from "../src/binary.js";
import {
  BINARY_PACKAGE_PREFIX,
  TARGETS,
  TARGET_KEY_DIRS,
  UNIVERSAL_DIR,
  packageDirName,
  packageNameFor,
  subPackageManifest,
  subPackageNames,
  targetForDir,
} from "../src/binary-targets.js";
import { parseCommonArgs } from "../scripts/binary-download.js";

const ROOT = join(import.meta.dir, "..");

/** Temporary fake installs, removed at the end of the file. */
const temporaries: string[] = [];
afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

/**
 * Build a throwaway `node_modules` containing one installed sub-package.
 *
 * `resolveSubPackageBinary` takes the base directory so this can be faked; the alternative is a
 * real `npm install` of 200 MB of binaries in a unit test.
 */
function fakeInstall(
  packageName: string,
  files: Record<string, string>,
): string {
  const base = mkdtempSync(join(tmpdir(), "yt-dlp-subpkg-"));
  temporaries.push(base);
  const packageDir = join(base, "node_modules", ...packageName.split("/"));
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, "package.json"),
    JSON.stringify({ name: packageName, version: "0.0.0-test" }),
  );
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(packageDir, name), content);
  }
  return base;
}

/** Any target that ships in its own sub-package, for tests that need one. */
const NATIVE = TARGETS.filter((t) => packageNameFor(t.dir) !== null);

describe("binary target table", () => {
  test("every sub-package name is unique", () => {
    const names = subPackageNames();
    expect(new Set(names).size).toBe(names.length);
  });

  test("the prefix and the directory name fully determine the package name", () => {
    // The whole design leans on this: verify-package.mjs recovers the `binaries/<dir>` path from
    // the package name alone, so a scheme that did not hold would break that cross-check.
    for (const target of NATIVE) {
      const name = packageNameFor(target.dir);
      expect(name).toBe(BINARY_PACKAGE_PREFIX + target.dir);
      expect(name!.replace(BINARY_PACKAGE_PREFIX, "")).toBe(target.dir);
    }
  });

  test("staging directory names are unique and filesystem safe", () => {
    const dirs = subPackageNames().map(packageDirName);
    expect(new Set(dirs).size).toBe(dirs.length);
    for (const dir of dirs) {
      expect(dir).not.toContain("@");
      expect(dir).not.toContain("/");
      expect(dir).not.toContain("\\");
      expect(dir).not.toContain(":");
    }
  });

  test("a target has a sub-package exactly when it declares os and cpu", () => {
    // These three must agree. If a target declared `os` but had no sub-package, the platform would
    // silently have no binary; if it had a sub-package without `cpu`, npm would install every
    // platform's package everywhere.
    for (const target of TARGETS) {
      const hasPackage = packageNameFor(target.dir) !== null;
      expect(hasPackage).toBe(target.os !== null && target.cpu !== null);
      if (hasPackage) {
        expect(target.os!.length).toBeGreaterThan(0);
        expect(target.cpu!.length).toBeGreaterThan(0);
      } else {
        expect(target.os).toBeNull();
        expect(target.cpu).toBeNull();
      }
    }
  });

  test("the only target without a sub-package is the arch-independent zipapp", () => {
    const staying = TARGETS.filter((t) => packageNameFor(t.dir) === null);
    expect(staying.map((t) => t.dir)).toEqual([UNIVERSAL_DIR]);
    expect(staying[0].script).toBe(true);
  });

  test("no two targets share an asset unless they are the zipapp", () => {
    // Two native targets sharing an asset is how one binary ended up in every platform directory.
    const assets = new Map<string, string[]>();
    for (const target of TARGETS) {
      const seen = assets.get(target.asset) ?? [];
      seen.push(target.dir);
      assets.set(target.asset, seen);
    }
    for (const [asset, dirs] of assets) {
      if (dirs.length > 1) expect(targetForDir(dirs[0])!.script).toBe(true);
    }
  });

  test("every resolution key points at a real, native target", () => {
    for (const [key, dir] of Object.entries(TARGET_KEY_DIRS)) {
      const target = targetForDir(dir);
      expect(target).toBeDefined();
      expect(target!.script).toBe(false);
      expect(packageNameFor(dir)).not.toBeNull();
      expect(key.startsWith(dir.split("-")[0])).toBe(true);
    }
  });

  test("both macOS architectures resolve to the one universal2 payload", () => {
    expect(TARGET_KEY_DIRS["macos-x64"]).toBe("macos-universal2");
    expect(TARGET_KEY_DIRS["macos-arm64"]).toBe("macos-universal2");
    expect(packageNameFor("macos-universal2")).not.toBeNull();
  });

  test("there is deliberately no android key, so Termux falls back to the zipapp", () => {
    // Upstream publishes no Bionic build. An `android-arm64` entry pointing at the same zipapp
    // would only restore the byte-identical duplicate this split removed.
    expect(Object.keys(TARGET_KEY_DIRS)).not.toContain("android-arm64");
    expect(getPlatform()).not.toBe("android");
  });

  test("musl and glibc targets are distinguishable only via libc", () => {
    // npm's os/cpu cannot tell them apart, so both would install on Alpine unless `libc` is set.
    // Toolchains that ignore `libc` install both and src/binary.ts still picks correctly.
    const glibc = targetForDir("linux-x64")!;
    const musl = targetForDir("linux-musl-x64")!;
    expect(glibc.os).toEqual(musl.os);
    expect(glibc.cpu).toEqual(musl.cpu);
    expect(glibc.libc).toEqual(["glibc"]);
    expect(musl.libc).toEqual(["musl"]);
  });

  test("the manifest carries the wrapper version, not the yt-dlp tag", () => {
    // The two schemes differ (2026.8.21 vs 2026.08.19). Deriving the version from the wrapper is
    // what makes optionalDependencies able to pin an exact version that is guaranteed to exist.
    const target = NATIVE[0];
    const manifest = subPackageManifest(target, {
      version: "9.9.9",
      ytDlpVersion: "2026.08.19",
    });
    expect(manifest.version).toBe("9.9.9");
    expect(manifest.ytDlpVersion).toBe("2026.08.19");
    expect(manifest.name).toBe(packageNameFor(target.dir));
  });

  test("the manifest declares no bin, so it cannot shadow a system yt-dlp", () => {
    for (const target of NATIVE) {
      const manifest = subPackageManifest(target, {
        version: "0.0.0",
        ytDlpVersion: "0.0.0",
      });
      expect(manifest.bin).toBeUndefined();
      expect(manifest.files).toEqual([target.filename]);
    }
  });

  test("asking for a manifest for a payload that stays in the main package throws", () => {
    expect(() =>
      subPackageManifest(targetForDir(UNIVERSAL_DIR)!, {
        version: "0.0.0",
        ytDlpVersion: "0.0.0",
      }),
    ).toThrow();
  });
});

describe("resolving a payload from an installed sub-package", () => {
  test("finds the payload in a fake install", () => {
    const target = targetForDir("linux-x64")!;
    const name = packageNameFor(target.dir)!;
    const base = fakeInstall(name, {
      [target.filename]: "#!/usr/bin/env python3\n",
    });
    expect(resolveSubPackageBinary(target.dir, base)).toBe(
      join(base, "node_modules", ...name.split("/"), target.filename),
    );
  });

  test("returns null when the package is not installed for this platform", () => {
    // The normal case on every platform but one: npm skipped the optional dependency.
    const base = mkdtempSync(join(tmpdir(), "yt-dlp-subpkg-empty-"));
    temporaries.push(base);
    expect(resolveSubPackageBinary("linux-arm64", base)).toBeNull();
  });

  test("returns null when the manifest is present but the payload is missing", () => {
    // A truncated publish or a botched install would otherwise produce a path that fails at
    // spawn time with an opaque ENOENT rather than falling back.
    const name = packageNameFor("linux-x64")!;
    const base = fakeInstall(name, {});
    expect(resolveSubPackageBinary("linux-x64", base)).toBeNull();
  });

  test("returns null for the zipapp, which ships in the main package", () => {
    const base = fakeInstall(packageNameFor("linux-x64")!, {
      "yt-dlp": "#!/usr/bin/env python3\n",
    });
    expect(resolveSubPackageBinary(UNIVERSAL_DIR, base)).toBeNull();
  });

  test("returns null for a directory that is not a target at all", () => {
    const base = mkdtempSync(join(tmpdir(), "yt-dlp-subpkg-unknown-"));
    temporaries.push(base);
    expect(resolveSubPackageBinary("plan9-x64", base)).toBeNull();
  });

  test("resolveBinary reports the sub-package as searched when no sibling tree exists", () => {
    // `binaries/` is not published, so for an installed consumer the sub-package lookup is the
    // normal path and it must appear in `searched` - otherwise a failure message would list only
    // the main package's zipapp and hide what was actually tried.
    const resolved = resolveBinary();
    const dir = TARGET_KEY_DIRS[getTargetKey()];
    if (dir && !resolved.path.includes(join("binaries", dir))) {
      const name = packageNameFor(dir)!;
      expect(resolved.searched.some((p) => p.includes(name))).toBe(true);
    }
  });
});

describe("wrapper manifest wiring", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

  test("every native target is declared as an optional dependency", () => {
    expect(Object.keys(pkg.optionalDependencies).sort()).toEqual(
      subPackageNames(),
    );
  });

  test("optional dependencies are pinned to the wrapper version exactly", () => {
    // A range would let npm resolve a sub-package from a different wrapper release and silently
    // pair a new wrapper with a stale binary.
    for (const [name, range] of Object.entries(pkg.optionalDependencies)) {
      expect(range).toBe(pkg.version);
      expect(name.startsWith(BINARY_PACKAGE_PREFIX)).toBe(true);
    }
  });

  test("--only with a missing or flag-shaped value is rejected, not treated as 'all'", () => {
    // `only: []` means "every target", and a full run deletes the staging tree and re-downloads
    // ~200 MB. A typo must not be able to trigger that.
    for (const argv of [
      ["--only"],
      ["--only", "--force"],
      ["--only="],
      ["--only", ""],
    ]) {
      expect(() => parseCommonArgs(argv)).toThrow(/--only/);
    }
    // A real list still parses.
    expect(
      parseCommonArgs(["--only", "linux-x64,macos-universal2"]).only,
    ).toEqual(["linux-x64", "macos-universal2"]);
  });

  test("there are no hard dependencies", () => {
    // A hard dependency would make install fail outright wherever a platform's package is
    // unavailable - e.g. a new architecture before its binary is published.
    expect(pkg.dependencies).toEqual({});
  });

  test("the wrapper ships the zipapp but no native payload", () => {
    // `binaries/any` rather than `binaries`: a bare "binaries" entry would ship all ~200 MB of
    // native payloads again and silently undo the split.
    expect(pkg.files).toContain("binaries/any");
    expect(pkg.files).not.toContain("binaries");

    // `files` names a path, not a glob, so nothing under binaries/other-platform can leak in.
    expect(
      pkg.files.some(
        (f: string) => f.startsWith("binaries/") && f !== "binaries/any",
      ),
    ).toBe(false);
  });

  test("prepublishOnly builds the sub-packages before verifying them", () => {
    // Verifying staged packages that prepublishOnly never built would check nothing at all.
    expect(pkg.scripts.prepublishOnly).toContain("build:binpkg");
    expect(pkg.scripts.prepublishOnly).toContain("verify-package.mjs");
  });

  test("a typecheck script exists that covers scripts/ and test/", () => {
    // tsconfig.json has rootDir=./src and only includes src/, so without a second config the build
    // scripts and the test suite are never type-checked at all.
    expect(pkg.scripts.typecheck).toContain("tsconfig.check.json");
    const check = JSON.parse(
      readFileSync(join(ROOT, "tsconfig.check.json"), "utf8"),
    );
    expect(check.include).toContain("scripts/**/*");
    expect(check.include).toContain("test/**/*.ts");
    expect(check.compilerOptions.noEmit).toBe(true);
  });
});
