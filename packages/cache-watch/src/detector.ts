/**
 * Hybrid cache-collapse detector (ADR 0001). Thresholds are named constants
 * in this single module; there is no config surface in the MVP.
 */
export const WINDOW_SIZE = 5;
export const BASELINE_MIN_RESPONSES = 20;
export const ABSOLUTE_FLOOR = 0.7;
export const RELATIVE_MARGIN = 0.15;
export const COLLAPSE_EVALUATIONS = 3;
export const RECOVERY_EVALUATIONS = 3;

/** Per-response token buckets needed for the cache-read rate. */
export interface TokenUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface AlertSink {
  warn(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
}

interface ResponseRecord {
  cacheRead: number;
  /** All non-cache-read input tokens: fresh input plus cache creation. */
  uncachedInput: number;
}

function rateOf(record: ResponseRecord): number {
  const denominator = record.cacheRead + record.uncachedInput;
  return denominator === 0 ? 1 : record.cacheRead / denominator;
}

function windowRate(window: ResponseRecord[]): number {
  let cacheRead = 0;
  let uncached = 0;
  for (const record of window) {
    cacheRead += record.cacheRead;
    uncached += record.uncachedInput;
  }
  const denominator = cacheRead + uncached;
  return denominator === 0 ? 1 : cacheRead / denominator;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * Per-session rolling state machine. Cold sessions (< BASELINE_MIN_RESPONSES)
 * have no frozen baseline and never alert. A benign reset suppresses alerting
 * (annotating instead) until a recovery re-arms detection.
 */
export class CacheWatchDetector {
  private readonly responses: ResponseRecord[] = [];
  private baseline: number | null = null;
  private belowStreak = 0;
  private recoveredStreak = 0;
  private alertActive = false;
  private benignSuppressed = false;

  constructor(
    private readonly sessionId: string,
    private readonly sink: AlertSink,
  ) {}

  recordResponse(usage: TokenUsage): void {
    this.responses.push({
      cacheRead: usage.cacheRead,
      uncachedInput: usage.input + usage.cacheWrite,
    });

    if (this.baseline === null && this.responses.length >= BASELINE_MIN_RESPONSES) {
      this.baseline = median(this.responses.slice(0, BASELINE_MIN_RESPONSES).map(rateOf));
    }
    if (this.baseline === null) return;

    const rate = windowRate(this.responses.slice(-WINDOW_SIZE));

    if (rate < ABSOLUTE_FLOOR && this.baseline - rate > RELATIVE_MARGIN) {
      this.belowStreak += 1;
      this.recoveredStreak = 0;
      if (this.belowStreak >= COLLAPSE_EVALUATIONS && !this.alertActive) {
        this.alertActive = true;
        if (this.benignSuppressed) {
          this.sink.debug(
            `cache-watch: collapse in session "${this.sessionId}" suppressed after benign reset`,
            { sessionId: this.sessionId, baseline: this.baseline, rate },
          );
        } else {

          this.sink.warn(
            `cache-watch: prompt-cache collapse in session "${this.sessionId}": ` +
              `rolling ${WINDOW_SIZE}-response cache-read rate ${pct(rate)} is below the ` +
              `${pct(ABSOLUTE_FLOOR)} floor and more than ${pct(RELATIVE_MARGIN)} below ` +
              `baseline ${pct(this.baseline)}`,
            {
              sessionId: this.sessionId,
              baseline: this.baseline,
              rate,
              floor: ABSOLUTE_FLOOR,
              margin: RELATIVE_MARGIN,
            },
          );
        }
      }
    } else if (rate >= ABSOLUTE_FLOOR) {
      this.belowStreak = 0;
      this.recoveredStreak += 1;
      if (this.recoveredStreak >= RECOVERY_EVALUATIONS) {
        this.alertActive = false;
        this.benignSuppressed = false;
      }
    } else {
      this.belowStreak = 0;
      this.recoveredStreak = 0;
    }
  }

  benignReset(kind: string): void {
    this.belowStreak = 0;
    this.benignSuppressed = true;
    this.sink.debug(`cache-watch: benign reset (${kind}) recorded for session "${this.sessionId}"`);
  }
}
