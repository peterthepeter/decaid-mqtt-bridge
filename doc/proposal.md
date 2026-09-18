# MQTT Integration — Proposal

**Resolves** the scope of [#681](https://github.com/decentespresso/decaid/issues/681). Full specifications: `doc/plans/mqtt/protocol.md` (wire contract) and `doc/plans/mqtt/architecture.md` (implementation).

## Problem

de1app's MQTT plugin (`simpkins/de1plus-mqtt`) powers real home/cafe
automations (Home Assistant, Node-RED, cloud IoT). Decaid has no equivalent,
which blocks de1app deprecation for those users.

## Solution: a JS plugin, not a core service

With #146 merged, plugins have permission-gated outbound TCP/TLS transports.
MQTT can therefore live entirely in a plugin — protocol logic out of the
trusted core, matching the platform boundary ("core owns native capabilities;
plugins own protocols"). It uses **MQTT over raw TCP**, exactly like de1app,
so existing brokers work unchanged.

| #681 scope | How | Status |
|------------|-----|--------|
| Publish machine state (P0) | `events.machine` → state JSON → MQTT.js over `host.transport` TCP/TLS | Achievable with merged capabilities |
| Receive control commands (P1) | Command topic → plugin `fetch` → Decaid's own REST (`PUT /api/v1/machine/state/<s>`, `POST /api/v1/machine/profile`) | Achievable; same loopback pattern the Visualizer plugin already uses |
| Settings page | Manifest-declared settings + `secure: true` password storage | Achievable |

**New capability beyond de1app parity:** live shot weight. When a scale is
attached, the plugin reads Decaid's live scale stream
(`ws://localhost:8080/ws/v1/scale/snapshot` over `host.transport` — the
loopback pattern proven by #146's acceptance tests) and reports `shot_weight_g`
in real time during the shot, plus final yield/id/duration afterward. The
state document's 17 de1app fields stay byte-frozen; shot fields are additive.

Note: `doc/Plugins.md`'s Machine Data Structure section documents a
`scale: {weight, weightFlow}` field in `stateUpdate` events, but the host
never includes it. Honoring that documented contract would be a small host
improvement that makes live weight available to all plugins natively; the
plugin works without it.

## Wire parity highlights

- `T/state` (QoS 1, retained): identical 17-field JSON, identical
  state/substate strings ("Sleep", "Idle", "Espresso" / "ready", "heating",
  "pouring"), identical presence rules, identical derived fields
  (`wake_state`, `steam_mode`).
- `T/command`: identical grammar — `wake`, `sleep`, `steam_on`, `steam_off`,
  `profile <name>`, `profile_filename <file>` — with de1app semantics
  (sleep ignored while in use, steam_on wakes + resets Eco timer).
- Home Assistant auto-discovery: identical entities (sensors, wake/steam
  switches, profile select), unique IDs, and templates.
- Config defaults identical: auto-generated unique client ID and
  `de1plus/<unique_id>` topic prefix, 60s publish interval, TLS on /
  port 8883.

## Known gaps (explicit)

- **mTLS / custom CA**: de1app supports client certs and custom CAs; the
  plugin transport does not yet. Tracked in #758 — config fields are reserved
  so adoption needs no schema change.
- **Water level ml conversion**: decaid exposes tank level in mm
  (`De1Interface.waterLevels`); porting de1app's mm→ml conversion is a small
  implementation task, not a blocker.
- **Command path caveat**: commands ride the broad `api` permission via
  loopback REST. Works today, precedent exists (Visualizer); a narrower
  `machine.control` plugin permission would be the cleaner long-term shape.

## Verification

Unit tests (state mapping, command parsing), fake-broker integration tests
(QoS/retain/will/reconnect), E2E with simulated machine + scale covering both
directions (state observed, sleep/wake commands acted on).
