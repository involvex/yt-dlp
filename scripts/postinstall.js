import fs from "fs";
import path from "path";
import { exec } from "child_process";

const completionDir = path.join(process.cwd(), "completions");
const powershellCompletion = path.join(completionDir, "yt-dlp.ps1");

console.log("Setting up @involvex/yt-dlp...");

if (fs.existsSync(powershellCompletion)) {
  console.log("\\nPowerShell completion is available!");
  console.log("To enable it, add this to your PowerShell profile:");
  console.log(`  . "${powershellCompletion}"`);
  console.log("\\nOr run:");
  console.log(
    "  Copy-Item -Path completions\\\\yt-dlp.ps1 -Destination $PROFILE",
  );
} else {
  console.log(
    "PowerShell completion not found. Run: bun run generate-completion",
  );
}

console.log("\\n@involvex/yt-dlp is ready to use!");
console.log("Try: yt-dlp --help");
