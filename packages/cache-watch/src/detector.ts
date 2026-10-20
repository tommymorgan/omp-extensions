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
  /** Top-level instruction fields are not message-list indices. */
  source?: 'system' | 'instructions';
}

/**
 * Injection ledger entry (CONTEXT.md "Injection event"): a context
 * contribution recorded read-only between two provider requests, tagged with
 * its source extension name.
 */
export interface InjectionRecord {
  requestNumber: number;
  source: string;
  content: string;
  contentHash: string;
  version?: string;
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

/** Candidates are correlated with changed wire content, not established causes. */
export type CollapseCause =
  | { kind: 'injection'; source: string; request: number; version?: string; contentHash?: string }
  | { kind: 'compaction'; benignKind: string; request: number }
  | { kind: 'none'; reason: 'unsupported-payload' | 'chained-input' | 'no-divergence' | 'no-matching-contributor' };

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
 * "immediately following" it (markers record at the last provider request
 * boundary, so the boundary spans marker+1 and marker+2). */
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

type FingerprintCoverage = 'complete' | 'partial' | 'unsupported';
type PrefixPart = { hash: string; text: string; messageIndex: number; source?: 'system' | 'instructions' };
type RequestSnapshot = { coverage: FingerprintCoverage; parts: PrefixPart[] };
const ATTRIBUTION_LOOKBACK_REQUESTS = 10;
const MAX_ATTRIBUTION_OBSERVATIONS = 64;

function hashOf(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Only text-bearing fields contribute to content matching; metadata is not inclusion. */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).join('\n');
  if (typeof value !== 'object' || value === null) return '';
  if ('text' in value && typeof value.text === 'string') return value.text;
  if ('content' in value) return textOf(value.content);
  return '';
}

function isWireContent(value: unknown): boolean {
  if (typeof value === 'string') return true;
  return Array.isArray(value) && value.every(part =>
    typeof part === 'object' && part !== null &&
    'type' in part && typeof part.type === 'string' &&
    (!['text', 'input_text', 'output_text'].includes(part.type) ||
      ('text' in part && typeof part.text === 'string')));
}

function isWireItem(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  if ('role' in value && typeof value.role === 'string' && 'content' in value) {
    return isWireContent(value.content);
  }
  // Responses tool calls/results and reasoning are typed input items, not messages.
  if (!('type' in value)) return false;
  switch (value.type) {
    case 'function_call':
      return 'call_id' in value && typeof value.call_id === 'string' &&
        'name' in value && typeof value.name === 'string' &&
        'arguments' in value && typeof value.arguments === 'string';
    case 'function_call_output':
      return 'call_id' in value && typeof value.call_id === 'string' &&
        'output' in value && (typeof value.output === 'string' || isWireContent(value.output));
    case 'reasoning':
      return 'summary' in value && Array.isArray(value.summary);
    case 'item_reference':
      return 'id' in value && typeof value.id === 'string';
    case 'compaction':
      return 'encrypted_content' in value && typeof value.encrypted_content === 'string';
    default:
      return false;
  }
}

function snapshotOf(payload: unknown): RequestSnapshot {
  const unsupported: RequestSnapshot = { coverage: 'unsupported', parts: [] };
  if (typeof payload !== 'object' || payload === null) return unsupported;
  if ('previous_response_id' in payload && payload.previous_response_id != null) {
    return { coverage: 'partial', parts: [] };
  }
  let messages: unknown[];
  if ('messages' in payload) {
    if (!Array.isArray(payload.messages) || !payload.messages.every(isWireItem)) return unsupported;
    messages = payload.messages;
  } else if ('input' in payload) {
    if (typeof payload.input === 'string') messages = [{ role: 'user', content: payload.input }];
    else if (Array.isArray(payload.input) && payload.input.every(isWireItem)) messages = payload.input;
    else return unsupported;
  } else return unsupported;
  const parts: PrefixPart[] = [];
  for (const source of ['system', 'instructions'] as const) {
    const content = source === 'system' && 'system' in payload ? payload.system :
      source === 'instructions' && 'instructions' in payload ? payload.instructions : null;
    if (content != null && !isWireContent(content)) return unsupported;
    // Fixed slots keep adding/removing instruction fields from shifting list indices.
    parts.push({ hash: hashOf(stableStringify(content ?? null)), text: textOf(content), messageIndex: 0, source });
  }
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex];
    parts.push({ hash: hashOf(stableStringify(message)), text: textOf(message), messageIndex });
  }
  return { coverage: 'complete', parts };
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

function contextVersionOf(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null || !('details' in message)) return undefined;
  const details = message.details;
  if (typeof details !== 'object' || details === null || !('version' in details)) return undefined;
  return typeof details.version === 'string' ? details.version : undefined;
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
  private previousParts: PrefixPart[] | null = null;
  private fingerprintCoverage: FingerprintCoverage = 'unsupported';
  private lastDivergence: DivergencePoint | null = null;
  private matchedContributor: InjectionRecord | null = null;
  /** Configured model (CONTEXT.md): what the session resolves to; never the fallback itself. */
  private configuredModel: string | null = null;
  /** Active fallback episode; null while the configured model is serving. */
  private fallbackEpisode: FallbackEpisode | null = null;
  /** The fallback banner is currently raised; tracks episode open/close. */
  private fallbackBannerUp = false;
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
            ? `; divergence at request ${this.lastDivergence.request} @ ${this.lastDivergence.source === undefined
              ? `message index ${this.lastDivergence.messageIndex}` : this.lastDivergence.source}`
            : '';
          const causeDetail =
            cause.kind === 'injection'
              ? `; correlated candidate: context contribution from source "${cause.source}"`
              : cause.kind === 'compaction'
                ? `; likely cause: compaction (${cause.benignKind} at request ${cause.request})`
                : `; attribution unavailable: ${cause.reason}`;
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
              fingerprintCoverage: this.fingerprintCoverage,
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
    // The banner clears when the episode ends (plan Task 4.2), without
    // restarting the session.
    if (this.fallbackBannerUp) {
      this.fallbackBannerUp = false;
      this.sink.fallbackBanner?.(null);
    }
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
      // A benignReset nulls the episode, so a persistent episode's banner
      // should be up — but if it is somehow down (defensive), restore it
      // without a repeat warning: the degradation is ongoing.
      if (!this.fallbackBannerUp) {
        this.fallbackBannerUp = true;
        this.sink.fallbackBanner?.(this.activeFallbackEpisode);
      }
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
    // Raise (or retarget) the banner with the episode: from → to for its
    // whole duration (ADR 0004); re-arms after a clear re-raise here.
    this.fallbackBannerUp = true;
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
    this.requestCount += 1;
    this.expireAttribution();
    const snapshot = snapshotOf(payload);
    this.fingerprintCoverage = snapshot.coverage;
    const previous = this.previousParts;
    this.previousParts = snapshot.coverage === 'complete' ? snapshot.parts : null;
    if (snapshot.coverage !== 'complete') {
      this.lastDivergence = null;
      this.matchedContributor = null;
      return;
    }
    if (previous === null) return;
    const parts = snapshot.parts;
    const shared = Math.min(previous.length, parts.length);
    for (let index = 0; index < shared; index++) {
      if (previous[index]!.hash !== parts[index]!.hash || previous[index]!.source !== parts[index]!.source) {
        this.recordDivergence(parts[index]!, previous[index]!);
        return;
      }
    }
    if (parts.length < previous.length) {
      const removed = previous[parts.length]!;
      this.recordDivergence({ ...removed, text: '' }, removed);
    }
  }

  private recordDivergence(part: PrefixPart, previous: PrefixPart): void {
    this.lastDivergence = {
      request: this.requestCount,
      messageIndex: part.messageIndex,
      ...(part.source === undefined ? {} : { source: part.source }),
    };
    this.matchedContributor = null;
    if (part.text === previous.text) return;
    let changedOffset = 0;
    while (changedOffset < part.text.length && changedOffset < previous.text.length &&
      part.text[changedOffset] === previous.text[changedOffset]) changedOffset += 1;
    for (const candidate of this.injections) {
      const age = this.requestCount - candidate.requestNumber;
      if (age < 0 || age > ATTRIBUTION_LOOKBACK_REQUESTS) continue;
      const start = part.text.lastIndexOf(candidate.content, changedOffset);
      if (start < 0 || changedOffset >= start + candidate.content.length) continue;
      if (this.matchedContributor === null || candidate.requestNumber > this.matchedContributor.requestNumber ||
        (candidate.requestNumber === this.matchedContributor.requestNumber &&
          (candidate.version !== undefined || this.matchedContributor.version === undefined))) {
        this.matchedContributor = candidate;
      }
    }
  }

  private expireAttribution(): void {
    while (this.injections.length > 0 &&
      this.requestCount - this.injections[0]!.requestNumber > ATTRIBUTION_LOOKBACK_REQUESTS) {
      this.injections.shift();
    }
    while (this.benignMarkers.length > 0 &&
      this.requestCount - this.benignMarkers[0]!.requestNumber > ATTRIBUTION_LOOKBACK_REQUESTS + COMPACTION_LOOKBACK_REQUESTS) {
      this.benignMarkers.shift();
    }
    if (this.lastDivergence !== null &&
      this.requestCount - this.lastDivergence.request > ATTRIBUTION_LOOKBACK_REQUESTS) {
      this.lastDivergence = null;
      this.matchedContributor = null;
    }
  }

  /** Publication is a candidate only; a later wire snapshot must prove inclusion. */
  recordPublication(source: string, content: string, version?: string): void {
    if (content.length === 0) return;
    const requestNumber = this.requestCount + 1;
    for (let index = this.injections.length - 1; index >= 0; index--) {
      const candidate = this.injections[index]!;
      if (candidate.requestNumber !== requestNumber) break;
      if (candidate.source === source && candidate.content === content && candidate.version === version) return;
    }
    if (this.injections.length >= MAX_ATTRIBUTION_OBSERVATIONS) this.injections.shift();
    this.injections.push({
      requestNumber,
      source, content, contentHash: hashOf(content),
      ...(version === undefined ? {} : { version }),
    });
  }

  /**
   * Preserve ordinary context observations. Publication events cover contributors
   * ordered after this context hook; neither observation alone proves wire inclusion.
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
      this.recordPublication(source, textOf(messages[index]), contextVersionOf(messages[index]));
    }
  }

  /** Compaction retains precedence unless a newer, wire-matched contributor exists. */
  private resolveCause(): CollapseCause {
    const divergence = this.lastDivergence;
    if (this.fingerprintCoverage === 'unsupported') return { kind: 'none', reason: 'unsupported-payload' };
    if (this.fingerprintCoverage === 'partial') return { kind: 'none', reason: 'chained-input' };
    if (divergence === null) return { kind: 'none', reason: 'no-divergence' };
    let compaction: { requestNumber: number; kind: string } | null = null;
    for (const marker of this.benignMarkers) {
      if (COMPACTION_KINDS[marker.kind] !== true) continue;
      const delta = divergence.request - marker.requestNumber;
      if (delta < 0 || delta > COMPACTION_LOOKBACK_REQUESTS) continue;
      if (compaction === null || marker.requestNumber >= compaction.requestNumber) {
        compaction = marker;
      }
    }
    const nearest = this.matchedContributor;
    if (nearest !== null && (compaction === null || nearest.requestNumber >= compaction.requestNumber)) {
      return {
        kind: 'injection', source: nearest.source, request: divergence.request,
        contentHash: nearest.contentHash,
        ...(nearest.version === undefined ? {} : { version: nearest.version }),
      };
    }
    if (compaction !== null) {
      return { kind: 'compaction', benignKind: compaction.kind, request: compaction.requestNumber };
    }
    return { kind: 'none', reason: 'no-matching-contributor' };
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
    this.previousParts = null;
    this.fingerprintCoverage = 'unsupported';
    this.lastDivergence = null;
    this.matchedContributor = null;
    this.injections.length = 0;
    this.contextMessageHashes = null;
    // ADR 0004: fallback episode state resets on session switch/compaction
    // like other rolling state; a later fallback opens a fresh episode.
    this.fallbackEpisode = null;
    // The episode ended, so its banner ends with it (symmetric with the
    // raise on open); a later applied event re-raises it.
    if (this.fallbackBannerUp) {
      this.fallbackBannerUp = false;
      this.sink.fallbackBanner?.(null);
    }
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
