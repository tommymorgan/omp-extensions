# OMP conversation history

Opt-in prompt recall for the current conversation, using OMP's native Up/Down editor navigation. The existing standalone experiment is packaged here without changing its behavior. Development dependencies are pinned to OMP 18.12.1.

## Installation

From a checkout of this repository:

```sh
omp plugin link ./packages/conversation-history
```

Run `/restart` afterward. This package registers a custom editor. Do not enable it alongside `tommy-omp-editor` or another custom-editor extension: it does not compose their editor behavior. If another editor owns input, this extension reports that conversation history is inactive rather than replacing that editor.

## Usage

- `/history-scope session`: limit Up/Down prompt recall to the current conversation.
- `/history-scope all`: use the host's global prompt history (the initial scope).
- `/history-scope`: open a scope selector.

The selected scope persists in `conversation-history/config.json` under OMP's agent directory. Conversation membership is stored separately in `conversation-history/history.db`; the extension does not migrate or rewrite the host history database. Exact submitted prompt text is also recorded in custom session entries so it can be restored with the conversation.

## Known limits

This is an interim extension, not a full replacement for native history scope:

- Scope controls use `/history-scope`, not the native settings interface.
- Changing scope after canceling a draft can clear the current editor undo history.
- A competing custom editor disables scoped recall; Home/End and undo/redo enhancements from `tommy-omp-editor` are not included.
- Older journals can recover human prompts and skill titles, but cannot always reconstruct original template commands or model-mention spelling.

## Development

From the repository root:

```sh
bun install
bun run test:conversation-history
```

The package ships `src/` and this README. Host packages are peers, not bundled runtime copies. No npm package is published; no public distribution license has been selected.
