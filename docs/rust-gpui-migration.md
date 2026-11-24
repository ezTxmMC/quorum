# Quorum: Rust / GPUI migration

## Current implementation

The native app builds with pinned GPUI 0.2.2 dependencies. It is still under development; the Electron app remains the default until feature parity is verified.

- Native Claude/Codex chats run through the Rust supervisor and Rust provider worker, without Node. Each running chat has a separate process tree. The UI polls journals on background tasks, persists event cursors, and reconnects after restart.
- Closing offers cancel, keep running, or stop all when chats are active. Unsaved editor changes are included in the warning. Failed persistence keeps the window open.
- The project file tree and editor share the selected chat's workspace. Open tabs survive chat switches. The editor supports Unicode/IME input, selection, clipboard, undo/redo, line numbers, indentation, search, and saving. File paths can be inserted into the chat.
- The native shell now follows the existing Quorum design tokens, 40 px top bar, 44 px activity rail, 280 px project-grouped/searchable/collapsible sidebar, provider welcome cards and rounded composer. Messages use a variable-height virtual list with wrapped text, user bubbles and fenced-code blocks. Multi-agent/models/tools rail entries remain explicitly unavailable until their native implementations exist.
- Only visible editor lines are shaped and painted. The text buffer updates its line index incrementally. Session lists and messages use virtual lists; profile I/O runs outside rendering. Fixed-width transcript splitting is no longer used by the native UI.
- Existing profile fields are preserved. Writes use an OS ownership lock, temporary files and external-change checks. Electron does not honor the native lock: simultaneous native/Electron profile writes are unsupported.
- Workspace operations reject path traversal, external symlinks, binary/oversized text, and stale saves.

## Build and validation

```sh
npm run gpui:dev
```

Use `QUORUM_DATA_DIR` to select a profile directory, including a separate test profile. Otherwise the existing platform data location is used. The native application writes chat data, so use a backup when testing existing profiles.

```sh
npm run test:native-core
npm run test:native-provider-worker
npm run test:native-runtime
cargo clippy --locked --manifest-path native/quorum-core/Cargo.toml --all-targets -- -D warnings
cargo clippy --locked --manifest-path native/quorum-desktop/Cargo.toml --all-targets -- -D warnings
```

Core tests cover incremental text editing, UTF-16/grapheme offsets, profile ownership and preservation, stale workspace writes, bounded journal replay, and provider event parsing. Integration tests exercise the real supervisor and Rust worker with fake provider CLIs, including persistence/reopen, cancellation and bounded output; no paid model requests are made.

The native app compiles and links here. Interactive visual verification is blocked by the environment's missing compositor (`NoCompositor`). No end-to-end latency measurements or visual QA are claimed.

Linux `xattr` 0.2.3 is patched locally to use `ENODATA`; macOS/BSD retain `ENOATTR`. See `native/quorum-desktop/vendor/xattr/QUORUM_PATCH.md`. The patch and both application Cargo lockfiles belong in source control.

## Remaining replacement work

- Full Markdown and attachment rendering, multiline composer and full provider/option parity.
- Syntax highlighting, LSP, file conflict resolution and broader IDE functions.
- Plans and their revision/approval semantics, agents/workflows, terminals and model runtimes.
- Credentials/settings UI, updates, native packaging and release switching.
- Visual verification with a real display, compatibility checks against representative profiles, and startup/input/frame-time/memory measurements under sustained streaming.

## Existing app improvements

Fable 5.2 is available in the model catalog. The unversioned `fable` alias resolves to `claude-fable-5-2`; explicit 5.1 selections remain unchanged. Multi-agent rendering avoids serializing tool objects for scroll tracking, memoizes finished cards and groups stages in one pass.

References: https://platform.claude.com/docs/en/models/fable-5-2/overview and https://docs.rs/gpui/0.2.2/gpui/.
