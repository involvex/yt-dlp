/**
 * Options for {@link YtDlp.download} / {@link YtDlp.getInfo}.
 *
 * Keys map to exact yt-dlp flags - see `OPTION_FLAGS` in ./options.ts. The union below is
 * deliberately closed: it used to carry `[key: string]: any`, which let any typo compile and then
 * emit a flag yt-dlp rejects. Unmodelled flags go in {@link YtDlpOptions.extraArgs} and are passed
 * through verbatim.
 *
 * Note there is no `quality` (yt-dlp has no such option - use `format: "best"`) and no `url` (the
 * URL is the first positional argument).
 */
export interface YtDlpOptions {
  // Selection and layout
  format?: string;
  output?: string;
  outDir?: string;
  mergeOutputFormat?: string;

  // Subtitles
  subtitles?: boolean;
  writeSub?: boolean;
  writeAutoSub?: boolean;
  subLang?: string;
  embedSubs?: boolean;

  // Metadata and thumbnails
  writeThumbnail?: boolean;
  embedThumbnail?: boolean;

  // Audio / video conversion
  extractAudio?: boolean;
  audioFormat?: string;

  // Playlist handling - pick one direction explicitly.
  playlist?: boolean;
  noPlaylist?: boolean;

  // Authentication and request shaping
  cookies?: string;
  cookiesFromBrowser?: string;
  userAgent?: string;
  referer?: string;
  proxy?: string;
  geoBypass?: boolean;

  // Reliability and diagnostics
  retries?: string | number;
  concurrentFragments?: string | number;
  ignoreErrors?: boolean;
  noWarnings?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  newline?: boolean;
  noCheckCertificate?: boolean;

  /**
   * Raw yt-dlp arguments appended verbatim after every mapped option, for anything this wrapper
   * does not model. Not validated - these reach yt-dlp exactly as written.
   */
  extraArgs?: string[];
}

export interface DownloadResult {
  success: boolean;
  filename?: string;
  error?: string;
  data?: any;
}

export interface VideoInfo {
  id: string;
  title: string;
  uploader: string;
  uploaderId?: string;
  duration?: number;
  viewCount?: number;
  thumbnail?: string;
  description?: string;
  uploadDate?: string;
  formats?: Format[];
  [key: string]: any;
}

export interface Format {
  formatId: string;
  ext: string;
  resolution?: string;
  fps?: number;
  filesize?: number;
  tbr?: number;
  vbr?: number;
  abr?: number;
  acodec?: string;
  vcodec?: string;
  container?: string;
  [key: string]: any;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface BinaryInfo {
  path: string;
  version: string;
  platform: string;
  arch: string;
}
