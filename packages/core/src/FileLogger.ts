import * as fs from "fs";
import * as path from "path";
import { format } from "winston";
import chalk from "chalk";

// Roll over to a fresh log file once the current one has had this many writes.
// Long-running sessions (e.g. `dove watch`) would otherwise grow a single
// debug log unbounded; capping at 200 writes per file keeps each one small.
const ROTATION_WRITE_LIMIT = 200;

// Truthy spellings accepted for the DOVETAIL_DEBUG env var.
const TRUTHY = /^(1|true|yes|on)$/i;

/**
 * @description Decide whether the file logger should write `dovetail-debug-*.log`
 * files to disk. File logging is OFF by default and only turns on when the user
 * explicitly opts in — either the `--debug` CLI flag (`--debug` or
 * `--debug=<truthy>`) or the `DOVETAIL_DEBUG` env var set to a truthy value.
 * Pure and side-effect free so it can be unit-tested with injected inputs.
 * @param {string[]} argv - CLI args after the node + script entries (process.argv.slice(2)).
 * @param {NodeJS.ProcessEnv} env - Environment map (defaults to an empty object).
 * @returns {boolean} true when file logging should be enabled.
 */
export function shouldEnableFileLogging(
  argv: string[] = [],
  env: NodeJS.ProcessEnv = {},
): boolean {
  const raw = typeof env.DOVETAIL_DEBUG === "string" ? env.DOVETAIL_DEBUG.trim() : "";
  if (TRUTHY.test(raw)) return true;

  const args = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--debug") return true;
    const eq = typeof arg === "string" ? arg.match(/^--debug=(.*)$/) : null;
    if (eq) return TRUTHY.test(eq[1].trim());
  }
  return false;
}

class FileLogger {
  private logFilePath: string;
  private logStream: fs.WriteStream | null = null;
  private initialized: boolean = false;
  private writeCount: number = 0;
  // File logging is opt-in — nothing touches disk unless this is true. Seeded
  // from `--debug` / DOVETAIL_DEBUG so a stray log file is never created just by
  // running a command; can also be flipped on at runtime via enable().
  private enabled: boolean;

  constructor() {
    // Initialize on first use
    this.logFilePath = "";
    this.enabled = shouldEnableFileLogging(
      Array.isArray(process.argv) ? process.argv.slice(2) : [],
      process.env,
    );
  }

  /**
   * Turn file logging on for this process (programmatic opt-in). Idempotent.
   */
  enable() {
    this.enabled = true;
  }

  /**
   * Whether file logging is currently active.
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Initialize the file logger in the current working directory
   */
  private initialize() {
    if (this.initialized) return;

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const logFileName = `dovetail-debug-${timestamp}.log`;

    // Create log file in the current working directory (ServiceNow folder)
    this.logFilePath = path.join(process.cwd(), logFileName);

    try {
      // Create or append to the log file
      this.logStream = fs.createWriteStream(this.logFilePath, { flags: 'a' });
      this.initialized = true;
      this.writeCount = 0;

      // Write header to log file — once, at the top of each (rotated) file
      this.writeToFile(`\n${"=".repeat(80)}`);
      this.writeToFile(`Dovetail Debug Log - Started at ${new Date().toISOString()}`);
      this.writeToFile(`Log file: ${this.logFilePath}`);
      this.writeToFile(`Working directory: ${process.cwd()}`);
      this.writeToFile(`${"=".repeat(80)}\n`);

      // Also log to console
      console.log(chalk.cyan(`📝 Debug logging enabled: ${this.logFilePath}`));
    } catch (error) {
      console.error(chalk.red(`Failed to create log file: ${error}`));
    }
  }

  /**
   * Close the current log file and start a new one once it has reached
   * ROTATION_WRITE_LIMIT writes. Keeps any single debug log from growing huge
   * during long watch sessions.
   */
  private rotateIfNeeded() {
    if (!this.initialized) return;
    if (this.writeCount < ROTATION_WRITE_LIMIT) return;

    if (this.logStream && this.logStream.writable) {
      const timestamp = new Date().toISOString();
      this.logStream.write(`[${timestamp}] ${"=".repeat(80)}\n`);
      this.logStream.write(`[${timestamp}] Log rotated after ${ROTATION_WRITE_LIMIT} writes — continues in a new file\n`);
      this.logStream.write(`[${timestamp}] ${"=".repeat(80)}\n`);
    }
    if (this.logStream) {
      this.logStream.end();
      this.logStream = null;
    }
    this.initialized = false;
    this.initialize();
  }

  /**
   * Write a message to the log file
   */
  private writeToFile(message: string) {
    // Opt-in gate: without --debug / DOVETAIL_DEBUG we never create or write a
    // log file. Console output (info/warn/error/success) still happens because
    // those methods log to the console before calling writeToFile.
    if (!this.enabled) return;

    if (!this.initialized) {
      this.initialize();
    } else {
      this.rotateIfNeeded();
    }

    if (this.logStream && this.logStream.writable) {
      const timestamp = new Date().toISOString();
      this.logStream.write(`[${timestamp}] ${message}\n`);
      this.writeCount++;
    }
  }

  /**
   * Format a message for both console and file output
   */
  private formatMessage(level: string, message: string, ...args: any[]): string {
    let fullMessage = message;
    
    // If there are additional arguments, stringify them
    if (args.length > 0) {
      const additionalInfo = args.map(arg => {
        if (typeof arg === 'object') {
          try {
            return JSON.stringify(arg, null, 2);
          } catch {
            return String(arg);
          }
        }
        return String(arg);
      }).join(' ');
      
      fullMessage = `${message} ${additionalInfo}`;
    }
    
    return fullMessage;
  }

  /**
   * Debug level logging - file only, no console output
   */
  debug(message: string, ...args: any[]) {
    const formattedMessage = this.formatMessage('DEBUG', message, ...args);
    this.writeToFile(`[DEBUG] ${formattedMessage}`);
  }

  /**
   * Info level logging
   */
  info(message: string, ...args: any[]) {
    const formattedMessage = this.formatMessage('INFO', message, ...args);
    
    // Write to console with color
    console.log(chalk.blue(message), ...args);
    
    // Write to file
    this.writeToFile(`[INFO] ${formattedMessage}`);
  }

  /**
   * Warning level logging
   */
  warn(message: string, ...args: any[]) {
    const formattedMessage = this.formatMessage('WARN', message, ...args);
    
    // Write to console with color
    console.log(chalk.yellow(message), ...args);
    
    // Write to file
    this.writeToFile(`[WARN] ${formattedMessage}`);
  }

  /**
   * Error level logging
   */
  error(message: string, ...args: any[]) {
    const formattedMessage = this.formatMessage('ERROR', message, ...args);
    
    // Write to console with color
    console.error(chalk.red(message), ...args);
    
    // Write to file
    this.writeToFile(`[ERROR] ${formattedMessage}`);
  }

  /**
   * Success level logging
   */
  success(message: string, ...args: any[]) {
    const formattedMessage = this.formatMessage('SUCCESS', message, ...args);
    
    // Write to console with color
    console.log(chalk.green(message), ...args);
    
    // Write to file
    this.writeToFile(`[SUCCESS] ${formattedMessage}`);
  }

  /**
   * Close the log file stream
   */
  close() {
    if (this.logStream) {
      this.writeToFile(`\n${"=".repeat(80)}`);
      this.writeToFile(`Log session ended at ${new Date().toISOString()}`);
      this.writeToFile(`${"=".repeat(80)}\n`);
      
      this.logStream.end();
      this.logStream = null;
      this.initialized = false;
    }
  }

  /**
   * Get the path to the current log file
   */
  getLogFilePath(): string {
    return this.logFilePath;
  }
}

// Create singleton instance
const fileLogger = new FileLogger();

// Export the logger instance
export { fileLogger };

// Also export a function to replace console.log globally
export function enableFileLogging() {
  // Opt in to file logging even if neither --debug nor DOVETAIL_DEBUG was set.
  fileLogger.enable();

  // Store original console.log
  const originalConsoleLog = console.log;
  
  // Override console.log to also write to file
  console.log = function(...args: any[]) {
    // Call original console.log
    originalConsoleLog.apply(console, args);
    
    // Also write to file
    const message = args.map(arg => {
      if (typeof arg === 'object') {
        try {
          return JSON.stringify(arg, null, 2);
        } catch {
          return String(arg);
        }
      }
      return String(arg);
    }).join(' ');
    
    fileLogger.debug(message);
  };
  
  // Log that file logging is enabled
  fileLogger.info('File logging has been enabled for this session');
}