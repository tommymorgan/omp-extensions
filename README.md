# Tommy's OMP extensions

One source repository, independently installable packages: the [editor](packages/editor/README.md) and the Eval progress trial.

## Development

Requires Bun and OMP. Editor regression dependencies are pinned to OMP 18.10.4; Eval progress dependencies are pinned to 18.11.1.

```sh
bun install
bun run test
omp plugin link ./packages/editor
```

Run `/restart` in OMP after installing or changing the editor. Keep only one active editor registration: do not also install the old loose `editor-redo.ts` or `zz-home-end` extension.

## Packages

- `packages/editor`: `tommy-omp-editor`, with one `omp.extensions` entry point.
- `packages/kizn-guidance`: `tommy-omp-kizn-guidance`, native authenticated Kizn instruction-change delivery to OMP model context, including idle wake. See its [activation requirements](packages/kizn-guidance/README.md).
- `packages/cache-watch`: `tommy-omp-cache-watch`, read-only alerting on silent session degradation — prompt-cache collapse with divergence attribution and model-fallback episodes, with TUI banners. See [CONTEXT.md](CONTEXT.md) and [docs/adr](docs/adr).
- `packages/eval-progress`: `tommy-omp-eval-progress`, a removable trial of live Eval agent completion and result previews.

Source: [tommymorgan/omp-extensions](https://github.com/tommymorgan/omp-extensions). No package has been published to npm. The editor remains `UNLICENSED`; public source availability does not grant a reuse license.

## Eval progress trial

Requires OMP 18.11.1 or newer in the 18.x line. The extension delegates unchanged arguments to native Eval, observes the calling session's agent jobs, and replaces only agent progress rendering. Completed, failed, and cancelled agents stop showing stale tool activity; a sanitized first-line result or error appears while other agents continue running. Native code/output rendering, kernels, cancellation, and result delivery remain with OMP. No global binary replacement is needed.

```sh
omp plugin link ./packages/eval-progress
```

Run `/restart` in existing OMP conversations. New sessions load the enabled plugin automatically; the status line reads `Eval progress trial`. Installing it does not reload an already-running process.

To stop the trial:

```sh
omp plugin disable tommy-omp-eval-progress
```

Run `/restart` again. Source stays in this repository. The plugin uses exported OMP registry and renderer modules, so verify compatibility when upgrading OMP; do not combine it with another extension that replaces `eval`.

Verification on stock OMP 18.11.1 used a real Eval kernel and two real agent jobs with an offline scripted model provider. In the installed plugin's interactive TUI, one agent showed its completed result while the sibling and cell remained running. The probe did not evaluate a real business task or external model. `bun run test:eval-progress` covers sibling settlement without worker updates, premature completion, late registration, failed results, observer teardown, and sanitized result rendering.
