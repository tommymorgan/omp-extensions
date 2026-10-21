# OMP editor

Conversation-scoped prompt recall, displayed-row Home/End navigation and undo/redo in one composed editor. Tested against OMP 18.12.1.

| Shortcut or command | Behavior |
| --- | --- |
| Home / End | Beginning/end of the current displayed row in insert mode, including wrapped and recalled prompts |
| Ctrl+Home / Ctrl+End | Beginning/end of the entire draft in insert mode |
| Ctrl+Shift+Z / Ctrl+Shift+Y | Undo / redo |
| `/history-scope session` | Limit Up/Down prompt recall to the current conversation |
| `/history-scope all` | Use global prompt history (the initial scope) |
| `/history-scope` | Open the scope selector |

Home/End use source spans from the host renderer and caret-only native edits: no simulated arrows and no independent wrapping algorithm. End stays on the same displayed row; at a hard wrap it stops before the final grapheme when the next insertion position belongs to the following row. On a logical line's final row, End moves after its final character. Typing immediately after Home honors the selected insertion point instead of the host's default first-edit history anchor.

Scope changes preserve the active composer, caret, canceled drafts, paste expansions and this editor's undo/redo stacks. Navigation and scope changes break typing groups. Changing the conversation owner drops the previous owner's local recall and undo/redo history.

## Local installation

From a checkout containing this version:

```sh
omp plugin link ./packages/editor
```

Keep `tommy-omp-editor` enabled. Run `/restart` after updating or linking it. The update does not restart running sessions automatically. To make session scope the startup choice across sessions sharing an agent directory, select `/history-scope session` in one restarted session before restarting the others.

Version 0.2 consolidates the former standalone `tommy-omp-conversation-history` package into this package. If that experimental package was installed, uninstall it; its separate editor must not remain active. Existing conversation-history data and scope configuration are reused without migration. Old loose `editor-redo.ts` and `zz-home-end` registrations must also remain outside active discovery. An unrelated custom-editor extension is not automatically composed; the package reports when another editor owns input.

## Storage and limits

The scope is saved in `conversation-history/config.json` under OMP's agent directory. Session membership lives in `conversation-history/history.db`, separate from the host's global database. Exact submitted text is also recorded in custom session entries for restoration. Older journals can recover human prompts and skill titles, but cannot always reconstruct original template-command or model-mention spelling. Scope controls use `/history-scope`, not native settings.

## Development

From the repository root:

```sh
bun install
bun run test:editor
```

`ConversationHistoryEditor` extends `HomeEndEditor`, which extends `UndoRedoEditor` and the host editor. Only `src/index.ts` is registered as an extension. The package ships `src/` and this README; host packages are peers rather than bundled runtime copies.

Regression coverage includes scoped prompt ownership, restored commands, canceled paste/attachment drafts, displayed-row navigation, resized/scrolled layouts, Unicode grapheme boundaries, scope-switch undo/redo and owner-change undo isolation.

No npm package has been published. A public distribution license has not yet been selected.
