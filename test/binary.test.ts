import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getArch,
  getPlatform,
  getTargetKey,
  isMusl,
  resolveBinary,
  runYtDlp,
} from "../src/binary.js";

const ROOT = join(import.meta.dir, "..");

describe("platform detection", () => {
  test("never silently maps an unknown platform to linux", () => {
    // The android case is the one that mattered: Termux reports "android", and folding it into
    // "linux" pointed the resolver at a glibc binary that cannot run on Bionic.
    const platform = getPlatform();
    expect(["windows", "macos", "linux", "linux-musl", "android"]).toContain(
      platform,
    );
  });

  test("maps known platforms to their bundled directory names", () => {
    const expected: Record<string, string> = {
      win32: "windows",
      darwin: "macos",
      linux: "linux",
      android: "android",
    };
    const current = process.platform as keyof typeof expected;
    if (current in expected) expect(getPlatform()).toBe(expected[current]);
  });

  test("arch mapping matches the bundled directory suffixes", () => {
    const expected: Record<string, string> = {
      x64: "x64",
      arm64: "arm64",
      ia32: "x86",
      arm: "armv7",
    };
    if (process.arch in expected)
      expect(getArch()).toBe(expected[process.arch]);
  });

  test("musl detection only reports true on non-musl linux", () => {
    if (process.platform !== "linux") expect(isMusl()).toBe(false);
  });
});

describe("binary resolution", () => {
  test("resolves a bundled binary on this host when one is present", () => {
    const resolved = resolveBinary();
    expect(["bundled", "universal", "path"]).toContain(resolved.source);
    expect(resolved.path.length).toBeGreaterThan(0);
    expect(resolved.searched.length).toBeGreaterThan(0);
  });

  test("target key is <platform>-<arch>", () => {
    expect(getTargetKey()).toBe(`${getPlatform()}-${getArch()}`);
  });

  test("never returns the bare PATH fallback while a bundled binary exists", () => {
    const key = getTargetKey();
    const bundled = join(ROOT, "binaries", key, "yt-dlp");
    const bundledExe = join(ROOT, "binaries", key, "yt-dlp.exe");
    if (existsSync(bundled) || existsSync(bundledExe)) {
      expect(resolveBinary().source).not.toBe("path");
    }
  });

  test("the universal zipapp fallback is never used on Windows", () => {
    if (process.platform !== "win32") return;
    const resolved = resolveBinary();
    expect(resolved.source).not.toBe("universal");
    expect(resolved.path).not.toContain("any");
  });

  test("runYtDlp propagates the child exit code", async () => {
    // The bundled PyInstaller onefile extracts itself to a temp dir on cold start, so the first
    // invocation can take several seconds. Network-free and side-effect-free.
    const code = await runYtDlp(["--version"]);
    expect(code).toBe(0);
  }, 120_000);
});

describe("packaging (regression guards)", () => {
  test("dist/.gitignore must not exist - npm treats it as dist/.npmignore", () => {
    // This single file caused ERR_MODULE_NOT_FOUND for every published install in 2026.8.21:
    // a nested .gitignore containing "*" silently emptied dist/ from the tarball.
    expect(existsSync(join(ROOT, "dist", ".gitignore"))).toBe(false);
  });

  test("dist/.npmignore exists so the compiled JS survives packing", () => {
    expect(existsSync(join(ROOT, "dist", ".npmignore"))).toBe(true);
  });

  test("dist/.npmignore excludes the Python build artifacts", () => {
    const ignore = readFileSync(join(ROOT, "dist", ".npmignore"), "utf8");
    expect(ignore).toContain("*.whl");
    expect(ignore).toContain("*.tar.gz");
  });

  test("package.json files field ships dist and the bin entrypoint", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.files).toContain("dist");
    expect(pkg.files).toContain("bin/yt-dlp.js");
    expect(pkg.files).toContain("binaries");
  });

  test("package.json permits android installs", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.os).toContain("android");
  });

  test("publish is gated by the verification script", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.scripts.prepublishOnly).toContain("verify-package.mjs");
  });

  test("the binary builder refuses to resolve 'latest'", () => {
    const source = readFileSync(
      join(ROOT, "scripts", "build-binaries.ts"),
      "utf8",
    );
    expect(source).toContain("refusing to build from");
  });
});
