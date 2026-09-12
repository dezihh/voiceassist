# Design: Skill-Runtime & Timing

> Wie das Skill-Backend betrieben wird und wie mit dem Alexa-Antwortfenster
> umgegangen wird. Entscheidung: [Issue #2](https://github.com/dezihh/meinhelfer/issues/2)

## Ergebnis (umgesetzt)

**Gateway als Alexa-Endpoint** – die Alexa-Lambda ist entfallen:

- Das Skill-Manifest zeigt auf `https://<gateway-host>/alexa` (nginx als
  knx als Reverse-Proxy, TLS, `location /` → Gateway `:8331`).
- Der `/alexa`-Endpoint im Gateway validiert die `applicationId`
  (403 bei fremder Skill-ID, kein Bearer – Alexa sendet keinen).
- Der Alexa-hosted-Build akzeptiert das Manifest mit `endpoint.uri` Problemlos.
- Der gehostete Lambda ist Dead Code (CodeCommit/CI-Push bleibt für
  Manifest/Modell-Sync bestehen).

## Grundlagen (verifiziert im Betrieb)

- Das Alexa-**Antwortfenster** von ~8 s gilt für die Antwort an den Nutzer.
- **Progressive Responses** verlängern das Nutzer-Fenster (~20–30 s).
- **ABER:** Die Alexa-hosted-Lambda hat ein **hartes, nicht konfigurierbares
  AWS-Function-Timeout von exakt 8 s** – nachweislich `REPORT Duration:
  8000.00 ms … Status: timeout` (CloudWatch) und `499` (client closed
  request) im Nginx-Access-Log. Der Warteton-Watchdog in der Lambda
  verlängert nur Alexanders Client-Fenster, nicht die Lambda-Ausführung.
  Agent-Ketten > 8 s können deshalb NICHT über eine Alexa-hosted-Lambda laufen.

## Architektur: Gateway-Endpoint (Option B)

- `/alexa` hält die HTTP-Verbindung offen, bis der Core fertig ist
  (deterministische Actions 200–370 ms, Agent-Ketten 10–15 s, nginx
  `proxy_read_timeout 35s`).
- **Warteton-Watchdog im Gateway:** bei langen Agent-Queries sendet der
  Gateway nach 6,5 s eine Progressive Response („Einen Moment, ich schaue
  das kurz nach.") über die Directives API (`api.eu.amazonalexa.com`,
  Bearer `apiAccessToken` aus dem Request).
- **Fast-Paths ohne Engine-Call** (direkte Antworten im Adapter):
  - `LaunchRequest` → fixe Begrüßung
  - `AMAZON.HelpIntent` → Fix-Hilfetext
  - `AMAZON.StopIntent` / `AMAZON.CancelIntent` / `SessionEndedRequest` →
    Abschied, Session-Ende
  - `AMAZON.FallbackIntent` → höfliche Wiederholung mit Beispielfrage
- GptQueryIntent → Core (`processQuery`), Modus je Action
  (deterministic/llm/hybrid) oder Agent.

## Latenzprofile (gemessen)

| Szenario | Dauer | Bemerkung |
|---|---|---|
| Template-Action hausstatus | 0,2–0,4 s | `ha.call` an HA-MCP-Skript |
| Agent warm (1 Tool) | 2–6 s | glm/gemini-Klasse |
| Agent cold mit Websuche | 10–15 s | Warteton bei 6,5 s |

Konfiguration: `LLM_MODEL=gemini/gemini-3.5-flash-lite` (kostenlos,
0,6 s/Tool-Turn), `LLM_MAX_TOKENS=2000` (zu klein → leere Speech durch
Thinking-Tokens), `num_results`-Cap 3 für searxng_web_search.

## Offene Punkte

- [ ] Multi-Turn-Clarification-State (Issue #7)
- [ ] Query-Slot-Bereinigung (Invocation-Reste im Slot-Text)
- [ ] Agent-Qualität: Halluzinationen („Aktenzeichen …") beobachten
