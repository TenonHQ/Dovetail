import { Sinc } from "@tenonhq/dovetail-types";
import { setLogLevel } from "./commands";
import { logger } from "./Logger";
import { spawn } from "child_process";

export async function dashboardCommand(args: Sinc.SharedCmdArgs & { port?: number }): Promise<void> {
  setLogLevel(args);

  let serverPath: string;
  try {
    serverPath = require.resolve("@tenonhq/dovetail-dashboard/server.js");
  } catch (e) {
    throw new Error(
      "Dashboard package not installed. Run: npm install @tenonhq/dovetail-dashboard",
    );
  }

  var port = args.port ? String(args.port) : (process.env.DASHBOARD_PORT || "3456");

  logger.info("Starting Update Set Dashboard...");

  const server = spawn("node", [serverPath], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: { ...process.env, DASHBOARD_PORT: port },
  });

  // Open browser after a short delay
  setTimeout(() => {
    const url = "http://localhost:" + port;
    spawn("open", [url]);
  }, 1000);

  server.on("close", (code) => {
    process.exit(code || 0);
  });

  // Forward signals
  process.on("SIGINT", () => {
    server.kill("SIGINT");
  });
  process.on("SIGTERM", () => {
    server.kill("SIGTERM");
  });
}
