import { createHash } from 'node:crypto';

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

/**
 * Divergence point carried in the warning detail (CONTEXT.md): the first
 * request whose message-prefix hash stops matching its predecessor's.
 */
export interface DivergencePoint {
  request: number;
  messageIndex: number;
}

/**
 * Injection ledger entry (CONTEXT.md "Injection event"): a context
 * contribution recorded read-only between two provider requests, tagged with
 * its source extension name.
 */
export interface InjectionRecord {
  requestNumber: number;
  source: string;
}

export interface AlertSink {
  warn(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
}

/**
 * Named cause carried in the warning (plan Task 2.2): precedence is
 * compaction marker, then nearest upstream injection, then "none recorded".
 */
export type CollapseCause =
  | { kind: 'injection'; source: string; request: number }
  | { kind: 'compaction'; benignKind: string; request: number }
  | { kind: 'none' };

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
 * Stable per-message serialization: object keys are sorted so a rebuild that
 * only reorders keys still hashes identically; `undefined` fields are dropped.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, field]) => field !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, field]) => `${JSON.stringify(key)}:${stableStringify(field)}`);
  return `{${entries.join(',')}}`;
}

/** Extracts the provider wire message list; null when the payload carries none. */
function extractMessages(payload: unknown): unknown[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  if (!('messages' in payload)) return null;
  return Array.isArray(payload.messages) ? payload.messages : null;
}

/**
 * Source name of an injected context message: custom-role messages are the
 * AgentMessage carrier extensions inject, identified by `customType`.
 */
function customTypeOf(message: unknown): string | null {
  if (typeof message !== 'object' || message === null) return null;
  if (!('role' in message) || message.role !== 'custom') return null;
  if (!('customType' in message)) return null;
  return typeof message.customType === 'string' ? message.customType : null;
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
  private windowStart = 0;
  private readonly injections: InjectionRecord[] = [];
  private contextMessageHashes: Set<string> | null = null;
  private requestCount = 0;
  private previousMessageHashes: string[] | null = null;
  private lastDivergence: DivergencePoint | null = null;

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

    const rate = windowRate(this.responses.slice(this.windowStart).slice(-WINDOW_SIZE));

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
          const cause = this.resolveCause();
          const divergenceDetail = this.lastDivergence
            ? `; divergence at request ${this.lastDivergence.request} @ message index ${this.lastDivergence.messageIndex}`
            : '';
          const causeDetail =
            cause.kind === 'injection'
              ? `; cause: nearest upstream injection from source "${cause.source}"`
              : `; cause: no context injection was recorded before the divergence`;
          this.sink.warn(
            `cache-watch: prompt-cache collapse in session "${this.sessionId}": ` +
              `rolling ${WINDOW_SIZE}-response cache-read rate ${pct(rate)} is below the ` +
              `${pct(ABSOLUTE_FLOOR)} floor and more than ${pct(RELATIVE_MARGIN)} below ` +
              `baseline ${pct(this.baseline)}${divergenceDetail}${causeDetail}`,
            {
              sessionId: this.sessionId,
              baseline: this.baseline,
              rate,
              floor: ABSOLUTE_FLOOR,
              margin: RELATIVE_MARGIN,
              divergence: this.lastDivergence,
              cause,
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

  /**
   * Prefix fingerprint taken at before_provider_request (ADR 0002: the
   * payload is hashed as received and never mutated). Records the first
   * message index whose hash differs from the same index in the previous
   * request; the first fingerprinted request has nothing to diverge from.
   */
  recordRequestPayload(payload: unknown): void {
    const messages = extractMessages(payload);
    if (messages === null) return;
    this.requestCount += 1;
    const hashes = messages.map(message =>
      createHash('sha256').update(stableStringify(message)).digest('hex'),
    );
    const previous = this.previousMessageHashes;
    this.previousMessageHashes = hashes;
    if (previous === null) return;
    // Only a changed or truncated prefix invalidates the prompt cache.
    // Appended messages (a longer list) preserve the predecessor prefix,
    // so they are never a divergence point.
    const shared = Math.min(previous.length, hashes.length);
    for (let index = 0; index < shared; index++) {
      if (previous[index] !== hashes[index]) {
        this.lastDivergence = { request: this.requestCount, messageIndex: index };
        return;
      }
    }
    if (hashes.length < previous.length) {
      this.lastDivergence = { request: this.requestCount, messageIndex: hashes.length };
    }
  }

  /**
   * Read-only injection ledger (ADR 0002): the context event fires before
   * each provider call with the assembled message list. A custom-role
   * message that was not in the previous snapshot — the carrier extensions
   * inject, identified by `customType` — is recorded as an injection
   * attributed to the upcoming request. Messages are hashed as received and
   * never mutated or suppressed.
   */
  recordContextMessages(messages: unknown): void {
    if (!Array.isArray(messages)) return;
    const hashes = messages.map(message =>
      createHash('sha256').update(stableStringify(message)).digest('hex'),
    );
    const previous = this.contextMessageHashes;
    this.contextMessageHashes = new Set(hashes);
    if (previous === null) return;
    for (let index = 0; index < messages.length; index++) {
      const source = customTypeOf(messages[index]);
      if (source === null || previous.has(hashes[index]!)) continue;
      this.injections.push({ requestNumber: this.requestCount + 1, source });
    }
  }

  /**
   * Cause lookup: the nearest upstream injection is the ledger entry with the
   * greatest requestNumber at or before the divergence request; ties go to
   * the most recently recorded entry. No divergence or no upstream entry
   */
  private resolveCause(): CollapseCause {
    const divergence = this.lastDivergence;
    if (divergence === null) return { kind: 'none' };
    let nearest: InjectionRecord | null = null;
    for (const injection of this.injections) {
      if (injection.requestNumber > divergence.request) continue;
      if (nearest === null || injection.requestNumber >= nearest.requestNumber) {
        nearest = injection;
      }
    }
    return nearest === null
      ? { kind: 'none' }
      : { kind: 'injection', source: nearest.source, request: nearest.requestNumber };
  }

  benignReset(kind: string): void {
    this.belowStreak = 0;
    this.windowStart = this.responses.length;
    this.benignSuppressed = true;
    // Compaction rewrites the message list for a benign reason; fingerprint
    // state must not carry a compaction-caused divergence into later alerts.
    this.previousMessageHashes = null;
    this.lastDivergence = null;
    this.sink.debug(`cache-watch: benign reset (${kind}) recorded for session "${this.sessionId}"`);
  }
}
