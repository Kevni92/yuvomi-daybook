# Yuvomi Daybook

Prototyp eines visuellen Familientagebuchs für Yuvomi.

## Zielbild

- neueste Erinnerung prominent oben
- ältere Ereignisse als alternierende Chronologie
- Filter nach Yuvomi-Familienmitgliedern
- Text, Fotos und Sprachnachrichten pro Ereignis
- Speech-to-Text über die OpenAI Audio-Transcription-API
- Wiederverwendung des bereits im Banking-Modul gespeicherten OpenAI-API-Keys
- GPS aus JPEG-EXIF übernehmen und Ereignis auf Google Maps anzeigen
- Dashboard-Widget „Letzte Erinnerung“
- Integration in den vorhandenen Yuvomi-Plus-Button über das Dashboard-Widget

## Struktur

- `modules/daybook/` – Yuvomi-Frontend-Modul
- `service/` – kleiner Node/TypeScript-Service mit SQLite, Medienablage und Transkription
- `docs/PROTOTYPE.md` – Architektur, Installation und bekannte Grenzen

> Status: funktionaler Prototyp. Das Datenmodell und die UI sind bewusst so angelegt, dass später Jahresrückblicke, automatische Kalender-Vorschläge, Tags und eine Volltextsuche ergänzt werden können.
