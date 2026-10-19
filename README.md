# Quorum

**All models. One table.** A desktop app for **Claude Code**, **GPT Codex**, **Antigravity (Gemini)**, **OpenCode**, **Ollama**, **llama.cpp**, and **OpenAI-compatible APIs**, with a multi-agent mode.
Electron · TypeScript · React · react-router · Tailwind CSS 4 · Iconify.

Quorum runs the CLIs (`claude`, `codex`, `agy`, `opencode`) headlessly using your existing logins. Ollama and llama.cpp support local models. You can also connect an OpenAI-compatible API using its base URL, optional API key, and model IDs in Settings.

## Getting started

```bash
npm install
node node_modules/electron/install.js  # If the Electron binary is missing
npm run dev                            # Development
npm run build && npm run start         # Build and run the production app
npm run update:linux -- --build        # Build, replace, install, and launch the Linux AppImage
```

For branding and icons, see [branding/README.md](branding/README.md). Regenerate icons with `npm run icons`.
