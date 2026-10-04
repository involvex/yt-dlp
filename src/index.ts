import {
  spawnYtDlp,
  getBinaryInfo,
  validateBinary,
  resolveBinary,
  execFileCapture,
  runYtDlp,
} from "./binary.js";
import {
  YtDlpOptions,
  DownloadResult,
  VideoInfo,
  Format,
  ExecResult,
} from "./types.js";

export class YtDlp {
  private binaryPath: string;

  constructor() {
    this.binaryPath = "";
  }

  async init(): Promise<void> {
    // No --version probe here: `this.binaryPath` comes from resolveBinary(), and the bundled
    // PyInstaller onefile has to extract itself to a temp dir on cold start (~9 s). Probing would
    // double startup for information nothing uses - runCli skips it for the same reason.
    this.binaryPath = resolveBinary().path;
  }

  /** Run yt-dlp with args passed as an array - never interpolated into a shell string. */
  private async execBinary(
    args: string[],
  ): Promise<{ stdout: string; stderr: string }> {
    // execFileCapture routes the zipapp payload (Android/Termux, unsupported arch) through a Python
    // interpreter, so the programmatic API behaves the same as the CLI on those platforms.
    return execFileCapture(resolveBinary(), args);
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
