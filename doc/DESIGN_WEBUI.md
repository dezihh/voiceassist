# Design: Admin-Web-UI

> Arbeitsdokument für die Design-Diskussion. Konkrete Entscheidungen werden als
> Issue festgehalten (`design`-Label) und hier verlinkt.
> Zentrale Architekturregeln: [ARCHITECTURE.md](ARCHITECTURE.md)

## Ziele

- Administration des voiceassist-Gateways über den Browser
- **LAN-only** (Allowlist im Reverse-Proxy), nie internet-exponiert
- Ein App-Container gemeinsam mit dem Gateway, getrennt via Sub-URL (`/voiceassist/admin/…`)
- Portabel: Dev auf `hotel`, Prod-Umzug auf anderen Server – Host/Ports/Tokens nur via Config/`.env`

## Reiter-Konzept (Navigation)

Die Oberfläche ist **reiterbasiert** aufgebaut – ein Reiter je Vorgang
(2026-09-06, Diskussion):

| Reiter | Inhalt | Status |
|---|---|---|
| **Grundeinstellungen** | System-/Agent-Prompte, Warteton (phrase/tone/off), Timeouts, Fuzzy-Matching global, Session-Verhalten | MVP |
| **Monitor / Test-Tool** | Live-Trace der Pipeline (Router → MCP → LLM → Antwort), Query simulieren, Statistik (Latenzprofile je Szenario) – ersetzt Dashboard + Test-Konsole | MVP |
| **Vorgang: Generisch (Agent)** | Der Default-Weg zum LLM: System-Prompt, Clarification-Budget, Tool-Iterations-Limit | MVP |
| **Vorgang: je Action ein Reiter** | Flexibler Vorgang, pro Reiter konfigurierbar: **Modus** (deterministisch / nur LLM / beides), eigenes System-Prompt, Trigger-Phrasen + Fuzzy-Schwellwert, verwendete Tools/MCP-Server, Ausgabe-Template | MVP |
| **MCP-Registry** | Server-URLs, Tools, Health-Check, Enable/Disable | MVP |
| **Logs** | Konversations- und Fehlerhistorie inkl. Nachfrage-Dialoge | MVP |

- Erlaubte MCP-Tools **je Vorgang** sind im Reiter definierbar – die feinere
  Permissions-/Confirmations-Ebene folgt später (Issues #3/#4)
- Die drei Szenarien werden damit zu **Konfigurationen eines einheitlichen
  Action-Modells** mit `mode`-Feld (`deterministic` / `llm` / `hybrid`) statt
  getrennter Typen; Routing-Priorität bleibt: deterministischer Treffer vor LLM

## Style (zentraler Webserver knx)

Die Admin-UI folgt dem **Style des zentralen Webservers auf knx** (`/dashui/`):

- **Dash-UI Theme** (Bootstrap 5, codescandy/Dash-UI) im **Dark-Mode**
- Basis-Hintergrund `#212b36`, Sidebar-Navigation, Feather-Icons
- Theme-Assets **self-hosted** im Container (kein CDN), Custom-Overrides in
  einer eigenen CSS-Datei (analog `dezi.css`)
- bleibt Vanilla HTML/CSS/JS – Bootstrap/Dash-UI sind CSS/JS-Dateien, kein Build-Schritt

## Entwicklung paralleler Umgang

Die Web-Oberfläche wird **während der Entwicklung** mitgebaut (nicht als
separater Schlussblock): Vorgänge, die im Gateway implementiert werden,
sind direkt im UI konfigurierbar/testbar.

## Szenarien / Action-Typen & Routing

Drei Bedienszenarien werden als **Action-Typen** im Router abgebildet
(→ Entscheidung in [Issue #1](https://github.com/dezihh/voiceassist/issues/1)):

| Typ | Szenario | Mechanik | Latenzziel |
|---|---|---|---|
| **Template-Action** | 3 – deterministisches Skript/Formular | Datenquelle (MCP-Call/Skript) + Jinja-Template → verlesfertiger Speech inkl. SSML; LLM-Zwischenschritt **pro Action konfigurierbar** (Standard: aus, LLM nur als Fallback bei Template-Fehlern) | < 3 s |
| **Prompt-Action** | 2 – Schlagwort → festes Prompt | Schlagworte + RapidFuzz-Ähnlichkeit (Schwellwert pro Action, UI-einstellbar, global abschaltbar, kein LLM-Router) → festes Prompt + MCP-Allowlist → deterministisches Ausgabe-Template | < 6–7 s |
| **Agent-Query** | 1 – freie LLM-Anfrage | LLM arbeitet frei mit MCP-Tools; Clarification-Budget 1–2 Rückfragen; Tool-Iterations-Limit | volles Fenster |

- **Routing-Priorität:** Template > Prompt-Action > Agent-Query (Agent = Default-Fallback)
- Bei Mehrfach-Treffern gewinnt die längste/spezifischste Phrase
- **Szenario 4 (proaktiv/geplante Briefings):** bewusst zurückgestellt, Ausblick
- Konsequenz für den Actions-Editor: drei Editor-Varianten (je Action-Typ)

## Entscheidungen (2026-09-06)

| Thema | Entscheidung |
|---|---|
| Container-Layout | **Option A: 1 Container** – Gateway + Admin-UI in einer App; Nginx splittet Sub-URLs (`/voiceassist/api/` exponiert, `/voiceassist/admin/` LAN-only) |
| Gateway-Backend | **Node.js + TypeScript** (ist auch Backend der Admin-UI; MCP-TypeScript-SDK, LLM via litellm/OpenAI-kompatibel) |
| Admin-Frontend | **Vanilla HTML/CSS/JS** – kein SPA-Framework, kein Node-Frontend-Build |
| Admin-Zugang | **LAN-only** (CIDR-Allowlist im Reverse-Proxy), kein zusätzlicher Login im MVP |
| Such-MCP | **Bestehender SearXNG-MCP auf knx** wird angebunden, kein eigenes Hosting |
| HA-MCP | **Offizielle HA-Integration** (`/api/mcp`), Long-Lived Access Token als Bearer; OAuth später (Issue #6) |
| Client-Auth (POC) | **Statisches Shared Secret**, kein OAuth-Flow; Replay-Schutz später (Issue #5) – getrennte Ebene von MCP-Auth |
| Persistenz | **SQLite** (`mcp_servers`, `actions`, `prompts`, `settings`), Credentials pragmatisch via `.env` |
| Session-Schnittstelle | `sessionId`/`conversationId` ab POC in der internen API, State-Ausbau später (siehe ARCHITECTURE.md) |
| Nachfragen | **Hybrid-Clarification**: LLM entscheidet, pro Action konfigurierbar, Budget 1–2 Rückfragen |
| Display/Media | Stufe 1+2 (Text + Bilder) ins MVP, Video/Audio später → [DESIGN_DISPLAY.md](DESIGN_DISPLAY.md) |
| Szenario 3 (Template-Action) | LLM-Zwischenschritt **pro Action konfigurierbar** (Standard: ohne LLM) |
| Schlagwort-Matching | **RapidFuzz**, Schwellwert pro Action, global abschaltbar, kein LLM-Router |
| Warteton | **Konfigurierbar** (Phrase / SSML-Ton / aus), Default: Phrase |
| Runtime-Phasing | **Phase 1: Alexa-hosted**, Phase 2 (Kontingenz): eigene AWS-Lambda → [DESIGN_SKILL_RUNTIME.md](DESIGN_SKILL_RUNTIME.md) |
| Szenario 4 (Proaktiv/Geplant) | Zurückgestellt (Ausblick) |
| UI-Navigation | **Reiter je Vorgang** (Grundeinstellungen, Monitor/Test, Generisch, je Action, MCP-Registry, Logs); einheitliches Action-Modell mit `mode`-Feld (deterministic/llm/hybrid) |
| UI-Style | **Dash-UI Theme** (Bootstrap 5, Dark-Mode `#212b36`) wie zentraler Webserver knx, self-hosted Assets, Vanilla JS |
| UI-Entwicklung | **Parallel zur Gateway-Entwicklung** (nicht separater Schlussblock) |

## Offene Fragen

- [ ] Detaillayout/-funktionen je Bereich (folgende Diskussionsrunde)
- [ ] Realtime für Logs/Traces (Polling vs. SSE)

## Entscheidungen (Issues)

- [#1 – Routing mit 3 Action-Typen](https://github.com/dezihh/voiceassist/issues/1)
- [#2 – Runtime-Phasing (Alexa-hosted → AWS-Lambda)](https://github.com/dezihh/voiceassist/issues/2)
