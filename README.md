# Tommy's OMP extensions

One source repository, independently installable packages. The first package is [the editor](packages/editor/README.md), which combines Home/End navigation and undo/redo.

## Development

Requires Bun and OMP. The regression dependencies are pinned to OMP 18.10.4.

```sh
bun install
bun run test
omp plugin link ./packages/editor
```

Run `/restart` in OMP after installing or changing the editor. Keep only one active editor registration: do not also install the old loose `editor-redo.ts` or `zz-home-end` extension.

## Packages

- `packages/editor`: `tommy-omp-editor`, with one `omp.extensions` entry point.
- `packages/kizn-guidance`: `tommy-omp-kizn-guidance`, native authenticated Kizn instruction-change delivery to OMP model context, including idle wake. See its [activation requirements](packages/kizn-guidance/README.md).

Source: [tommymorgan/omp-extensions](https://github.com/tommymorgan/omp-extensions). No package has been published to npm. The editor remains `UNLICENSED`; public source availability does not grant a reuse license.
