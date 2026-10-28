# Tommy's OMP extensions

One source repository, independently installable packages. [The editor](packages/editor/README.md) combines conversation-scoped prompt recall, displayed-row Home/End navigation and undo/redo.

## Development

Requires Bun and OMP. Each package pins its own host regression dependencies; see its README.

```sh
bun install
bun run test
omp plugin link ./packages/editor
```

Run `/restart` in OMP after installing or changing the editor. Keep only one active editor registration: do not also install the old loose `editor-redo.ts` or `zz-home-end` extension.

## Packages

- `packages/editor`: `tommy-omp-editor`, scoped prompt recall plus Home/End navigation and undo/redo in one editor registration. Keep this package enabled; `/history-scope session` selects current-conversation recall.
- `packages/kizn-guidance`: `tommy-omp-kizn-guidance`, native authenticated Kizn instruction-change delivery to OMP model context, including idle wake. See its [activation requirements](packages/kizn-guidance/README.md).
- `packages/cache-watch`: `tommy-omp-cache-watch`, read-only alerting on silent session degradation — prompt-cache collapse with provider-aware coverage and request-matched contributor candidates, plus model-fallback episodes and TUI banners. Attribution is correlation, not proof of cache-loss causation. See [CONTEXT.md](CONTEXT.md) and [docs/adr](docs/adr).
- `packages/palette-commands`: `tommy-omp-palette-commands`, publishes live OMP command inventories into Trailboss. Install with `omp plugin link ./packages/palette-commands`, restart the intended OMP panes, then link `~/.local/state/omp-extensions/palette-commands/plugin` using `trailboss --session daily plugin link <path> --enabled`. Dispatch supports both CLI `focused_pane_id` and palette UI `pane_id` contexts; conflicting targets are refused. Commands run only in a live publishing pane.

Source: [tommymorgan/omp-extensions](https://github.com/tommymorgan/omp-extensions). No package has been published to npm. The editor remains `UNLICENSED`; public source availability does not grant a reuse license.
