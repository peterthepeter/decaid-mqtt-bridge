# Changelog

## 0.2.2 — 2026-09-18

- Remove the duplicate legacy millisecond heartbeat field from tablet settings.
- Visibly default the single seconds heartbeat field to 60 and explain immediate
  transitions plus automatic 1 s brewing, 2 s heating, and 5 s awake-idle updates.
- On update, old millisecond-only settings reset to the recommended 60 seconds;
  explicitly saved seconds values are unchanged.

## 0.2.1 — 2026-09-18

- Fix water-level updates bypassing activity-aware telemetry cadence.
- Suppress repeated shot settings and unchanged shot-state notifications;
  prevent telemetry timers while the machine is disconnected.
- Set Home Assistant display precision: flow sensors 2 decimals, water height
  1 decimal, water volume whole millilitres. Raw measurements remain unchanged.
- Replace technical shot event categories with lifecycle milestones:
  `Bezug gestartet`, `Bezug beendet`, `Bezug abgebrochen`. Retain stop reason
  and decision details, suppress intermediate phases and duplicate milestones.
  **Migration:** update automations using the old `state`, `decision`, or
  `terminal` event types.
- Reorder tablet settings and label advanced options. Add heartbeat in seconds;
  preserve legacy millisecond intervals and client IDs. An explicitly set
  seconds value takes precedence; otherwise the legacy value or 60 s applies.
- Add lifecycle, configuration compatibility, and sleeping/disconnected MQTT
  silence regression tests. Platform TLS and extended hardware validation
  remain pending.

## 0.2.0 — 2026-09-18

Initial independent field-test release of Decaid MQTT Bridge.

- Optional retained Home Assistant discovery, stable device/entity identifiers,
  and removal of obsolete discovery topics.
- Expanded machine, scale, workflow, tablet, and shot telemetry.
- Safe wake/sleep, profile selection, and steam-heater control.
- Activity-aware telemetry cadence: 1 s active, 2 s heating, 5 s idle,
  heartbeat-only while sleeping or disconnected; immediate state transitions.
- Suppression of unchanged intermediate state documents.
- Automatic MQTT connection verification after load/settings save, including
  command SUBACK and the first QoS 1 state PUBACK.
- Non-retained shot events with initial WebSocket replay suppression.
- Production bundle tested with 30 unit and 38 integration tests.
- GitHub release ZIP and branch installation support for Decaid source tracking.

Based on meldavy/decaid-mqtt-plugin 0.1.4. Real tablet, platform TLS,
and Home Assistant UI validation remain pending.
