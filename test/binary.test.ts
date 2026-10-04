import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildInvocation,
  execFileCapture,
  getArch,
  getPlatform,
  getTargetKey,
  isMusl,
  resolveBinary,
  runYtDlp,
  type ResolvedBinary,
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

  test("zipapp payloads are invoked through an interpreter, never a shell", () => {
    const resolved = resolveBinary();
    const { command, args } = buildInvocation(resolved, ["--version"]);
    if (resolved.needsPython) {
      // No `/bin/sh` anywhere: Android has none, so a shell-based fallback cannot work there.
      expect(command).toMatch(/python/i);
      expect(args[0]).toBe(resolved.path);
    } else {
      expect(command).toBe(resolved.path);
    }
  });

  test("the universal zipapp fallback is never used on Windows", () => {
    if (process.platform !== "win32") return;
    const resolved = resolveBinary();
    expect(resolved.source).not.toBe("universal");
    expect(resolved.path).not.toContain("any");
  });

  test("the download execution path cannot acquire a deadline", async () => {
    // Regression guard. execFileCapture is what the programmatic API's download()/getInfo() run on,
    // and those legitimately run for hours, so it must impose no timeout. A behavioural test cannot
    // prove that cheaply - any cap large enough to matter (the bug was 30 s) outlasts the test - so
    // assert the structure instead: the function takes exactly (resolved, args), leaving nowhere to
    // put a default deadline without the signature visibly changing.
    expect(execFileCapture.length).toBe(2);

    // Node itself stands in as a controllable payload, so no bundled binary is needed.
    const slow: ResolvedBinary = {
      path: process.execPath,
      source: "bundled",
      needsPython: false,
      // Annotated rather than `as const`: `as const` makes `searched` a readonly tuple, which is not
      // assignable to ResolvedBinary's mutable string[]. Benign at runtime, but it means the object
      // was not actually the type it claims to be.
      searched: [],
    };

    // And it really does let a slow child run to completion.
    const started = Date.now();
    await execFileCapture(slow, ["-e", `setTimeout(()=>{}, ${2_000})`]);
    expect(Date.now() - started).toBeGreaterThan(1_500);
  }, 30_000);

  test("runYtDlp propagates the child exit code", async () => {
    // `binaries/` is gitignored and no CI workflow builds it, so on a fresh clone there is nothing
    // to run and no yt-dlp on PATH. Skip rather than fail for contributors who have not run
    // `bun run build:bin`.
    const resolved = resolveBinary();
    if (resolved.source === "path") {
      console.log(
        "skipping: no bundled binary (run `bun run build:bin` to exercise this)",
      );
      return;
    }
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
    // `binaries/any` rather than `binaries`. The entry has to keep the zipapp in the wrapper -
    // Android/Termux and unsupported architectures have no sub-package to fall back to - while a
    // bare "binaries" would drag all ~200 MB of native payloads back in and undo the split.
    expect(pkg.files).toContain("binaries/any");
    expect(pkg.files).not.toContain("binaries");
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
    // Behavioural, not a source-grep: the refusal used to live in build-binaries.ts and asserting
    // on that file's text meant the guard silently stopped covering anything the moment the logic
    // moved. Running the real entrypoint also proves the argument is rejected before any network
    // access, which a string match cannot show.
    let stderr = "";
    let code = 0;
    try {
      execFileSync(
        process.execPath,
        ["scripts/build-binaries.ts", "--version", "latest"],
        {
          cwd: ROOT,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (error) {
      const failure = error as { status?: number; stderr?: string };
      code = failure.status ?? 0;
      stderr = failure.stderr ?? "";
    }
    expect(code).not.toBe(0);
    expect(stderr).toContain("latest");

    // Same refusal for the packaging script, which shares the version resolver.
    let packaged = 0;
    try {
      execFileSync(
        process.execPath,
        ["scripts/build-binary-packages.ts", "--version", "latest"],
        { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (error) {
      packaged = (error as { status?: number }).status ?? 0;
    }
    expect(packaged).not.toBe(0);
  });
});
