# Quorum

Quorum brings multi-provider chats, coding agents, revisioned plans and a Monaco editor into one desktop workspace.

## Getting started

Install Node.js 24 or newer, npm and stable Rust with Cargo. The Tauri desktop also needs the Tauri 2 build prerequisites for your operating system. On Linux these include WebKitGTK 4.1. [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

```sh
npm ci
npm run tauri:dev
```

The Tauri preview uses the existing Quorum React workbench. Rust owns the window, SQLite profile and chat supervisors. Install Node 24+ on the machine running the preview for the transitional provider and workspace service. Use `npm run tauri:build` to create a platform bundle. Electron remains the full-featured release desktop, started with `npm run dev`.

## Kimi

- **Kimi AI (K3 / K3.1 API)**. In **Settings → API**, select **Kimi AI**, enter a Moonshot API key and save. Choose **API → Kimi AI** with `kimi-k3.1-pro`, `kimi-k3.1-pro-highspeed`, `kimi-k3` or `kimi-k3-256k` in a chat. Use the connection test to discover additional models available to your account. Tauri keeps keys for the current session. [Moonshot models](https://platform.kimi.ai/)
- **Kimi Code (CLI & ACP)**. Install and authenticate the Kimi Code CLI (`kimi`), then choose **Kimi Code** directly in the model picker (supports `kimi-k3.1-pro`, `kimi-k3.1-pro-highspeed`, `kimi-k3`, `--thinking` / `--no-thinking`, `--yolo` / `--auto` and session resume) or **ACP-Agenten → Kimi Code** (`kimi acp`). [Kimi Code command reference](https://moonshotai.github.io/kimi-code/en/reference/kimi-command.html)

## Plans and IDE

**Plan & IDE** manages tasks, revision hashes, questions and scoped approvals. Open a task file to edit it. External changes refresh clean buffers and mark dirty buffers for comparison. Ctrl/Cmd+P opens files, and Ctrl/Cmd+Shift+F searches the workspace. TypeScript and Python language servers require workspace trust. [Plan and editor implementation](docs/plan-ide-implementation.md)

## Processes and profile data

Each desktop chat gets a Rust supervisor and a separate provider worker. Closing the desktop offers to keep active chats running or stop them. Reopening Quorum reattaches to the journal. Local-model chat workers share a per-profile admission lock to avoid loading duplicate runtimes simultaneously. [Chat host architecture](docs/chat-hosts.md)

Set `QUORUM_DATA_DIR` to choose a profile. On its first launch the Tauri desktop imports the existing chat/settings snapshot into `quorum.sqlite`. Electron continues to use `hub.json`. Both desktops can access the same plan database and job journals. Run one desktop at a time for a given profile. Tauri currently supports one workbench window. Tray, updater and the model administration screens still require Electron.

## Command line

```sh
npm run build:cli
node bin/quorum.mjs --tui .
node bin/quorum.mjs -P acp -m kimi -p "Explain this project" .
node bin/quorum.mjs plan --help
```

The CLI reads API keys from `QUORUM_API_KEY_<CONNECTION_ID>`. The Electron desktop imports finished TUI turns through the profile inbox. Use `quorum --help` for folder selection, session continuation and window options.

## Development checks

```sh
npm run typecheck
npm test
npm run test:integration
npm run test:native-core
```

Integration checks require Python 3, Cargo and loopback networking. On Linux, `xvfb-run -a npm run test:ide-ui` exercises the built Electron workbench. CI installs Biome 2.3.13. With that version on PATH, run `npm run lint` or `npm run format`.

[Design concept](docs/Quorum_Plan_Mode_und_AI_IDE_Konzept.md) · [Pureline specification](docs/PURELINE_SPECIFICATION_1.5.md) · [Brand assets](branding/README.md)
