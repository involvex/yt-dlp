import { spawn, exec } from "child_process";
import { promisify } from "util";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import { BinaryInfo } from "./types.js";

const execAsync = promisify(exec);

const __dirname = dirname(fileURLToPath(import.meta.url));

export function getPlatform(): string {
  const platform = process.platform;
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  return "linux";
}

export function getArch(): string {
  const arch = process.arch;
  if (arch === "x64") return "x64";
  if (arch === "arm64") return "arm64";
  if (arch === "ia32") return "x86";
  return arch;
}

export function getBinaryPath(): string {
  const platform = getPlatform();
  const arch = getArch();

  const binaryDir = join(__dirname, "..", "binaries", `${platform}-${arch}`);
  const binaryName = platform === "windows" ? "yt-dlp.exe" : "yt-dlp";
  const binaryPath = join(binaryDir, binaryName);

  if (existsSync(binaryPath)) {
    return binaryPath;
  }

  return binaryName;
}

export async function getBinaryInfo(): Promise<BinaryInfo> {
  const binaryPath = getBinaryPath();

  try {
    const { stdout } = await execAsync(`"${binaryPath}" --version`);
    const version = stdout.trim();

    return {
      path: binaryPath,
      version,
      platform: getPlatform(),
      arch: getArch(),
    };
  } catch (error) {
    throw new Error(`Failed to get binary info: ${error}`);
  }
}

export async function validateBinary(): Promise<boolean> {
  try {
    await getBinaryInfo();
    return true;
  } catch {
    return false;
  }
}

export function spawnYtDlp(args: string[] = []) {
  const binaryPath = getBinaryPath();
  return spawn(binaryPath, args, {
    stdio: ["inherit", "pipe", "pipe"],
  });
}
