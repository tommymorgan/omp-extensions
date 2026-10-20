# Feature: Evidence-based cache-collapse attribution

**Created**: 2026-10-20
**Goal**: OMP reports observable cache-attribution coverage and request-matched contributor candidates instead of treating missing fingerprints as evidence that no guidance update occurred.
> Source: Tommy's approval, “Implement the recommended fix,” following Kizn investigation Item `01a15ac0-6594-71d9-8982-a398a2f9e2ce` and Raw Source `01a15abe-debe-754c-8a22-a4784cf8f8be`.
> Source PRD: none — bounded repair of the existing cache-watch behavior, not a new product PRD.
> PRD coverage: none — the approved repair requirements and scenarios below define the boundary.
> Plan home: repository
> Target repository: `git@github.com:tommymorgan/omp-extensions.git`
> Context: [CONTEXT.md](../CONTEXT.md) · [Read-only observer](../docs/adr/0002-read-only-observer.md)

## Slice 1: Diagnose provider-visible divergence without overclaiming causation

**Tracer bullet**: a changed, included Kizn snapshot in a full Codex Responses request produces a correlated contributor candidate in the actual warning/banner.
**Touches**: `packages/cache-watch/src/`, its behavioral tests, `features/cache-divergence-attribution.feature`, `features/cache-banner.feature`, and related code-local documentation.
**Off-limits**: OMP core, Kizn broadcast behavior, request/context mutation, collapse thresholds, fallback behavior, unrelated editor/eval-progress changes, live-agent reload/restart, publication and deployment.

### Task 1.1: Provider-aware coverage and request-matched attribution

> Depends on: none
> Shippable state: the complete observer still detects the same collapse/fallback episodes, but supports full messages/input payloads, exposes unsupported/chained coverage and names only bounded request-matched contributor candidates; no successor is needed to restore correctness.
> Boundary verification: run the complete cache-watch suite, focused type checks and a real installed-OMP fixture smoke showing a Codex-shaped request's correlated contributor banner and a distinct unsupported/partial diagnostic; observe normal recovery without modifying any live session.

The historical October18 plan and its DONE markers remain unchanged. This is one cohesive repair unit: provider extraction, evidence interpretation and the displayed diagnostic must agree at the boundary. Implementation work may be concurrent across files, not delivered as partially compatible layers.

<!-- DONE -->
# Living: features/cache-divergence-attribution.feature::Codex input reports a correlated contributor candidate
# Action: extends
# Status: DONE
# Living updated: YES
Scenario: Codex input reports a correlated contributor candidate
  Given a session with a healthy cache baseline and a named Kizn snapshot in its request prefix
  When an included changed snapshot is sent through full Responses input and the cache rate collapses
  Then the warning identifies the actual divergence and a request-matched Kizn contributor candidate
  And the attribution is described as correlation rather than proof of cache-loss causation

<!-- DONE -->
# Living: features/cache-divergence-attribution.feature::Top-level instruction changes participate in fingerprinting
# Action: extends
# Status: DONE
# Living updated: YES
Scenario: Top-level instruction changes participate in fingerprinting
  Given a supported provider request whose message list remains unchanged
  When its top-level system or instructions prefix changes before a collapse
  Then the warning identifies the changed prefix instead of reporting that no divergence was captured

<!-- DONE -->
# Living: features/cache-divergence-attribution.feature::Unsupported and chained requests expose incomplete coverage
# Action: extends
# Status: DONE
# Living updated: YES
Scenario: Unsupported and chained requests expose incomplete coverage
  Given a session with a healthy cache baseline
  When a collapse occurs on an unsupported payload or an append-only chained Responses request
  Then the diagnostic distinguishes unsupported from partial chained fingerprint coverage
  And it does not reuse an old complete-request fingerprint to invent a divergence or contributor
  And provider request boundaries still advance independently of successful extraction

<!-- DONE -->
# Living: features/cache-divergence-attribution.feature::A later publication is matched to the actual request
# Action: extends
# Status: DONE
# Living updated: YES
Scenario: A later publication is matched to the actual request
  Given cache-watch observes context before a Trailboss contributor publishes its snapshot
  When that snapshot appears at the changed prefix in the same session's outgoing request
  Then the warning can identify the contributor and its available version and content digest
  But a publication that is absent from the request or belongs to another session is not attributed
  And observing the publication does not accept or modify it

<!-- DONE -->
# Living: features/cache-divergence-attribution.feature::Old or unrelated contributors do not explain a later collapse
# Action: extends
# Status: DONE
# Living updated: YES
Scenario: Old or unrelated contributors do not explain a later collapse
  Given a Kizn update followed by thirty healthy provider requests
  When a later collapse follows an unrelated earlier message edit
  Then the warning does not name the old Kizn update as its contributor candidate
  And a candidate outside the bounded divergence window is not reused

<!-- DONE -->
# Living: features/cache-banner.feature::Attribution diagnostics distinguish missing evidence from a candidate
# Action: extends
# Status: DONE
# Living updated: YES
Scenario: Attribution diagnostics distinguish missing evidence from a candidate
  Given a watched interactive session with an active collapse episode
  When attribution has a correlated contributor, unsupported payload, chained partial coverage, no captured divergence or no matching contributor
  Then the banner distinguishes those evidence states rather than displaying generic none recorded
  And ordinary collapse recovery and the separate fallback banner keep their existing behavior

## Preservation and verification notes

- Keep the observer read-only: emitted request/context/publication objects must remain unchanged.
- Pure appended messages preserve the predecessor prefix; supported extraction must not turn them into a false divergence.
- Compaction and session changes retain their existing suppression/reset behavior. Retry fallback remains a separate episode.
- Never log contributor content. Diagnostic provenance is source, available version, digest and the actual request association.
- Retain at most 64 observations even when no provider requests advance; discard oldest evidence without accepting or modifying a publication.
- Regression cases are behavioral. Existing incidental-format or mock-forwarding assertions must not be re-pinned as substitutes for coverage.
- No live process may be restarted or reloaded merely to activate this repair. Build completion is a local verified bookmark, not publication or deployment.

## Verification evidence

- `bun test packages/cache-watch/test` within the full repository gate: 79 pass, 0 fail, 214 assertions across 12 files. Full repository: 122 pass, 0 fail, 316 assertions across 16 files.
- Full-project strict type check, including the declared OMP 18.10.4 SDK: `tsc -p tsconfig.json`, passed.
- The unchanged baseline detector fails the new request-ordinal/Responses divergence assertion: expected request 23 at index 0, received null. Additional failing-before/passing-after cases cover changed occurrences of previously present text, delayed context version retention and oldest-evidence eviction without losing recent matches during idle publication bursts.
- Nine isolated source mutations each caused behavioral assertion failures: Responses extraction, top-level prefix extraction, coverage classification, publication observation, attribution expiration, visible evidence states, changed-occurrence matching, delayed context version retention and idle retention. Candidate source was never mutated; scratch evidence: `/tmp/cache-watch-final-mutations-YBC58x`. The actual-detector idle witness retained 64 of 1,000 snapshots after repair, rather than all 1,000.
- Real installed OMP, isolated homes and loopback Responses SSE fixture: 35 interactive main turns and 38 total provider requests per run. Full-history input included the changed fixture snapshot, showed `correlated candidate "repair-fixture"` and cleared the banner on recovery (`/tmp/cache-watch-repair-smoke-nzfW9h`). Stateful Responses emitted genuine `previous_response_id` requests, showed `partial coverage` and cleared on recovery (`/tmp/cache-watch-repair-smoke-hq4I7m`).
- These are deterministic local provider fixtures, not evidence of real OpenAI cache behavior or proof that Kizn caused the original incident. No live session was restarted or reloaded.
- No repository-specific size budget applies. Keep the complete repair as one sequentially shippable review unit rather than inventing an Infilla size limit or a partially compatible layer split.
