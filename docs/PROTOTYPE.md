# Familientagebuch – Prototyp

## UX

Die Modulstartseite zeigt die neueste Erinnerung als große Hero-Karte. Darunter folgt eine vertikale Chronologie, die auf breiten Ansichten abwechselnd links und rechts der Zeitachse verläuft. Auf Smartphones klappt sie bewusst auf eine gut lesbare Einzelspalte zusammen.

Personen werden aus Yuvomi geladen. Jede Person bekommt eine stabile Akzentfarbe; die Filterleiste kann die Chronik auf ein Familienmitglied reduzieren.

Der Editor unterstützt Text, mehrere Fotos und eine Sprachaufnahme. Eine Aufnahme wird als Original-Audio gespeichert und zusätzlich per OpenAI transkribiert. Der erkannte Text kann direkt als Tagebuchtext übernommen werden.

JPEG-Fotos werden im Browser auf EXIF-GPS geprüft. Wenn Koordinaten vorhanden sind, übernimmt der Entwurf sie als Ort und zeigt eine Google-Maps-Vorschau. Es werden keine Google-Maps-API-Schlüssel benötigt; der Prototyp verwendet die normale Maps-Embed-URL.

## Dashboard-Plus

Yuvomis Dashboard-FAB ist aktuell im Core hart codiert. Der Prototyp löst das ohne Core-Fork: Das standardmäßig sichtbare Daybook-Widget hängt beim Mounten den Eintrag „Erinnerung“ an das bestehende Speed-Dial und navigiert nach `/m/daybook?new=1`.

Das ist bewusst eine Prototyp-Brücke. Eine spätere saubere Plattform-Erweiterung sollte Quick-Actions als Manifest-Capability unterstützen.

## OpenAI-Konfiguration

Der Daybook-Service kann den im Banking-Modul gespeicherten API-Key wiederverwenden. Dafür wird die Banking-SQLite-Datei read-only eingebunden und mit demselben `BANKING_DATA_ENCRYPTION_KEY` entschlüsselt. Falls das nicht konfiguriert ist, dient `OPENAI_API_KEY` als Fallback.

Standardmodell für Sprache-zu-Text ist `gpt-4o-mini-transcribe`; es kann über `DAYBOOK_TRANSCRIPTION_MODEL` geändert werden.

## Datenhaltung

SQLite speichert Einträge und Medien-Metadaten. Binärdaten liegen in `DAYBOOK_MEDIA_DIR`. Ein Eintrag enthält einen Snapshot der beteiligten Personen, damit ältere Erinnerungen auch nach späteren Namensänderungen verständlich bleiben.

## Noch nicht Teil des Prototyps

- Bearbeiten/Löschen mit Versionshistorie
- Videos und HEIC-EXIF
- automatische Jahres- und Monatsrückblicke
- Volltextsuche und semantische Suche
- automatische Vorschläge aus Kalender/Tasks
- Gesichtserkennung
- gemeinsames Kommentieren/Reaktionen
