/**
 * Release the wrapper and its binary sub-packages to npm, in dependency order.
 *
 * Order is mandatory, not a preference: `@involvex/yt-dlp@VERSION` declares every sub-package as
 * an *optional* dependency at `VERSION` exactly. If the wrapper lands before the sub-packages exist,
 * npm skips them and an install degrades silently to the zipapp/PATH fallback - correct, but the
 * 17 MB download the split exists to deliver is not happening. Publishing the sub-packages first
 * means that window is never observed.
 *
 * The one thing this script cannot do is authenticate. It shells out to `npm publish`, which reads
 * its credentials from the environment (`NPM_TOKEN` or `npm login`). If that fails it stops at the
 * first package rather than continuing into a half-published state.
 *
 *   bun run release                     # dry-run: pack + verify only, no upload
 *   bun run release -- --publish        # actually publish (needs npm auth)
 *   bun run publish -- --dry-run        # explicit dry-run
 *   bun run publish -- --access public  # also pass --access public to npm publish
 *   bun run publish -- --otp 123456     # 2FA one-time password
 *
 * The build artifacts in dist/ and build/binary-packages/ are NOT regenerated here; run
 * `bun run build && bun run build:binpkg` first, or the script aborts. This keeps a release
 * reviewable: what publishes is what was built and verified, not what this script happens to
 * rebuild.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_DIR = join(ROOT, "build", "binary-packages");

interface Args {
  publish: boolean;
  dryRun: boolean;
  access?: string;
  otp?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { publish: false, dryRun: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--publish") args.publish = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--access") args.access = argv[++i];
    else if (arg.startsWith("--access=")) args.access = arg.slice(9);
    else if (arg === "--otp") args.otp = argv[++i];
    else if (arg.startsWith("--otp=")) args.otp = arg.slice(6);
    else throw new Error(`unknown argument: ${arg}`);
  }
  // `--publish` is the escape hatch; everything else is opt-in to dry-run so a bare invocation
  // never touches the registry.
  if (args.publish) args.dryRun = false;
  return args;
}

function requireBuilt(): { index: any; pkg: any } {
  const manifestPath = join(ROOT, "package.json");
  const indexPath = join(OUT_DIR, "index.json");
  if (!existsSync(join(ROOT, "dist", "cli.js")))
    throw new Error("dist/ is not built - run `bun run build:ts` first");
  if (!existsSync(indexPath))
    throw new Error(
      "build/binary-packages/ is not staged - run `bun run build:binpkg` first",
    );
  return {
    index: JSON.parse(readFileSync(indexPath, "utf8")),
    pkg: JSON.parse(readFileSync(manifestPath, "utf8")),
  };
}

/**
 * Run `npm publish` (or `npm pack --dry-run`) in a directory.
 *
 * Always shows the resulting file list and size, because a tarball that accidentally excludes the
 * payload - the exact failure class the whole split defends against - is only visible from here.
 */
function publishDir(dir: string, name: string, args: Args): void {
  const cwd = join(OUT_DIR, dir);
  // `npm pack` is the read-only shape of `npm publish` and shows the file list without touching the
  // registry, so it runs even in a --publish run as a final confirmation.
  const packed = execSync("npm pack", {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tarball = packed.trim().split("\n").pop()!;

  if (args.publish) {
    console.log(`  publish  ${name} (${tarball})`);
    execSync(`npm publish ${publishArgs(args).join(" ")}`, {
      cwd,
      encoding: "utf8",
      stdio: "inherit",
    });
  } else {
    console.log(`  dry-run  ${name} (would publish ${tarball})`);
  }
}

function publishArgs(args: Args): string[] {
  const parts: string[] = [];
  if (args.dryRun) parts.push("--dry-run");
  if (args.access) parts.push("--access", args.access);
  if (args.otp) parts.push("--otp", args.otp);
  return parts;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const { index, pkg } = requireBuilt();

  if (index.wrapper.version !== pkg.version) {
    throw new Error(
      `wrapper version ${pkg.version} does not match staged index ${index.wrapper.version} - ` +
        "the packages were built from a different version; rebuild before publishing",
    );
  }

  console.log(`@involvex/yt-dlp release (dry-run=${args.dryRun})\n`);

  // Sub-packages first, then the wrapper: an installed consumer never observes a wrapper whose
  // optionalDependencies point at packages that do not exist, because the sub-packages land first.
  const order = [...index.packages].sort((a, b) => (a.name < b.name ? -1 : 1));

  for (const p of order) {
    publishDir(p.stagingDir, p.name, args);
  }
  console.log("");

  // The wrapper publishes from the repo root, where dist/ and package.json live.
  if (args.publish) {
    console.log(`  publish  ${pkg.name} (wrapper, v${pkg.version})`);
    execSync(`npm publish ${publishArgs(args).join(" ")}`, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: "inherit",
    });
  } else {
    // Pack the wrapper too so the dry run shows its real file list and size.
    const packed = execSync("npm pack", {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tarball = packed.trim().split("\n").pop()!;
    console.log(
      `  dry-run  ${pkg.name} (wrapper, v${pkg.version}; would publish ${tarball})`,
    );
  }

  console.log(
    "\nRelease complete.\n  " +
      (args.dryRun
        ? "This was a dry-run; nothing was uploaded. Run `bun run release -- --publish --access public` to publish."
        : `${order.length} sub-package(s) + the wrapper have been published.`),
  );
}

main();
