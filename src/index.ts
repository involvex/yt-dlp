import {
  spawnYtDlp,
  getBinaryInfo,
  validateBinary,
  resolveBinary,
  runYtDlp,
} from "./binary.js";
import { promisify } from "util";
import { execFile } from "child_process";
import {
  YtDlpOptions,
  DownloadResult,
  VideoInfo,
  Format,
  ExecResult,
} from "./types.js";

const execFileAsync = promisify(execFile);

export class YtDlp {
  private binaryPath: string;

  constructor() {
    this.binaryPath = "";
  }

  async init(): Promise<void> {
    // Resolve the command without requiring the --version probe to succeed: a missing or
    // mismatched bundled binary must surface when yt-dlp is invoked, not here.
    this.binaryPath = resolveBinary().path;
    await getBinaryInfo();
  }

  /** Run yt-dlp with args passed as an array - never interpolated into a shell string. */
  private async execBinary(
    args: string[],
  ): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync(this.binaryPath, args, {
      maxBuffer: 1024 * 1024 * 64,
      windowsHide: true,
    });
  }

  async download(
    url: string,
    options: YtDlpOptions = {},
  ): Promise<DownloadResult> {
    const args = this.buildArgs(url, options);

    try {
      const { stdout, stderr } = await this.execBinary(args);

      return {
        success: true,
        data: stdout,
        error: stderr,
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  async getInfo(url: string, options: YtDlpOptions = {}): Promise<VideoInfo> {
    const args = ["--dump-json", url, ...this.buildOptions(options)];

    try {
      const { stdout } = await this.execBinary(args);
      return JSON.parse(stdout);
    } catch (error: any) {
      throw new Error(`Failed to get info: ${error.message}`);
    }
  }

  async listFormats(
    url: string,
    options: YtDlpOptions = {},
  ): Promise<Format[]> {
    const info = await this.getInfo(url, options);
    return info.formats || [];
  }

  async exec(args: string[]): Promise<ExecResult> {
    try {
      const { stdout, stderr } = await this.execBinary(args);

      return {
        stdout,
        stderr,
        exitCode: 0,
      };
    } catch (error: any) {
      return {
        stdout: error.stdout || "",
        stderr: error.stderr || error.message,
        exitCode: error.code || 1,
      };
    }
  }

  private buildArgs(url: string, options: YtDlpOptions): string[] {
    const args = [url, ...this.buildOptions(options)];
    return args;
  }

  private buildOptions(options: YtDlpOptions): string[] {
    const args: string[] = [];

    for (const [key, value] of Object.entries(options)) {
      if (value === undefined || value === null) continue;

      const flag = `--${key.replace(/([A-Z])/g, "-$1").toLowerCase()}`;

      if (typeof value === "boolean") {
        if (value) args.push(flag);
      } else {
        args.push(flag, String(value));
      }
    }

    return args;
  }
}

export async function createYtDlp(): Promise<YtDlp> {
  const ytdlp = new YtDlp();
  await ytdlp.init();
  return ytdlp;
}

export { getBinaryInfo, validateBinary, resolveBinary, runYtDlp, spawnYtDlp };
export type { ResolvedBinary } from "./binary.js";
export * from "./types.js";
