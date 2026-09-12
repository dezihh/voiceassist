# MeinHelfer

**Deine Alexa mit Superkräften.** Stell Fragen, erledige Dinge, bleib natürlich — ein sprachgesteuerter Assistent, der funktioniert, egal ob du es genau wissen willst oder nur mal kurz „Was gibt's Neues?" wirfst.

- **Schnell, wo es zählt.** Klare, wiederkehrende Fragen — „Hausstatus", „Benzinpreis", „Nachrichten" — beantwortet ein fester Router deterministisch: gleiche Frage, gleiche Antwort, in Sekundenbruchteilen. Keine KI-Lotterie.
- **Klug, wo es drauf ankommt.** Alles Offene übernimmt dein LLM — mit einstellbarem Kontext aus der Vergangenheit (einstellbar), damit es weiß, was zuletzt war. Unterbrechen? Nachfragen? Jederzeit.
- **Eingebunden, nicht eingebildet.** Über MCP greift MeinHelfer auf deine echte Welt zu: Smart Home, Websuche, Nachrichtenquellen.
- **Privat & lokal.** Die Intelligenz läuft auf deiner eigenen Hardware. Deine Fragen bleiben bei dir.

## Zwei Modi, ein Flow

Standard ist der **OneShot-Modus**: eine Frage → eine Antwort → Session zu. Kein „Wartet die Alexa noch?"-Gefühl, kein offenes Mikrofon. Der Kontext aus der letzten Frage bleibt aber erhalten.

Möchtest du dranbleiben: **„Mein Helfer, Chat-Modus"** — jetzt bleibt die Session offen, du kannst Folgefragen ganz ohne „Alexa..." anhängen, bis du beendest.

## Architektur

```text
Alexa (Echo-Geräte)
  │
  ▼
AWS Lambda  ── Thin Adapter: Locale, SSML, APL, Session/Progressive Response
  │ HTTPS (Bearer/HMAC, Reverse-Proxy, Sub-URL)
  ▼
MeinHelfer Gateway (lokal, Docker, Node.js + TypeScript)
  ├─ Router: gelenkte Prompt-Actions (deterministische Ausgaben, z. B. „Hausstatus“)
  ├─ MCP-Client(s): Home-Assistant-MCP, SearXNG-Such-MCP, weitere
  ├─ LLM-Orchestrierung via litellm (Tool-Calls über MCP)
  └─ Admin-Web-UI (LAN-only)
```

Zentrale Architekturregeln (Adapter-Muster, Auth-/Berechtigungs-Ebenen, Datenmodell): [doc/ARCHITECTURE.md](doc/ARCHITECTURE.md)

## Features

- **MCP-Integration:** Alexa-Anfragen werden von lokalen MCP-Servern beantwortet (HA, Suche, …)
- **Gelenkte Prompt-Actions:** definierte Prompts lösen Aktionen aus, die das LLM mit definierten Tools ausführt und nach deterministischem Muster strukturiert zurückgibt (z. B. Hausstatus, Nachrichten zu Thema X)
- **Hybrid-Nachfragen (Clarification):** das LLM darf Rückfragen stellen, pro Action konfigurierbar, mit Budget (1–2 Rückfragen)
- **Kontext & Follow-ups:** jede Antwort wandert ins Kurzzeitgedächtnis, Folgefragen innerhalb einer offenen Session funktionieren ohne Neu-Invocation
- **Warteton bei längerer Recherche:** dauert eine Antwort länger, meldet sich der Skill nach wenigen Sekunden mit einer kurzen Ansage (Progressive Response), damit Alexa das Antwortfenster nicht abbricht
- **Echo-Show (APL):** Antworten mit scrollbarem Text auf Geräten mit Bildschirm
- **Thin Lambda:** AWS-Seite minimal halten (Locale/SSML/APL/Session), gesamte Logik lokal im Gateway
- **Admin-Web-UI:** LAN-only – Dashboard, Actions-Editor, MCP-Registry, Test-Konsole, Logs (Design in `doc/DESIGN_WEBUI.md`)
- **Portabel:** Dev auf `hotel`, Produktivumzug auf anderen Server – Domain/Ports/Tokens rein über Config/`.env`

## Sicherheit

Das Projekt bringt eigenen Schutz mit, setzt aber **keinen Reverse-Proxy voraus** — wird einer davor betrieben, kann er die genannten Punkte zusätzlich übernehmen (empfohlen).

**Im Projekt selbst:**

- `/alexa` (Skill-Endpoint): validiert die `applicationId` und optional die Alexa-Signatur (Zertifikatskette, Timestamp-Toleranz; Modus off/warn/enforce über `.env`)
- `/api/*` und `/admin/*`: Bearer-Token-Auth (`AUTH_TOKEN`), constant-time verglichen
- JSON-Body-Limit (1 MB), Non-Root-Container, gepinnte Dependencies, Secrets nur via `.env` (nie im Repo)
- Admin-UI: nie im Internet exponieren; im Reverse-Proxy auf LAN-Allowlist legen
- Prompt-Injection-Schutz: deterministische Ausgabe-Templates, Tool-Allowlist, strikte Antwortvalidierung

**Empfohlen (Reverse-Proxy, z. B. nginx):**

- TLS-Beendung für `vsys.ziegler-eu.de` etc.
- Rate-Limiting als zusätzliche Drossel
- LAN-Allowlist für die Admin-UI

## Repository-Struktur

```text
alexa/           Alexa-Skill-Paket: Lambda-Adapter (ask-sdk, Python), Interaktionsmodell, CI-Workflows
gateway/         Gateway (Node.js + TypeScript): Router, MCP-Clients, LLM-Orchestrierung, Admin-API
gateway/web/     Admin-Weboberfläche (vanilla HTML/CSS/JS, LAN-only)
doc/             Design-Dokumente (DESIGN_WEBUI.md, DESIGN_DISPLAY.md), Deployment
.github/         CI/CD-Workflows (Smoke-Tests, Alexa: Modell-, Manifest-, Deploy-Sync)
```

## Status

**In Entwicklung.** Design-Diskussion: [doc/DESIGN_WEBUI.md](doc/DESIGN_WEBUI.md) + Issues.

- AWS CLI wird für Lambda-Deployment genutzt; dafür nötige lokale Dateien (`.aws/`, Builds, Secrets) sind via `.gitignore` ausgeschlossen.

## Ausblick (Streckliste)

Ideen, die nicht versprochen, aber festgehalten sind — gerne priorisieren:

- **Musik (via MCP):** Music Assistant bietet einen MCP-Server (Player, Suche, Queue, Playlists) → Motivation: MeinHelfer als Sprach-Steuerung. Hinweis: echte Audio-Wiedergabe auf dem Echo läuft über den separaten Alexa-Provider von Music Assistant, nicht über diesen Skill.
- **Echo-Show Autoscroll:** scrollbaren Text auf Bildschirm-Geräten zusätzlich automatisch weiterlaufen lassen (Barrierefreiheit).
- **Weitere MCP-Quellen:** z. B. Kalender/Wetter/Verkehr als weitere MCP-Server.
- **Mehrsprachigkeit:** Skill-Name und Begrüßung konfigurierbar, sodass z. B. englischsprachige Nutzer den Skill ohne Code-Eingriff umbenennen können.