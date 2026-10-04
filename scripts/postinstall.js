import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Resolve paths relative to THIS package, not process.cwd(). During `npm install` the cwd is the
// consuming project, so `process.cwd()/completions` never existed and the completion hint could
// never be found.
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const powershellCompletion = path.join(
  packageRoot,
  "completions",
  "yt-dlp.ps1",
);

console.log("Setting up @involvex/yt-dlp...");

if (fs.existsSync(powershellCompletion)) {
  console.log("\nPowerShell completion is available!");
  console.log("To enable it, add this to your PowerShell profile:");
  console.log(`  . "${powershellCompletion}"`);
  console.log("\nOr run:");
  console.log(
    `  Copy-Item -Path "${powershellCompletion}" -Destination $PROFILE`,
  );
} else {
  console.log("PowerShell completion not found.");
}

console.log("\n@involvex/yt-dlp is ready to use!");
console.log("Try: yt-dlp --help");
