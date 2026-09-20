# Architecture

`mqtt.reaplugin` is a self-contained Decaid JavaScript plugin. MQTT.js and the
source under `src/` are bundled into `mqtt.reaplugin/plugin.js`; Decaid loads
that bundle using the sibling `manifest.json`.

## Runtime components

| Source | Responsibility |
|---|---|
| `main.js` | Lifecycle, cached runtime state, publish scheduling, streams |
| `bridge.js` | MQTT session, retained state, will, commands, reconnect/fallback |
| `host-transport-stream.js` | MQTT.js duplex adapter for Decaid TCP/TLS transports |
| `loopback.js` | Reconnecting JSON WebSocket client for Decaid streams |
| `decaid-api.js` | Loopback REST reads and history counts |
| `state-doc.js`, `mapping.js` | Stable MQTT state schema and enum mapping |
| `dispatcher.js`, `command-handler.js` | Strict parsing and guarded Decaid REST commands |
| `discovery.js` | Home Assistant discovery configs and stable topic identities |
| `storage.js` | Persistent unique ID and discovery-topic list |

## Decaid capabilities

The manifest requests `log`, `api`, `pluginStorage`, `events.machine`,
`events.shots`, `network.tcp`, `network.tls`, and `network.websocket`.
`events.workflow` is intentionally not requested because it is newer than the
minimum supported Decaid release; workflow is read through loopback REST.

At runtime the plugin uses six transports, within Decaid's limit of eight:

1. one MQTT TCP or TLS connection;
2. `ws/v1/scale/snapshot`;
3. `ws/v1/machine/waterLevels`;
4. `ws/v1/machine/shotSettings`;
5. `ws/v1/machine/shotState`;
6. `ws/v1/devices`.

Machine measurements themselves arrive through the `stateUpdate` plugin
event. `shotStored` triggers a read of the completed record. REST supplies
workflow, profiles, settings, device snapshots, and shot/steam counts.

## Data and scheduling

One in-memory runtime object holds the latest value from each independent
source. A serialized promise chain prevents concurrent refresh/publish cycles
from reordering retained state.

- state or connectivity transitions enqueue an immediate publish;
- telemetry is coalesced by state: 1 second active, 2 seconds heating,
  5 seconds idle, and heartbeat-only while sleeping/disconnected;
- byte-identical telemetry documents are skipped, while heartbeat messages
  remain explicit availability refreshes;
- the normal heartbeat refreshes workflow and usage counts;
- initial broker connection additionally loads profiles, tablet settings, and
  devices before publishing discovery;
- if a newly selected profile title is absent from the cache, profiles are
  refreshed once so its filename and select options can be resolved.

Each WebSocket has independent exponential reconnect state. A failed optional
stream removes only the availability or fields owned by that source; it does
not take MQTT or other telemetry offline.

## Commands

Commands cross the plugin boundary through Decaid's loopback REST API. The
dispatcher receives the latest raw machine state, workflow snapshot, and
machine capabilities as providers, then evaluates preconditions immediately
before each request.

Wake/sleep and profile selection never interrupt active operations. The steam
switch changes the configured steam target rather than requesting the
`steam` machine state, so turning the switch on cannot unexpectedly start the
wand. It uses the authoritative workflow endpoint and Streamline's shared
remembered steam-temperature key. Operation start/stop commands fail closed and
their discovery entities are omitted unless machine info explicitly reports
that no physical Group Head Controller is present.

## Discovery lifecycle

`discovery.js` generates single-component Home Assistant discovery messages.
All components share one stable device identifier and the same retained state
topic. Configuration is retained at QoS 1. The exact list of topics is stored
after every synchronization; topics no longer present are cleared with an
empty retained publish.

Shot events are intentionally separate, non-retained messages. The Decaid
shot-state stream replays its current value on connection, so `main.js`
suppresses the first frame of every connection and forwards only live frames.

## Lifecycle and failure behavior

On load, plugin storage is read before configuration is normalized. An empty
broker host leaves the plugin disabled without opening transports. On MQTT
connect, the plugin subscribes to commands and publishes static data,
discovery, and current state. MQTT 5 protocol rejection retries immediately
with MQTT 3.1.1; other failures use capped exponential reconnect.

On unload, timers are cancelled, new publish work is rejected, WebSockets are
closed, and the MQTT bridge publishes its retained offline document before a
clean disconnect. The broker will covers abnormal process or transport loss.

## Packaging and updates

Decaid's GitHub repository source expects the installable plugin in a release
ZIP. The release workflow:

1. installs dependencies and rebuilds the committed bundle;
2. fails if the committed bundle differs;
3. runs unit and real-socket integration tests;
4. requires the Git tag, package version, and manifest version to agree;
5. creates a ZIP whose root contains the `mqtt.reaplugin/` directory;
6. attaches that ZIP to the GitHub release.

Because the plugin ID remains `mqtt.reaplugin`, installing this repository is
a drop-in update of the original plugin. Decaid records its GitHub source in
`.rea_source.json`, allowing later semantic-versioned releases to be offered
through the normal plugin update flow.

## Tests

`npm test` covers configuration, mapping, state documents, command guards,
API handling, storage identity, and discovery generation. `npm run test:integ`
runs the committed production bundle in a VM matching the Decaid host API,
using real local TCP and WebSocket connections to a purpose-built MQTT broker
and Decaid simulator. It covers broker fallback/auth/reconnect/will, shutdown,
REST commands, all streams, shot lifecycle, publish cadence, retained
discovery creation/removal, and shot replay suppression.
