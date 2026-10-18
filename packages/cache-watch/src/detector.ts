import { createHash } from 'node:crypto';
import type { BannerState } from './banner.ts';


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

/**
 * A fallback episode (CONTEXT.md / ADR 0004): opened by a
 * retry_fallback_applied event (from → to, with reason) and ended when the
 * configured model serves a request again. Exactly one warning per episode.
 */
export interface FallbackEpisode {
  from: string;
  to: string;
  reason?: string;
}

export interface AlertSink {
  warn(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
  /**
   * Banner lifecycle output (plan Task 3.1): fired with the machine-readable
   * state when a collapse warning raises the banner, and with null when
   * recovery clears it. Optional so log-only sinks stay valid.
   */
  banner?(state: BannerState | null): void;
  /**
   * Fallback banner lifecycle (plan Task 4.2): fired with the episode when it
   * opens (or switches target) and with null when the episode ends — the
   * configured model serving again or a benign reset. Optional so log-only
   * sinks stay valid.
   */
  fallbackBanner?(episode: FallbackEpisode | null): void;
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

/** Benign markers that represent compaction (cause precedence, plan 2.2). */
const COMPACTION_KINDS: Record<string, true> = {
  session_compact: true,
  auto_compaction_start: true,
  auto_compaction_end: true,
};

/** Divergence requests this close after a compaction marker still count as
 * "immediately following" it (markers record at the last fingerprinted
 * request, so the boundary spans marker+1 and marker+2). */
const COMPACTION_LOOKBACK_REQUESTS = 2;

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

export function pct(value: number): string {
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
  private readonly benignMarkers: { requestNumber: number; kind: string }[] = [];
  private readonly responses: ResponseRecord[] = [];
  private baseline: number | null = null;
  private belowStreak = 0;
  private recoveredStreak = 0;
  private alertActive = false;
  /** A banner is currently raised (only warned alerts raise it, not suppressed ones). */
  private bannerUp = false;
  private benignSuppressed = false;
  private windowStart = 0;
  private readonly injections: InjectionRecord[] = [];
  private contextMessageHashes: Set<string> | null = null;
  private requestCount = 0;
  private previousMessageHashes: string[] | null = null;
  private lastDivergence: DivergencePoint | null = null;
  /** Configured model (CONTEXT.md): what the session resolves to; never the fallback itself. */
  private configuredModel: string | null = null;
  /** Active fallback episode; null while the configured model is serving. */
  private fallbackEpisode: FallbackEpisode | null = null;
  /** Last fallback target this session served through; survives benignReset
   * so a post-compaction serving model equal to it is never adopted as the
   * configured model. Cleared when a genuinely different model serves. */
  private lastFallbackTarget: string | null = null;

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
              : cause.kind === 'compaction'
                ? `; likely cause: compaction (${cause.benignKind} at request ${cause.request})`
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
          this.sink.banner?.({
            sessionId: this.sessionId,
            baseline: this.baseline,
            rate,
            cause,
          });
          this.bannerUp = true;
        }
      }
    } else if (rate >= ABSOLUTE_FLOOR) {
      this.belowStreak = 0;
      this.recoveredStreak += 1;
      if (this.recoveredStreak >= RECOVERY_EVALUATIONS) {
        this.alertActive = false;
        this.benignSuppressed = false;
        // Recovery clears a raised banner without restarting the session
        // (plan Task 3.1); suppressed alerts never raised one.
        if (this.bannerUp) {
          this.bannerUp = false;
          this.sink.banner?.(null);
        }
      }
    } else {
      this.belowStreak = 0;
      this.recoveredStreak = 0;
    }
  }

  /**
   * Serving model from the finalized assistant_message (AssistantMessage.model,
   * pi-ai 18.10.4 types.d.ts). While an episode is active, the fallback target
   * serving again keeps the episode and never becomes the configured model.
   * Any other model means the configured model is serving again (or the
   * session's resolution changed): the episode ends, re-arming alerting.
   */
  recordServingModel(model: string): void {
    // A model that has ever served as a fallback target is never adopted as
    // the configured model — a compaction (benignReset) clears the episode
    // while the fallback may still be serving, and adopting it here would
    // poison the baseline (review finding). Bootstrap limit: a session
    // restored mid-fallback sees its fallback as the first serving model and
    // there is no event to contradict it; documented in CONTEXT.md.
    if (this.fallbackEpisode === null) {
      if (model !== this.lastFallbackTarget) {
        this.configuredModel = model;
        this.lastFallbackTarget = null;
      }
      return;
    }
    if (model === this.fallbackEpisode.to) return;
    const target = this.fallbackEpisode.to;
    this.fallbackEpisode = null;
    this.lastFallbackTarget = target;
    if (model !== target) this.configuredModel = model;
    this.sink.debug(
      `cache-watch: "${model}" is serving in session "${this.sessionId}" ` +
        `(differs from fallback target "${target}"); fallback episode ended`,
      { sessionId: this.sessionId, model, fallbackTarget: target },
    );
  }

  /**
   * retry_fallback_applied (ADR 0004): the authoritative "configured model
   * couldn't be used" moment. Opens a fallback episode and logs its single
   * warning naming from, to, and the reason verbatim. While an episode is
   * active, further applied events for the same target only annotate — the
   * incident is a state, not an event-per-request. A different target is a
   * new degradation: a new episode with its own warning.
   */
  recordFallbackApplied(from: string, to: string, reason?: string): void {
    if (this.fallbackEpisode !== null && this.fallbackEpisode.to === to) {
      this.sink.debug(
        `cache-watch: fallback to "${to}" still active in session "${this.sessionId}"; no repeat warning`,
        { sessionId: this.sessionId, from, to, reason },
      );
      return;
    }
    this.fallbackEpisode = { from, to, reason };
    this.lastFallbackTarget = to;
    if (this.configuredModel === null) this.configuredModel = from;
    const reasonDetail = reason === undefined ? '' : ` (reason: ${reason})`;
    this.sink.warn(
      `cache-watch: model fallback in session "${this.sessionId}": requests are served by ` +
        `fallback model "${to}" instead of "${from}"${reasonDetail}`,
      { sessionId: this.sessionId, from, to, reason },
    );
    // Raise (or retarget) the banner with the episode: from → to (ADR 0004).
    this.sink.fallbackBanner?.(this.activeFallbackEpisode);
  }

  /** retry_fallback_succeeded only annotates (ADR 0004): confirms the fallback landed; never alerts. */
  recordFallbackSucceeded(model: string): void {
    this.sink.debug(
      `cache-watch: fallback request succeeded on "${model}" in session "${this.sessionId}"`,
      { sessionId: this.sessionId, model },
    );
  }

  /** Active fallback episode or null — the Task 4.2 banner seam (read-only copy). */
  get activeFallbackEpisode(): FallbackEpisode | null {
    return this.fallbackEpisode === null ? null : { ...this.fallbackEpisode };
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
   *
   * Best-effort by platform shape, documented honestly: the context event
   * fires per handler over the accumulated list, so an extension ordered
   * after this one injects after this snapshot and is invisible here; and
   * injections carried as system/user/assistant content changes (no custom
   * message) are not nameable. Such divergences surface without a named
   * cause rather than with a false one.
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
   * Cause lookup. Compaction and injection candidates are compared by
   * recency; the change nearest the divergence wins.
   *
   * 1. compaction — a benign marker of a compaction kind whose boundary
   *    window contains the divergence (the plan's "immediately follows"
   *    Given). Markers record at the last fingerprinted request, so the
   *    window allows divergence.request - marker.requestNumber in [0, 2].
   *    Non-compaction markers never mask a compaction candidate.
   * 2. nearest upstream injection — the ledger entry with the greatest
   *    requestNumber at or before the divergence request; ties go to the
   *    most recently recorded entry. An injection recorded after the
   *    compaction marker outranks it.
   * 3. otherwise "none recorded".
   */
  private resolveCause(): CollapseCause {
    const divergence = this.lastDivergence;
    if (divergence === null) return { kind: 'none' };
    let compaction: { requestNumber: number; kind: string } | null = null;
    for (const marker of this.benignMarkers) {
      if (COMPACTION_KINDS[marker.kind] !== true) continue;
      const delta = divergence.request - marker.requestNumber;
      if (delta < 0 || delta > COMPACTION_LOOKBACK_REQUESTS) continue;
      if (compaction === null || marker.requestNumber >= compaction.requestNumber) {
        compaction = marker;
      }
    }
    let nearest: InjectionRecord | null = null;
    for (const injection of this.injections) {
      if (injection.requestNumber > divergence.request) continue;
      if (nearest === null || injection.requestNumber >= nearest.requestNumber) {
        nearest = injection;
      }
    }
    if (nearest !== null && (compaction === null || nearest.requestNumber >= compaction.requestNumber)) {
      return { kind: 'injection', source: nearest.source, request: nearest.requestNumber };
    }
    if (compaction !== null) {
      return { kind: 'compaction', benignKind: compaction.kind, request: compaction.requestNumber };
    }
    return { kind: 'none' };
  }

  benignReset(kind: string): void {
    this.belowStreak = 0;
    this.recoveredStreak = 0;
    this.windowStart = this.responses.length;
    this.benignSuppressed = true;
    // The benign marker is kept for cause attribution: a later warning whose
    // divergence still follows this marker names it as the likely cause.
    this.benignMarkers.push({ requestNumber: this.requestCount, kind });
    // Compaction rewrites the message list for a benign reason; fingerprint
    // state must not carry a compaction-caused divergence into later alerts.
    this.previousMessageHashes = null;
    this.lastDivergence = null;
    // ADR 0004: fallback episode state resets on session switch/compaction
    // like other rolling state; a later fallback opens a fresh episode.
    this.fallbackEpisode = null;
    // A session switch is a display-context boundary: the TUI has already
    // wiped hook widgets (extension-ui-controller clearHookWidgets), so the
    // alert episode must end here — otherwise a switch back to a
    // still-collapsed session stays silent forever, because recovery is
    // impossible while collapsed. Compaction keeps its in-episode
    // suppression; only the switch ends the episode.
    if (kind === 'session_switch') {
      this.alertActive = false;
      this.benignSuppressed = false;
      if (this.bannerUp) {
        this.bannerUp = false;
        this.sink.banner?.(null);
      }
    }
    this.sink.debug(`cache-watch: benign reset (${kind}) recorded for session "${this.sessionId}"`);
  }
}
