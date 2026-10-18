# Quorum

**Alle Modelle. Ein Tisch.** Desktop-App für **Claude Code**, **GPT Codex**, **Antigravity (Gemini)**, **OpenCode**, **ChatGPT (Plan)** und **Ollama** – mit Multi-Agent-Modus.
Electron · TypeScript · React · react-router · Tailwind CSS 4 · Iconify.

Die CLIs (`claude`, `codex`, `agy`, `opencode`) werden headless gesteuert; es gelten deine bestehenden Logins. ChatGPT läuft als reiner Chat mit deinem
Plus-/Pro-Plan über „Sign in with ChatGPT“ (`@siwc/local`, Anmeldung im Standardbrowser, kein API-Key), Ollama über die lokale HTTP-API.

## Start
```bash
npm install
node node_modules/electron/install.js   # falls das Electron-Binary fehlt
npm run dev                             # Entwicklung
npm run build && npm run start          # Produktions-Build starten
npm run update:linux -- --build         # AppImage bauen, altes entfernen, neues installieren und starten
```

Branding und Icons: siehe `branding/README.md` (`npm run icons`).
