# Troubleshooting

## MQTT connection

Saving the plugin settings reloads the plugin and tests the real MQTT
connection. A successful check produces a log message beginning with:

```text
MQTT connection verified
```

If the broker cannot be reached, check:

- The broker hostname or IP address contains no URL scheme or port
- The configured port matches the TLS setting (`8883` for TLS or `1883` for
  plain TCP in a typical setup)
- The username and password are correct
- The broker is reachable from the Decaid tablet's network
- The broker certificate is accepted by the tablet's platform trust store

Custom CA certificates and mutual TLS are not supported until Decaid exposes
custom trust material to plugins. Track
[decaid#758](https://github.com/decentespresso/decaid/issues/758) for that
platform capability.

## Connection verification fails

The plugin considers the connection verified only after the broker has
acknowledged all of the following:

1. MQTT CONNECT
2. The subscription to `<topic_prefix>/command`
3. The first retained QoS 1 publish to `<topic_prefix>/state`

The broker account must have permission for both topics. Home Assistant
discovery additionally requires publish access to the configured discovery
prefix, which is `homeassistant` by default.

## Home Assistant entities do not appear

- Confirm that Decaid and Home Assistant connect to the same broker
- Enable Home Assistant auto-discovery in the plugin settings and save
- Make sure the configured discovery prefix matches Home Assistant's MQTT
  discovery prefix
- Check the Decaid plugin log for rejected discovery publishes

Discovery is disabled by default to avoid changing existing MQTT installations.

## Entities are unavailable

An MQTT connection only confirms that the plugin can reach the broker. Machine
and scale entities can remain unavailable when the corresponding hardware is
not connected to Decaid.

Sleeping and disconnected machines publish only on state transitions and at
the configured heartbeat interval. This reduced cadence is expected.

## Replacing the original plugin

Decaid MQTT Bridge retains the plugin ID `mqtt.reaplugin`. It cannot run beside
the original MQTT plugin under the same ID.

Back up the existing settings before replacing the plugin. After installation,
verify that Decaid tracks `peterthepeter/decaid-mqtt-bridge`; otherwise future
updates may still be requested from the previous repository.

## Updating an older bridge version

The previous millisecond heartbeat setting is no longer shown. An existing
legacy value is still accepted when no seconds value has been saved; otherwise
the visible `HeartbeatSeconds` setting takes precedence and defaults to 60.
Existing custom MQTT client IDs remain supported.

The password field declares secure storage. Decaid 0.8.5 stores it in regular
plugin settings because secure credential storage was added by later Decaid
versions.

## Reporting a problem

Open a [GitHub issue](https://github.com/peterthepeter/decaid-mqtt-bridge/issues)
and include:

- Decaid version
- Plugin version
- MQTT broker name and version
- Whether TLS and Home Assistant discovery are enabled
- Reproduction steps
- Relevant redacted plugin logs

Never include broker passwords, access tokens, or other credentials. Security
issues should follow [SECURITY.md](../SECURITY.md).
