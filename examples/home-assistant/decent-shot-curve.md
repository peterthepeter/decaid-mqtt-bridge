# Letzten Espresso-Bezug anzeigen

Ab Plugin **0.3.0** wird bei aktivierter MQTT-Discovery automatisch der Sensor
**DE1+ Last Shot Curve** (abhängig vom konfigurierten Namenspräfix) angelegt.
ApexCharts Card und card-mod müssen in HA vorhanden sein. Es sind keine Helfer,
Automationen oder separaten Druck-/Durchfluss-Sensoren für diese Karte nötig.

1. MQTT-Plugin in Decaid auf 0.3.0 aktualisieren. Der letzte gespeicherte
   Espresso-Bezug wird beim Start eingelesen, sofern er verwertbare Messpunkte hat.
2. In HA unter **Einstellungen → Geräte & Dienste → MQTT → Decent-Gerät** den
   neuen Sensor suchen und dessen Entitäts-ID in `sensor.decaid_last_shot_curve`
   ändern. Alternativ seine tatsächliche ID überall im Karten-YAML einsetzen.
3. [decent-shot-curve.yaml](decent-shot-curve.yaml) als manuelle Dashboard-Karte
   einfügen. Im vorhandenen Decent-Pop-up kann sie als weiterer Eintrag unter
   `cards:` eingefügt werden; der umgebende Pop-up bleibt bestehen.
4. Den Sensor von Recorder ausschließen. Folgenden Eintrag in einen bestehenden
   `recorder:`-Abschnitt **integrieren**, keinen zweiten Abschnitt anlegen:

   ```yaml
   recorder:
     exclude:
       entities:
         - sensor.decaid_last_shot_curve
   ```

   Konfiguration prüfen und HA nach dieser Recorder-Änderung neu starten.
   Die Grafik braucht keine HA-Verlaufseinträge: Sie liest die Messpunkte direkt
   aus den aktuellen Sensorattributen, die MQTT gespeichert vorhält.

## Darstellung

Druck (Grün, bar) und maschinenseitiger Durchfluss (Sandgelb, mL/s) haben getrennte
Y-Achsen. Die dünnen gestrichelten Linien sind die tatsächlich aufgezeichneten
Sollwerte. Decaid kann für eine gerade nicht geregelte Größe einen Sollwert von
0 liefern; dieser wird unverändert dargestellt. Die Legende erlaubt das
Ausblenden einzelner Kurven. Temperatur und Gewicht stehen ebenfalls als Daten
bereit; die Standardkarte zeigt bewusst nur Druck, Durchfluss und Sollwerte.

Die X-Achse zeigt Sekunden ab dem ersten gespeicherten Espresso-Messpunkt, nicht
die Uhrzeit. Die Originalzeit und das Profil stehen in der Kopfzeile. Intern
werden die Punkte auf den Anfang der aktuellen Stunde gelegt, damit auch ein
Tage alter Bezug sichtbar bleibt. **Das ist nur eine Verschiebung der Anzeige;
Zeitabstände und Messwerte bleiben erhalten.** Die Standardansicht umfasst
0–60 Sekunden. Für längere Rezepte `graph_span: 2min` (0–120 Sekunden) oder
entsprechend länger einstellen. Fehlende Messwerte bleiben Lücken, keine Nullen.

Neue Espresso-Bezüge ersetzen die Grafik erst, wenn Decaid sie gespeichert hat.
Dampf, Heißwasser, Spülen und Reinigung ersetzen sie nicht. Ein leerer oder
fehlerhafter Datensatz lässt die letzte brauchbare Grafik bestehen. Die Kurve
bleibt als historischer Datensatz auch bei ausgeschalteter Maschine sichtbar.

## Verfügbare Attribute

Alle Messreihen sind gleich lange Arrays; `time_s[i]` gehört jeweils zum Wert
mit demselben Index. Fehlende/ungültige Werte sind `null`.

| Attribut | Bedeutung |
| --- | --- |
| `shot_id`, `started_at`, `profile` | Bezug, Zeitpunkt mit Zeitzone, gespeichertes Profil |
| `duration_s`, `yield_g`, `stop_reason` | Aufgezeichnete Kurvendauer, Endgewicht, Stoppgrund |
| `time_s` | Sekunden ab erstem Espresso-Messpunkt |
| `pressure`, `target_pressure` | Ist-/Solldruck, bar |
| `flow`, `target_flow` | Ist-/Solldurchfluss der Maschine, mL/s |
| `temperature`, `target_temperature` | Ist-/Soll-Mischtemperatur, °C |
| `group_temperature` | Brühgruppentemperatur, °C |
| `weight`, `weight_flow` | Waagengewicht, g; Waagendurchfluss, g/s |
| `source_samples` | Anzahl gültiger Espresso-Messpunkte vor Größenbegrenzung |

Maximal 512 gleichmäßig ausgewählte Messpunkte inklusive Anfang und Ende werden
übertragen. Normale Bezüge behalten damit alle Messpunkte. Werte werden auf zwei
Nachkommastellen gerundet, Zeitabstände auf Millisekunden genau erhalten. Das
Endgewicht kann durch Nachtropfen höher sein als der letzte Kurvenwert.
