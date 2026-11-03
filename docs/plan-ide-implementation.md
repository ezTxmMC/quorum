# Plan Mode und Mini-IDE: Umsetzungsstand

Referenzen: [Konzept](../Quorum_Plan_Mode_und_AI_IDE_Konzept.md), [Pureline 1.5](../PURELINE_SPECIFICATION_1.5.md).

Das Zielkonzept umfasst sechs Ausbauphasen. Dieser Stand implementiert den persistenten Plan-Core und einen Monaco-Editor mit TypeScript-/Python-LSP. Er erfüllt noch nicht die gesamte Definition of Done des Konzepts.

## Bestandsaufnahme (Phase 0)

- React/Zustand im Renderer, Electron Main und typisierte Preload-Bridge vorhanden.
- CLI und TUI verwenden bereits dieselben Provideradapter wie Desktop.
- Bestehende Chat-/Workflow-Persistenz bleibt in `hub.json` und Workflow-Dateien. Pläne sind eigenständige Entitäten; keine verlustbehaftete automatische Konvertierung vorhandener Workflows.
- Bestehende Terminals und Git-Status-/Diff-Panels werden über den aktiven Plan-Workspace weiterverwendet.
- Bestehende Providerargumente sind keine technisch wirksame Quorum-Sandbox. Deshalb startet die neue Plan-Freigabe noch keine Coding-CLI.

## Implementiert

### Persistenter Plan-Core

- Electron-unabhängiger `core/plan/PlanService`, gemeinsam für Desktop und CLI/TUI.
- `plans.sqlite` im bestehenden Quorum-Datenverzeichnis; `QUORUM_DATA_DIR` für isolierte CLI-Nutzung.
- SQLite WAL, Foreign Keys, Busy Timeout, Schema-Version und Backup vor Migration. Unbekannte neuere Datenbankversionen werden abgelehnt.
- Workspace-UUIDs und kanonische Roots; unabhängige Plan-/Revisions-/Freigabe-/Frage-/Event-IDs.
- Unveränderliche Revisionen, deterministischer SHA-256-Inhaltshash, optimistische Konfliktprüfung anhand der erwarteten Revision.
- Laufzeitvalidierung ohne zusätzliche Paketabhängigkeit: Pflichtfelder, Limits, Phasen-/Modellreferenzen, Akzeptanzkriterien, eindeutige IDs und azyklische Task-Abhängigkeiten.
- Freigaben für exakte Revision, Hash und expliziten Scope; Widerruf, Ablaufdatum und Kostenlimit werden validiert. Neue Revisionen erben keine Freigabe.
- Persistente Rückfragen und Antworten; offene Fragen verhindern Freigabe. Eine neue Rückfrage widerruft bestehende Freigaben dieser Revision.
- Transaktionale, monoton geordnete Audit-Ereignisse; keine vollständigen Quelltexte oder Antworten im Eventlog.
- Archivierung und portables JSON-Import/Export. Import erzeugt neue Identitäten und übernimmt keine Rechte.
- Desktop unter **Plan & IDE**: Aufgabenübersicht, Formular/JSON-Editor, Abhängigkeiten, Akzeptanzkriterien, Fragen, Scope-Freigabe, Revisionen und Audit. Frühere Revisionen lassen sich als neuer Entwurf übernehmen.

### Monaco-Editor und Language Server

- Workspace-Dateibaum und mehrere Tabs, Datei aus einem Task öffnen. Monaco-Modelle behalten beim Tabwechsel ihren Buffer, Undo-Verlauf und Ansichtsposition.
- Monaco mit lokalen Web Workern, Syntax-Highlighting, Multi-Cursor, Befehlspalette, Suche/Ersetzen und schreibgeschütztem Side-by-side-Diff. Der Plan-/Editor-Bereich wird erst beim Öffnen nachgeladen.
- Quick Open (Strg/Cmd+P) und Workspace-Textsuche (Strg/Cmd+Shift+F) mit Ergebnisnavigation, Abbruch vorheriger Suchläufe und festen Datei-/Byte-/Trefferlimits. Generierte Verzeichnisse, Symlinks und bekannte Secret-Dateien werden ausgelassen. Keine vollständige .gitignore-/Regex-Suche in diesem Stand.
- UTF-8, BOM-Erhalt, Anzeige von Sprache und Zeilenende; Binärdateien und Dateien über 2 MB werden abgelehnt.
- Native Monaco-Suche/Ersetzen, Speichern/Neu laden, Strg/Cmd+S.
- Ungespeicherte Buffer bleiben bei externen Änderungen erhalten. Konflikte werden angezeigt, Datenträgerversion kann daneben geöffnet werden.
- SHA-256-Prüfung und Serialisierung konkurrierender Schreibzugriffe; temporäre Datei und atomare Umbenennung statt teilweise beschriebener Zieldateien.
- Polling alle drei Sekunden für offene Dateien; kein nativer File-Watcher in diesem Stand.
- Warnung bei Workspace-/Planwechsel, Router-Navigation und Fensterschließen mit ungespeicherten Änderungen.
- Dateizugriffe ausschließlich über Main/Core; kanonische Pfad- und Symlinkprüfung gegen den Workspace. Kein Agent-Sandboxersatz und keine Garantie gegen böswilliges gleichzeitiges Austauschen übergeordneter Verzeichnisse.

### LSP-Bedienung und Grenzen

Eine `.ts`, `.tsx`, `.js` oder `.py` öffnen und **LSP aktivieren** wählen. Vor dem ersten Serverstart fragt der Main-Prozess nach Vertrauen in den Workspace. Vertrauen gilt nur für dieses Fenster/diese Sitzung. **LSP neu starten** startet den Server kontrolliert neu und synchronisiert die offenen Buffer erneut; **LSP stoppen** beendet ihn. Das Probleme-Panel öffnet die Diagnose an der passenden Stelle. F12 navigiert zur Definition, Shift+F12 zu Referenzen; Hover und Strg+Leertaste verwenden die Server.

- `core/ide/lsp` verwaltet stdio-JSON-RPC, Initialize/Initialized, ausgehandelte Full-/Incremental-Synchronisierung, Open/Change/Save/Close und Shutdown/Exit. Ein Server pro Fenster/Workspace/Sprache.
- Completion, Hover, Definition und References für TypeScript/JavaScript sowie Python/Pyright. Die IPC bietet ausschließlich diese Methoden und Dokumentoperationen, keinen allgemeinen JSON-RPC-/Shell-Zugriff.
- Requests, Anfragenzahl, Nachrichtengröße und Puffer sind begrenzt. Serverabbruch verwirft wartende Requests; alte Dokumentversionen und versionierte Diagnosen werden abgewiesen. Unversionierte Diagnosen werden der beim Empfang synchronisierten Buffer-Version zugeordnet, weil LSP diese Versionsangabe optional macht.
- Serverseitige `workspace/applyEdit`-Anfragen werden abgewiesen; Commands aus Completion-Ergebnissen werden nicht ausgeführt. Navigation außerhalb des Workspaces wird gefiltert. Hover-Markdown bleibt unvertrauenswürdig, ohne HTML oder ausführbare Befehlslinks.
- Der Serverprozess erbt keine API-Keys oder Node-Preload-Optionen aus der App-Umgebung. TypeScript verwendet die mitgelieferte Compilerinstallation; automatische Typdownloads sind ausgeschaltet.
- App-Ende, Rendererabbruch, Navigation und Workspacewechsel räumen Server und unter POSIX deren Prozessgruppen auf. Unter Windows wird `taskkill /T` mit kurzem Timeout verwendet.
- Installierte Server und TypeScript werden als `extraResources` in Desktop-Pakete aufgenommen. Es gibt keine automatischen Downloads oder Installationsskripte im Nutzer-Workspace.
- Workspace-Vertrauen ist keine OS-/Netzwerk-Sandbox: Language Server können Projektkonfiguration lesen und weitere Analyseprozesse starten. Kein allgemeines LSP-Serverpfad-/Transport-Setup oder Remote-LSP in diesem Stand.

## Bedienung im Terminal

Nach `npm run build`:

```sh
node bin/quorum.mjs plan --help
node bin/quorum.mjs plan list /pfad/zum/workspace
node bin/quorum.mjs plan create /pfad/zum/workspace 'Mein Plan' definition.json
node bin/quorum.mjs plan show PLAN_ID
node bin/quorum.mjs plan revise PLAN_ID ERWARTETE_REVISION_ID definition.json
node bin/quorum.mjs plan ask PLAN_ID REVISION_ID 'Welche Tests sollen laufen?'
node bin/quorum.mjs plan answer PLAN_ID FRAGE_ID 'Integrationstests'
node bin/quorum.mjs plan approve PLAN_ID REVISION_ID scope.json
node bin/quorum.mjs plan export PLAN_ID > plan.json
node bin/quorum.mjs plan import /pfad/zum/workspace plan.json
node bin/quorum.mjs plan archive PLAN_ID
```

Die TUI kennt `/plans` für den aktuellen Workspace und `/plan PLAN_ID` zum Anzeigen. Definition und Scope entsprechen den Shared-TypeScript-Verträgen. Node ab Version 24 mit `node:sqlite` wird benötigt; Electron bringt seine eigene Node-Laufzeit mit.

Beispiel für eine reine Lesefreigabe:

```json
{
  "workspaceRoot": "/absoluter/workspace",
  "allowedPaths": ["."],
  "allowedTools": ["read"],
  "allowShell": false,
  "allowNetwork": false
}
```

## Noch offen, nach Konzeptphasen

- **Phase 1:** getrennte Execution-/Attempt-/Checkpoint-/Artifact-Persistenz und Crash-Recovery für tatsächliche Runs. Aktuell gibt es keine neuen Plan-Runs, deshalb auch keinen automatischen Wiederanlauf.
- **Phase 2:** persistente Editor-Sessions, nativer File-Watcher, konfigurierbare Ignore-/Regex-Suche und breitere UI-/Plattformprüfung. Monaco, Diff, Command Palette, Quick Open und einfache Workspace-Suche sind integriert.
- **Phase 3:** grafischer Revisionsvergleich, konfigurierbare externe Server und zusätzliche Sprachen sowie Rename/WorkspaceEdit-Review. TypeScript-/Python-LSP samt Trust, Status, Restart, Diagnostics, Completion, Hover, Definition und References sind integriert.
- **Phase 4:** providerunabhängige Plan-Generierung/Discovery, AI-Kontextinspektor, Patch-Proposals mit Dokumentversionen, Hunk-Review, Permission Broker mit wirksamer Prozess-/Netzwerkisolation, Task-Scheduler und Verification Engine. Freigaben allein starten absichtlich noch keinen Providerprozess.
- **Phase 5:** isolierte Git-Worktrees, Retry/Recovery, Multi-Agent-Ausführung, Test Explorer, Nutzungs-/Kostenmetriken und Konfliktauflösung.
- **Phase 6:** Semantic Search, Tree-sitter, Ghost Text, DAP, Remote-Workspaces, Smart Routing und Scheduled Agents.
- Vorhandene Chat-/Workflow-/CLI-Rechte werden durch diese Ergänzung nicht global migriert. Die Sicherheitsanforderungen des neuen Konzepts gelten daher noch nicht projektweit als erfüllt.

## Prüfung

- Release-CI verwendet Node 24 und führt Plan-, LSP- und Suchtests nach dem Build vor der Paketierung aus.
- `npm run typecheck`
- `npm run build`
- `npm run test:plan-core`: Persistenz, Hashes, DAG-Fehler, Freigaben, Fragen, Import/Archiv, konkurrierende Revisionen, vollständiger Rollback bei Auditfehler, Migrationsbackup, Datei-/Symlinkgrenzen, UTF-8/BOM und Speicherkonflikte.
- `npm run test:plan-cli`: gebauter Launcher und separate CLI-Prozesse auf derselben SQLite-Datenbank; CRUD, Fragen, Freigaben, Import/Export und veraltete Revisionen.
- `npm run test:lsp-core`: JSON-RPC-Framing (auch fragmentiertes UTF-8), Nachrichtengrenzen, Timeouts, Serverabbruch, Shutdown/Exit, Neustart, versionierte Diagnosen, veraltete Antworten, Full-/Incremental-Sync und Navigation innerhalb des Workspaces.
- `npm run test:lsp-servers`: echte installierte TypeScript-/Python-Server gegen den tatsächlichen Core-Manager; Initialize, Open/Change/Save, Completion, Hover, Definition, References und Diagnosekorrektur bestanden. Ein Python-Harness besitzt die Prozesse und verbindet sie über stdio, da direkte Node-Subprozesse in dieser Ausführungsumgebung eingeschränkt sind.
- `npm run test:workspace-search`: Dateisuche, Trefferpositionen, Begrenzung, Abbruch sowie Secret-/Symlink-/Generated-Ausschlüsse.
- `npm run test:ide-ui`: reproduzierbarer Electron-Test mit isoliertem Profil für Plan-Navigation, Monaco-Bearbeitung, Speichern und Suche. Benötigt einen funktionierenden Desktop-/Displayzugriff; Screenshot unter dem System-Temp-Verzeichnis (`quorum-ide-smoke.png`).
- Bestehende Chat-Controls-, Chat-Modi-, 3D- und Release-Cleanup-Prüfungen bestanden.
- Bestehende Providerprüfung kann hier wegen `listen EPERM 127.0.0.1` nicht durchlaufen. Der vorhandene CLI-Test trifft auf `spawnSync /usr/bin/node EPERM`; sein Fake-Provider wurde zusätzlich direkt aus einem Python-Unterprozess erfolgreich ausgeführt.
- Visueller Electron-Smoke-Test wurde versucht, aber durch `sandbox_host_linux.cc: Operation not permitted` vor dem Fensterstart verhindert. Der Versuch wurde auch nach der Monaco-Integration wiederholt; die UI ist typgeprüft und gebaut, noch nicht visuell/E2E bestätigt.

Neue Module folgen Pureline: Guard Clauses, explizite Blöcke, `const` zuerst, `unknown` an unvalidierten Grenzen, keine neuen Framework-/Factory-Schichten und Aufteilung nach Plan-/Datei-/UI-Verantwortung. Bestehende Stilabweichungen außerhalb der Integration wurden nicht pauschal umgeschrieben.

Protokollreferenz: [Language Server Protocol 3.17](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/). Monaco-APIs und Serveroptionen wurden gegen die lokal installierten Pakete geprüft.


## Ergänzung: Chat-Prozesse und Workbench

Die Desktop-Chats über `hub:run` verwenden inzwischen einen eigenen Rust-Host mit
separatem Node-Provideradapter, persistentem Journal und Wiederanbindung. Beim
Schließen lassen sie sich weiterlaufen lassen oder stoppen. Activity Rail und
Prozessstatus ergänzen die Workbench. Dies ist eine Chat-Laufzeit und ersetzt noch
nicht die geplante DAG-Ausführung mit Plan-Approvals, Worktrees und Verification.
Details und bekannte Grenzen: [Chat-Hosts](chat-hosts.md).
