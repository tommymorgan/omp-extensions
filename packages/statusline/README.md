# Private status-line companion components

This package provides private build helpers and an explicitly loaded personal UI extension. It registers no discoverable OMP extension, publishes no command, installs nothing globally, and does not modify stock OMP or select a companion bundle.

## Supported build

Linux x64 with existing `git`, Bun >=1.4 and `tar` is supported. The staging caller supplies an owned `stagingRoot`; each invocation creates a fresh candidate directory. No system packages or toolchains are installed. Local dependencies are resolved with the selected source's `bun install --frozen-lockfile`.

`src/baseline.ts` exports:

- `resolveOfficialSource(version, repository?)`: resolves only `refs/tags/v<version>` (including annotated-tag peeling) to an immutable commit. The repository defaults to official `can1357/oh-my-pi`; overrides are for explicitly trusted offline mirrors/tests, not an automatic alternate-source fallback.
- `checkoutOfficialSource(source, directory)`: checks the clone still matches the resolved commit and that the coding-agent manifest declares the selected version; records the source lockfile SHA-256.
- `stageOfficialBaseline({version, stagingRoot, repository?})`: prepares exact locked dependencies and published same-version native addons, invokes that revision's supported `ci:release:build-binaries --targets linux-x64`, copies the executable into its candidate directory, and runs version and worker gates. Returns the candidate, binary path and provenance. Writes `provenance.json` only after verification. Deletes its own failed candidate; no ready/current reference is created or changed.
- `buildBaselineBinary(sourceDirectory, candidate, version)` and `verifyBaselineBinary(binary, version, ownedRoot)`: reusable private build/verification gates for a later launcher. The lower-level build caller owns source validation and dependency preparation. Neither helper promotes or installs anything.
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

`src/extension.ts` requires the supported `getStatusLineMetrics()` budget/native-rate/native-quota contract, not merely an official version number. Load it explicitly with `-e` and apply `--config packages/statusline/overlay.json` only to the companion process. The overlay is not written into ordinary settings. Keep the existing combined editor enabled; this extension never claims its factory or input.

Upper widgets wrap the complete title, host rate, weighted last-ten completed response cache percentage, twelve-cell used compaction-budget meter and reported remaining Week/5h allowance. Below-editor facts wrap hostname, full model/path and the native jj-first VCS label. Native OMP retains its own brand/activity/timer. No cumulative counters are enabled. Missing usage consumes a response slot and makes cache unavailable; model-only changes do not reset active-branch history.

Quota reads use only the native selected snapshot. A one-second presentation refresh updates countdowns and retained native rate without fetching. VCS uses the host's shared active-repository resolver and native display detector with bounded asynchronous label reads. Noninteractive hosts install no widgets or timers; unsupported TUI hosts receive capability guidance without editor replacement.

The reusable compiled feature gate is `test/runtime/verify.py`. It accepts `--candidate`, `--bundle`, `--expected-version`, an optional `--baseline` unsupported host, and a new owned `--output` directory. All runtime code comes from the supplied staged bundle, not this checkout: `statusline/src/{extension,rails}.ts`, `statusline/overlay.json`, `statusline/test/runtime/fixture.ts`, the owned `statusline/node_modules/zod` dependency, and unchanged `editor/src`. The optional `--editor` is relative to that bundle (default `editor/src/index.ts`); escaping paths and bundle symlinks are rejected. No rebuilding occurs. Its `bundle-assets.json` records the binary and every staged asset checksum.

The gate creates controlling PTYs at80/96columns, native local provider/quota fixtures, saved sessions and real tree transitions. It checks current host budget changes, native streaming/tool rate, cache windows/deduplication, countdowns, editor keys, and unsupported/headless isolation. It preserves raw PTY captures and actual component observations. `render_captures.py` optionally rasterizes those captures with pyte and Pillow for visual inspection; this is not a reconstructed UI or a dependency of the semantic gate. No credentials or external model calls are used.

This is not an installed companion. No public launcher, updater, global plugin registration or live activation is included.
