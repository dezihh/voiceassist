# Architektur

> Zentrale Architekturregeln von voiceassist. Festgehalten nach Review 2026-09-06
> (Improvement-Issues #3–#6, POC-Entscheidungen in [DESIGN_WEBUI.md](DESIGN_WEBUI.md)).

## Zentrale Architekturregel: Adapter-Muster

Der Core kennt **kein Alexa**. Alexa-spezifisches (Requests, JSON-Strukturen,
Response Cards, APL) liegt ausschließlich im Adapter:

```text
Alexa Adapter ──▶ VoiceQuery ──▶ VoiceAssist Core ──▶ AssistantResponse ──▶ Alexa Adapter
```

```typescript
interface VoiceQuery {
  sessionId: string;
  userId?: string;
  text: string;
}

interface AssistantResponse {
  speech: string;            // für Sprachausgabe immer gesetzt
  display?: DisplayPayload;  // optional, siehe DESIGN_DISPLAY.md
}
```

Damit sind weitere Adapter möglich, ohne den Core anzufassen:
**Alexa Adapter** (MVP), später Web Adapter, API Adapter, Home-Assistant-Voice-Adapter.

Der Core kennt: Query, Session, User, Response, MCP, LLM, Actions –
aber keine Alexa-Requests, Alexa-JSON-Strukturen oder Response Cards.

## Pipeline

```text
VoiceQuery
  ▼
Router: Template-Action > Prompt-Action > Agent-Query (Default)
  ▼                 ▼                       ▼
Jinja + Kontext   LLM + festes Prompt    LLM frei mit MCP-Tools
  └────────────────┴───────────────────────┘
                    ▼
        AssistantResponse { speech, display? }
```

Routing-Details und Latenzbudgets: [DESIGN_WEBUI.md](DESIGN_WEBUI.md), [DESIGN_SKILL_RUNTIME.md](DESIGN_SKILL_RUNTIME.md).

## Authentifizierung: zwei getrennte Ebenen

| Ebene | POC | Später (Improvement) |
|---|---|---|
| **Client-Auth** (Alexa → Gateway) | statisches Shared Secret, vorab konfiguriert; kein OAuth, kein interaktiver Login | Replay-Schutz via HMAC (Timestamp + Nonce) → Issue #5 |
| **MCP-Server-Auth** (Gateway → HA `/api/mcp`) | Long-Lived Access Token als Bearer | OAuth (IndieAuth-artig) → Issue #6 |

- Zweck des POC-Client-Auth: „Der Request kommt von meinem Alexa-Client."
- Eine spätere Trennung zwischen Client-Authentifizierung und User-Identität bleibt möglich
- Beide Ebenen bewusst nicht vermischt und nicht verkompliziert

## Berechtigungen: zwei getrennte Ebenen

```text
Home Assistant
└── Welche Entities darf MCP sehen?          (HA-eigene Steuerung)

VoiceAssist
└── Welche MCP-Tools darf das LLM verwenden? (später pro Action, Issues #3/#4)
```

VoiceAssist baut **keine zweite Entity-Berechtigungsschicht** nach.

## Template-Action: kontrollierter Kontext

Jinja2 erhält **keinen direkten MCP-Zugriff**, sondern einen kontrollierten Kontext:

- `ha.state(entity_id)`, `ha.entities(domain, …)`, `ha.call(…)` – oder allgemeiner `tools.<name>(…)`
- Bestandteile einer Template-Action: Template, definierter Kontext, verfügbare
  Daten-/Tool-Funktionen, optionale Bedingungen, resultierender Text

Beispiel:

```yaml
name: house_status
type: template
template: |
  {% set temp = ha.state("sensor.living_room_temperature") %}
  {% set lights = ha.entities("light") | selectattr("state", "eq", "on") | list %}

  Im Wohnzimmer sind {{ temp }} Grad.

  {% if lights | length > 0 %}
  Es sind {{ lights | length }} Lichter eingeschaltet.
  {% else %}
  Es sind keine Lichter eingeschaltet.
  {% endif %}
```

Damit behalten wir die Kontrolle darüber, was ein Template ausführen darf
(POC: sehr einfach gehalten).

## Datenmodell (POC)

SQLite, bewusst klein:

| Tabelle | Inhalt |
|---|---|
| `mcp_servers` | MCP-Server-Registry (URL, Auth-Vermerk, Aktiv-Status) |
| `actions` | Vorgänge inkl. Trigger, Templates, `mode` (deterministic/llm/hybrid), Flags |
| `prompts` | System-/Agent-Prompte |
| `settings` | Laufzeit-Einstellungen (Warteton, Timeouts, Fuzzy global) |

Credentials pragmatisch (`.env`/Env-Vars) – kein ausgefeiltes Secret-Management
als POC-Blocker.

## Externe Dienste

| Dienst | Endpoint (konfigurierbar via `.env`) |
|---|---|
| LLM | LiteLLM **knx**: `<llm-base-url>` (OpenAI-kompatibel, `chat/completions`; z. B. Modell `chat-fast`/`chat-quality`; API-Key via Env) |
| MCP (HA) | Offizielle HA-Integration `/api/mcp` (Streamable HTTP, Bearer-LLAT) |

## Conversation State

Die interne API kennt ab POC `sessionId`/`conversationId`:

```json
{"sessionId": "…", "query": "Mach es auf 21 Grad"}
```

POC: State sehr simpel. Später ausbaubar zu:

```text
session
├── conversation history
├── previous action
├── clarification
└── context
```

## Trace & Logging

Jeder Tool-Call wird geloggt (inkl. Szenario und Latenz) – Basis für spätere
Permissions (#3/#4) und Betriebsauswertung (Phase-2-Trigger, siehe
[DESIGN_SKILL_RUNTIME.md](DESIGN_SKILL_RUNTIME.md)).
