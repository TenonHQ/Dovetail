#!/usr/bin/env node
import path from "path";
import { init } from "./bootstrap";
import { fileLogger } from "./FileLogger";

// Library exports — consumers can `import { decodeV2Values } from "@tenonhq/dovetail-core"`.
// Keep exports above the CLI entry so bundlers/TS can tree-shake and require() consumers
// never accidentally invoke main().
export { decodeV2Values, encodeV2Values, V2ValueEntry } from "./flowDesigner/values";

async function main() {
  // Initialize file logging as early as possible
  fileLogger.info("Starting Dovetail...");
  // Deprecated alias: warn once when the CLI is invoked as `sinc` instead of `dove`.
  // The `sinc` bin shim is kept for one minor version to avoid breaking existing scripts.
  const invokedAs = path.basename(process.argv[1] || "").replace(/\.(js|cmd|exe)$/i, "");
  if (invokedAs === "sinc") {
    process.stderr.write(
      "[deprecation] The 'sinc' command has been renamed to 'dove'. Run 'npx dove migrate' to update your project, then call 'dove' going forward. The 'sinc' alias will be removed in the next major release.\n",
    );
  }
  await init();
}

// Only run the CLI when this file is executed directly (e.g. `npx dove`, `node dist/index.js`).
// When imported as a library, require.main !== module and main() is skipped.
if (require.main === module) {
  main().catch(function (e) {
    fileLogger.error("Fatal error: " + String(e));
    process.exit(1);
  });
}
