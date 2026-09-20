# Projektstil für Home-Assistant-Karten

Bei neuen oder geänderten Dashboard-Karten ist diese Farbpalette zu verwenden:

- Akzentblau / aktive Icons: `#A1CCD1`
- Pop-up-Hintergrund: `#191919`
- Kartenhintergrund: `#202020`
- Haupthintergrund: `#252525`
- Icon-Hintergrund: `#2b2b2b`
- Primärtext: `#e5e5e5`
- Sekundärtext: `#a6a6a6`
- Dezentes Warngelb: `#d6c49b`
- Dezentes Warnrot: `#d98b83`
- Dezentes Statusgrün: `#a8c99f`
- Spotify-Akzent: `#C5ECBE`

Nicht ohne ausdrücklichen Wunsch auf `var(--primary-color)` oder ein anderes Blau ausweichen. Aktive Geräte- und Funktionsicons verwenden grundsätzlich `#A1CCD1`.

# Git- und Release-Ablauf

Änderungen, die als Plugin-Update ausgeliefert werden sollen, vor dem ersten
Push vollständig als Release vorbereiten:

1. Nächste semantische Version festlegen.
2. Version konsistent in `package.json`, `package-lock.json`,
   `mqtt.reaplugin/manifest.json`, `src/discovery.js`, `README.md` und
   `CHANGELOG.md` aktualisieren.
3. `npm test`, `npm run build`, `npm run check` und die relevanten
   Integrationstests ausführen.
4. Feature, Dokumentation, gebautes Bundle und Versionsänderung gemeinsam
   committen.
5. `main` genau einmal pushen. Dieser Push aktualisiert nur den Quellstand und
   soll keinen Workflow auslösen.
6. Danach den zur Manifest-Version passenden annotierten Tag erstellen und
   pushen, zum Beispiel `v0.2.3`. Nur der Tag-Lauf führt Validierung, Unit- und
   Integrationstests aus und erstellt anschließend Release-ZIP und
   GitHub-Release.

Nicht erst einen unveröffentlichten Feature-Commit nach `main` pushen und
anschließend einen separaten Versions-Commit pushen. Das erzeugt einen
unnötigen zusätzlichen Push. `.github/workflows/release.yml` soll nicht auf
Pushes nach `main`, sondern nur auf Pull Requests, manuelle Ausführung und
Versions-Tags (`v*`) reagieren. Damit gibt es pro Veröffentlichung genau einen
vollständigen Workflow-Lauf.
