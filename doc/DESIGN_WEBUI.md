# Design: Admin-Web-UI

> Arbeitsdokument für die Design-Diskussion. Konkrete Entscheidungen werden als
> Issue festgehalten (`design`-Label) und hier verlinkt.

## Ziele

- Administration des voiceassist-Gateways über den Browser
- **LAN-only** (Allowlist im Reverse-Proxy), nie internet-exponiert
- Ein App-Container gemeinsam mit dem Gateway, getrennt via Sub-URL (`/voiceassist/admin/…`)

## Skeleton-Struktur

| Bereich | Zweck | Status |
|---|---|---|
| Dashboard | Systemstatus (MCP-Server, LLM, letzte Interaktionen) | offen |
| Actions-Editor | Prompt-Actions anlegen/editieren (deterministische Templates, Clarification-Flags) | offen |
| MCP-Registry | MCP-Server verwalten (URL, Tools, Aktiv-Status, Health-Check) | offen |
| Test-Konsole | Alexa-Anfrage simulieren, Pipeline-Trace sichtbar (Router → MCP → LLM) | offen |
| Logs | Konversations-/Fehlerhistorie inkl. Nachfrage-Dialoge | offen |

## Offene Fragen

- [ ] Inhalte/Detaillayout je Bereich (Beschreibung folgt)
- [ ] Tech-Stack UI (Server-rendered FastAPI/Templates vs. separates SPA)
- [ ] Auth im LAN (reine Allowlist vs. zusätzlicher Login)
- [ ] Realtime (Polling vs. SSE für Logs/Traces)

## Entscheidungen (Issues)

- (noch keine)
