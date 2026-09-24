#!/usr/bin/env node

import { main } from "../dist/cli.js";

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
