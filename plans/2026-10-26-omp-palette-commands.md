# Feature: OMP slash commands in the Trailboss command palette

**Created**: 2026-10-26
**Goal**: From the Trailboss palette, Tommy can discover and invoke OMP slash commands under an `omp:` namespace, executing in the OMP instance attached to the selected pane.

> Source PRD: none (feature seed from Tommy + trailboss capability answer 2026-10-26; plan without PRD is allowed — no coverage ledger extracted)
> Plan home: this repository (plans/, docs/adr/, CONTEXT.md)
> Target repository: tommymorgan/omp-extensions
> Status: BUILD IN PROGRESS — Task 1.1 done; execution mechanism revised to bridge pane send-text (ADR 0005 Revision) after Task 1.2 falsified sendUserMessage execution

## Established facts (verified 2026-10-26)

- Trailboss plugin contract (master fdcbbed): plugin dir + `trailboss-plugin.toml` with `[[actions]]` (id, title, command argv); titles render verbatim → `omp: restart` namespaces itself; `plugin.link {path, enabled:true}` auto-registers actions into `plugin.action.list`/`ui.command.list`; manifest file replace + `ui.command.list` refresh reloads disk manifests; 2 MiB total publication budget; action ids ≤120 chars `[A-Za-z0-9:._-]` (no `/`).
- `plugin.action.invoke {plugin_id, action_id, context}` carries the palette-captured pane_id in context; NO argument field exists. Bridge receives `HERDR_PLUGIN_ACTION_ID` + `HERDR_PLUGIN_CONTEXT_JSON` env when spawned via manifest argv.
- omp extension API: `api.getCommands()` returns the session's full slash-command catalog; extensions may open sockets, timers, `api.exec()`. ~~`sendUserMessage` executes slash text~~ FALSIFIED 2026-10-26 (Task 1.2 evidence, plan line 69): `sendUserMessage` passes `expandPromptTemplates: false` — slash text goes to the model as chat; no extension command-execution surface exists. Execution therefore rides omp's real input path via trailboss pane send-text (ADR 0005 Revision).
- Trailboss has NO plugin-action argument collection: `plugin.action.invoke` carries no args, and the only input-adjacent action feature is `confirmation_fragment` (a confirm gate, not text input) — verified in `crates/trailboss-runtime/src/app/api/plugins/{commands,manifest}.rs` 2026-10-26. Palette-side argument collection would be a trailboss Core change, excluded by the no-Core-changes decision (ADR 0005 §1).

## Open decisions (interview)

All interview decisions are resolved; technical decisions and rationale live in `docs/adr/0005-palette-command-dispatch.md`:

1. **Scope B (Tommy, 2026-10-26)** — typed-argument commands are in the MVP.
2. **Argument transport = pane-composer prefill** (ADR 0005 §2).
3. **Dispatch = instance registry + bridge pane send-text** (ADR 0005 §3 + Revision; per-instance queues dropped).
4. **Deny-list = `quit`, `delete`, user-extendable; atomic manifest refresh on catalog change and instance start/stop** (ADR 0005 §4).

## Domain terms

Defined in `CONTEXT.md` § palette-commands (command inventory, bare-invocable, argument command, aggregated manifest, pane send-text dispatch, deny-list). This plan links to them; it does not inline them.

## Slice 1: One command, palette-visible (tracer bullet)

**Tracer bullet**: `omp: restart` appears in trailboss `ui.command.list`; invoking it from a pane-selected palette produces a dispatch artifact consumed by that pane's extension.
**Touches**: new package `packages/palette-commands/` (extension + bridge), trailboss plugin dir generation.
**Off-limits**: omp upstream (~/src/oh-my-pi), trailboss upstream, existing packages (editor, kizn-guidance).

### Task 1.1: Static manifest + bridge skeleton
<!-- estimate: ~150 reviewable lines | feature-files: features/palette-commands.feature | demoable: yes -->
> Depends on: none
> Shippable state: repo contains the package; a hand-written manifest links into a local trailboss and lists `omp: restart`; bridge argv runs, logs its env context, exits 0.
> Boundary verification: with the plugin linked, `ui.command.list` shows `omp: restart`; invoking it from a selected pane logs `HERDR_PLUGIN_CONTEXT_JSON` containing that pane_id.
> Boundary evidence (2026-10-26, commit 05adf9ec): throwaway trailboss 0.9.3 server (session palette-smoke-1, env-stripped) — plugin.link accepted the generated manifest (root incl. `min_herdr_version = "0.9.3"`); `plugin.action.list` contains `title "omp: restart"`; `plugin.action invoke restart` spawned the bridge (log plugin-log-1: status succeeded, exit_code 0) whose stdout logged `{"action_id":"restart","context":{…,"focused_pane_id":"w1:p1",…}}`. First link attempt exposed missing `min_herdr_version` (error `invalid_plugin_min_herdr_version`) — fixed in 05adf9ec with test pin.

<!-- DONE -->
# Living: features/palette-commands.feature::Palette lists a published omp command
# Action: creates
# Status: DONE
# Living updated: YES
Scenario: Palette lists a published omp command
  Given a trailboss plugin dir for plugin id "omp" with action "restart" titled "omp: restart" is linked and enabled
  When the command palette catalog is listed via ui.command.list
  Then an entry with title "omp: restart" and plugin identity {kind: plugin, plugin_id: "omp"} is present

<!-- DONE -->
# Living: features/palette-commands.feature::Bridge receives selected pane context
# Action: creates
# Status: DONE
# Living updated: YES
Scenario: Bridge receives selected pane context
  Given the omp plugin is linked and a pane running omp is selected
  When the palette invokes plugin action "restart"
  Then the bridge process receives HERDR_PLUGIN_ACTION_ID "restart" and HERDR_PLUGIN_CONTEXT_JSON containing the selected pane's pane_id

### Task 1.2: Bridge dispatches slash text to the verified pane
<!-- estimate: ~120 reviewable lines | feature-files: features/palette-commands.feature | demoable: yes -->
> Depends on: Task 1.1
> Shippable state: extension publishes its instance registry entry `{pane_id, pid, session_id}` (queue dirs dropped); bridge resolves the context pane_id via the registry, verifies the PID is alive, and sends `"/restart\n"` to that pane through the trailboss session socket; dead/unregistered pane → nonzero exit, nothing sent.
> Boundary verification: throwaway trailboss session with a real omp pane running the extension; invoke the bridge with that pane's context → same PID alive, `/proc/<pid>/maps` stack region changed, session id preserved; stale registry entry → nonzero exit, no text sent.
> Boundary evidence (2026-10-26, revised mechanism): VERIFIED on throwaway session palette-smoke-2 (omp 18.13.0). Bridge run with `PALETTE_TRAILBOSS_SOCKET` + context `{"focused_pane_id":"w1:p1"}` + action `restart`: envelope logged, exit 0, `pane.send_input {text:"/restart",keys:["Enter"]}` → SAME pid 2819306 alive, `/proc/<pid>/maps` `[stack]` re-randomized 7ffead7d6000→7ffd995f0000 (exec replacement), durable session preserved (trailboss still binds the pane to session file `…01a17b03-3919….jsonl`; per-instance registry session_id suffix rotates across restart — harmless, dispatch keys are pane_id+pid). Negative: hand-crafted dead-PID entry for w9:p9 → stderr refusal, exit 5, live pane stack unchanged — nothing sent.
> Boundary evidence (2026-10-26, fix pass — findings 1–4): RE-VERIFIED on throwaway session palette-smoke-2 after the session-scoping rework. Extension published `registry/palette-smoke-2/w1:p1.json` (session derived from the pane's socket path; HERDR_SESSION absent). Bridge with that pane's context (HERDR_SESSION unset → session derived from `PALETTE_TRAILBOSS_SOCKET`): envelope logged, exit 0 → SAME pid 3305106 alive, `[stack]` re-randomized 7ffffffb9000→7ffd87bb000-range (exec replacement), durable session preserved. Live cross-session gate proof: the same bridge run from a shell leaking `HERDR_SESSION=daily` refused with exit 4 ("no instance registry entry for pane w1:p1 in session daily") — finding 1's security property demonstrated in the real runtime. Stale dead-PID entry w9:p9 → exit 5, refusal, live pane stack unchanged.
> Boundary evidence (2026-10-26, omp 18.13.0 on throwaway trailboss session palette-smoke-2): BLOCKED — `pi.sendUserMessage` cannot execute slash commands in this build. Source (18.12.1 checkout): `AgentSession.sendUserMessage` passes `expandPromptTemplates: false` ("skip command handling", agent-session.ts:9273) and the TUI extension action routes to the same method (extension-ui-controller.ts:1442); the Extension API exposes no command-execution surface (live surface dumps; no `ctx.restart`, no `executeCommand`). Runtime: queue dispatch consumed and `/restart` delivered to the model as chat (stack unchanged, no exec; twice); terminal-typed `/restart` exec-replaces (pid 2009368 preserved, `[stack]` re-randomized, 275-line maps rebuild) — the scenario's Then-clause is unreachable through the planned mechanism. Needs a mechanism decision (omp-side execution API, or an accepted replication of `ctx.restart()` internals) before this scenario can truthfully flip DONE.

<!-- DONE -->
# Living: features/palette-commands.feature::Dispatch executes the slash command in the owning instance
# Action: creates
# Status: DONE
# Living updated: YES
Scenario: Dispatch executes the slash command in the owning instance
  Given an omp instance running the palette-commands extension
  When the bridge sends "/restart\n" to that pane through the trailboss session socket, after verifying its registry entry
  Then the omp process exec-replaces itself (PID unchanged, stack changed) while preserving session id

## Slice 2: Live catalog sync (aggregation)

**Tracer bullet**: two omp instances publish their inventories; the manifest is the stable union; palette shows it.
**Touches**: packages/palette-commands (aggregator), manifest writer.
**Off-limits**: omp upstream, trailboss upstream.

### Task 2.1: Inventory publish + manifest aggregation
<!-- estimate: ~180 reviewable lines | feature-files: features/palette-commands.feature | demoable: yes -->
> Depends on: Task 1.1
> Shippable state: each extension publishes its inventory (deny-list filtering arrives in Task 4.1) to a registry file; an aggregator produces the atomic manifest replace; restart of one instance does not lose the other's commands.
> Boundary verification: with instances A and B publishing disjoint commands, generated manifest lists the union; kill B, regenerate → A's commands remain.
> Boundary evidence (2026-10-26, commits 24312954 + d90d3856, throwaway session palette-smoke-3): two real omp panes (w1:p1 pid 4118163, w1:p2 pid 4121063) published session-scoped registry entries carrying full inventories; the aggregator emitted 322 actions / 113 KB (well under the 2 MiB budget) including instance-B-unique commands (agent-mail-work, i-have-adhd); after SIGKILL of B's omp, re-aggregation emitted 318 actions with B-unique commands gone and A's retained (autoresearch present). `action-map.json` written alongside the manifest.
> Fix-pass boundary evidence (2026-10-26, commit 84397b00, throwaway session palette-smoke-3): manifest now carries min_herdr_version "0.9.0" and `trailboss plugin link` ACCEPTS it (pre-fix the runtime rejected the link); two omp panes (w2:p1 /tmp, w3:p1 /tmp/p21b) published inventories including BUILTINS via the host's builtin-registry import — `plugin action list --plugin omp` showed "omp: restart" and "omp: model"; a `.omp/commands/b-only.md` file command published with its real argumentHint ("<work>" in the action description); after SIGKILL of pane B, re-aggregation emitted 438 actions with b-only gone and both builtins retained. 443→438 action delta matches B-unique commands (b-only, agent-mail-label, agent-mail-work, history-scope, i-have-adhd).

<!-- DONE -->
# Living: features/palette-commands.feature::Aggregated manifest is the union of live instances
# Action: creates
# Status: DONE
# Living updated: YES
Scenario: Aggregated manifest is the union of live instances
  Given omp instance A publishes command "restart" and instance B publishes command "model"
  When the aggregated manifest is regenerated
  Then it contains actions for both "omp: restart" and "omp: model"
  And regenerating after instance B exits still contains "omp: restart"

<!-- DONE -->
# Living: features/palette-commands.feature::Argument-requiring commands publish
# Action: creates
# Status: DONE
# Living updated: YES
Scenario: Argument-requiring commands publish
  Given an instance whose inventory contains argument command "tan" that requires typed work text
  When the aggregated manifest is generated
  Then an action titled "omp: tan" is present and its description carries the usage hint "<work>"

## Slice 3: End-to-end invocation through the bridge

**Tracer bullet**: pick `omp: restart` in the palette with pane selected → that pane's omp restarts.
**Touches**: bridge pane send-text dispatch, registry verification, staleness checks.
**Off-limits**: omp upstream, trailboss upstream.

### Task 3.1: Bridge maps pane_id to instance and dispatches
<!-- estimate: ~120 reviewable lines | feature-files: features/palette-commands.feature | demoable: yes -->
> Depends on: Tasks 1.2, 2.1
> Shippable state: bridge reads HERDR_PLUGIN_CONTEXT_JSON, resolves pane_id via the registry, verifies PID liveness, sends the slash text to that pane via the trailboss session socket; stale/dead pane → nonzero exit with clear error, nothing sent.
> Boundary verification: invoke from palette on live pane → restart happens in that pane; invoke with stale registry entry → no execution, bridge error output.
> Boundary evidence (2026-10-27, throwaway session palette-smoke-3): with the aggregated plugin dir linked (--enabled) and workspace w2 focused, `plugin action invoke restart --plugin omp` spawned the bridge from the manifest argv; the plugin log captured the real context shape (focused_pane_id w2:p1, workspace/tab/cwd/agent fields) and the bridge exited 0. Target pane w2:p1 omp (pid 649303) exec-replaced: SAME pid and /proc starttime, /proc/<pid>/maps md5 changed 18c4f05d→cb2031f5, registry re-published with the same pid (session preserved). Other pane w3:p1 (pid 653166) untouched: pid, starttime and maps hash all unchanged.

<!-- DONE -->
# Living: features/palette-commands.feature::Palette invocation restarts the selected pane's omp
# Action: creates
# Status: DONE
# Living updated: YES
Scenario: Palette invocation restarts the selected pane's omp
  Given two omp instances in different panes and the plugin linked with action "restart"
  When the palette invokes plugin action "restart" with pane P selected
  Then only the omp instance attached to pane P exec-replaces itself
  And the other instance is unchanged

> Stale-negative evidence (2026-10-27, same session): after SIGKILL of pane w3:p1's omp (pid 653166, no shutdown → registry entry left stale) and focusing w3, `plugin action invoke restart --plugin omp` exited code 5 "stale registry entry for pane w3:p1 (pid 653166 is dead); refusing to dispatch" — nothing sent: pane w2:p1's omp (pid 649303) kept an identical /proc maps hash across the negative.

<!-- DONE -->
# Living: features/palette-commands.feature::Stale pane entry is rejected
# Action: creates
# Status: DONE
# Living updated: YES
Scenario: Stale pane entry is rejected
  Given a registry entry whose PID no longer exists
  When the bridge resolves that pane_id
  Then no text is sent and the bridge exits nonzero with an error naming the stale pane

### Task 3.2: Argument-command transport via composer prefill
<!-- estimate: ~80 reviewable lines | feature-files: features/palette-commands.feature | demoable: yes -->
> Depends on: Tasks 2.1, 3.1
> Shippable state: picking an argument command sends `"/<name> "` (no trailing newline) to the selected pane via pane send-text, landing in the omp composer unsubmitted; nothing executes until the operator submits.
> Boundary verification: invoke "omp: tan" from a pane-selected palette; the selected pane's composer contains "/tan " with no turn started; other panes unchanged.

> Boundary evidence (2026-10-27, throwaway session palette-smoke-3): a real file command `.omp/commands/tan.md` (argument-hint `<work>`) published with its hint; `prefill-actions.json` marked `tan: true`. With w2 focused, `plugin action invoke tan --plugin omp` exited 0 (stderr: "action tan -> /tan sent to pane w2:p1 (session palette-smoke-3)"). `pane read w2:p1` showed the omp composer holding `❯ /tan <work>` UNSUBMITTED — agent status idle, pid 979709 and maps hash unchanged (no turn, no exec-replace). Other pane w3:p1 (pid 981205): composer empty, status idle, maps hash unchanged.

<!-- DONE -->
# Living: features/palette-commands.feature::Argument command prefills the selected pane's composer
# Action: creates
# Status: DONE
# Living updated: YES
Scenario: Argument command prefills the selected pane's composer
  Given an instance whose inventory includes argument command "tan" and the plugin linked with action "tan"
  When the palette invokes plugin action "tan" with pane P selected
  Then the omp attached to pane P shows "/tan " in its input composer, unsubmitted
  And no agent turn starts until the operator submits it

## Slice 4: Lifecycle, safety, and refresh

**Tracer bullet**: kill an omp; its commands leave the manifest; deny-listed commands never publish.
**Touches**: extension session_shutdown handler, registry cleanup, deny-list config.
**Off-limits**: omp upstream, trailboss upstream.

### Task 4.1: Lifecycle cleanup and safety filter
<!-- estimate: ~150 reviewable lines | feature-files: features/palette-commands.feature | demoable: yes -->
> Depends on: Tasks 2.1, 3.1
> Shippable state: extension removes its registry entries on session_shutdown; deny-list excludes configured commands from publication; manifest regenerates on catalog change.
> Boundary verification: after SIGKILL + cleanup sweep, stale registry entries are pruned; /quit (deny-listed) never appears in the manifest.
> Refresh design as shipped (2026-10-27): instance-lifecycle triggers only — each extension re-aggregates under a cross-process lockfile (`<stateDir>/aggregate.lock`, O_EXCL create, holder pid recorded, stale holders taken over by pid liveness, live holders skipped since their fleet-wide aggregation subsumes ours) right after publishing (session_start) and after shutdown-removal. No daemon, no timers; the CLI aggregator remains the manual path. Inventory publishes at session start only: the 18.13 host exposes no cheap catalog-change signal to extensions (checked the extension event surface; none matches), and in practice skills/commands load before session_start — a documented limitation, not a silent gap.
> Boundary evidence (2026-10-27, throwaway session palette-smoke-3): the manifest auto-refreshed from instance lifecycle triggers alone (no CLI run — plugin dir materialized after both panes' session_start). (a) Default deny-list live: `omp: quit` and `omp: delete` absent from plugin.action.list while `omp: restart` and B-only `omp: bmark` present. (b) deny-list.txt + `bmark` → re-aggregate → `omp: bmark` gone, `omp: restart` retained; deleting the file restored `omp: bmark`. (c) Graceful: `pane close w3:p1` → B's registry entry removed by session_shutdown and the lifecycle-triggered re-aggregation dropped `omp: bmark` (restart retained). (d) SIGKILL of A (pid 1273989) left w2:p1.json stale; the next CLI aggregation PRUNED it (registry left empty) and emitted a valid zero-action manifest.
<!-- DONE -->
# Living: features/palette-commands.feature::Deny-listed commands never publish
# Action: creates
# Status: DONE
# Living updated: YES
Scenario: Deny-listed commands never publish
  Given the deny-list contains "quit" and an instance's inventory includes it
  When the aggregated manifest is generated
  Then no action for "omp: quit" is present

<!-- DONE -->
# Living: features/palette-commands.feature::Instance shutdown removes its published commands
# Action: creates
# Status: DONE
# Living updated: YES
Scenario: Instance shutdown removes its published commands
  Given instance B publishes command "model" and the manifest includes it
  When instance B shuts down and the manifest regenerates
  Then "omp: model" is absent from the manifest and other instances' actions remain

<!-- DONE -->
# Living: features/palette-commands.feature::Killed instance's stale entries are swept
# Action: creates
# Status: DONE
# Living updated: YES
Scenario: Killed instance's stale entries are swept
  Given a registry entry for an instance that was SIGKILLed and did not run session_shutdown
  When the cleanup sweep runs
  Then the dead entry is pruned and live instances' entries remain

## Delivery review fix pass (2026-10-27)

Canonical Superpowers review (Kizn Code review procedure r17) over the full feature (main b68c1086 → task-4.1 head) returned 11 findings (6 P1, 5 P2), verdict "not ready to merge". All 11 verified against omp/trailboss/herdr source and fixed in one pass; suite 210/210 repo-wide (+20 tests).

Fixes (finding → change):
1. Headless publish guard — `session_start` returns unless `ctx.hasUI === true` (omp's task executor rebinds parent extension factories into headless children with `hasUI: false` and inherited pane env; verified oh-my-pi executor.ts:529-530/4496 + runtime-init.ts:51-52). Shutdown removal is additionally pid-guarded (removes only its own entry).
2. Socket-bound session identity — the invoking session is derived from the SELECTED socket path; an explicit `HERDR_SESSION` that disagrees refuses dispatch (exit 8). Trailboss routes `pane.send_input` within the connected socket's session.
3. Process-incarnation liveness — registry entries record `/proc/<pid>/stat` field 22 (starttime); aggregation and dispatch verify pid alive AND same incarnation (a recycled pid never verifies). Pre-upgrade entries without the field fall back to existence.
4. Composer draft protection — every dispatch first sends a keys-only clearing sequence: `ctrl+u` (omp's `tui.editor.deleteToLineStart`, keybindings.ts:111) + `backspace` pairs (omp backspace at column 0 joins lines — `#deleteCharsBeforeCursor` crosses line boundaries) ×64, every step a no-op on an empty composer. Drafts beyond 64 lines retain earlier lines (documented bound).
5. Inventory gate — dispatch refuses (exit 9) unless the command name exists in the selected instance's own registry inventory (the manifest unions instances; unknown slash text would start a model turn).
6. Lock protocol — per-holder claim files replaced by a lock DIRECTORY acquired by atomic `mkdir` (pid ordering admitted a later lower-pid claimant while a higher-pid holder was inside). Holder identity (pid + starttime) in `holder.json`; dead-incarnation takeover by atomic rename (exactly one contender wins); init grace for the mkdir→write window; age-based corpse sweep. A nonexistent state dir is created and locked (previously ran unlocked).
7. Lifecycle retry — publish/removal retries the whole critical section (5s budget, 2s for shutdown) while the lock is contended; persistent contention is logged, never silently dropped.
8. Atomic dispatch generation — `action-map.json` + `prefill-actions.json` replaced by ONE `dispatch.json` (`{actions: {id: {name, prefill}}}`) written atomically BEFORE the manifest; unknown action id fails closed (exit 7). The bridge reads one coherent generation.
9. Collision suffixes reserved inside the 120-char action-id budget.
10. Prefill only for REQUIRED arguments — a usage hint prefills only when an unbracketed `<placeholder>` remains after stripping `[optional]` groups (omp marks optional parameters with brackets: `/compact [focus]` executes immediately; placeholders quoted inside brackets don't count). Matches CONTEXT.md's bare-invocable classification.
11. Dot-segment registry keys rejected (`.`/`..`); aggregation skips stray non-directory session entries.

Boundary evidence (2026-10-27, throwaway session palette-smoke-4, fresh state dir, extension linked from the working tree):
- Publish + generation: TUI omp published `registry/palette-smoke-4/w1:p2.json` with `proc_start_ticks`; the plugin dir materialized `dispatch.json` + `trailboss-plugin.toml` (no action-map/prefill-actions), no leftover `aggregate.lock`.
- Fail-closed: invoking `restart` while a SHELL pane was focused refused dispatch ("no instance registry entry for pane w1:p1") — nothing typed into the shell.
- Exec dispatch: after focusing the omp pane, `restart` executed — bridge log `action restart -> /restart sent to pane w1:p2 (session palette-smoke-4)`; exec-replace signature held (pid 1852899 and starttime unchanged, `/proc/<pid>/maps` hash changed).
- Prefill dispatch: `add-dir` (required `<path>`) left `❯ /add-dir` unsubmitted in the composer, agent idle, no model turn.
- Headless guard: `omp -p 'reply ok'` run with the PARENT pane's env (HERDR_PANE_ID=w1:p2) did not overwrite or remove the parent's registry entry (md5 identical before/after; entry pid still the TUI's 1852899).
- Cleanup: throwaway session, state dir, and the omp plugin link removed.

## Delivery review round-2 fix pass (2026-10-27)

Re-review (same reviewer) of the round-1 fixes found 7 defects (R1–R7) in the fixes themselves; all fixed in src + tests, then boundary-re-proven end-to-end.

Fixes (finding → change):
- R1/R2 (lock protocol rebuilt): claim files and the userspace lock directory replaced by `src/critical.ts` — every registry mutation + re-aggregation runs as ONE `flock`-held critical section in a subprocess (`runCriticalSection(stateDir, mode, {pluginDir, payload, waitSeconds})`; `flock -w` exit 0 = ran, 1 = contended, other nonzero = real failure surfaced via stderr). `index.ts` `runLifecycle` retries within the mode budget (5s publish, 2s shutdown) and returns success; `aggregate.ts` `cliAggregate` spawns the same flock'd child. No userspace lock files remain to stale-crash or race.
- R3 (deterministic ids): `actionIdFor(name) = sanitize(name).slice(0,111) + '-' + sha256(name)hex[0:8]` — stateless, no collision-suffix loop; duplicate names throw.
- R4 (draft clearing): keys-only sequence `ctrl+e, ctrl+u, backspace` ×64 + final `ctrl+e, ctrl+u` (194 keys); `ctrl+e`/`ctrl+u` reach any cursor position or wrapped/suffixed line, every step a no-op on an empty composer.
- R5 (strict liveness): `isProcessAlive(pid, startTicks)` returns false when `startTicks` is undefined — no existence-only fallback for a recycled pid.
- R6 (identity): socket present but session underivable → exit 8 "cannot establish"; no `HERDR_SESSION` env fallback.
- R7 (prefill derived, not stored): `dispatch.json` is `{actions: {id: {name}}}` only; the bridge prefills from the selected instance's OWN registry entry via `requiresArgument` (an unbracketed `<placeholder>` remains after stripping `[optional]` groups). `DispatchOptions`/prefill flag deleted.

The boundary re-proof caught two further real bugs (the round-2 live path had never executed):
- Publish payload referenced `pane` (undefined; the variable is `paneId`) — ReferenceError thrown at argument evaluation, outside `runLifecycle`'s catch, silently swallowed by omp's session_start runner: every publish died after logging "publishing". Fixed: `{session, pane: paneId, pid, commands}`.
- Success logs lied: "published/removed instance state" logged unconditionally even after a warned failure. Fixed: `runLifecycle` returns boolean; both success debug lines are conditional.

Boundary evidence (2026-10-27, throwaway session palette-smoke-5, fresh state dir, extension linked from the working tree):
- Publish: TUI omp logged publishing → published; `registry/palette-smoke-5/w1:p7.json` + 441-action `trailboss-plugin.toml` + populated `dispatch.json` (hash ids).
- Refusal guard: invoke with the SHELL pane focused → bridge exit 4 "no instance registry entry for pane w1:p1 … refusing to dispatch"; shell pane untouched.
- Draft-clearing dispatch: `DRAFTMARKER q7` typed into the omp composer via `pane send-text`, omp pane focused, `add-dir` invoked → bridge exit 0; composer showed `/add-dir <path>` with DRAFTMARKER gone (no merge).
- Shutdown removal: pane close → "removed instance state" logged; registry session dir empty, manifest 0 actions, `dispatch.json` `{"actions": {}}`.
- Stale-entry sweep re-confirmed: a manually published entry with a dead pid was pruned by the next aggregation.
- Cleanup: throwaway session, state dir, and the omp plugin link removed.

Suites after the fix pass: 66/66 package, 206/206 repo-wide (bun test).

## Delivery review round-3 fix pass (2026-10-27)

Round-3 re-review (same reviewer) closed R1–R7 but found 2 defects in the round-2 fixes themselves; both fixed and boundary-re-proven.

- P1 (multiline drafts): the round-2 clearing sequence never visited lines below the cursor line — a two-line draft with the cursor on line 1 kept its second line, and the dispatched command would submit merged with it. Fix: each round gains `down` (omp `tui.editor.cursorDown`): `[ctrl+e, ctrl+u, down, backspace]`×64 + `[ctrl+e, ctrl+u]` (258 keys). Verified against omp's binary: ctrl+e = cursorLineEnd (line-scoped), ctrl+u = deleteToLineStart, `down` descends one line while lines remain below (kMultilineMove) and on the last line falls through to history-next — a no-op unless already history-browsing (canNavigateToNext requires history index > -1); any pulled entry is itself cleared by the next round. Backspace at column 0 joins the now-empty line into the line above (deleteCharBackward crosses line boundaries). Live regression (palette-smoke-6): draft `FIRSTLINE\nSECONDLINE` with the cursor on line 1, `add-dir` invoked → bridge exit 0, composer showed only `/add-dir <path>`, zero draft remnants.
- P2 (flock exit codes): flock returned 1 both for lock contention AND for real child failures (flock passes through the child's exit status), so runLifecycle retried genuine failures as contention and cliAggregate exited 0 after a failed child. Fix: `flock -E 75` (FLOCK_CONFLICT_EXIT, exported from critical.ts); only 75 is contention (retry within budget / subsumed-run message), every other nonzero surfaces its real exit code + stderr. cliAggregate now routes through runCriticalSection (single flock launch path, no duplicated spawn), with CriticalOutcome extended to carry the child's stdout for CLI pass-through.

Tests: clearing-sequence structure updated (round = 4 keys, 258 total); contention test expects 75; new test pins a real child failure (exit 64, unknown-mode stderr) surfacing under an acquired lock. Suites: 67/67 package, 207/207 repo-wide.

Boundary (palette-smoke-6, fresh state dir): publish (registry `w1:p2.json` + manifest + dispatch.json, success log), the multiline-draft clearing regression above, shutdown removal (registry empty, manifest 0 actions), cleanup done.

## Delivery review round-4 fix pass (2026-10-27)

Round-4 re-review closed the flock exit-code and multiline-clearing defects, leaving one P2: dispatch still submitted unconditionally after the bounded clearing — a draft exceeding CLEAR_ROUNDS (e.g. 66 lines) would submit `/restart` merged with the surviving lines. Fixed with a verified-clearing gate.

- Verified clearing (round-4 P2): after the clearing keys, the bridge reads the pane's recent rendered text over the SAME session socket (`pane.read`, source `recent`, 256 lines) and parses the composer region (`composerResidue`: the LAST `❯` line plus continuation lines up to the blank separator before the status block). Any content — or an unverifiable composer (prompt not found) — refuses dispatch with exit 10 BEFORE any command text; one retry at +500ms absorbs a slow render. Exit 0 requires a verifiably empty composer. The trailboss response shape was caught live: `sessionRequest` resolves with the JSON-RPC `result` (`response.read.text`), and the first wiring read `response.result.read.text`, refusing everything — the boundary run caught it before any review.
- Tests: `composerResidue` unit cases (clean, prompt-line content, continuation content, missing prompt); over-bound residue refusal (code 10, clearing keys only, no command sent); the dispatch deps seam gains `readPaneRecent` + injectable `wait`; bridge options gain `readPaneRecent`/`wait` overrides. Suites: 69/69 package, 209/209 repo-wide.

Boundary (palette-smoke-7, fresh state dir, live proofs of both gate arms):
- Normal path: empty composer → invoke `add-dir` → bridge exit 0, composer `❯ /add-dir <path>` (verification passed, command landed).
- Over-bound path: 66-line draft typed with the cursor on line 1 → invoke → bridge exit 10, stderr `residue: dl66`, no command text sent — the exact regression the reviewer specified.
- Publish + shutdown removal re-proven (registry entries materialized per pane; after close, registry empty, manifest 0 actions). Cleanup done.

## Delivery review round-5 fix pass (2026-10-27)

Round-5 re-review accepted the verified-clearing gate but found its parser could false-clean: a blank line INSIDE draft content (e.g. `❯\n\n  SECRET\n\nstatus`) ended the composer scan early, and a literal `❯` in draft content could pose as the composer prompt — neither a blank line nor an arbitrary `❯` proves emptiness. No authoritative editor-state API exists (that absence is why dispatch is pane send-text), so the fix is the reviewer's alternative: an unambiguous rendering boundary with ambiguous reads refused.

- Strict composer shape (round-5 P2): `composerResidue` accepts emptiness ONLY for one shape — the bottom-most `❯`-starting line is BARE, followed (after an optional blank separator) by a short contiguous status block (≤8 non-blank lines) whose first line carries omp's middot `·` separator, ending the output. Anything else — draft content, extra blanks, a longer run, a non-middot block, no status block at all, or content after the prompt — is residue and refuses dispatch (exit 10) before any command text. A false refusal (if the status rendering changes in a future omp) is safe-direction and visible; a false clean requires a draft whose surviving tail renders exactly like omp's status block.
- Tests: parser regressions for the reviewer's two cases (blank continuation before surviving content; a bare `❯` continuation posing as the prompt) plus the no-blank-separator clean shape, the missing-status-block refusal, and the middot requirement. Suites: 69/69 package, 209/209 repo-wide.
- Live re-verification (palette-smoke-8): empty composer → invoke `add-dir` → bridge exit 0, `❯ /add-dir <path>` — the strict shape accepts omp's real render (no false refusal); cleanup done. The over-bound refusal and normal-dispatch proofs from palette-smoke-7 remain the recorded gate evidence.

## Delivery review round-6 fix pass (2026-10-27)

Round-6 re-review found two remaining false-clean shapes in the strict parser: a trailing prompt-looking draft line (an indented bare `❯`) became the selected "prompt" while residue above it was skipped, and the documented "ending the output" condition was not implemented — non-status content after a middot-headed block was never checked. Fixed by anchoring the boundary independently of user-writable glyphs and enforcing the end-of-output rule.

- Column-0 prompt (round-6 P2, part 1): the composer prompt is the bottom-most `❯` AT COLUMN 0 (`startsWith`, no trim). omp renders composer continuation lines indented, so a user-typed `❯` inside draft content never sits at column 0 and cannot pose as the prompt; residue between the real prompt and the status block is always scanned.
- End-of-output rule (round-6 P2, part 2): after the recognized middot-headed status block, ONLY blank lines may remain to the end of the pane output; any non-blank content after the block refuses ("non-status content after the status block"). The status region must account for the entire remaining output, not just its first matching block.
- Tests: the reviewer's two exact false-clean fixtures pinned — `❯\n  SECRET\n  ❯\n\n· model junkman\nmail omp-1 reachable\n` (residue before a trailing fake prompt) and `❯\n\n· draft bullet\n\nSECRET\n\n· real status` (non-status content after a middot block) — plus a middot-bearing residue line followed by the real status. Suites: 69/69 package, 209/209 repo-wide.
- Live re-verification (palette-smoke-9): empty composer → invoke `add-dir` → bridge exit 0, `❯ /add-dir <path>` — the column-0 rule accepts omp's real render; cleanup done.

## Delivery review round-7 fix pass (2026-10-27)

Round-7 re-review found one remaining false-clean shape: omp's borderless composer (`bottomBarGap: false`, verified in the binary) places status rows DIRECTLY after editor content with no blank separator, so a surviving gutter-indented draft line containing `·` (`❯\n  a · b\n· model junkman\nmail omp-1\n`) was counted as the first status row and passed.

- Gutter-continuation rejection (round-7 P2): omp renders composer continuation lines with a ≥2-space gutter while status rows carry 0–1 leading spaces (icon row: one space; extension rows: column 0). Any `/^ {2,}/`-shaped line inside the recognized status region is therefore a surviving continuation, never a status row — `composerResidue` refuses with "composer continuation above the status block". The check runs before the middot check, so indented residue gets the precise diagnosis.
- Tests: the reviewer's exact contiguous-footer fixture pinned as BOTH a parser regression and a dispatch refusal (code 10, clearing keys only, no command text); the round-5/6 indented-residue fixtures' expected messages updated to the continuation diagnosis. Suites: 70/70 package, 210/210 repo-wide.
- Live re-verification (palette-smoke-10): empty composer → invoke `add-dir` → bridge exit 0, `❯ /add-dir <path>` — the real status render (1-space icon row + column-0 extension rows) is not gutter-shaped; no false refusal. Cleanup done.
