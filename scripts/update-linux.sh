#!/usr/bin/env bash
# AI Hub – Update-Skript für Linux (AppImage)
#
#   1. beendet die laufende App (erst sanft, dann hart)
#   2. entfernt das alte AppImage
#   3. installiert das neue AppImage (+ Startmenü-Eintrag und `ai-hub` im PATH)
#   4. startet die App im Vordergrund – wird das Terminal geschlossen oder das Skript beendet (Strg+C), schließt sich auch die App
#
# Aufruf:
#   scripts/update-linux.sh                  # neuestes AppImage aus ./release
#   scripts/update-linux.sh /pfad/AI-Hub.AppImage
#   scripts/update-linux.sh --build          # vorher `npm run dist:linux` ausführen
#   scripts/update-linux.sh --no-run         # nur installieren, nicht starten
#
# Umgebungsvariable: AI_HUB_DIR (Installationsordner, Standard ~/.local/share/ai-hub)

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="${AI_HUB_DIR:-$HOME/.local/share/ai-hub}"
TARGET="$INSTALL_DIR/Quorum.AppImage"
BIN_LINK="$HOME/.local/bin/quorum"
OLD_BIN_LINK="$HOME/.local/bin/ai-hub"                       # Vorgängername – wird mit aufgeräumt
DESKTOP_FILE="$HOME/.local/share/applications/quorum.desktop"
OLD_DESKTOP_FILE="$HOME/.local/share/applications/ai-hub.desktop"

BUILD=0
RUN=1
SOURCE=""
for arg in "$@"; do
  case "$arg" in
    --build)  BUILD=1 ;;
    --no-run) RUN=0 ;;
    -h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) SOURCE="$arg" ;;
  esac
done

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mFehler:\033[0m %s\n' "$*" >&2; exit 1; }

# --- 0. Quelle bestimmen ----------------------------------------------------------------------------------------
if [[ "$BUILD" == 1 ]]; then
  say "Baue neues AppImage (npm run dist:linux) …"
  (cd "$REPO" && npm run dist:linux)
fi

if [[ -z "$SOURCE" ]]; then
  # neuestes x86_64-AppImage im release-Ordner
  SOURCE="$(ls -t "$REPO"/release/*.AppImage 2>/dev/null | head -n1 || true)"
fi
[[ -n "$SOURCE" && -f "$SOURCE" ]] || die "Kein AppImage gefunden. Erst bauen (--build) oder Pfad angeben."
say "Neue Version: $SOURCE"

# --- 1. Laufende App beenden --------------------------------------------------------------------------------------
# Treffer: das installierte AppImage, das AppImage aus ./release und die gemountete AppImage-Umgebung (/tmp/.mount_AIHub…).
find_pids() {
  { pgrep -f -- "$TARGET" || true
    pgrep -f -- '(AI[ _-]?Hub|Quorum).*\.AppImage' || true
    pgrep -f -- "$REPO/release/.*\.AppImage" || true
    pgrep -f -- '/\.mount_(AI[ _-]?Hub|Quorum)' || true
  } | sort -un | grep -vxE "$$|$PPID" || true   # weder das Skript selbst noch dessen Aufrufer (npm/Shell) beenden
}

stop_app() {
  local pids
  pids="$(find_pids)"
  [[ -z "$pids" ]] && return 0
  say "Beende laufende AI-Hub-Prozesse …"
  # shellcheck disable=SC2086
  kill -TERM $pids 2>/dev/null || true
  for _ in $(seq 1 40); do          # bis zu 8 s sanft warten
    [[ -z "$(find_pids)" ]] && return 0
    sleep 0.2
  done
  say "Prozesse reagieren nicht – erzwinge Beenden."
  # shellcheck disable=SC2046
  kill -KILL $(find_pids) 2>/dev/null || true
  sleep 0.5
}

# --- 2. Aktuell installiertes AppImage ermitteln (BEVOR die App beendet wird) -----------------------------------------------
# Quellen: laufende Instanz (Umgebungsvariable APPIMAGE), ai-hub-Symlink, Startmenü-Eintrag und der Standardpfad.
declare -a OLD=()
add_old() {
  local p="${1:-}"
  [[ -n "$p" && -f "$p" ]] || return 0
  p="$(readlink -f -- "$p")"
  [[ "$p" == "$(readlink -f -- "$SOURCE")" ]] && return 0     # niemals die Quelle selbst löschen
  local q; for q in "${OLD[@]:-}"; do [[ "$q" == "$p" ]] && return 0; done
  OLD+=("$p")
}
for pid in $(find_pids); do
  add_old "$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | sed -n 's/^APPIMAGE=//p' | head -n1 || true)"
done
add_old "$(readlink -f -- "$BIN_LINK" 2>/dev/null || true)"
add_old "$(readlink -f -- "$OLD_BIN_LINK" 2>/dev/null || true)"
add_old "$(sed -n 's/^Exec="\{0,1\}\([^"%]*\.AppImage\).*/\1/p' "$DESKTOP_FILE" 2>/dev/null | head -n1 || true)"
add_old "$(sed -n 's/^Exec="\{0,1\}\([^"%]*\.AppImage\).*/\1/p' "$OLD_DESKTOP_FILE" 2>/dev/null | head -n1 || true)"
add_old "$TARGET"
add_old "$INSTALL_DIR/AI-Hub.AppImage"

stop_app

# --- 3. Altes entfernen, DANACH das neue einspielen ----------------------------------------------------------------------------
# Neuer Ort = der Pfad der bisher installierten Version (Starter und Verknüpfungen bleiben gültig), sonst der Standardpfad.
NEW_PATH="${OLD[0]:-$TARGET}"
mkdir -p "$(dirname "$NEW_PATH")" "$(dirname "$BIN_LINK")" "$(dirname "$DESKTOP_FILE")" "$HOME/.local/share/icons/hicolor/512x512/apps"
# Icon für Startmenü/Dock: aus dem Repo (build/icon.png), falls vorhanden
[[ -f "$REPO/build/icon.png" ]] && cp -f -- "$REPO/build/icon.png" "$HOME/.local/share/icons/hicolor/512x512/apps/quorum.png"
for f in "${OLD[@]:-}"; do
  [[ -n "$f" ]] || continue
  say "Entferne installiertes AppImage: $f"
  rm -f -- "$f" || die "Konnte $f nicht löschen."
  [[ ! -e "$f" ]] || die "$f existiert noch – Abbruch (Neue Version wird nicht installiert)."
done
say "Installiere neue Version nach: $NEW_PATH"
cp -f -- "$SOURCE" "$NEW_PATH"
chmod +x "$NEW_PATH"
TARGET="$NEW_PATH"
ln -sf -- "$TARGET" "$BIN_LINK"
rm -f -- "$OLD_BIN_LINK" "$OLD_DESKTOP_FILE"     # alte Einträge „AI Hub“ entfernen

cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=Quorum
Comment=Alle Modelle. Ein Tisch. – Claude Code, GPT Codex, Antigravity, OpenCode und Ollama
Exec="$TARGET" %U
Icon=quorum
Terminal=false
Categories=Development;
StartupWMClass=quorum
EOF
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$(dirname "$DESKTOP_FILE")" >/dev/null 2>&1 || true
say "Installiert: $TARGET"

[[ "$RUN" == 1 ]] || { say "Fertig (ohne Start)."; exit 0; }

# --- 4. Starten und an das Terminal binden ---------------------------------------------------------------------------------
APP_PID=""
cleanup() {
  trap - EXIT HUP INT TERM
  if [[ -n "$APP_PID" ]] && kill -0 "$APP_PID" 2>/dev/null; then
    say "Beende AI Hub …"
    # eigene Prozessgruppe (setsid) komplett beenden, sonst bleiben Electron-Helferprozesse übrig
    kill -TERM -- "-$APP_PID" 2>/dev/null || kill -TERM "$APP_PID" 2>/dev/null || true
    for _ in $(seq 1 25); do kill -0 "$APP_PID" 2>/dev/null || break; sleep 0.2; done
    kill -KILL -- "-$APP_PID" 2>/dev/null || true
  fi
  stop_app   # Nachzügler (z. B. gemountetes AppImage) einsammeln
}
trap cleanup EXIT
trap 'exit 129' HUP      # Terminal geschlossen
trap 'exit 130' INT      # Strg+C
trap 'exit 143' TERM

say "Starte AI Hub (Schließen dieses Terminals oder Strg+C beendet die App) …"
setsid "$TARGET" &
APP_PID=$!
wait "$APP_PID" || true
