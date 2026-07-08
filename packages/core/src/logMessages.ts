import { Sinc } from "@tenonhq/dovetail-types";
import { logger } from "./Logger";
import { fileLogger } from "./FileLogger";
import chalk from "chalk";

export const log = console.log;

function parseError(err: Error): string {
  return `${err.name}:
 ${err.message}
 Stack Trace:
 ${err.stack || "none"}`;
}

export function logFilePush(
  context: Sinc.FileContext,
  res: Sinc.PushResult,
): void {
  const { message, success } = res;
  const instance = process.env.SN_INSTANCE || "instance";
  const label = chalk.bold.blue;
  const timestamp = new Date().toLocaleTimeString();

  const fileLabel =
    context.tableName + "/" + context.name + " (" + context.targetField + ")";

  if (success) {
    logger.info(
      chalk.green("Pushed") +
        " " +
        fileLabel +
        " to " +
        instance +
        " at " +
        timestamp,
    );
    // Persist every push to the session log file (file-only, no console echo).
    // The log file rotates every 200 writes (see FileLogger) so it never grows huge.
    fileLogger.debug(
      "Pushed " + fileLabel + " to " + instance + " at " + timestamp,
    );
  } else {
    logger.error("Failed to push " + fileLabel + " to " + instance);
    logger.error(message);
    fileLogger.debug(
      "Failed to push " + fileLabel + " to " + instance + ": " + message,
    );
  }
}

function multiLog(
  files: Sinc.FileContext[],
  success: boolean,
  resultSet: boolean[],
  successMessage: string,
  errorMessage: string,
  err?: Error,
) {
  if (success) {
    let fileNum = chalk.bold.blue(
      resultSet.filter((result) => result).length + "",
    );
    let message = chalk.green(`${fileNum} files ${successMessage}`);
    logger.info(message);
  } else {
    logger.error(errorMessage);
    if (err) {
      logger.error(parseError(err));
    }
  }
  spacer();
}

export function logDeploy(
  files: Sinc.FileContext[],
  success: boolean,
  resultSet: boolean[],
  err?: Error,
) {
  multiLog(
    files,
    success,
    resultSet,
    "successfully deployed",
    "Failed to deploy files",
    err,
  );
}

function spacer() {
  logger.info("");
}

const logOperationResults = (
  results: Sinc.PushResult[] | Sinc.BuildResult[],
  operation: string,
): void => {
  const unsuccessful = results.filter((r) => !r.success);
  const logr = logger.getInternalLogger();
  const label = (content: string) => chalk.bold.blue(content);
  const success = (content: string) => chalk.bold.green(content);
  const fail = (content: string) => chalk.bold.red(content);
  logr.info(`${label("Total Records:")} ${results.length}`);
  logr.info(
    `${label(`Successful ${operation}:`)} ${success(
      results.length - unsuccessful.length + "",
    )}`,
  );
  logr.info(
    `${label(`Failed ${operation}:`)} ${fail(unsuccessful.length + "")}`,
  );
  if (unsuccessful.length === 0) {
    return;
  }
  logger.error("-".repeat(60));
  logger.error(fail("Error Summary"));
  logger.error("-".repeat(60));
  unsuccessful.forEach(({ message }, index) => {
    if (unsuccessful.length === 1) {
      logr.error(message);
    }
    logr.error(`${index + 1}. ${message}`);
  });
};

export const logPushResults = (results: Sinc.PushResult[]): void => {
  logOperationResults(results, "Pushes");
};

export const logBuildResults = (results: Sinc.BuildResult[]): void => {
  logOperationResults(results, "Builds");
};
