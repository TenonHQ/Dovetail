import * as fs from "fs";
import * as path from "path";
import { format } from "winston";
import chalk from "chalk";

// Roll over to a fresh log file once the current one has had this many writes.
// Long-running sessions (e.g. `dove watch`) would otherwise grow a single
// debug log unbounded; capping at 200 writes per file keeps each one small.
const ROTATION_WRITE_LIMIT = 200;

class FileLogger {
  private logFilePath: string;
  private logStream: fs.WriteStream | null = null;
  private initialized: boolean = false;
  private writeCount: number = 0;

  constructor() {
    // Initialize on first use
    this.logFilePath = "";
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