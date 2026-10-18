# Quorum als multimodale AI-Plattform – Analyse und Umsetzungsplan

## 1. Bestandsaufnahme

| Bereich | Bestand | Wiederverwendung |
|---|---|---|
| Provider-Abstraktion | `electron/providers/runner.ts` startet CLIs headless und normalisiert Events zu `HubEvent`. Ollama läuft über HTTP (`ollama.ts`). | Bleibt unverändert. Neue Runtimes werden daneben registriert, nicht darüber gelegt. |
| Event-Modell | `HubEvent` (`shared/types.ts`): text, tool, image, usage, done. | Wird für Runtime-Ausgaben direkt genutzt. Mesh-/Audio-Events kommen als weitere Typen hinzu. |
| Bild-Engines | `IMAGE_ENGINES` und `imageEngines()` in `shared/catalog.ts`, Ollama-Bildmodelle via `capabilities: image`. | Wird zur Capability-Erkennung ausgebaut, nicht ersetzt. |
| Multi-Agent | `electron/orchestrator.ts`, Strategien, Rollen, `AgentSpec.provider`. | Bekommt später `model`-Routing statt nur `provider`. |
| Persistenz | `electron/store.ts`, `hub.json` mit asynchronem, koalesziertem Speichern. | Modellregistrierung und Presets kommen in denselben Store. |
| Dateiimport | `electron/images.ts` (Bildablage), `quorum-img://`-Schema. | Wiederverwendet für Bildartefakte aus Diffusers und 3D. |
| Terminal/Prozesse | `electron/terminal.ts`, Prozessgruppen mit `SIGTERM`/`SIGKILL`. | Vorlage für isolierte Runtime-Prozesse. |
| UI | React-Router-Routen, Zustand-Store, Modelauswahl (`ModelPicker.tsx`), Optionen-Panel (`OptionsPanel.tsx`). | Erweitert um Modellverwaltung und Workflow-Editor als neue Routen. |

**Fazit:** Die Architektur ist für Erweiterung geeignet. Der zentrale Engpass ist, dass Provider und Modell gleichgesetzt sind (`ProviderId`). Die Plattform braucht eine Trennung zwischen Provider, Runtime und Modell.

## 2. Entscheidungen

- **Keine Trennung in „Modelle“ und „Provider“ durch Ersetzen:** Bestehende `ProviderId`-Pfade bleiben. Lokale Modelle werden als eigene Quelle mit Runtime geführt.
- **Vokabular in `shared/models.ts`:** Quelle, Format, Architektur, Runtime, Backend, Capability. Jede Dimension einzeln, damit Kombinationen geprüft werden können.
- **Kompatibilität als reine Funktion in `shared/compat.ts`:** Dieselbe Regel gilt im Main-Prozess (Auswahl) und im Renderer (Anzeige). Im Zweifel `incompatible`.
- **Runtime-Adapter in `electron/runtimes/adapter.ts`:** Einheitliche Schnittstelle plus Registry. Implementierungen folgen Phase für Phase.
- **Vertrauen ist explizit:** `needsRemoteCode` und PyTorch-`.bin` (pickle) führen zu `requires-trust`. Ohne Freigabe wird nichts ausgeführt.
- **Keine ComfyUI-Integration:** Alles läuft über die eigene Oberfläche.

## 3. Phasen

### Phase 1 – Gemeinsames Fundament (umgesetzt in diesem Schritt)
- [x] `shared/models.ts`: Taxonomie und Typen (Quelle, Format, Architektur, Runtime, Backend, Capability, Ergebnis der Erkennung).
- [x] `shared/compat.ts`: Kompatibilitätsregeln für llama.cpp, Transformers, Diffusers, Mesh-Adapter, Ollama und OpenAI-kompatible APIs.
- [x] `electron/runtimes/adapter.ts`: Adapter-Schnittstelle und Registry.
- [x] Typecheck grün (`npx tsc --noEmit`), Regeln stichprobenartig geprüft (GGUF→llama.cpp, Safetensors-LLM→transformers, remote code→requires-trust, GGUF-Diffusion→keine Runtime).

**Noch offen in Phase 1:** Die Regeln sind noch nicht durch Tests abgedeckt. Vorschlag: Vitest als Dev-Abhängigkeit, Testdatei `shared/compat.test.ts`.

### Phase 2 – llama.cpp und Hugging-Face-Modellverwaltung
**Status: umgesetzt und getestet** (Suche, Download mit Abbruch/Resume, Registry, Import, llama.cpp-Adapter mit Vulkan).
Code: `electron/models/hf.ts`, `inspect.ts`, `manager.ts`, `registry.ts`, `ipc.ts`, `electron/runtimes/llamacpp.ts`, Oberfläche `src/routes/Models.tsx`.
Offen: Download-Warteschlange für mehrere parallele Dateien, Versions-Update-Prüfung für bereits installierte Modelle.
1. Hugging-Face-Hub-Client im Main-Prozess: Suche (`/api/models`), Dateiliste, Lizenz und Tags aus den Modell-Metadaten. Downloads mit Fortschritt, Abbruch und Wiederaufnahme (HTTP-Range, `.part`-Dateien).
2. Modell-Registry (persistiert in `hub.json`): Quelle, Pfad, Format, Architektur, Quantisierung, Version, Lizenz.
3. Import lokaler Ordner und Dateien mit Formaterkennung (GGUF-Magic, `config.json`, `*.safetensors`).
4. llama.cpp-Adapter: `llama-server` als isolierter Kindprozess mit OpenAI-kompatibler API. Vorteil: wiederverwendet `openai-compatible` für Chat und Streaming.
5. Tests: Formaterkennung und Download-Wiederaufnahme mit lokalem HTTP-Server.

**Risiko:** llama.cpp mit ROCm für die RX 7800 XT (gfx1101). Ob das Vulkan- oder ROCm-Build passt, muss auf der Zielmaschine gemessen werden. Vulkan ist der pragmatische Startpunkt.

**Status: umgesetzt und getestet.** Isolierte venv (`electron/runtimes/pyenv.ts`, Pins in `python/requirements.txt`, Torch vom System wegen ROCm). Ein Worker-Prozess pro Modell (`python/quorum_worker.py`, `electron/runtimes/pyworker.ts`). Getestet auf der RX 7800 XT: Transformers-Chat (Qwen2.5-0.5B-Instruct, Streaming) und Diffusers-Bilder (SD-Turbo fp16, 512×512, über die App). Vertrauen für eigenen Modellcode nur mit ausdrücklicher Freigabe pro Modell.

### Phase 3 – Python-Runtimes (PyTorch, Transformers, Diffusers)
1. Isolierte Python-Umgebung je Runtime unter dem App-Datenordner (`venv`), Versionen in einem Lock-File.
2. Worker-Protokoll: JSON-Lines über stdin/stdout, eine Anfrage je Zeile, Ergebnisse als Events. Gleiches Muster wie beim bestehenden CLI-Runner.
3. Transformers-Adapter (Safetensors-LLMs, Embeddings, Speech) mit `trust_remote_code` nur nach expliziter Freigabe.
4. Diffusers-Adapter für Text→Bild und Bild→Bild, mit Inpainting als Pipeline-Variante.
5. Backend-Erkennung: `torch.cuda`/`torch.version.hip` für ROCm, `vulkan` für llama.cpp, CPU als Fallback.

**Risiko:** Für ROCm auf RDNA3 sind PyTorch-Wheels je Version unterschiedlich verfügbar. Die Erkennung muss dies melden, statt stillschweigend auf CPU zu fallen.

**Status: nicht umgesetzt – blockiert.** Hunyuan3D braucht eigenen Modellcode und kompilierte CUDA-Erweiterungen (z. B. Rasterizer). Auf ROCm/RDNA3 ist das nicht verifiziert. Vor einer Umsetzung muss geprüft werden, ob es eine ROCm/HIP-Portierung gibt.

### Phase 4 – Multimodale Pipelines
- Text→3D und Bild→3D über einen Mesh-Adapter (Hunyuan3D 2.0/2.1 als erste Ziele). Vor der Integration: Modellkarte, Lizenz, Speicherbedarf und unterstützte Backends prüfen.
- Ausgabe-Darstellung: Bild-Vorschau, 3D-Viewer (three.js, lokal gebündelt), Audio-Player.
- Eingaben und Einstellungen werden aus `ModelDescriptor.capabilities` abgeleitet (`CAPABILITY_LABELS`, `CapabilityIO`).

### Phase 5 – Ressourcenverwaltung (Model-Manager)
**Status: Kern umgesetzt und getestet** – Monitoring (AMD-sysfs, nvidia-smi, RAM, CPU), Speicherschätzung vor dem Laden, LRU-Entladung, Prioritätswarteschlange, Leerlauf-Entladung, CPU-Fallback bei GPU-OOM, Runtime als isolierter Prozess (Absturz betrifft nur dieses Modell).
Code: `electron/runtimes/resources.ts`, `scheduler.ts`. Offen: Abbruch laufender Ladevorgänge aus der UI, Ressourcenverbrauch pro Workflow (Modell-Statistik existiert bereits).
- Monitoring: VRAM via `rocm-smi`/`amd-smi` (AMD), `nvidia-smi` (NVIDIA), RAM und CPU via `os`/`/proc`.
- Speicherbedarf vor dem Laden: Gewichtsgröße plus Kontext-KV-Cache, grobe Schätzung mit Sicherheitsaufschlag.
- Scheduler: Warteschlange mit Prioritäten, Abbruch, Entladen nach Inaktivität, Fallback auf CPU-Offloading bei OOM.
- Runtimes laufen als eigene Prozesse. Ein Absturz wird über Exit-Code und Heartbeat erkannt und nur als Fehler des Modells gemeldet.

### Phase 6 – Routing und Agenten
**Status: umgesetzt und getestet.** Agenten können feste Modelle oder eine Fähigkeit (chat, coding, reasoning) angeben; der Hub wählt zur Laufzeit ein installiertes Modell (bevorzugt geladene). Getestet mit einem Multi-Agent-Lauf über die Fähigkeit „chat“. `shared/route.ts` (Override, Priorität, Fallbacks, Ausschlüsse) ist fertig. Agenten können ein lokales Denkmodell wählen (`AgentSpec.localModel`); solche Agenten sind reine Text-Agenten ohne Werkzeuge und werden über den Scheduler ausgeführt. Ende-zu-Ende geprüft mit einem Multi-Agent-Lauf zweier lokaler Agenten (Qwen2.5-0.5B-Instruct, Q4_K_M). Offen: Capability-Routing der Agenten (automatische Modellwahl statt manueller Zuordnung), Bild-/Audio-/3D-Modelle als Agenten-Tools.
- Capability-basiertes Routing: Anfrage mit benötigter Capability → Kandidaten nach Priorität → Fallback bei Fehler oder fehlendem Speicher → manueller Override.
- `AgentSpec` erhält `model`-Auswahl je Rolle (Planung, Implementierung, Vision), statt nur `provider`.
- Agenten können Bild-, Audio- und 3D-Modelle als Tools aufrufen.

**Status: umgesetzt und getestet (Engine und IPC).** `shared/workflow.ts` (typisierte Ports, Validierung inkl. Kreiserkennung), `electron/workflows/engine.ts` (parallele Ausführung, Verzweigung über Bedingungen, Wiederholung mit Backoff, Abbruch bis in laufende Prozesse, Unter-Workflows), `store.ts` (Versionen mit Verlauf und Wiederherstellung, Export/Import, Protokolle). Oberfläche `src/routes/Workflows.tsx` als Formular-Editor, nicht als Drag-and-Drop-Canvas. Geprüft: Verzweigung, Validierung, Bildlauf, Abbruch. Die Oberfläche selbst ist nicht per Klick getestet.

### Phase 7 – Visueller Workflow-Editor
- Knoten mit typisierten Ports (`Artifact`-Typen aus `OutputKind`/`InputKind`). Verbindungen nur bei passenden Typen.
- Ausführungs-Engine: Topologische Sortierung, parallele Zweige, Bedingungen, Wiederholungen mit Backoff, Abbruch.
- Persistenz der Läufe und Artefakte, Versionierung und Export als JSON.

## 4. Konkrete Modellempfehlungen (noch nicht verifiziert)

Die Modellnamen stammen aus der Anforderung. Vor der Integration muss pro Modell auf Hugging Face geprüft werden: Architektur und Dateiformat (GGUF oder Safetensors), Lizenz, `trust_remote_code`-Bedarf, Speicherbedarf und unterstützte Backends. Die Regeln in `shared/compat.ts` entscheiden dann, welche Runtime infrage kommt.

- **Chat/Coding/Reasoning:** Qwen3.5-9B, GPT-OSS-20B, Qwen3-Coder-Next (mit Offloading auf 16 GB VRAM / 32 GB RAM).
- **Bild:** Stable Diffusion XL (Diffusers, Safetensors), Z-Image-Turbo (Diffusers-Kompatibilität prüfen).
- **3D:** Hunyuan3D 2.0 und 2.1 (eigener Modellcode, daher `requires-trust`).

## 5. Prozessverwaltung

- Laufende `llama-server` werden in `runtimes.json` im Datenordner geführt. Beim Start beendet die App verwaiste Server aus einem früheren Lauf (nur Prozesse mit `--no-webui`).
- SIGTERM, SIGINT und SIGHUP stoppen Läufe und Runtimes, bevor die App endet.
- Geprüft: harter Absturz (SIGKILL) hinterlässt einen Server, den der nächste Start entfernt. SIGTERM beendet App und Server innerhalb einer Sekunde.

## 6. Bekannte Einschränkungen (Stand Phase 2/5/6)

- Audio/Sprache (Speech-to-Text, Text-to-Speech) und Video sind nicht umgesetzt.
- llama-server auf dieser Maschine ist ohne ROCm gebaut – nur Vulkan wird erkannt und genutzt.
- Modelle mit kleinem Trainingskontext (z. B. stories260K: 128 Token) scheitern bei längeren Prompts mit HTTP 400; die Fehlermeldung enthält jetzt die Serverantwort.
- GGUF-Version 1 wird abgelehnt (von aktuellem llama.cpp nicht mehr lesbar).
- Speicherschätzung ist grob (Gewichte plus Puffer, 40 Schichten angenommen) und kann vom tatsächlichen Verbrauch abweichen.
- Modellpresets: pro Modell werden GPU-Schichten und Kontextgröße gespeichert; benannte Preset-Sammlungen fehlen noch.

## 7. Sicherheit

- Eigener Modellcode wird nur nach ausdrücklicher Freigabe pro Modell ausgeführt.
- Keine automatische Ausführung von Installationsskripten; Python-Pakete nur aus festen Versionsangaben.
- Modelldateien werden nur unter dem App-Datenordner oder vom Nutzer gewählten Ordnern gelesen.
- Pickle-Gewichte (`.bin`) gelten als unsicher und brauchen Freigabe.
