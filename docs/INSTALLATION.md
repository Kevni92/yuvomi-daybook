# Installation des Prototyps

## 1. Frontend-Modul

Den Ordner `modules/daybook` in das Modulverzeichnis der Yuvomi-Installation kopieren, z. B. nach:

`/opt/yuvomi/modules/daybook`

Danach Yuvomi neu laden/neustarten, damit `module.json` erkannt wird. In den Berechtigungen benötigt das Modul den Schlüssel `ext:daybook` mit `read` oder `write`.

## 2. Daybook-Service

Der Service läuft standardmäßig auf Port 3200 und erwartet, dass Yuvomi `/api/extensions/daybook/*` dorthin proxyt. Das Reverse-Proxy-Muster ist dasselbe wie beim Banking-Modul.

Wichtige Variablen:

| Variable | Zweck |
| --- | --- |
| `YUVOMI_INTERNAL_URL` | interne URL des Yuvomi-Core |
| `DAYBOOK_DB_PATH` | SQLite-Datei |
| `DAYBOOK_MEDIA_DIR` | Fotos und Audio |
| `BANKING_DB_PATH` | read-only gemountete Banking-SQLite-Datei |
| `BANKING_DATA_ENCRYPTION_KEY` / `_FILE` | Entschlüsselung des dort gespeicherten OpenAI-Keys |
| `OPENAI_API_KEY` | optionaler Fallback, falls Banking nicht gemountet ist |
| `DAYBOOK_TRANSCRIPTION_MODEL` | standardmäßig `gpt-4o-mini-transcribe` |

`deploy/docker-compose.example.yml` zeigt die beabsichtigte Einbindung. Die konkreten Pfade für Banking-Daten und Secrets müssen an die bestehende Installation angepasst werden.

## 3. Dashboard-Plus

Das Widget „Letzte Erinnerung“ ist standardmäßig sichtbar. Beim Mounten erweitert es Yuvomis bestehenden Plus-Speed-Dial um „Erinnerung“. Dadurch ist für den Prototyp keine Änderung am Yuvomi-Core nötig.

Wenn das Widget komplett aus dem Dashboard entfernt wird, entfällt auch diese dynamische Quick-Action. Langfristig sollte Yuvomi Quick-Actions als offizielle Extension-Capability anbieten.

## 4. GPS

Der Prototyp liest GPS aus JPEG-EXIF direkt im Browser. PNG/WebP können gespeichert werden, liefern in dieser Version aber keine Standortdaten. Die Karte wird über eine normale Google-Maps-Embed-URL dargestellt; ein separater Maps-API-Key ist nicht nötig.

## 5. Datenschutz

Fotos und Audio bleiben im eigenen Daybook-Speicher. Nur eine aktiv aufgenommene Sprachnachricht wird für Speech-to-Text an OpenAI übertragen. Der OpenAI-Schlüssel wird nie an den Browser ausgegeben.
