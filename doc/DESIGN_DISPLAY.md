# Design: Display & Media (Echo Show)

> Echo-Gerätepark: **gemischt** (Echo Show + reine Audio-Geräte) → alle
> Display-Inhalte sind optional, `speech` kommt immer.

## Roadmap

| Stufe | Inhalt | Aufwand | Meilenstein |
|---|---|---|---|
| 1 | Vorgelesener Text auf dem Display | gering | **MVP** |
| 2 | Grafiken/Bilder (Icons, Snapshots, Suchergebnis-Bilder, Carousels) | gering–mittel | **MVP** |
| 3 | Videos (MP4/HLS) via APL `Video` | mittel | später |
| 4 | Musik/Audio via `AudioPlayer`-Interface (Playqueue) | mittel–hoch | später |

## Antwort-Schema (Gateway → Lambda)

```json
{
  "speech": "…",
  "display": {
    "title": "…",
    "text": "…",
    "images": ["https://…"],
    "video": "https://…"
  }
}
```

- `display` ist **optional**; Audio-Geräte ignorieren es (Fallback-Strategie)
- Das dünne Lambda rendert nur ein APL-Dokument aus dem Payload (Template im Repo, keine Logik dort)
- MCP-Server können Media-URLs liefern; LLM kann Bild-URLs aus Suchergebnissen ergänzen
- Deterministische Actions (z. B. „Hausstatus") definieren ihre Display-Ausgabe im Template

## Constraints (wichtig)

- Echo-Geräte holen Media **direkt aus dem Internet**: URLs müssen öffentlich per HTTPS erreichbar sein
- LAN-URLs (`192.168.x.x`) funktionieren nicht → LAN-Medien über den öffentlichen Host tunneln
  (z. B. `https://<host>/<sub-path>/media/…` mit Token-in-URL, kurzlebig)
- Formate: JPEG/PNG für Bilder; H.264/AAC MP4 oder HLS für Video
- `AudioPlayer` (Stufe 4) ist ein separates Interface mit eigenen Direktiven – eigener Workstream

## Offene Fragen

- [ ] Media-Endpoint am öffentlichen Host (Reverse-Proxy) konkret ausgestalten (Stufe 2)
- [ ] APL-Viewport-Anpassung je Echo-Show-Modell
