import { exec } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";

const execAsync = promisify(exec);

const platforms = [
  { name: "windows", arch: "x64", ext: ".exe" },
  { name: "windows", arch: "x86", ext: ".exe" },
  { name: "windows", arch: "arm64", ext: ".exe" },
  { name: "linux", arch: "x64", ext: "" },
  { name: "linux", arch: "arm64", ext: "" },
  { name: "linux", arch: "armv7", ext: "" },
  { name: "macos", arch: "x64", ext: "" },
  { name: "macos", arch: "arm64", ext: "" },
];

const GITHUB_RELEASES = "https://github.com/yt-dlp/yt-dlp/releases/latest";

async function downloadBinary(
  platform: string,
  arch: string,
  ext: string,
): Promise<void> {
  const binaryDir = join(process.cwd(), "binaries", `${platform}-${arch}`);
  const binaryName = `yt-dlp${ext}`;
  const binaryPath = join(binaryDir, binaryName);

  if (existsSync(binaryPath)) {
    console.log(`Binary already exists: ${binaryPath}`);
    return;
  }

  mkdirSync(binaryDir, { recursive: true });

  const url = `${GITHUB_RELEASES}/download/yt-dlp${ext}`;

  console.log(`Downloading ${platform}-${arch} binary from ${url}...`);

  try {
    // Download using curl
    await execAsync(`curl -L -o "${binaryPath}" "${url}"`);

    // Only set executable permissions on Unix-like systems (not Windows)
    if (process.platform !== "win32") {
      await execAsync(`chmod +x "${binaryPath}"`);
    }

    console.log(`Successfully downloaded: ${binaryPath}`);
  } catch (error) {
    console.error(`Failed to download ${platform}-${arch} binary:`, error);
  }
}

async function buildBinaries(): Promise<void> {
  console.log("Building yt-dlp binaries...");

  for (const platform of platforms) {
    await downloadBinary(platform.name, platform.arch, platform.ext);
  }

  console.log("\\nBinary build complete!");
}

buildBinaries().catch((error) => {
  console.error("Build failed:", error);
  process.exit(1);
});
