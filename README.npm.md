# @involvex/yt-dlp

A feature-rich command-line audio/video downloader - Node.js wrapper with TypeScript API and PowerShell completion support.

## Installation

\`\`\`bash
npm install @involvex/yt-dlp
\`\`\`

## Usage

### CLI Usage

\`\`\`bash

# Download a video

yt-dlp https://www.youtube.com/watch?v=VIDEO_ID

# Download with options

yt-dlp -f "best" -o "%(title)s.%(ext)s" https://www.youtube.com/watch?v=VIDEO_ID

# Get video info

yt-dlp --dump-json https://www.youtube.com/watch?v=VIDEO_ID
\`\`\`

### TypeScript API Usage

\`\`\`typescript
import { createYtDlp } from "@involvex/yt-dlp";

async function main() {
const ytdlp = await createYtDlp();

// Download a video
const result = await ytdlp.download("https://www.youtube.com/watch?v=VIDEO_ID", {
format: "best",
output: "%(title)s.%(ext)s",
});

console.log("Download result:", result);

// Get video info
const info = await ytdlp.getInfo("https://www.youtube.com/watch?v=VIDEO_ID");
console.log("Video info:", info);

// List available formats
const formats = await ytdlp.listFormats("https://www.youtube.com/watch?v=VIDEO_ID");
console.log("Available formats:", formats);
}

main();
\`\`\`

## Bundled binaries

Native yt-dlp executables are bundled for Windows (x64, x86, arm64), Linux (x64, arm64, musl x64),
and macOS (universal2, one binary for both Apple Silicon and Intel). The binary matching your
platform is selected automatically - no configuration needed.

If no matching binary is present, the CLI falls back to a `yt-dlp` found on your `PATH`.

## Android / Termux

**There is no native Android binary.** The yt-dlp project does not publish a Bionic build, and the
Linux binaries are glibc-linked, so they will not run on Android. The payload bundled for Android is
the arch-independent Python zipapp, which means **Python must be installed**:

\`\`\`bash
pkg install python
pip install -U yt-dlp
\`\`\`

After that the CLI works normally:

\`\`\`bash
bunx @involvex/yt-dlp https://www.youtube.com/watch?v=VIDEO_ID
\`\`\`

\`\`\`bash
# you can also skip the pip step; the CLI will use yt-dlp from PATH
pkg install yt-dlp
\`\`\`

> \`bun build --os android\` only retargets the JavaScript bundle. It does **not** solve the native
> binary problem and is not required to use this package on Android.

## PowerShell Completion

The package includes PowerShell completion support. After installation, you can enable it by:

\`\`\`powershell

# For current user

Copy-Item -Path node_modules/@involvex/yt-dlp/completions/yt-dlp.ps1 -Destination $PROFILE

# For all users (requires admin)

Copy-Item -Path node_modules/@involvex/yt-dlp/completions/yt-dlp.ps1 -Destination "$env:ALLUSERSPROFILE\\Documents\\WindowsPowerShell\\yt-dlp.ps1"
\`\`\`

Then restart your PowerShell session.

## API Reference

### `createYtDlp()`

Creates a new YtDlp instance.

\`\`\`typescript
const ytdlp = await createYtDlp();
\`\`\`

### `YtDlp.download(url, options)`

Downloads a video from the given URL.

\`\`\`typescript
const result = await ytdlp.download(url, {
format: "best",
output: "%(title)s.%(ext)s",
subtitles: true,
});
\`\`\`

#### Options

Each option name maps to one specific yt-dlp flag, and an unknown name throws immediately instead of
being passed along as a guessed flag. For example `outDir` maps to `--paths`:

\`\`\`typescript
await ytdlp.download(url, { outDir: "/tmp/videos", format: "worst" });
// yt-dlp receives: --paths /tmp/videos --format worst
\`\`\`

Two options are deliberately absent, because yt-dlp has no such flag and the previous implementation
generated a broken one: use `format: "best" | "worst"` rather than `quality`, and pass the URL as the
first argument rather than as a `url` option.

For any flag this wrapper does not model, use `extraArgs`. These are appended verbatim after the
mapped options, so they take precedence:

\`\`\`typescript
await ytdlp.download(url, {
  format: "worst",
  extraArgs: ["--format", "bv+ba", "--min-filesize", "50M"],
});
\`\`\`

### `YtDlp.getInfo(url, options)`

Gets information about a video without downloading it.

\`\`\`typescript
const info = await ytdlp.getInfo(url);
console.log(info.title, info.uploader, info.duration);
\`\`\`

### `YtDlp.listFormats(url, options)`

Lists all available formats for a video.

\`\`\`typescript
const formats = await ytdlp.listFormats(url);
formats.forEach(format => {
console.log(format.formatId, format.ext, format.resolution);
});
\`\`\`

### `YtDlp.exec(args)`

Executes arbitrary yt-dlp command with custom arguments.

\`\`\`typescript
const result = await ytdlp.exec(["--list-extractors"]);
console.log(result.stdout);
\`\`\`

## Development

\`\`\`bash

# Install dependencies

bun install

# Build the package

bun run build

# Generate completion scripts

bun run generate-completion

# Run in development mode

bun run dev
\`\`\`

## License

Unlicense

## Support

For issues and support, please visit: https://github.com/involvex/yt-dlp/issues
