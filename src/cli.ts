import { spawnYtDlp, getBinaryInfo } from "./binary.js";

export async function runCli(args: string[]): Promise<number> {
  try {
    const info = await getBinaryInfo();
    const child = spawnYtDlp(args);

    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);

    return new Promise((resolve) => {
      child.on("close", (code) => {
        resolve(code ?? 0);
      });

      child.on("error", (error) => {
        console.error("Failed to start yt-dlp:", error);
        resolve(1);
      });
    });
  } catch (error) {
    console.error("Error:", error);
    return 1;
  }
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const exitCode = await runCli(args);
  process.exit(exitCode);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
