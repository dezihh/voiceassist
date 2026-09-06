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

## Offene Fragen

- [ ] Detaillayout/-funktionen je Bereich (folgende Diskussionsrunde)
- [ ] Persistenz der Konfiguration (Dateien YAML/JSON vs. SQLite)
- [ ] Realtime für Logs/Traces (Polling vs. SSE)
- [ ] Authentisierung Lambda → Gateway: Bearer vs. HMAC (Replay-Schutz) final wählen

## Entscheidungen (Issues)

- (noch keine)
