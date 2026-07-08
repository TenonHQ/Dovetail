/**
 * Opt-in benchmark collector for `sinc refresh`. Wired into snClient via
 * setBenchmarkSink — when null (the default), there is zero overhead.
 *
 * PR #36 changed refresh from "download files absent from disk" to "bulk-download
 * every manifest file and compare before writing". That shifted the request
 * profile silently. This collector surfaces the numbers so regressions are
 * visible.
 */

export interface HttpSample {
  path: string;
  tableCount: number;
  durationMs: number;
  statusCode: number;
  responseBytes: number;
}

export interface ScopeSample {
  scopeName: string;
  wallTimeMs: number;
  httpRequests: number;
  filesWritten: number;
  filesUnchanged: number;
  totalResponseBytes: number;
}

export class BenchmarkCollector {
  private httpSamples: HttpSample[] = [];
  private scopeSamples: ScopeSample[] = [];
  private currentScope: {
    name: string;
    startedAt: number;
    httpStart: number;
    bytesStart: number;
  } | null = null;

  recordHttp(sample: HttpSample): void {
    this.httpSamples.push(sample);
  }

  startScope(scopeName: string): void {
    this.currentScope = {
      name: scopeName,
      startedAt: Date.now(),
      httpStart: this.httpSamples.length,
      bytesStart: this.totalBytes(),
    };
  }

  endScope(filesWritten: number, filesUnchanged: number): void {
    if (!this.currentScope) return;
    var scope = this.currentScope;
    this.scopeSamples.push({
      scopeName: scope.name,
      wallTimeMs: Date.now() - scope.startedAt,
      httpRequests: this.httpSamples.length - scope.httpStart,
      filesWritten: filesWritten,
      filesUnchanged: filesUnchanged,
      totalResponseBytes: this.totalBytes() - scope.bytesStart,
    });
    this.currentScope = null;
  }

  getHttpSamples(): HttpSample[] {
    return this.httpSamples.slice();
  }

  getScopeSamples(): ScopeSample[] {
    return this.scopeSamples.slice();
  }

  private totalBytes(): number {
    var total = 0;
    for (var i = 0; i < this.httpSamples.length; i++) {
      total += this.httpSamples[i].responseBytes;
    }
    return total;
  }

  formatSummary(): string {
    var lines: string[] = [];
    lines.push("");
    lines.push("=".repeat(72));
    lines.push("Refresh Benchmark");
    lines.push("=".repeat(72));

    if (this.httpSamples.length === 0) {
      lines.push("(no samples recorded)");
      return lines.join("\n");
    }

    var latencies = this.httpSamples
      .map(function (s) {
        return s.durationMs;
      })
      .sort(function (a, b) {
        return a - b;
      });
    var p50 = percentile(latencies, 0.5);
    var p95 = percentile(latencies, 0.95);
    var max = latencies[latencies.length - 1];
    var totalBytes = this.totalBytes();

    lines.push(
      "Overall: " +
        this.httpSamples.length +
        " HTTP requests, " +
        formatBytes(totalBytes) +
        " received",
    );
    lines.push(
      "Latency: p50 " + p50 + "ms | p95 " + p95 + "ms | max " + max + "ms",
    );

    if (this.scopeSamples.length > 0) {
      lines.push("");
      lines.push("Per-scope:");
      for (var i = 0; i < this.scopeSamples.length; i++) {
        var s = this.scopeSamples[i];
        lines.push(
          "  " +
            s.scopeName +
            ": " +
            s.wallTimeMs +
            "ms wall, " +
            s.httpRequests +
            " req, " +
            formatBytes(s.totalResponseBytes) +
            ", " +
            s.filesWritten +
            " written / " +
            s.filesUnchanged +
            " unchanged",
        );
      }
    }

    lines.push("=".repeat(72));
    return lines.join("\n");
  }
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  var idx = Math.min(sortedAsc.length - 1, Math.floor(sortedAsc.length * p));
  return sortedAsc[idx];
}

function formatBytes(n: number): string {
  if (n < 1024) return n + "B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + "KB";
  return (n / (1024 * 1024)).toFixed(2) + "MB";
}
