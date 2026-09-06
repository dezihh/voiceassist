# Design: Skill-Runtime & Timing

> Wie das Skill-Backend betrieben wird und wie mit dem Alexa-Antwortfenster
> (~8 s) umgegangen wird. Entscheidung: [Issue #2](https://github.com/dezihh/voiceassist/issues/2)

## Grundlagen

- Das Alexa-Antwortfenster von **~8 s** gilt unabhängig vom Hosting.
- **Progressive Responses** (Directives API) sind auch bei Alexa-hosted nutzbar
  (Bestandsprojekt hat den Bestätigungston so gesendet) und verlängern das
  effektive Fenster (~20–30 s, im Betrieb zu verifizieren).
- Erfahrungswerte aus dem Bestandsprojekt: Timeout-Probleme sind die Ausnahme.

## Phase 1 (MVP): Alexa-hosted Skill

- Skill-Backend läuft bei Amazon (Python, ask-sdk) – **die gleiche Codebasis wie später Phase 2**
- Ruft nur den öffentlichen Gateway-Endpoint auf (`/voiceassist/api/`, Reverse-Proxy, TLS)
- Kein Account-Linking nötig: Gateway-Token als Umgebungsvariable im Alexa-Console-Setup
- **Harte Latenzdisziplin** (Budget ~8 s):

| Szenario | Budget | Maßnahmen |
|---|---|---|
| Template-Action | < 3 s | kein LLM (Standard), parallele MCP-Calls |
| Prompt-Action | < 6–7 s | festes Prompt, MCP-Allowlist, begrenzte Tool-Runden |
| Agent-Query | volles Fenster | Tool-Iterations-Limit (z. B. max. 3), max_tokens begrenzt, schnelles Modell, parallele MCP-Calls |

- **Graceful Timeout:** bei Überschreitung höfliche Fehlerantwort („Das hat leider zu lange gedauert…") + Log-Eintrag – die Logdaten sind die Entscheidungsgrundlage für Phase 2
- **Warteton-Watchdog (implementiert):** Gateway-Aufruf im Worker-Thread;
  nach `watchdog_delay` (~6,5 s) ohne Antwort zweite Progressive Response
  (Warteton-Phrase), danach Warten bis `gateway_timeout` (28 s). Konfiguration
  über Lambda-Umgebungsvariablen (`warteton_enabled`, `warteton_phrase`,
  `watchdog_delay`, `gateway_timeout`); Acknowledgment-Phrase bei t = 0 bleibt
  separat (`acknowledgment_enabled`).

### Verifikationspunkte Prototyp

1. Progressive Response in Alexa-hosted: funktioniert? Bis wann?
2. Effektive Antwortfenster-Grenze messen
3. Latenzprofile je Szenario im Gateway-Log erfassen (später UI-Statistik)

## Phase 2 (Kontingenz): eigene AWS-Lambda

**Nur wenn im Betrieb Probleme auftreten** (Trigger z. B.: wiederholt Agent-Queries > 8 s,
Graceful-Timeout-Quote über Schwelle). Dann:

- Umzug des Skill-Backends auf **eigene AWS-Lambda** – gleiche Codebasis, nur Deployment-Wechsel (ARN-Endpoint in der Alexa-Console ändern)
- Lambda-Timeout erhöhen
- **Progressive-Response-Kette:**
  - t ≈ 0,5–1 s: Warteton/Phrase an den Nutzer (konfigurierbar)
  - t ≈ 6,5 s ohne Gateway-Antwort: **Watchdog** sendet zweite Progressive Response („Ich bin noch dabei…") → verlängert das Fenster
  - sobald Gateway fertig: finale Antwort innerhalb des verlängerten Fensters
  - wichtig: **keine finale Zwischenantwort als Trick** – sie beendet den Request endgültig
- Falls auch das Fenster endet: Graceful Timeout wie Phase 1

## Konfiguration (Gateway/Lambda)

| Parameter | Default | Phase |
|---|---|---|
| Warteton-Modus | `phrase` (`phrase` / `tone` / `off`) | 1+2 |
| Agent: max. Tool-Iterationen | 3 | 1+2 |
| Agent: max_tokens | klein (Antwortlänge Sprache) | 1+2 |
| Watchdog-Schwelle | ~6,5 s | 1+2 (implementiert) |
| Lambda-Timeout | 8 s (Alexa-hosted fix) | 2: erhöhen |
| Gateway-Timeout (Lambda) | 28 s | 1+2 (implementiert) |

## Offene Fragen

- [ ] Konkrete Trigger-Schwellen für Phase 2 (aus anfänglichen Betriebsdaten ableiten)
- [ ] Alexa-hosted: Speicher-/Package-Grenzen für lambda/ prüfen
