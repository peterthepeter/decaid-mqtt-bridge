# Changelog

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
