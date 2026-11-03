# Isolierte Chat-Prozesse und Wiederanbindung

## Bedienung

Jede aktive Desktop-Chat-Anfrage startet einen eigenen `quorum-chat-host` aus Rust. Der Host besitzt einen separaten Node-Adapterprozess mit den vorhandenen CLI-/API-/Ollama-/ACP-/Local-/3D-Adaptern. Nach Abschluss werden Host und Adapter wieder beendet; ein inaktiver Chat hält keinen Prozess offen.

Die Statusleiste zeigt aktive Chat-Prozesse. Ein Klick öffnet die Prozessübersicht mit Titel, Anbieter, Zustand und Rust-PID. Dort kann ein einzelner Chat oder die gesamte Gruppe gestoppt werden.

Beim Schließen eines Fensters beziehungsweise Beenden von Quorum mit aktiven Chat-Prozessen erscheinen drei Optionen:

- **Abbrechen:** Fenster und Prozesse bleiben offen.
- **Bis zum Ende weiterlaufen lassen:** Bereits gestartete Anfragen laufen unabhängig von Electron weiter. Beim nächsten Start bindet Quorum aktive Anfragen und noch nicht übernommene Ergebnisse wieder an die ursprünglichen Nachrichten an.
- **Alle Chat-Prozesse stoppen:** Quorum fordert den Abbruch an, wartet eine kurze Schonfrist und beendet bei Bedarf den zugehörigen Prozessbaum. Wenn die Bestätigung fehlt, bleibt Quorum mit einer Fehlermeldung geöffnet.

Vor dem Schließen wird der aktuelle Renderer-Zustand übertragen und gespeichert. Erst danach dürfen Journale als übernommen markiert werden. Dateibuffer im Editor verwenden weiterhin die separate Warnung vor ungespeicherten Änderungen.

Ein weiteres offenes Quorum-Fenster kann weiterlaufende Chats ebenfalls wieder anhängen. Beim Schließen des letzten normalen Fensters wird Quorum tatsächlich beendet; ein verstecktes Quick-Fenster/Tray verhindert dies nicht mehr.

## Architektur und Daten

```text
Electron / React
  ├─ Startkonfiguration und UI-Cursor
  └─ begrenzte Journal-Batches
        ↕
quorum-chat-host (Rust, pro aktivem Chat)
  ├─ private, geordnete Journale und Heartbeat
  ├─ Abbruch / Schonfrist / Prozessbaum
  └─ Node-Provideradapter (separater Prozess)
       └─ CLI / HTTP / lokaler Modellprozess / Blender
```

Die Provideradapter wurden bewusst weiterverwendet. Der Host und seine Prozess-/Journalverwaltung sind Rust; die Anbieterimplementierungen sind weiterhin TypeScript in einem eigenen Node-Prozess. Im Electron-Main läuft die Provider-Auswertung für diese Chats nicht mehr.

`<Quorum-Datenverzeichnis>/chat-jobs/<runId>/` enthält Metadaten, `state.json`, `events.jsonl` und eine kurzlebige Kommando-Mailbox. Auf POSIX-Systemen werden private Verzeichnisse mit Modus `0700` und Journale/Metadaten mit `0600` angelegt. Windows nutzt die geerbten Zugriffsrechte des Benutzerprofils.

- API-Keys und Start-Anhänge werden über anonyme Pipes übergeben und nicht in den Job-Metadaten gespeichert. Die Pipeline-Prüfung kontrolliert dies mit einem Testschlüssel.
- Direkt nachgesendete Nachrichten verwenden private, zeitlich begrenzte Mailbox-Dateien; diese werden nach Übergabe beziehungsweise Job-Ende entfernt. Eine unbestätigte Zustellung wird nicht automatisch erneut gesendet.
- Events sind monoton nummeriert. Die Nachricht speichert Run-ID, letzte übernommene Sequenz und Abschlussstatus zusammen mit ihrem Inhalt. Ein erneutes Einlesen überspringt bereits verarbeitete Events.
- Ein Start-Snapshot rettet auch einen Chat, dessen erste neue Nachricht vor dem Schließen noch nicht in `hub.json` stand. Nach bestätigter Übernahme wird dieser zusätzliche Snapshot entfernt, damit der Verlauf nicht für jede Anfrage erneut dauerhaft gespeichert wird.
- Gelöschte Chats erhalten einen persistenten Löschmarker. Bereits übernommene beziehungsweise später kompaktierte Nachrichten werden nicht aus alten Start-Snapshots wiederhergestellt. Journale sind lokale Ausführungsprotokolle und bleiben in diesem Stand gespeichert.
- Es gibt keine automatische Wiederholung unterbrochener Anfragen. Ein abgebrochener Host wird als unterbrochen angezeigt, statt mögliche externe Seiteneffekte blind zu wiederholen.
- Rust liest und schreibt Provider-Events außerhalb von Electron. Eventgröße, Pipe-Queues, Journalgröße und Main-/Renderer-Batches sind begrenzt; Text wird in kleinere, Unicode-sichere Blöcke geteilt. Markdown wird zusätzlich mit verzögerter React-Priorität gerendert. Das ist Prozessisolation, keine Garantie für beliebig große Inhalte oder unbegrenzte parallele GPU-Modelle.

Host, gebündelte Adapterdateien und Python-Skripte werden vor dem Start versionsbezogen unter `chat-runtimes/` im Datenverzeichnis abgelegt. Damit verschwinden sie beim Aushängen eines AppImages nicht unter einem laufenden Chat. „Weiterlaufen lassen“ wartet zusätzlich auf die Initialisierungsbestätigung des Adapters. Alte Runtime-Versionen bleiben für laufende Jobs erhalten.

Unter POSIX besitzt der Adapter eine eigene Prozessgruppe; die betroffenen Provider-/Runtime-/Blender-Starts bleiben darin. Unter Windows wird ein Job Object mit Kill-on-close verwendet. Auf Linux erhält der Adapter beim Tod seines Hosts ein Parent-Death-Signal; zusätzlich überwacht der Adapter die Host-Lebensdauer. Rust behält während blockierender Worker-Ein-/Ausgabe eine unabhängig laufende Steuerung für den Abbruch.

## Umfang und Grenzen

- Erfasst werden die Desktop-Chats über `hub:run`, einschließlich Bild-, lokalem Modell- und 3D-Chatmodus. Die separate Multi-Agent-/Workflow-Oberfläche und CLI/TUI-Ausführung wurden nicht auf dieses neue Protokoll migriert. Diese älteren Main-Prozess-Abläufe erhalten dadurch noch keine persistente Hintergrundfortsetzung.
- Jeder lokale Modell-Chat verwendet einen eigenen Adapter/Scheduler. Mehrere Chats können entsprechend mehrere Modellkopien und mehr RAM/VRAM benötigen. Andere Prozesse oder externe Dienste werden nicht als zusätzlicher freier Speicher behandelt.
- Bereits im Eingabefeld vorgemerkte, noch nicht gestartete Folgeanfragen gehören nicht zum laufenden Host. Hintergrundfortsetzung betrifft die bereits gestartete Anfrage.
- Bei „Weiterlaufen lassen“ bleibt ein zuvor in Quorum gestarteter gemeinsamer Ollama-Server verfügbar, damit seine HTTP-Anfragen weiterarbeiten können. Ein solcher Server ist ein gemeinsamer Dienst und wird nicht pro abgeschlossener Anfrage beendet. Externe Ollama-/API-Dienste werden ebenfalls nicht gestoppt.
- Prozesse, die ein CLI selbstständig in fremde Sitzungen/Dienste auslagert, sind keine wirksame OS-Sandbox. Die neue Architektur ändert bestehende Tool-/Netzwerkberechtigungen nicht.
- Die UI hat eine kompakte Activity Rail, eine schmalere Chat-Seitenleiste, einen gesonderten Workspace-Aufbau und eine Prozess-Statusleiste. Die angegebene Referenz [Lumen IDE](https://github.com/ezTxmMC/lumen-ide) war aus dieser Umgebung weder über GitHub noch Raw/API abrufbar. Ein genauer visueller Abgleich gegen deren tatsächliche Oberfläche steht noch aus; es wurden keine Referenzdetails erfunden.

## Build und Prüfungen

Ein aktuelles stabiles Rust-/Cargo-Toolchain und Node ≥24 werden benötigt. `npm run build` baut Web/Main, den separaten Adapter und das native Host-Binary. `npm run dev` baut den Host vor dem Entwicklungsstart. Es gibt keinen stillen Fallback auf die Ausführung im Main-Prozess, falls Host oder Adapter fehlen.

Desktop-Pakete nehmen den nativen Host unter `resources/chat-host/` auf. Die plattformspezifischen `dist:*`-Skripte prüfen OS und Architektur; ein Linux-Host darf nicht versehentlich als Windows- oder macOS-Binary ausgeliefert werden. Native Pakete auf der jeweiligen Zielplattform bauen; Rust-Cross-Packaging ist noch nicht konfiguriert.

```sh
npm run build
npm run test:chat-host
npm run test:chat-provider-worker
npm run test:chat-recovery
npm run test:chat-manager
npm run test:chat-lifecycle
npm run test:chat-persistence
npm run test:chat-runtime
cargo fmt --manifest-path native/chat-host/Cargo.toml --check
cargo clippy --manifest-path native/chat-host/Cargo.toml --all-targets -- -D warnings
```

- Native Tests verwenden echte Rust-Hosts: Loslösen vom Starter, parallele Jobs, ein blockierender Prozess mit Kindprozess, Eskalation und fehlerhafte Worker-Ausgabe.
- Der Adaptertest verwendet die echte gebaute Rust→Node→CLI-Pipeline mit einem Fake-Anbieter, ohne echte Provideranfragen. Er prüft lange Unicode-Antworten, genau einen Abschluss und die Nichtpersistenz des Testschlüssels.
- Die Runtime-Prüfung entfernt die ursprünglichen Programmdateien und prüft weiter verfügbare, voneinander getrennte Versionen.
- Recovery-/Managerprüfungen decken Snapshots, Sequenz-Cursor, begrenzte UTF-8-Dateilesevorgänge, Übernahmebestätigung und Löschmarker ab.
- Der Schließdialog wird mit einem Electron-Testdouble gegen die echte Lifecycle-Klasse geprüft: Abbrechen, Weiterlaufen, Stoppen, Fehler und mehrere Fenster. Dies ersetzt keine visuelle Betriebssystemprüfung.
- Ein visueller Electron-Smoke-Test ist weiterhin durch `sandbox_host_linux.cc: Operation not permitted` in der Ausführungsumgebung blockiert. Windows-Job-Object-Code und macOS-Prozessverhalten benötigen zusätzlich Prüfungen auf diesen Plattformen.
