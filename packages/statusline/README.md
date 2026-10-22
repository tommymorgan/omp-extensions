# OMP status-line companion

This private package provides a separate `omp-statusline` command, an explicitly loaded personal UI extension, and exact-release build helpers. It is not a globally discoverable OMP plugin. Source implementation does not install the command, activate the extension, modify a human profile, or restart existing sessions.

## Supported build

Linux x64 with existing `git`, Bun >=1.4 and `tar` is supported. The staging caller supplies an owned `stagingRoot`; each invocation creates a fresh candidate directory. No system packages or toolchains are installed. Local dependencies are resolved with the selected source's `bun install --frozen-lockfile`.

`src/baseline.ts` exports:

- `resolveOfficialSource(version, repository?)`: resolves only `refs/tags/v<version>` (including annotated-tag peeling) to an immutable commit. The repository defaults to official `can1357/oh-my-pi`; overrides are for explicitly trusted offline mirrors/tests, not an automatic alternate-source fallback.
- `checkoutOfficialSource(source, directory)`: checks the clone still matches the resolved commit and that the coding-agent manifest declares the selected version; records the source lockfile SHA-256.
- `stageOfficialBaseline({version, stagingRoot, repository?})`: prepares exact locked dependencies and published same-version native addons, invokes that revision's supported `ci:release:build-binaries --targets linux-x64`, copies the executable into its candidate directory, and runs version and worker gates. Returns the candidate, binary path and provenance. Writes `provenance.json` only after verification. Deletes its own failed candidate; no ready/current reference is created or changed.
- `buildBaselineBinary(sourceDirectory, candidate, version)` and `verifyBaselineBinary(binary, version, ownedRoot)`: reusable compiled build/worker gates. The lower-level build caller owns source validation and dependency preparation. Neither helper promotes or installs anything.
- `checksum(file)`: artifact SHA-256.

Native preparation obtains `@oh-my-pi/pi-natives-linux-x64@<version>` over HTTPS from npm, compares the registry SLSA statement's source commit and subject digest, verifies the tarball's SHA-512 integrity, and records addon SHA-256 values. The official builder additionally checks native version stamps. This is registry-served provenance/integrity checking, not independent Sigstore signature verification. No native binary is borrowed from another checkout. Missing or mismatched provenance fails closed.

Worker verification uses the compiled executable's existing `--smoke-test` (bundled workers and assets, not a replacement smoke). Its HOME, agent directory and XDG paths are owned by the candidate, with no inherited profile/plugin configuration. The resulting SHA-256 identifies the locally built binary, not a claim of byte-for-byte reproducibility with an official distributed executable.

## Checks

From the repository root:

```sh
bun run test:statusline
STATUSLINE_REAL_BASELINE=1 bun test packages/statusline/test/official-boundary.test.ts
```

The opt-in real check builds official18.12.6, runs its worker smoke, and compares stock checksum plus an owned stock RPC witness before/after. It preserves the resulting `/tmp/statusline-official-proof-*` candidate and JSON evidence for inspection. It makes no model request. Ordinary tests exercise real local Git repositories and subprocess failures; executable fixtures test negative gates only and never substitute for the real baseline build.

## Explicit supported-host UI

`src/extension.ts` requires the supported `getStatusLineMetrics()` budget/native-rate/native-quota contract and read-only `ctx.ui.getStatus(key)` capability, not merely an official version number. Load it explicitly with `-e` and apply `--config packages/statusline/overlay.json` only to the companion process. The overlay selects the extension-owned `personal-native-statusline` composer shape and is not written into ordinary settings. Keep the existing combined editor enabled; this extension never claims its factory or input.

The upper rail uses the native theme: accent/bold complete title, success-colored weighted last-ten completed-response cache percentage, warning-colored twelve-cell used compaction-budget meter, muted reported Week/5h allowance, and error-colored exhausted windows. Native generation rate is accent-colored at the right edge of the first metrics row. Left facts retain their origin as rate digits change. Complete facts wrap at80/96columns rather than disappearing to make room for the rate; extremely narrow terminals wrap the complete rate separately. `upperMetricFields()` owns the shared semantic formatting, while `upperMetrics()` retains the plain representation for existing consumers.

The lower rail combines the host's own brand/spinner/elapsed indicator with icon-led hostname, full model/path and native jj-first VCS label. The custom shape suppresses only the dedicated native activity row and removes only the appended horizontal-rule fill from its content; native indicator ANSI and timing remain host-owned. Widgets and the presentation timer detach on shutdown/session transition; composer registration/disposal belongs to the public extension host.

An assigned agent-mail ID appears at the right end of that same logical lower rail. Every render safely looks up `ctx.ui.getStatus` through `Reflect` and reads only `agent-mail`, consuming the canonical producer's plain `mail <identity> <state>` status. Missing, cleared, malformed or `unassigned` statuses omit identity. No environment/hash inference, broker lookup or `agent-mail-work` publication text is used. Full IDs and cwd/jj facts wrap without truncation; an ID wider than the terminal continues across rows instead of being clipped.

Quota reads use only the native selected snapshot. A one-second presentation refresh updates countdowns and retained native rate without fetching. VCS uses the host's shared active-repository resolver and native display detector with bounded asynchronous label reads. Noninteractive hosts install no widgets or timers; unsupported TUI hosts receive capability guidance without editor replacement.

The reusable compiled feature gate is `test/runtime/verify.py`. It accepts `--candidate`, `--bundle`, `--expected-version`, an optional `--baseline` unsupported host, and a new owned `--output` directory. All runtime code comes from the supplied staged bundle, not this checkout: `statusline/src/{extension,rails}.ts`, `statusline/overlay.json`, `statusline/test/runtime/fixture.ts`, the owned `statusline/node_modules/zod` dependency, and unchanged `editor/src`. The optional `--editor` is relative to that bundle (default `editor/src/index.ts`); escaping paths and bundle symlinks are rejected. No rebuilding occurs. Its `bundle-assets.json` records the binary and every staged asset checksum.

The gate creates controlling PTYs at80/96columns, native local provider/quota fixtures, saved sessions and real tree transitions. It checks current host budget changes, native streaming/tool rate, cache windows/deduplication, countdowns, editor keys, and unsupported/headless isolation. UI04/UI05 add measured right-edge rate/identity columns, live width changes, semantic theme colors, native active-to-idle indicator co-location with complete lower facts, and producer identity change/unassigned/clear/oversize wrapping without provider traffic. Full-surface absence of a duplicate native row also requires inspecting the actual retained PTY captures; lower-component observations alone do not prove that. The fixture publishes status through the real host UI API without loading or contacting a broker. `render_captures.py` optionally rasterizes captures with pyte and Pillow; this is not a reconstructed UI or a dependency of the semantic gate. No credentials or external model calls are used.

## Separate launch and update

When installation is separately authorized, the package's `bin/omp-statusline` entrypoint is the command to expose on PATH. It requires Bun on PATH. Running the source directly is also supported:

```sh
bun packages/statusline/bin/omp-statusline update
bun packages/statusline/bin/omp-statusline --session /path/to/saved-session.jsonl
bun packages/statusline/bin/omp-statusline --resume
```

`OMP_STATUSLINE_STOCK` may select the official stock executable explicitly; otherwise the command resolves `omp` on PATH. It rejects itself and companion artifacts as stock update targets. The selected invocation must resolve as `omp` in its own directory: that directory is placed first on the updater's PATH and its resolved identity checked, because the official updater selects its replacement target through PATH. An ambiguous target fails before updating anything. `OMP_STATUSLINE_ROOT` selects the companion's private state root; the default is `$XDG_STATE_HOME/omp-statusline` or `~/.local/state/omp-statusline`. These variables do not select a different update channel. The resolved stock executable's own `update` command follows its configured channel. Updating stock independently remains supported.

Update runs synchronously under an exclusive owned update lock. It maps stock's resulting actual version to exact official source, prepares locked dependencies/native provenance, and builds an unmodified official baseline. The staged official binary must pass the complete compiled API semantics and selected UI contract before the temporary patch can retire. A matching accessor name is insufficient. Otherwise `core.patch` must apply cleanly, and the patched candidate must build and pass version, bundled-worker, budget/rate/quota semantics and exact staged UI gates.

The CLI reports each update phase on stderr immediately and prints an elapsed-time heartbeat every ten seconds while work continues. Full source builds and compiled terminal checks can take several minutes. Ordinary launch arguments, including `--resume`, pass through to OMP. Cancelling before the first successful update leaves no ready companion; use stock `omp` until initialization completes.

The distributed `core.patch` extends `can1357/oh-my-pi` official18.12.6 source45c35e40c46166dc726ccc52f5d27f40f2449f99 with the native metrics API and shared quota freshness. Usage refreshes and successful saved resets publish the same selected snapshot to extension metrics without adding render-time fetches. Its SHA-256 is recorded in each patched bundle; runtime equivalence is still required when applying it to any later exact source.

Each candidate owns its binary, extension, overlay, zod, editor test assets and reusable verification fixtures. The prior bundle is never edited. A read-only bundle manifest records every file checksum, official source commit and patch identity (or verified official equivalence). Only a fully verified combination becomes ready through a same-filesystem atomic `ready.json` rename. Normal launch validates that complete manifest before executing it. Failed candidates remain unreachable; their owned work/proof directories are retained for diagnosis.

Launch replaces the wrapper process with the pinned binary using `execve`: terminal descriptors, process group, signals and exit status belong to OMP, not an emulated terminal or background supervisor. Ordinary arguments, sessions, settings, editor and plugin discovery remain intact. Only this invocation receives the companion overlay and explicit extension; no complete user profile is copied, frozen or rewritten.

Failures name the failed gate, resolved stock invocation/version, retained companion invocation/base if available, and `omp-statusline update` recovery. Without a previous verified bundle, launch fails explicitly with stock fallback guidance rather than silently starting without customization. Stock is not rolled back after a companion failure. Version drift is disclosed on launch; it never triggers an implicit rebuild or restart. Existing processes keep their old immutable executable and assets.

The updater does not reap previous bundles or delete diagnostic work automatically. Do not remove an update lock owned by a running updater. A stale lock after a crashed updater must be resolved only after establishing that its owner is gone.

## Compiled lifecycle evidence

The real official18.12.6 pipeline has been exercised in an owned temporary installation root: exact source45c35e40c46166dc726ccc52f5d27f40f2449f99, locked dependency/native preparation, supported release compilation, the metrics delta, existing compiled workers, semantic API gate and staged split-rail UI gate. A separate controlling-PTY check launches the actual command against an ordinary owned profile: discovered editor/other extensions, named saved session/history/model, selected companion layout, normal exit/terminal restoration, unchanged config bytes and subsequent stock layout. No human installation or activation is implied.

`test/runtime/launch.py --package <package> --state <owned-state> --stock <owned-stock> --output <new-proof-dir>` repeats the ordinary-profile launch gate. `bun test/runtime/lifecycle.ts <real-pipeline-result.json> <new-owned-proof-dir>` builds controlled future-release fixtures and exercises promotion, retained sessions, drift, all update/bootstrap failure stages and semantic patch-retirement/rejection gates through the production lifecycle. Its fixture adapter supplies prepared source/native inputs only; successful candidates still compile and pass actual worker/API/UI gates. Fixture18.12.7 is a locally controlled test release, **not** evidence that upstream published18.12.7 or that its source/provenance exists. Wrong-budget and omitted-quota fixtures change actual compiled host behavior. Negative compiler/worker fixtures deliberately fail the named production gate; they are not successful compiled-build evidence.

`test/api-runtime/verify.py` and `reader.ts` preserve the reusable Task1.2 compiled semantic contract. The updater composes this gate with the exact owned UI gate; optional unsupported-baseline UI testing remains a separate regression check, not a requirement that an equivalent official host be unsupported.
