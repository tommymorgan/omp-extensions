# OMP editor

Home/End navigation and undo/redo in one composed editor. Tested against OMP 18.10.4.

| Shortcut | Behavior |
| --- | --- |
| Home / End | Navigate to the beginning/end of the current displayed row in insert mode, including wrapped rows |
| Ctrl+Home / Ctrl+End | Navigate to the beginning/end of the entire draft in insert mode |
| Ctrl+Shift+Z / Ctrl+Shift+Y | Undo / redo |

Home/End use source spans from the host renderer and caret-only native edits: no simulated arrows and no independent wrapping algorithm. End stays on the same displayed row; at a hard wrap it stops before the final grapheme when the next insertion position belongs to the following row. On a logical line's final row, End moves after its final character. Typing immediately after Home honors the selected insertion point instead of the host's default first-edit history anchor.

Regression coverage includes interior wrapped rows of recalled prompts, continued history browsing, word wrapping, Unicode grapheme boundaries, terminal resizing, scrolled viewports, explicit newlines, empty lines, and undo/redo after editing a recalled prompt.

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
