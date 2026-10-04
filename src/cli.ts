import { fileURLToPath } from "url";
import { resolve } from "path";
import { runYtDlp, getBinaryInfo, resolveBinary } from "./binary.js";

export async function runCli(args: string[]): Promise<number> {
  const resolved = resolveBinary();

  // Only probe when we had to fall back to PATH, where it is genuinely unknown whether the command
  // works. Probing a bundled binary is pure overhead: the PyInstaller onefile has to extract itself
  // to a temp directory on every cold start, and doing it twice roughly doubles startup time.
  if (resolved.source === "path") {
    const info = await getBinaryInfo();
    if (info.version === "unknown") {
      console.error(
        `warning: could not run ${resolved.path} from PATH; attempting anyway`,
      );
    }
  }

  return runYtDlp(args);
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const exitCode = await runCli(args);
  process.exit(exitCode);
}

// Only self-start when this file is the process entrypoint. Compare resolved filesystem paths:
// comparing `import.meta.url` (always file:// with forward slashes) against process.argv[1] (a
// native path) never matches on Windows.
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
