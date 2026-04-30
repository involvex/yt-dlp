import { spawnYtDlp, getBinaryInfo, validateBinary } from "./binary.js";
import { promisify } from "util";
import { exec } from "child_process";
import {
  YtDlpOptions,
  DownloadResult,
  VideoInfo,
  Format,
  ExecResult,
} from "./types.js";

const execAsync = promisify(exec);

export class YtDlp {
  private binaryPath: string;

  constructor() {
    this.binaryPath = "";
  }

  async init(): Promise<void> {
    const info = await getBinaryInfo();
    this.binaryPath = info.path;
  }

  async download(
    url: string,
    options: YtDlpOptions = {},
  ): Promise<DownloadResult> {
    const args = this.buildArgs(url, options);

    try {
      const { stdout, stderr } = await execAsync(
        `"${this.binaryPath}" ${args.join(" ")}`,
      );

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
      const { stdout } = await execAsync(
        `"${this.binaryPath}" ${args.join(" ")}`,
      );
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
      const { stdout, stderr } = await execAsync(
        `"${this.binaryPath}" ${args.join(" ")}`,
      );

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

export { getBinaryInfo, validateBinary };
export * from "./types.js";
