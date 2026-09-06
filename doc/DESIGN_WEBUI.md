# Design: Admin-Web-UI

> Arbeitsdokument für die Design-Diskussion. Konkrete Entscheidungen werden als
> Issue festgehalten (`design`-Label) und hier verlinkt.

## Ziele

- Administration des voiceassist-Gateways über den Browser
- **LAN-only** (Allowlist im Reverse-Proxy), nie internet-exponiert
- Ein App-Container gemeinsam mit dem Gateway, getrennt via Sub-URL (`/voiceassist/admin/…`)
- Portabel: Dev auf `hotel`, Prod-Umzug auf anderen Server – Host/Ports/Tokens nur via Config/`.env`

## Skeleton-Struktur

| # | Bereich | Kernaufgabe (vorläufig) | Status |
|---|---|---|---|
| 1 | Dashboard | Systemstatus: MCP-Server-Health, LLM-Erreichbarkeit, letzte Interaktionen | offen |
| 2 | Actions-Editor | Prompt-Actions pflegen: Trigger-Phrasen, Anweisung an LLM, Tool-/MCP-Zugriff, deterministisches Ausgabetemplate, Clarification-Flag | offen |
| 3 | MCP-Registry | Server-URLs, Tools, Health-Check, Enable/Disable | offen |
| 4 | Test-Konsole | Alexa-Query simulieren, Trace der Pipeline (Router → MCP → LLM → Antwort) live sehen | offen |
| 5 | Logs | Konversations- und Fehlerhistorie inkl. Nachfrage-Dialoge | offen |

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
| HA-MCP | **Community-Server** (z. B. als HA-Add-on, streamable-http) |
| Nachfragen | **Hybrid-Clarification**: LLM entscheidet, pro Action konfigurierbar, Budget 1–2 Rückfragen |
| Display/Media | Stufe 1+2 (Text + Bilder) ins MVP, Video/Audio später → [DESIGN_DISPLAY.md](DESIGN_DISPLAY.md) |
| Szenario 3 (Template-Action) | LLM-Zwischenschritt **pro Action konfigurierbar** (Standard: ohne LLM) |
| Schlagwort-Matching | **RapidFuzz**, Schwellwert pro Action, global abschaltbar, kein LLM-Router |
| Warteton | **Konfigurierbar** (Phrase / SSML-Ton / aus), Default: Phrase |
| Runtime-Phasing | **Phase 1: Alexa-hosted**, Phase 2 (Kontingenz): eigene AWS-Lambda → [DESIGN_SKILL_RUNTIME.md](DESIGN_SKILL_RUNTIME.md) |
| Szenario 4 (Proaktiv/Geplant) | Zurückgestellt (Ausblick) |

## Offene Fragen

- [ ] Detaillayout/-funktionen je Bereich (folgende Diskussionsrunde)
- [ ] Persistenz der Konfiguration (Dateien YAML/JSON vs. SQLite)
- [ ] Realtime für Logs/Traces (Polling vs. SSE)
- [ ] Authentisierung Skill → Gateway: Bearer vs. HMAC (Replay-Schutz) final wählen

## Entscheidungen (Issues)

- [#1 – Routing mit 3 Action-Typen](https://github.com/dezihh/voiceassist/issues/1)
- [#2 – Runtime-Phasing (Alexa-hosted → AWS-Lambda)](https://github.com/dezihh/voiceassist/issues/2)
