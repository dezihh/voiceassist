# voiceassist

Sprachassistent-Plattform: Alexa steuert lokale **MCP-Services** – ohne direkte Home-Assistant-Kopplung im Skill. Home Assistant ist nur noch *ein* anbindbarer MCP-Server neben anderen (z. B. Websuche).

Basierend auf den Erkenntnissen aus [HomeAssistantAssistAWS](https://github.com/dezihh/HomeAssistantAssistAWS) (dort: Alexa-Skill mit HA-Conversation-API und deterministischer Pyscript-Pipeline).

## Architektur

```text
Alexa (Echo-Geräte)
  │
  ▼
AWS Lambda  ── Thin Adapter: Locale, SSML, APL, Session/Progressive Response
  │ HTTPS (Bearer/HMAC, Reverse-Proxy, Sub-URL)
  ▼
voiceassist Gateway (lokal, Docker, FastAPI)
  ├─ Router: gelenkte Prompt-Actions (deterministische Ausgaben, z. B. „Hausstatus“)
  ├─ MCP-Client(s): Home-Assistant-MCP, SearXNG-Such-MCP, weitere
  ├─ LLM-Orchestrierung via litellm (Tool-Calls über MCP)
  └─ Admin-Web-UI (LAN-only)
```

## Features

- **MCP-Integration:** Alexa-Anfragen werden von lokalen MCP-Servern beantwortet (HA, Suche, …)
- **Gelenkte Prompt-Actions:** definierte Prompte lösen Aktionen aus, die das LLM mit definierten Tools ausführt und nach deterministischem Muster strukturiert zurückgibt (z. B. Hausstatus, Nachrichten zu Thema X)
- **Hybrid-Nachfragen (Clarification):** das LLM darf Rückfragen stellen, pro Action konfigurierbar, mit Budget (1–2 Rückfragen)
- **Thin Lambda:** AWS-Seite minimal halten (Locale/SSML/APL/Session), gesamte Logik lokal im Gateway
- **Admin-Web-UI:** LAN-only – Dashboard, Actions-Editor, MCP-Registry, Test-Konsole, Logs (Design in `doc/DESIGN_WEBUI.md`)
- **Portabel:** Dev auf `hotel`, Produktivumzug auf anderen Server – Domain/Ports/Tokens rein über Config/`.env`

## Sicherheit

- Öffentlicher Angriffsfläche: ausschließlich der token-geschützte Gateway-Endpoint hinter Reverse-Proxy (TLS, Rate-Limit, Body-Limits)
- Authentisierung: Bearer-Token bzw. HMAC-Signatur (Timestamp + Nonce) gegen Replay
- Admin-UI: nie im Internet exponiert, LAN-Allowlist im Reverse-Proxy
- Container-Härtung: Non-Root, gepinnte Dependencies, Secrets nur via `.env` (nie im Repo)
- Prompt-Injection-Schutz: deterministische Ausgabe-Templates, Tool-Allowlist, strikte Antwortvalidierung

## Repository-Struktur (geplant)

```text
lambda/          AWS Lambda: Alexa-Adapter (ask-sdk)
gateway/         FastAPI-Gateway: Router, MCP-Clients, LLM-Orchestrierung
admin-ui/        Admin-Weboberfläche (LAN-only)
config/          Prompt-Actions, MCP-Registry (Beispiele)
doc/             Design-Dokumente (DESIGN_WEBUI.md), Deployment
```

## Status

**In Entwicklung.** Design-Diskussion: [doc/DESIGN_WEBUI.md](doc/DESIGN_WEBUI.md) + Issues.

- AWS CLI wird für Lambda-Deployment genutzt; dafür nötige lokale Dateien (`.aws/`, Builds, Secrets) sind via `.gitignore` ausgeschlossen.
