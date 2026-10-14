# OMP editor

Home/End navigation and undo/redo in one composed editor. Tested against OMP 18.10.4.

| Shortcut | Behavior |
| --- | --- |
| Home / End | Navigate within the displayed row in insert mode |
| Ctrl+Home / Ctrl+End | Navigate to the beginning/end of the entire draft in insert mode |
| Ctrl+Shift+Z / Ctrl+Shift+Y | Undo / redo |

Single-line Home/End and whole-draft Ctrl+Home/End have automated regression coverage. Plain Home/End behavior on multiline and wrapped drafts has not been fully validated.

## Local installation

```sh
omp plugin link /home/tommy/src/omp-extensions/packages/editor
```

Run `/restart` afterward. Remove the old loose editor registrations from active discovery before installing this package.

## Development

From the repository root:

```sh
bun install
bun run test:editor
```

The package ships `src/` and this README; tests and pinned host development dependencies stay in the repository. Host packages are peer dependencies, not bundled runtime copies.

## Why one editor entry point?

`HomeEndEditor` extends `UndoRedoEditor`, which extends OMP's `CustomEditor`. Navigation breaks the undo edit group; ordinary editing passes through the undo/redo layer. Only `src/index.ts` registers the composed editor. The implementation modules do not independently install competing editors, so no `zz` filename prefix is needed.

No package has been published. A public distribution license has not yet been selected.
