# Decaid MQTT Bridge

An independent community project for Decaid and Home Assistant. Not affiliated
with Decent Espresso or Home Assistant.

Version 0.2.2 is a field-test release. Basic MQTT and discovery operation have
been observed on a real tablet and Home Assistant installation; automated tests
cover the latest fixes. Extended hardware and platform TLS validation remain
pending. See [CHANGELOG.md](CHANGELOG.md).

MQTT integration for [Decaid](https://github.com/decentespresso/decaid) —
publishes machine state to an MQTT broker and accepts control commands.
Wire-compatible with the de1app MQTT plugin
([simpkins/de1plus-mqtt](https://github.com/simpkins/de1plus-mqtt)), so
existing MQTT consumers (Home Assistant, Node-RED, custom scripts) keep
working unchanged.

Specs: [doc/protocol.md](doc/protocol.md) (wire contract),
[doc/architecture.md](doc/architecture.md) (implementation design).
Tracking: [decentespresso/decaid#681](https://github.com/decentespresso/decaid/issues/681).

## Features

- Publishes machine state to `{topic_prefix}/state` (QoS 1, retained):
  the de1app-compatible base fields plus Decaid temperatures, pressure/flow,
  targets, scale, workflow, tablet, water, and shot telemetry.
- Live shot weight: with a scale attached, `shot_weight_g` updates in real
  time during a shot; the final yield, shot id, start time and duration are
  reported after completion. (Additive fields beyond de1app parity.)
- Subscribes to `{topic_prefix}/command` for `wake`, `sleep`, `steam_on`,
  `steam_off`, `profile <name>`, `profile_filename <file>`.
- MQTT over raw TCP or TLS (matching de1app, not MQTT-over-WebSocket).
- Auto-generated unique client ID and topic prefix so multiple machines never
  collide on one broker.
- Reconnect loop with exponential backoff (2 s doubling, capped at 64 s, 15
  attempts); MQTT last will publishes an explicit offline state document.
- Optional Home Assistant MQTT discovery for a single grouped Decent device,
  including live pressure/flow, targets, scale, shot, connectivity and tablet
  entities. No Home Assistant YAML or custom integration is required.

## Payloads

All state is published to `{topic_prefix}/state` as a single JSON document
(QoS 1, retained). Below, the auto-generated topic prefix
`de1plus/<unique_id>` is written as `de1plus/abcd1234`.

Machine awake and idle, no scale connected:

```json
{
  "online": true,
  "de1_connected": true,
  "scale_connected": false,
  "state": "Idle",
  "substate": "ready",
  "profile": "Medium",
  "profile_filename": "medium.tcl",
  "espresso_count": 1234,
  "steaming_count": 56,
  "head_temperature": 93.5,
  "mix_temperature": 92.1,
  "steam_heater_temperature": 24.0,
  "wake_state": true,
  "steam_mode": "Off",
  "steam_state": false,
  "water_level_mm": 58.0,
  "water_level_ml": 1808,
  "shot_active": false
}
```

During a shot with a scale connected (published ~1 s apart while pouring):

```json
{
  "online": true,
  "de1_connected": true,
  "scale_connected": true,
  "state": "Espresso",
  "substate": "pouring",
  "profile": "Medium",
  "profile_filename": "medium.tcl",
  "espresso_count": 1234,
  "steaming_count": 56,
  "head_temperature": 93.5,
  "mix_temperature": 92.1,
  "steam_heater_temperature": 24.0,
  "wake_state": true,
  "steam_mode": "Off",
  "steam_state": false,
  "water_level_mm": 57.0,
  "water_level_ml": 1808,
  "shot_active": true,
  "shot_weight_g": 18.4
}
```

After the shot completes, `shot_active` becomes `false` and the shot record
fills in (`shot_id`, `shot_started_at`, `shot_duration_s`, and
`shot_weight_g` as the final yield):

```json
{
  "online": true,
  "de1_connected": true,
  "scale_connected": true,
  "state": "Idle",
  "substate": "ready",
  "profile": "Medium",
  "profile_filename": "medium.tcl",
  "espresso_count": 1235,
  "steaming_count": 56,
  "head_temperature": 93.5,
  "mix_temperature": 92.1,
  "steam_heater_temperature": 24.0,
  "wake_state": true,
  "steam_mode": "Off",
  "steam_state": false,
  "water_level_mm": 57.0,
  "water_level_ml": 1808,
  "shot_active": false,
  "shot_id": "a1b2c3d4",
  "shot_started_at": "2026-09-12T13:14:15.000Z",
  "shot_duration_s": 27.5,
  "shot_weight_g": 36.2
}
```

Machine asleep, no scale, no shot history: the 17 de1app-compatible fields
plus `shot_active: false` (shot fields without values are omitted).

Machine link down or app dead (also the last-will payload, retained):

```json
{"online": false, "de1_connected": false}
```

When the machine is connected, all fields above are always present except the
shot record fields (`shot_id`, `shot_started_at`, `shot_duration_s`,
`shot_weight_g`), which appear after the first completed shot;
`shot_weight_g` additionally requires a scale. Full field reference:
[doc/protocol.md](doc/protocol.md#state-document-tstate).

### Commands

Send plain-text UTF-8 payloads to `{topic_prefix}/command`
(e.g. `de1plus/abcd1234/command`):

| Payload | Action |
|---------|--------|
| `wake` | Wake the machine |
| `sleep` | Put the machine to sleep |
| `steam_on` / `steam_off` | Toggle the steam heater |
| `profile <name>` | Select a profile by title, e.g. `profile Medium` |
| `profile_filename <file>` | Select a profile by filename, e.g. `profile_filename medium.tcl` |

Unknown payloads are logged and ignored.

## Install

### From a GitHub release (tracked, auto-updates)

Open **Settings → Plugins → Add repository** in Decaid and enter this
repository as `peterthepeter/decaid-mqtt-bridge`. Choose the GitHub release source. Decaid
stores the repository source and offers newer semantic-versioned releases as
automatic plugin updates.

```
POST http://<tablet>:8080/api/v1/plugins/install/github-release
{"repo": "peterthepeter/decaid-mqtt-bridge"}
```

or use the Plugins settings screen in Decaid.

### From a branch (tracked, updates on commit)

```
POST http://<tablet>:8080/api/v1/plugins/install/github-branch
{"repo": "peterthepeter/decaid-mqtt-bridge"}
```

### From a local build

Zip the `mqtt.reaplugin/` directory and install it from the Plugins settings
screen (local ZIP), or copy it into the app's plugin folder.

## Compatibility

- Requires Decaid **0.8.5 or later** (that is the first stable release with
  the plugin `host.transport` network permissions this plugin needs).
- The manifest deliberately does not request `events.workflow` (0.8.6+ only);
  instead the current profile title is polled from `GET /api/v1/workflow` on
  the heartbeat cadence, so `profile`/`profile_filename` stay correct on both
  0.8.5 and newer builds. After a `profile`/`profile_filename` command the
  state is re-polled immediately.
- The manifest carries explicit empty `api` and `drivers` arrays because
  Decaid's manifest parser requires a (possibly empty) list for `api`.
- On 0.8.5 the broker password is stored in regular settings storage; secure
  credential storage arrives with later Decaid versions (`secure: true` is
  already declared).

## Settings

Configured in Decaid's plugin settings screen:

| Setting | Default | Meaning |
|---------|---------|---------|
| MQTT broker address | *(empty)* | Hostname/IP without scheme or port; empty disables the bridge |
| Broker port | 8883 | 8883 for TLS, 1883 for plain TCP |
| Encrypted connection (TLS) | on | Platform certificate validation; choose a matching port |
| Username / Password | *(empty)* | Optional broker credentials; password stays secure |
| Enable Home Assistant auto-discovery | off | Publish/remove retained HA entities |
| Home Assistant device name (optional) | auto | Derived from the connected machine model |
| Status heartbeat (seconds) | 60 | Regular combined status while sleeping/disconnected; wake/connection changes immediate; measurements up to every 1 s brewing, 2 s heating, 5 s awake idle |
| Advanced: MQTT topic prefix | auto | Normally leave unchanged; `de1plus/<unique id>` when empty |
| Advanced: Home Assistant discovery prefix | `homeassistant` | Normally unchanged; must match HA's MQTT setting |
| Advanced: Home Assistant entity name prefix | `DE1+ ` | Optional prefix for entity display names |
| Advanced: MQTT client ID | auto | Compatibility/custom broker requirements; `de1plus_<unique id>` when empty |

Decaid renders one flat settings list, not collapsible groups. Advanced fields
are therefore labeled and placed last. There is only one heartbeat field, in
seconds, visibly defaulting to `60`. The old millisecond field is removed;
installations without a saved seconds value use 60 seconds after updating.
Existing client IDs remain supported. Automatic telemetry cadence needs no
extra settings. A lower heartbeat can also cause more frequent combined state
messages; use the recommended 60 seconds for quiet standby operation.

After saving the broker settings, enable Home Assistant auto-discovery once.
Home Assistant 2025.2 or newer then creates one device containing the sensors,
binary sensors, power/steam switches, profile selector and shot event entity.
Disable discovery and save before moving to another broker or uninstalling so
the plugin can retract its retained discovery topics.

Saving settings reloads the plugin and therefore tests the real broker
connection. The plugin reports success only after MQTT CONNECT, the command
subscription, and the first retained QoS 1 state publish have been acknowledged.
Look for `MQTT connection verified` in the Decaid plugin log; connection,
authentication, subscription, publish, and timeout failures identify the
failed stage without logging the broker password.

Telemetry is activity-aware: active operations publish at most once per
second, heating every two seconds, awake idle readings every five seconds,
and sleeping/disconnected machines only on transitions plus the configured
heartbeat. Power and connection transitions are always published immediately.

Custom CA / mutual TLS is not supported yet — it depends on the plugin
transport gaining custom trust material
([decaid#758](https://github.com/decentespresso/decaid/issues/758)).

## Development

```
npm install
npm run build       # bundles src/ + mqtt.js into mqtt.reaplugin/plugin.js
npm test            # unit tests (no broker or sockets required)
npm run test:integ  # end-to-end integration tests (~2 min, real sockets)
```

### Integration tests

`npm run test:integ` is a separate build target from `npm test`. It runs the
**built** `mqtt.reaplugin/plugin.js` bundle inside a sandboxed VM that mirrors
the Decaid plugin runtime (`host.transport` over real TCP sockets, host-owned
`fetch`, async `storageRead` events, permission gating, transport limits)
against a purpose-built in-process MQTT broker (MQTT 3.1.1 and 5, retained
messages, last will, QoS 1, auth) and a simulated Decaid REST/WebSocket API on
a real loopback HTTP server. No external broker, machine or app instance is
required; everything runs on ephemeral localhost ports, so it works in any
developer environment and in CI.

The suite covers: broker handshake (client id, keepalive, will, MQTT 5 with
3.1.1 fallback), state document wire format and publish triggers, heartbeat
cadence, live shot weight over the scale stream, shot completion records,
water levels, profile selection, all six commands, unknown/invalid commands,
broker outage and restart reconnects, last-will offline documents on abnormal
client death, unload teardown, and broker authentication.

CI runs both the unit and integration suites against the committed bundle.

The built `plugin.js` is committed so branch installs work; CI verifies it is
up to date and repackages it for releases. Tag a release `vX.Y.Z` matching
`manifest.json`'s `version`.

### Status and known limitations

- The `host.transport` → MQTT.js adapter (`src/host-transport-stream.js`,
  `src/bridge.js`) is exercised end-to-end by `npm run test:integ` against a
  real in-process broker over real TCP sockets. On-device TLS (platform trust
  store) is not covered by the harness; everything else runs the shipping
  bundle.
- Home Assistant auto-discovery targets Home Assistant 2025.2 and later and is
  disabled by default for compatibility with existing MQTT installations.
- Commands execute through Decaid's own REST API over loopback HTTP (same
  pattern as the bundled Visualizer plugin).

## License

MIT

## Migration and troubleshooting

The plugin ID remains `mqtt.reaplugin` for compatibility. This bridge and the
original MQTT plugin cannot run side by side under that ID. Back up your
settings before replacing an existing installation, and verify the tracked
repository source afterwards so updates come from this repository.

- No broker connection: check host, port, credentials, TLS mode, and the
  Decaid plugin log. TLS uses platform certificate validation.
- Connection succeeds but verification fails: the broker account must allow
  subscription to `<topic_prefix>/command` and publishing to
  `<topic_prefix>/state`. Discovery additionally requires publishing to the
  configured Home Assistant discovery prefix.
- No Home Assistant entities: both services must use the same broker;
  enable discovery in this plugin and ensure the discovery prefixes match.
- Entities unavailable: check machine/scale connectivity. Broker connectivity
  alone does not mean that a machine snapshot is available.

Report reproducible problems through this repository's GitHub Issues. Include
versions and redacted logs, never broker passwords or access tokens. See
[SECURITY.md](SECURITY.md) for security reporting and deployment notes.

## Acknowledgements and provenance

This independent project was originally based on
[meldavy/decaid-mqtt-plugin](https://github.com/meldavy/decaid-mqtt-plugin)
(MIT), at commit `a00b4b46d333360872501d67e8a6945db0504652`.
The inherited MQTT transport and protocol foundation has been extended with
Home Assistant discovery, additional telemetry, guarded controls,
activity-aware publishing, connection verification, and automated tests.
Installation and updates are served by this repository, not the original.

[teich/ha-decaid](https://github.com/teich/ha-decaid) served as a reference for
Decaid entity coverage and API behavior; no source code was copied from it.
[simpkins/de1plus-mqtt](https://github.com/simpkins/de1plus-mqtt) is the
reference for the compatible base MQTT vocabulary.
