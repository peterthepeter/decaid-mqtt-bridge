# Decaid MQTT Bridge

MQTT bridge for [Decaid](https://github.com/decentespresso/decaid) with Home
Assistant auto-discovery, extended telemetry, and safe machine controls.

The bridge publishes machine, scale, water, profile, and shot data to an MQTT
broker. It is wire-compatible with the de1app MQTT plugin
([simpkins/de1plus-mqtt](https://github.com/simpkins/de1plus-mqtt)), so existing
Home Assistant, Node-RED, and custom MQTT consumers can keep using the same
base message format.

Version 0.2.6 has been tested on a real Decaid tablet and Home Assistant
installation. Automated unit and integration tests cover the MQTT connection,
state publishing, discovery, commands, reconnect behavior, and shot events.

## Features

- Retained MQTT state with machine, scale, temperature, water, profile, usage,
  and shot telemetry
- Live shot weight plus final yield, shot ID, start time, and duration
- Optional Home Assistant MQTT discovery with one grouped Decent device
- Wake, sleep, steam-heater, profile-selection, and safe stop controls
- Automatic MQTT 5 to MQTT 3.1.1 fallback, connection verification, and
  reconnect with exponential backoff
- Activity-aware publishing: up to every 1 s during a shot, 2 s while heating,
  5 s while awake and idle, and the configured heartbeat while inactive

## Requirements

- Decaid 0.8.5 or newer
- An MQTT broker reachable from the Decaid tablet
- Home Assistant 2025.2 or newer when using MQTT discovery

Custom CA certificates and mutual TLS are not currently supported because the
Decaid plugin transport does not yet expose custom trust material
([decaid#758](https://github.com/decentespresso/decaid/issues/758)).

## Installation

In Decaid, open **Settings → Plugins → Add repository**, enter:

```text
peterthepeter/decaid-mqtt-bridge
```

Choose the **GitHub release** source. Decaid then tracks the repository and
offers new semantic-versioned releases as plugin updates.

The equivalent API request is:

```http
POST http://<tablet>:8080/api/v1/plugins/install/github-release
```

```json
{"repo": "peterthepeter/decaid-mqtt-bridge"}
```

### Replacing the original MQTT plugin

This bridge keeps the original plugin ID, `mqtt.reaplugin`, for compatibility.
The two plugins therefore cannot run side by side. Back up the existing
settings before replacing the original plugin, then verify that Decaid tracks
`peterthepeter/decaid-mqtt-bridge` for future updates.

Branch and local-build installation instructions are in
[Development](doc/development.md#alternative-installation-methods).

## Configuration

Configure the plugin from Decaid's plugin settings screen:

| Setting | Default | Meaning |
|---------|---------|---------|
| MQTT broker address | *(empty)* | Hostname or IP without scheme or port; empty disables the bridge |
| Broker port | `8883` | Use 8883 for TLS or 1883 for plain TCP |
| Encrypted connection (TLS) | On | Uses platform certificate validation |
| Username / Password | *(empty)* | Optional broker credentials |
| Enable Home Assistant auto-discovery | Off | Publishes retained Home Assistant entities |
| Home Assistant device name | Automatic | Defaults to the connected machine model |
| Status heartbeat | `60` seconds | Regular state refresh while sleeping or disconnected |
| Advanced: MQTT topic prefix | Automatic | Defaults to `de1plus/<unique-id>` |
| Advanced: Home Assistant discovery prefix | `homeassistant` | Must match Home Assistant's MQTT configuration |
| Advanced: Home Assistant entity name prefix | `DE1+ ` | Optional entity display-name prefix |
| Advanced: MQTT client ID | Automatic | Defaults to `de1plus_<unique-id>` |

After entering the broker settings, save once to reload the plugin and test the
real connection. The log reports success only after MQTT CONNECT, the command
subscription, and the first retained QoS 1 state publish are acknowledged.
Look for `MQTT connection verified`.

Enable Home Assistant auto-discovery and save again if you want Home Assistant
to create the device and its entities automatically. Disable discovery and
save before changing brokers or uninstalling so the plugin can remove its
retained discovery topics.

## MQTT interface

State is published as retained JSON with QoS 1 to:

```text
{topic_prefix}/state
```

The current profile is polled from Decaid's workflow API on the heartbeat
cadence, so profile changes are published without starting a shot. Profile
changes sent through this bridge are re-polled immediately.

Send plain-text UTF-8 commands to:

```text
{topic_prefix}/command
```

| Payload | Action |
|---------|--------|
| `wake` | Wake the machine |
| `sleep` | Put the machine to sleep |
| `steam_on` / `steam_off` | Toggle the steam heater |
| `stop` | Stop espresso, steam, hot water, or rinse |
| `profile <name>` | Select a profile by title |
| `profile_filename <file>` | Select a profile by filename |

Unknown commands are logged and ignored. See the [protocol
reference](doc/protocol.md) for the complete state document, payload examples,
topics, delivery guarantees, and shot events.

## Home Assistant controls

Discovery creates one device containing sensors, binary sensors, power and
steam-heater switches, a profile selector, a Stop control, and shot events. No
Home Assistant YAML or custom integration is required.

Remote start buttons are intentionally not exposed. On machines with an active
Group Head Controller, Decaid can acknowledge a start request even though the
firmware still requires physical confirmation. The Stop control remains
available for an active beverage or rinse operation.

## Troubleshooting

- **No broker connection:** Check the host, port, credentials, TLS mode, and
  Decaid plugin log.
- **Verification fails:** The broker account must be allowed to subscribe to
  `<topic_prefix>/command` and publish to `<topic_prefix>/state`.
- **No Home Assistant entities:** Enable discovery and make sure Decaid and
  Home Assistant use the same broker and discovery prefix.
- **Entities are unavailable:** Broker connectivity alone does not mean the
  machine or scale is connected.

More diagnostic guidance is available in
[Troubleshooting](doc/troubleshooting.md). Report reproducible problems through
[GitHub Issues](https://github.com/peterthepeter/decaid-mqtt-bridge/issues) with
versions and redacted logs. Never include broker passwords or access tokens.

## Documentation

- [MQTT protocol and payload reference](doc/protocol.md)
- [Architecture](doc/architecture.md)
- [Development, testing, and alternative installation](doc/development.md)
- [Troubleshooting](doc/troubleshooting.md)
- [Changelog](CHANGELOG.md)
- [Security guidance](SECURITY.md)

## Acknowledgements and license

This independent project was originally based on
[meldavy/decaid-mqtt-plugin](https://github.com/meldavy/decaid-mqtt-plugin)
(MIT), at commit `a00b4b46d333360872501d67e8a6945db0504652`. Its MQTT
transport and protocol foundation has since been extended with Home Assistant
discovery, additional telemetry, guarded controls, activity-aware publishing,
connection verification, and automated tests. Installation and updates are
served by this repository, not the original.

[teich/ha-decaid](https://github.com/teich/ha-decaid) served as a reference for
Decaid entity coverage and API behavior; no source code was copied from it.
[simpkins/de1plus-mqtt](https://github.com/simpkins/de1plus-mqtt) is the
reference for the compatible base MQTT vocabulary.

Licensed under the [MIT License](LICENSE). This project is not affiliated with
Decent Espresso or Home Assistant.
