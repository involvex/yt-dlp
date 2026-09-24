import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { writeFileSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const YT_DLP_FLAGS = [
  "--help",
  "--version",
  "--update",
  "--no-update",
  "--update-to",
  "--ignore-errors",
  "--no-abort-on-error",
  "--abort-on-error",
  "--list-extractors",
  "--extractor-descriptions",
  "--use-extractors",
  "--force-generic-extractor",
  "--default-search",
  "--ignore-config",
  "--no-config-locations",
  "--config-locations",
  "--plugin-dirs",
  "--no-plugin-dirs",
  "--js-runtimes",
  "--no-js-runtimes",
  "--remote-components",
  "--no-remote-components",
  "--flat-playlist",
  "--no-flat-playlist",
  "--live-from-start",
  "--no-live-from-start",
  "--wait-for-video",
  "--no-wait-for-video",
  "--mark-watched",
  "--no-mark-watched",
  "--no-colors",
  "--color",
  "--compat-options",
  "--alias",
  "--preset-alias",
  "--proxy",
  "--socket-timeout",
  "--source-address",
  "--impersonate",
  "--list-impersonate-targets",
  "--force-ipv4",
  "--force-ipv6",
  "--enable-file-urls",
  "--geo-verification-proxy",
  "--xff",
  "--geo-bypass",
  "--no-geo-bypass",
  "--geo-bypass-country",
  "--geo-bypass-ip-block",
  "--playlist-start",
  "--playlist-end",
  "--playlist-items",
  "--match-title",
  "--reject-title",
  "--min-filesize",
  "--max-filesize",
  "--date",
  "--datebefore",
  "--dateafter",
  "--min-views",
  "--max-views",
  "--match-filters",
  "--no-match-filters",
  "--break-match-filters",
  "--no-break-match-filters",
  "--no-playlist",
  "--yes-playlist",
  "--age-limit",
  "--download-archive",
  "--no-download-archive",
  "--max-downloads",
  "--break-on-existing",
  "--no-break-on-existing",
  "--break-on-reject",
  "--break-per-input",
  "--no-break-per-input",
  "--skip-playlist-after-errors",
  "--concurrent-fragments",
  "--limit-rate",
  "--throttled-rate",
  "--retries",
  "--file-access-retries",
  "--fragment-retries",
  "--retry-sleep",
  "--skip-unavailable-fragments",
  "--abort-on-unavailable-fragments",
  "--keep-fragments",
  "--no-keep-fragments",
  "--buffer-size",
  "--resize-buffer",
  "--no-resize-buffer",
  "--http-chunk-size",
  "--test",
  "--playlist-reverse",
  "--no-playlist-reverse",
  "--playlist-random",
  "--lazy-playlist",
  "--no-lazy-playlist",
  "--hls-prefer-native",
  "--hls-prefer-ffmpeg",
  "--hls-use-mpegts",
  "--no-hls-use-mpegts",
  "--download-sections",
  "--downloader",
  "--downloader-args",
  "--batch-file",
  "--no-batch-file",
  "--id",
  "--paths",
  "--output",
  "--output-na-placeholder",
  "--autonumber-size",
  "--autonumber-start",
  "--restrict-filenames",
  "--no-restrict-filenames",
  "--windows-filenames",
  "--no-windows-filenames",
  "--trim-filenames",
  "--no-overwrites",
  "--force-overwrites",
  "--no-force-overwrites",
  "--continue",
  "--no-continue",
  "--part",
  "--no-part",
  "--mtime",
  "--no-mtime",
  "--write-description",
  "--no-write-description",
  "--write-info-json",
  "--no-write-info-json",
  "--write-playlist-metafiles",
  "--no-write-playlist-metafiles",
  "--clean-info-json",
  "--no-clean-info-json",
  "--write-comments",
  "--no-write-comments",
  "--load-info-json",
  "--cookies",
  "--no-cookies",
  "--cookies-from-browser",
  "--no-cookies-from-browser",
  "--cache-dir",
  "--no-cache-dir",
  "--rm-cache-dir",
  "--write-thumbnail",
  "--no-write-thumbnail",
  "--write-all-thumbnails",
  "--list-thumbnails",
  "--write-link",
  "--write-url-link",
  "--write-webloc-link",
  "--write-desktop-link",
  "--quiet",
  "--no-quiet",
  "--no-warnings",
  "--simulate",
  "--no-simulate",
  "--ignore-no-formats-error",
  "--no-ignore-no-formats-error",
  "--skip-download",
  "--print",
  "--print-to-file",
  "--get-url",
  "--get-title",
  "--get-id",
  "--get-thumbnail",
  "--get-description",
  "--get-duration",
  "--get-filename",
  "--get-format",
  "--dump-json",
  "--dump-single-json",
  "--print-json",
  "--force-write-archive",
  "--newline",
  "--no-progress",
  "--progress",
  "--console-title",
  "--progress-template",
  "--progress-delta",
  "--verbose",
  "--dump-pages",
  "--write-pages",
  "--load-pages",
  "--print-traffic",
  "--encoding",
  "--legacy-server-connect",
  "--no-check-certificates",
  "--prefer-insecure",
  "--user-agent",
  "--referer",
  "--add-headers",
  "--bidi-workaround",
  "--sleep-requests",
  "--sleep-interval",
  "--max-sleep-interval",
  "--sleep-subtitles",
  "--format",
  "--format-sort",
  "--format-sort-reset",
  "--format-sort-force",
  "--no-format-sort-force",
  "--video-multistreams",
  "--no-video-multistreams",
  "--audio-multistreams",
  "--no-audio-multistreams",
  "--all-formats",
  "--prefer-free-formats",
  "--no-prefer-free-formats",
  "--check-formats",
  "--check-all-formats",
  "--no-check-formats",
  "--list-formats",
  "--list-formats-as-table",
  "--list-formats-old",
  "--merge-output-format",
  "--allow-unplayable-formats",
  "--no-allow-unplayable-formats",
  "--write-subs",
  "--no-write-subs",
  "--write-auto-subs",
  "--no-write-auto-subs",
  "--all-subs",
  "--list-subs",
  "--sub-format",
  "--sub-langs",
  "--username",
  "--password",
  "--twofactor",
  "--netrc",
  "--netrc-location",
  "--netrc-cmd",
  "--video-password",
  "--ap-mso",
  "--ap-username",
  "--ap-password",
  "--ap-list-mso",
  "--client-certificate",
  "--client-certificate-key",
  "--client-certificate-password",
  "--extract-audio",
  "--audio-format",
  "--audio-quality",
  "--remux-video",
  "--recode-video",
  "--postprocessor-args",
  "--keep-video",
  "--no-keep-video",
  "--post-overwrites",
  "--no-post-overwrites",
  "--embed-subs",
  "--no-embed-subs",
  "--embed-thumbnail",
  "--no-embed-thumbnail",
  "--embed-metadata",
  "--no-embed-metadata",
  "--embed-chapters",
  "--no-embed-chapters",
  "--embed-info-json",
  "--no-embed-info-json",
  "--metadata-from-title",
  "--parse-metadata",
  "--replace-in-metadata",
  "--xattrs",
  "--concat-playlist",
  "--fixup",
  "--ffmpeg-location",
  "--exec",
  "--no-exec",
  "--exec-before-download",
  "--no-exec-before-download",
  "--convert-subs",
  "--convert-thumbnails",
  "--split-chapters",
  "--no-split-chapters",
  "--remove-chapters",
  "--no-remove-chapters",
  "--force-keyframes-at-cuts",
  "--no-force-keyframes-at-cuts",
  "--use-postprocessor",
  "--sponsorblock-mark",
  "--sponsorblock-remove",
  "--sponsorblock-chapter-title",
  "--no-sponsorblock",
  "--sponsorblock-api",
  "--extractor-retries",
  "--allow-dynamic-mpd",
  "--ignore-dynamic-mpd",
  "--hls-split-discontinuity",
  "--no-hls-split-discontinuity",
  "--extractor-args",
];

export function generatePowerShellCompletion(): string {
  const flagsArray = YT_DLP_FLAGS.map((f) => `"${f}"`).join(", ");

  const completionScript = `# PowerShell completion script for yt-dlp
# Generated by @involvex/yt-dlp

using namespace System.Management.Automation
using namespace System.Management.Automation.Language

$script:block = {
    param($wordToComplete, $commandAst, $cursorPosition)
    
    $command = $commandAst.CommandElements[0].Value
    $prevWord = if ($commandAst.CommandElements.Count -gt 1) {
        $commandAst.CommandElements[-2].Value
    } else {
        ""
    }
    
    # File options that expect file paths
    $fileOptions = @("-a", "--batch-file", "--download-archive", "--cookies", "--load-info-json")
    
    # Directory options that expect directory paths
    $dirOptions = @("--cache-dir")
    
    # Special keywords
    $keywords = @(":ytfavorites", ":ytrecommended", ":ytsubscriptions", ":ytwatchlater", ":ythistory")
    
    # Video format options
    $formatOptions = @("mp4", "mkv", "flv", "ogg", "webm")
    
    # All available flags
    $flags = @(${flagsArray})
    
    # Handle file completion
    if ($fileOptions -contains $prevWord) {
        $completions = @(Get-ChildItem -Path $wordToComplete* -File | Select-Object -ExpandProperty Name)
        $completions | ForEach-Object {
            [CompletionResult]::new($_, $_, [CompletionResultType]::ParameterValue, $_)
        }
        return
    }
    
    # Handle directory completion
    if ($dirOptions -contains $prevWord) {
        $completions = @(Get-ChildItem -Path $wordToComplete* -Directory | Select-Object -ExpandProperty Name)
        $completions | ForEach-Object {
            [CompletionResult]::new($_, $_, [CompletionResultType]::ParameterValue, $_)
        }
        return
    }
    
    # Handle format completion
    if ($prevWord -eq "--remux-video" -or $prevWord -eq "--recode-video") {
        $formatOptions | ForEach-Object {
            [CompletionResult]::new($_, $_, [CompletionResultType]::ParameterValue, $_)
        }
        return
    }
    
    # Handle keyword completion
    if ($wordToComplete -match "^:") {
        $keywords | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
            [CompletionResult]::new($_, $_, [CompletionResultType]::ParameterValue, $_)
        }
        return
    }
    
    # Handle flag completion
    $flags | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
        [CompletionResult]::new($_, $_, [CompletionResultType]::ParameterName, $_)
    }
}

Register-ArgumentCompleter -Native -CommandName yt-dlp -ScriptBlock $script:block
`;

  return completionScript;
}

export async function writePowerShellCompletion(
  outputPath: string,
): Promise<void> {
  const completionScript = generatePowerShellCompletion();
  writeFileSync(outputPath, completionScript, "utf-8");
  console.log(`PowerShell completion script written to: ${outputPath}`);
}

export async function installPowerShellCompletion(): Promise<void> {
  const outputPath = join(__dirname, "..", "..", "completions", "yt-dlp.ps1");
  await writePowerShellCompletion(outputPath);

  console.log("");
  console.log("To install PowerShell completion, run:");
  console.log("  # For current user:");
  console.log("  Copy-Item -Path completions/yt-dlp.ps1 -Destination $PROFILE");
  console.log("");
  console.log("  # For all users (requires admin):");
  console.log(
    "  Copy-Item -Path completions/yt-dlp.ps1 -Destination $env:ALLUSERSPROFILE/Documents/WindowsPowerShell/yt-dlp.ps1",
  );
  console.log("");
  console.log("Then restart your PowerShell session.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  installPowerShellCompletion();
}
