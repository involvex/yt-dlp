/**
 * Mapping from library option names to the exact yt-dlp command-line flags.
 *
 * This table exists because guessing a flag name from a JavaScript key produces silent breakage.
 * The previous implementation did:
 *
 *     `--${key.replace(/([A-Z])/g, "-$1").toLowerCase()}`
 *
 * which turned the options this library actually documented into flags yt-dlp rejects outright:
 *
 *     outDir     -> --out-dir       INVALID (the real flag is --paths)
 *     quality    -> --quality       INVALID (there is no --quality; -f best/worst covers it)
 *     subtitles  -> --subtitles     INVALID (there is no --subtitles)
 *     url        -> --url           INVALID, and the URL is positional anyway
 *
 * Three more only worked by accident, because Python's optparse accepts any *unambiguous prefix*
 * of a long option:
 *
 *     writeSub    -> --write-sub     resolves to --write-subs
 *     writeAutoSub-> --write-auto-sub resolves to --write-auto-subs
 *     subLang     -> --sub-lang      resolves to --sub-langs
 *
 * That is a trap rather than a feature: the moment yt-dlp adds an option sharing one of those
 * prefixes the abbreviation becomes ambiguous and every call breaks, with no change on our side.
 * Every flag below was verified against the bundled binary's real parser, not from documentation
 * or memory.
 */

/** Library option name -> exact yt-dlp long flag. */
export const OPTION_FLAGS: Readonly<Record<string, string>> = Object.freeze({
  // Selection and layout
  format: "--format",
  output: "--output",
  outDir: "--paths",
  mergeOutputFormat: "--merge-output-format",

  // Subtitles
  subtitles: "--write-subs",
  writeSub: "--write-subs",
  writeAutoSub: "--write-auto-subs",
  subLang: "--sub-langs",
  embedSubs: "--embed-subs",

  // Metadata and thumbnails
  writeThumbnail: "--write-thumbnail",
  embedThumbnail: "--embed-thumbnail",

  // Audio / video conversion
  extractAudio: "--extract-audio",
  audioFormat: "--audio-format",

  // Playlist handling. Both are listed because callers legitimately want either direction.
  playlist: "--yes-playlist",
  noPlaylist: "--no-playlist",

  // Authentication and request shaping
  cookies: "--cookies",
  cookiesFromBrowser: "--cookies-from-browser",
  userAgent: "--user-agent",
  referer: "--referer",
  proxy: "--proxy",
  geoBypass: "--geo-bypass",

  // Reliability and diagnostics
  retries: "--retries",
  concurrentFragments: "--concurrent-fragments",
  ignoreErrors: "--ignore-errors",
  noWarnings: "--no-warnings",
  quiet: "--quiet",
  verbose: "--verbose",
  newline: "--newline",
  noCheckCertificate: "--no-check-certificate",
});

/** Keys consumed by the library rather than translated into flags. */
const INTERNAL_KEYS: ReadonlySet<string> = new Set(["extraArgs"]);

/** Option names we deliberately dropped, with the reason - kept to make the break discoverable. */
const REMOVED_OPTIONS: Readonly<Record<string, string>> = Object.freeze({
  url: "the URL is passed positionally as the first argument; pass it to download()/getInfo()",
  quality: "yt-dlp has no --quality option; use format: 'best' or 'worst'",
});

/**
 * Translate a caller-supplied options object into yt-dlp argv.
 *
 * Unknown keys throw rather than being invented into a flag. That is the point of this function:
 * the old behaviour accepted any key and produced a plausible-looking flag, so a typo or an
 * option this wrapper does not model surfaced as an opaque `no such option` from yt-dlp at
 * execution time - or, worse, was silently ignored. `extraArgs` is the escape hatch for flags not
 * modelled here; they are passed through verbatim and never inspected.
 *
 * @throws if a key has no known yt-dlp flag, or a dropped key is used.
 */
export function buildOptionArgs(options: object = {}): string[] {
  const args: string[] = [];

  for (const [key, value] of Object.entries(
    options as Record<string, unknown>,
  )) {
    if (INTERNAL_KEYS.has(key)) continue;
    if (value === undefined || value === null) continue;

    const removed = REMOVED_OPTIONS[key];
    if (removed) {
      throw new TypeError(
        `Unknown yt-dlp option "${key}": ${removed}. ` +
          `Use extraArgs for flags this wrapper does not model.`,
      );
    }

    const flag = OPTION_FLAGS[key];
    if (!flag) {
      throw new TypeError(
        `Unknown yt-dlp option "${key}". ` +
          `Known options: ${Object.keys(OPTION_FLAGS).sort().join(", ")}. ` +
          `For anything not listed, use extraArgs, e.g. { extraArgs: ["--${key.replace(/([A-Z])/g, "-$1").toLowerCase()}"] }.`,
      );
    }

    if (typeof value === "boolean") {
      // yt-dlp's own --no-* flags are separate options and are listed as such (noPlaylist), so a
      // `false` here always means "leave it off" rather than "emit the negation".
      if (value) args.push(flag);
    } else {
      args.push(flag, String(value));
    }
  }

  // Pass-through last so a caller can override anything above (yt-dlp honours last-wins).
  const extra = (options as Record<string, unknown>).extraArgs;
  if (Array.isArray(extra)) {
    for (const arg of extra) {
      if (typeof arg !== "string") {
        throw new TypeError(
          `extraArgs must contain only strings, received ${typeof arg}`,
        );
      }
      args.push(arg);
    }
  } else if (extra !== undefined && extra !== null) {
    throw new TypeError(
      `extraArgs must be an array of strings, received ${typeof extra}`,
    );
  }

  return args;
}
