import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOptionArgs, OPTION_FLAGS } from "../src/options.js";
import { getBinaryPath } from "../src/binary.js";

const execFileAsync = promisify(execFile);

/** The bundled binary, or null when this checkout has none (binaries/ is gitignored). */
function bundledBinary(): string | null {
  const path = getBinaryPath();
  return path.includes("/") || path.includes("\\")
    ? existsSync(path)
      ? path
      : null
    : null;
}

/**
 * Ask the real yt-dlp binary whether it recognises a flag, rather than trusting the table that
 * produced it. This is the whole point: the bug being fixed was a mapping that disagreed with
 * yt-dlp, so a test asserting the mapping agrees with itself would have passed.
 *
 * `--simulate` keeps it network-free, and `probe:invalid` is an unsupported URL scheme so yt-dlp
 * bails out at request dispatch instead of attempting extraction. Option parsing happens before
 * either, so an unrecognised flag is still reported. The flags are probed with a value argument,
 * because options that take one (e.g. --format) consume the next token and would otherwise swallow
 * the URL.
 *
 * Runs in a throwaway cwd: some flags take a FILE argument and yt-dlp creates it eagerly, so
 * `--cookies probe-value` would otherwise drop a cookie file into the repository working tree.
 */
async function acceptsFlag(binary: string, flag: string): Promise<boolean> {
  const cwd = mkdtempSync(join(tmpdir(), "yt-dlp-flagprobe-"));
  try {
    await execFileAsync(
      binary,
      [flag, "probe-value", "probe:invalid", "--simulate"],
      { timeout: 30_000, windowsHide: true, cwd },
    );
    return true;
  } catch (error) {
    // A non-zero exit is fine - only an unrecognised option matters here.
    const stderr = String((error as { stderr?: string }).stderr ?? "");
    return !stderr.includes("no such option");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("every mapped flag is accepted by the real yt-dlp parser", async () => {
  const binary = bundledBinary();
  if (!binary) {
    console.log(
      "skipping: no bundled binary (run `bun run build:bin` to exercise this)",
    );
    return;
  }

  const flags = [...new Set(Object.values(OPTION_FLAGS))];
  const rejected: string[] = [];

  // Probed concurrently in small batches: each spawn pays the PyInstaller one-file cold start
  // (~2.5 s warm), so serial probing of 31 flags dominates the whole test run.
  const CONCURRENCY = 6;
  for (let i = 0; i < flags.length; i += CONCURRENCY) {
    const batch = flags.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(
        async (flag) => [flag, await acceptsFlag(binary, flag)] as const,
      ),
    );
    for (const [flag, ok] of results) if (!ok) rejected.push(flag);
  }

  expect(rejected).toEqual([]);
}, 300_000);

test("no mapped flag relies on optparse prefix abbreviation", async () => {
  // --write-sub, --write-auto-sub and --sub-lang used to "work" only because Python's optparse
  // accepts any unambiguous prefix of a long option. The moment yt-dlp adds a colliding option
  // they break with no change on our side, so the table must use the exact spelling.
  const abbreviations = ["--write-sub", "--write-auto-sub", "--sub-lang"];
  for (const abbreviation of abbreviations) {
    expect(Object.values(OPTION_FLAGS)).not.toContain(abbreviation);
  }
}, 60_000);

test("options map to the exact yt-dlp flag, not a guessed kebab-case one", () => {
  // The four documented options that previously produced flags yt-dlp rejects outright.
  expect(buildOptionArgs({ outDir: "/tmp/x" })).toEqual(["--paths", "/tmp/x"]);
  expect(buildOptionArgs({ subLang: "en" })).toEqual(["--sub-langs", "en"]);
  expect(buildOptionArgs({ writeSub: true })).toEqual(["--write-subs"]);
  expect(buildOptionArgs({ writeAutoSub: true })).toEqual([
    "--write-auto-subs",
  ]);
  expect(buildOptionArgs({ subtitles: true })).toEqual(["--write-subs"]);
});

test("dropped options fail loudly with the reason", () => {
  // `quality` and `url` produced --quality / --url, neither of which exists. A caller who was
  // relying on them was getting a runtime failure from yt-dlp; now they get a local explanation.
  expect(() => buildOptionArgs({ quality: "best" })).toThrow(/no --quality/);
  expect(() => buildOptionArgs({ url: "https://example.com" })).toThrow(
    /passed positionally/,
  );
});

test("an unrecognised option throws instead of inventing a flag", () => {
  // This is the silent-failure fix: previously any key became a plausible flag, so a typo became
  // an opaque `no such option` from yt-dlp at run time.
  expect(() => buildOptionArgs({ formt: "best" })).toThrow(
    /Unknown yt-dlp option/,
  );
  expect(() => buildOptionArgs({ formt: "best" })).toThrow(/extraArgs/);
});

test("boolean options emit their flag only when true", () => {
  expect(buildOptionArgs({ playlist: true })).toEqual(["--yes-playlist"]);
  expect(buildOptionArgs({ playlist: false })).toEqual([]);
  expect(buildOptionArgs({ noPlaylist: true })).toEqual(["--no-playlist"]);
});

test("undefined and null options are ignored", () => {
  expect(buildOptionArgs({ format: undefined, outDir: null })).toEqual([]);
});

test("extraArgs is passed through verbatim and comes last", () => {
  // Last so a caller can override a mapped option - yt-dlp honours the final occurrence.
  expect(
    buildOptionArgs({ format: "worst", extraArgs: ["--format", "best"] }),
  ).toEqual(["--format", "worst", "--format", "best"]);
  expect(buildOptionArgs({ extraArgs: ["--any-future-flag", "v"] })).toEqual([
    "--any-future-flag",
    "v",
  ]);
});

test("a malformed extraArgs is rejected", () => {
  expect(() => buildOptionArgs({ extraArgs: "nope" })).toThrow(
    /must be an array of strings/,
  );
  expect(() => buildOptionArgs({ extraArgs: [1] })).toThrow(/only strings/);
});

test("the documented option union covers every key in the mapping table", () => {
  // Keeps the public type and the runtime table from drifting apart. Reads the compiled .d.ts so it
  // catches the case where someone adds a mapping but forgets to document it, scoped to the
  // YtDlpOptions block so the other interfaces in the file cannot satisfy the check.
  const dts = readFileSync(
    join(import.meta.dir, "..", "dist", "types.d.ts"),
    "utf8",
  );
  const start = dts.indexOf("interface YtDlpOptions");
  expect(start).toBeGreaterThan(-1);
  const block = dts.slice(start, dts.indexOf("\n}", start));
  const documented = new Set(
    [...block.matchAll(/^\s+(\w+)\??:/gm)].map((match) => match[1]),
  );
  expect(documented.size).toBeGreaterThan(0);

  const undocumented = Object.keys(OPTION_FLAGS).filter(
    (key) => !documented.has(key),
  );
  expect(undocumented).toEqual([]);
});
