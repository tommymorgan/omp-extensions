# Private status-line baseline staging

This package currently provides private build helpers only. It registers no OMP extension, publishes no command, installs nothing globally, and does not modify stock OMP or select a companion bundle.

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

This is not yet an installable status-line companion. No public `omp-statusline` launcher, API patch, UI extension, settings overlay, updater or activation is included here.
