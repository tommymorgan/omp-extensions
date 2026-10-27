# ADR 0005: Palette-command dispatch via manifest mirroring, registry + queues

**Date**: 2026-10-26
**Status**: accepted (delegated maintainer choices within the planning assignment; Tommy may override at plan review)
**Context**: plan `plans/2026-10-26-omp-palette-commands.md` — publish OMP slash commands into the Trailboss palette under an `omp:` namespace.

## Decision 1 — Manifest mirroring + bridge adapter (no trailboss Core changes)

Trailboss already supports manifest-backed discovery (`trailboss-plugin.toml` `[[actions]]`), owner-safe invocation (`plugin.action.invoke` carries the palette-captured `pane_id`), and manifest reload on `ui.command.list`. The extension generates and atomically replaces that manifest; a bridge executable is the manifest's command argv. No second palette catalog, no Core provider interface. Rejected: direct in-process live publication (requires new trailboss Core surface; Tommy deferred that to a possible later project).

## Decision 2 — Argument transport = pane-composer prefill

`plugin.action.invoke` has no argument field and trailboss's only input-adjacent action feature is `confirmation_fragment` (confirm gate, not text input) — verified in `crates/trailboss-runtime/src/app/api/plugins/{commands,manifest}.rs` at master `fdcbbed`. Dispatching an argument command (`/tan <work>`) therefore places `/<name> ` into the selected pane's omp composer via `setEditorText`, unsubmitted; the operator completes and submits in-context. Palette-side collection is revisited only if trailboss grows a parameter surface.

## Decision 3 — Dispatch = registry file + per-instance queue dirs

Each omp instance publishes `{pane_id, pid, session_id, queue_dir}` under a runtime state dir; the trailboss-spawned bridge resolves the target pane's entry, checks liveness, and writes the invocation request into that instance's queue; the owning extension consumes it and executes via `api.sendUserMessage` (bare commands) or the prefill path (argument commands). Chosen over per-instance Unix sockets (lifecycle churn on crash) and reporter-channel piggyback (couples palette dispatch to reporter versioning). Matches the plain-file precedents (cache-watch, restart journals).

## Decision 4 — Deny-list = `quit`, `delete` (user-extendable)

Session-terminal (`quit`, alias `q`) and session-destructive (`delete`) commands are never published, regardless of inventory. The list is settings-extendable without code change. Manifest refresh happens on catalog change and on instance start/stop, always as an atomic replace.

## Consequences

- All state is inspectable plain files; debugging = reading a directory.
- Crash cleanup needs a staleness sweep (PID check) since queues/registry entries can outlive a SIGKILLed instance.
- Argument commands take one extra step (finish typing in the pane) — accepted for zero Core changes.

## Revision 2026-10-26 — §2/§3 execution mechanism corrected (sendUserMessage falsified)

Task 1.2's boundary check falsified the original execution assumption: omp's extension `sendUserMessage` passes `expandPromptTemplates: false` (agent-session.ts, 18.12.1 source) — slash text is delivered to the model as chat, never executed; the extension surface exposes no `executeCommand`/`restart`. Runtime-confirmed twice on a throwaway session: no exec replacement. Typed `/restart` exec-replaces normally — the gap is extension-triggered execution only.

**Corrected mechanism (within this plan's constraints — no omp upstream changes, no trailboss Core changes):** the bridge dispatches by sending text into the selected pane via trailboss's existing session API (`pane.send_text`-equivalent): `"/<name>\n"` executes through omp's real input path with full TUI teardown; `"/<name> "` without a newline is the scope-B composer prefill. The per-instance dispatch queues are dropped. The instance registry stays: the bridge must verify the selected pane is a live omp instance (registry entry + PID alive) before typing — sending slash text into a non-omp pane would execute shell commands.

Rejected alternatives: (a) omp upstream `executeCommand` surface — cleanest long-term refinement, but outside this plan's authorized scope; revisit after this ships. (b) extension-side `pi-natives` `execReplace` replication — skips TUI teardown, version-fragile, terminal-corruption risk; rejected outright.

**Fix-pass amendment (review findings 1–4):** the instance registry is SESSION-SCOPED — `registry/<session>/<pane_id>.json` — because trailboss pane ids are per-session (`w1:p1` exists in every session); the bridge resolves the INVOKING session (from `HERDR_SESSION`, else derived from the session socket path) and requires a same-session entry before typing. Registry keys (session and pane) are validated against `[A-Za-z0-9:._-]` on both write and read, failing closed. The session-socket client clears its connect timer once connected (an in-flight response between the connect and response deadlines is not a connect failure) and decodes only complete newline-terminated byte-accumulated lines, so multi-byte characters split across chunk boundaries cannot silently drop a response after the pane text was delivered (double-send hazard).
