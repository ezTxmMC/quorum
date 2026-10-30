# Quorum

**All models. One table.** A desktop app for **Claude Code**, **GPT Codex**, **Antigravity (Gemini)**, **OpenCode**, **Ollama**, **llama.cpp**, and **OpenAI-compatible APIs**, with a multi-agent mode.
Electron · TypeScript · React · react-router · Tailwind CSS 4 · Iconify.

Quorum runs the CLIs (`claude`, `codex`, `agy`, `opencode`) headlessly using your existing logins. Ollama and llama.cpp support local models. You can also connect an OpenAI-compatible API using its base URL, optional API key, and model IDs in Settings.

## Command line

```bash
quorum [folder]                # open Quorum with a new chat in the folder (a file opens its folder)
quorum --tray                  # start hidden in the system tray (a minimized window if the tray is not visible)
quorum --tui [folder]          # terminal UI, also works over SSH without a display
quorum -p "prompt" [folder]    # one-shot answer on stdout; "-p -" reads the prompt from stdin; --json prints events
```

Options: `-P provider`, `-m model`, `--permission mode`, `-c` (TUI: continue the folder's last session), `-r` (open in the existing window), `-n` (new window), `--help`, `--version`.
A second `quorum <folder>` while Quorum is running opens the folder in the running instance. `-p` runs read-only (plan mode) unless `--permission` is given.
The terminal modes are built by `npm run build:cli` (`dist-cli/quorum.mjs`, runs with Node or with the Electron binary in `ELECTRON_RUN_AS_NODE` mode). In a checkout, `node bin/quorum.mjs …` (or `npm link`) works without packaging; API keys for the `api` provider are read from `QUORUM_API_KEY_<CONNECTION_ID>` in terminal mode, since the app's encrypted key store needs Electron. `QUORUM_DATA_DIR` overrides the data folder.
Chats are shared with the app: the TUI reads the app's chats (`-c`, `/chats`, `/resume`) and hands finished turns over through `<data dir>/inbox/`; the app merges them into its chat list (also at its next start).

## Getting started

```bash
npm install
node node_modules/electron/install.js  # If the Electron binary is missing
npm run dev                            # Development
npm run build && npm run start         # Build and run the production app
npm run update:linux -- --build        # Build, replace, install, and launch the Linux AppImage
```

For branding and icons, see [branding/README.md](branding/README.md). Regenerate icons with `npm run icons`.
