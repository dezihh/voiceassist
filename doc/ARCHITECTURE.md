# Architektur

> Zentrale Architekturregeln von meinhelfer. Festgehalten nach Review 2026-09-06
> (Improvement-Issues #3–#6, POC-Entscheidungen in [DESIGN_WEBUI.md](DESIGN_WEBUI.md)).

## Zentrale Architekturregel: Adapter-Muster

Der Core kennt **kein Alexa**. Alexa-spezifisches (Requests, JSON-Strukturen,
Response Cards, APL) liegt ausschließlich im Adapter:

```text
Alexa Adapter ──▶ VoiceQuery ──▶ MeinHelfer Core ──▶ AssistantResponse ──▶ Alexa Adapter
```

```typescript
interface VoiceQuery {
  sessionId: string;
  userId?: string;
  text: string;
}

interface AssistantResponse {
  speech: string;            // für Sprachausgabe immer gesetzt
  ssml?: boolean;            // true: speech enthält fertiges SSML (Passthrough)
  display?: DisplayPayload;  // optional, siehe DESIGN_DISPLAY.md
  followUp?: boolean;        // true: Session offen halten (Rückfrage)
}
```

Damit sind weitere Adapter möglich, ohne den Core anzufassen:
**Alexa Adapter** (MVP), später Web Adapter, API Adapter, Home-Assistant-Voice-Adapter.

Der Core kennt: Query, Session, User, Response, MCP, LLM, Actions –
aber keine Alexa-Requests, Alexa-JSON-Strukturen oder Response Cards.

## SSML: Verantwortung liegt beim Adapter

Die Sprachausgabe braucht SSML (Erfahrung aus dem Vorgängerprojekt: ohne
`<break>`-Pausen und `<say-as>`/`<sub>` für Einheiten und Zahlen klingt die
Ausgabe schlecht bzw. wird falsch ausgesprochen). Der Grundsatz:

- **Der Core arbeitet sprachneutral.** `AssistantResponse.speech` ist standardmäßig
  Klartext. Enthält eine Quelle (z. B. HA-Skript) fertiges SSML, setzt der Core
  `ssml: true` und reicht es unverändert durch – er strippt es nicht mehr.
- **Der Adapter erzeugt bzw. validiert SSML.** Der Alexa-Adapter wrappt Klartext
  selbst (inkl. XML-Escaping) zu `<speak>…</speak>`; bei `ssml: true` wird das
  vorhandene SSML unverändert übernommen und maximal auf genau einen
  `<speak>`-Wrapper normalisiert. **Kein Doppel-Wrapping, kein Escaping von
  gültigem SSML** – beides führt zu Invalid-SSML-Fehlern auf Alexa-Seite.
- **Envelopes werden unwrappt, nicht zerstört.** Alte HA-Skripte antworten mit
  `{"speech": {"ssml": {"speech": "<speak>…"}}}` – der Template-Kontext extrahiert
  das innere SSML und markiert es als solches. Für die Card (Display) wird SSML
  zu Klartext bereinigt.

Damit kann jede Quelle (Skript, Template, LLM) selbst entscheiden, ob sie
Prosodie-Kontrolle über SSML braucht – ohne dass der Core Alexa-Details kennt.

## Pipeline

```text
VoiceQuery
  ▼
Router: Action-Route > Agent-Query (Default)
  ▼               ▼
 deterministisch  LLM frei mit MCP-Tools
 (Handler:       (System-Prompt, Tool-Allowlist,
  template /      Clarification-Budget)
  search_summary /            │
  llm/hybrid)                 ▼
  └────────────────┬──────────┘
                   ▼
        AssistantResponse { speech, ssml?, display?, followUp?, keepOpen? }
```

Routing-Details und Latenzbudgets: [DESIGN_WEBUI.md](DESIGN_WEBUI.md), [DESIGN_SKILL_RUNTIME.md](DESIGN_SKILL_RUNTIME.md).

## Authentifizierung: zwei getrennte Ebenen

| Ebene | Stand (Implementierung) | Später (Improvement) |
|---|---|---|
| **Client-Auth** (Alexa → Gateway `/alexa`) | `applicationId`-Vergleich; optional Alexa-Signatur-Verifikation (Zertifikatskette gem. Amazon, Timestamp-Toleranz) via `ALEXA_VERIFY_MODE` off/warn/enforce | — |
| **API-/Admin-Auth** (`/api/*`, `/admin/*`) | Bearer-Token (`AUTH_TOKEN`), constant-time über `timingSafeEqual` | Replay-Schutz via HMAC (Timestamp + Nonce) → Issue #5 |
| **MCP-Server-Auth** (Gateway → HA `/api/mcp`) | Long-Lived Access Token als Bearer | OAuth (IndieAuth-artig) → Issue #6 |

- Zweck der Client-Auth auf `/alexa`: „Der Request kommt von meinem Alexa-Skill (applicationId) und wirklich von Amazon (Signatur)."
- Eine spätere Trennung zwischen Client-Authentifizierung und User-Identität bleibt möglich
- Beide Ebenen bewusst nicht vermischt und nicht verkompliziert

## Berechtigungen: zwei getrennte Ebenen

```text
Home Assistant
└── Welche Entities darf MCP sehen?          (HA-eigene Steuerung)

MeinHelfer
└── Welche MCP-Tools darf das LLM verwenden? (später pro Action, Issues #3/#4)
```

MeinHelfer baut **keine zweite Entity-Berechtigungsschicht** nach.

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
| `actions` | Vorgänge inkl. Trigger, Templates, `mode` (deterministic/llm/hybrid/search_summary), `handler_config` (JSON), Flags |
| `prompts` | System-/Agent-Prompte |
| `settings` | Laufzeit-Einstellungen (Warteton, Timeouts, Fuzzy global, Session-Followup) |
| `logs` | Request-Log inkl. Route, Latenz, Trace (Tool-Calls, LLM-Schritte) |

Credentials pragmatisch (`.env`/Env-Vars) – kein ausgefeiltes Secret-Management
als POC-Blocker.

## Externe Dienste

| Dienst | Endpoint (konfigurierbar via `.env`) |
|---|---|
| LLM | LiteLLM (OpenAI-kompatibel, `chat/completions`; Base-URL via Env `LLM_BASE_URL`, z. B. Modell `chat-fast`/`chat-quality`; API-Key via Env) |
| MCP (HA) | Offizielle HA-Integration `/api/mcp` (Streamable HTTP, Bearer-LLAT) |

## Conversation State

Die API kennt `sessionId`:

```json
{"sessionId": "…", "query": "Mach es auf 21 Grad"}
```

Implementiert (2026-09): Kurzzeitgedächtnis pro Session (`rememberTurn`/`priorTurns`,
in-memory + Rückgriff auf die letzten Agent-Logs), steuerbar über das Setting
`session_followup` (llm/keyword/beides) — eine offene Session erlaubt Folgefragen
ohne erneute Invocation. Ausbaubar zu:

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
