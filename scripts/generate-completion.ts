import { installPowerShellCompletion } from "../dist/completion/powershell.js";

async function main(): Promise<void> {
  console.log("Generating completion scripts...");
  await installPowerShellCompletion();
  console.log("\\nCompletion generation complete!");
}

main().catch((error) => {
  console.error("Generation failed:", error);
  process.exit(1);
});
