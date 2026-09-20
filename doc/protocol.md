# MQTT and Home Assistant protocol

This document describes the observable interface of `mqtt.reaplugin` 0.2.x.
The base topic and command grammar remain compatible with the original
de1app MQTT plugin; the additional telemetry and Home Assistant entities are
additive.

## MQTT connection

- MQTT 5 is attempted first, with automatic fallback to MQTT 3.1.1.
- Raw TCP or TLS is selected in plugin settings.
- State, discovery, and commands use QoS 1.
- The generated client ID is `de1plus_<unique_id>`.
- The default topic prefix is `de1plus/<unique_id>`.
- The unique ID is generated once and persisted in Decaid plugin storage.

The retained last will on `T/state` is:

```json
{"online":false,"de1_connected":false}
```

The plugin publishes the same document before a clean unload.

## Topics

With `T` as the configured topic prefix:

| Topic | Direction | Retained | Purpose |
|---|---|---:|---|
| `T/state` | plugin → broker | yes | Complete current state document |
| `T/command` | broker → plugin | no | Plain-text control commands |
| `T/event/shot` | plugin → broker | no | Live Decaid shot-sequencer events |
| `<ha_prefix>/<component>/<entity_id>/config` | plugin → broker | yes | Home Assistant discovery configuration |

## State document

`T/state` is one JSON object. The two availability fields are always present:

| Field | Type | Meaning |
|---|---|---|
| `online` | boolean | MQTT plugin is connected to the broker |
| `de1_connected` | boolean | A machine is connected and a machine snapshot is available |

While the tablet is online but no machine snapshot is available, the document
is `{online: true, de1_connected: false}` and may also contain
`tablet_battery_percent`. Machine-derived fields are omitted. A broker will or
clean unload uses `online: false`.

When the machine is available, these de1app-compatible fields are present:

| Field | Type | Unit / meaning |
|---|---|---|
| `scale_connected` | boolean | Scale connection state |
| `state`, `substate` | string | Mapped machine state |
| `profile`, `profile_filename` | string | Current profile |
| `espresso_count`, `steaming_count` | number | Lifetime counts |
| `head_temperature`, `mix_temperature`, `steam_heater_temperature` | number | °C |
| `water_level_mm`, `water_level_ml` | number | Water-tank level |
| `wake_state` | boolean | False only while sleeping |
| `steam_mode` | string | `On` or `Off` (`Eco` remains reserved for parity) |
| `steam_state` | boolean | Steam heater enabled |

The plugin adds the following fields when their Decaid sources have delivered
values:

- live machine values: `pressure`, `target_pressure`, `flow`, `target_flow`,
  `target_group_temperature`, `target_mix_temperature`;
- machine settings: `target_steam_temperature`, `target_steam_duration_s`,
  `target_hot_water_temperature`, `target_hot_water_volume_ml`,
  `target_hot_water_duration_s`, `target_shot_volume_ml`,
  `configured_group_temperature`;
- scale: `scale_weight_g`, `scale_weight_flow_g_s`,
  `scale_battery_percent`, `scale_timer_ms`;
- workflow/tablet: `target_dose_g`, `target_yield_g`,
  `tablet_battery_percent`, `refill_level_mm`;
- shot sequencer: `shot_phase`, `last_shot_stop_reason`,
  `scale_lost_during_shot`;
- completed-shot detail: `shot_active`, `shot_id`, `shot_started_at`,
  `shot_duration_s`, `shot_weight_g`.

Dynamic numeric samples use a state-dependent cadence: 1 second during active
operations, 2 seconds while heating, and 5 seconds while awake and idle.
Sleeping or disconnected machines rely on the configured heartbeat (default
60 seconds). Machine state/substate transitions, connectivity changes, water
changes, and shot completion publish promptly. Byte-identical non-heartbeat
documents are suppressed. The heartbeat also supplies the REST refresh cadence
(minimum configurable interval 1000 ms, default 60000 ms).

### State mapping

The main mappings retained from de1app are:

| Decaid | MQTT |
|---|---|
| `booting` | `Init` |
| `busy` | `Busy` |
| `idle`, `heating`, `preheating` | `Idle` |
| `schedIdle` | `SchedIdle` |
| `sleeping` | `Sleep` |
| `espresso` | `Espresso` |
| `hotWater` | `HotWater` |
| `flush` | `HotWaterRinse` |
| `steam` | `Steam` |
| `steamRinse` | `SteamRinse` |
| `cleaning` | `Clean` |
| `descaling` | `Descale` |
| `needsWater` | `Refill` |
| `error` | `FatalError` |

Known substates are mapped to de1app spelling (`idle` → `ready`,
`preparingForShot` → `heating`, `pouringDone` → `ending`, and the documented
error names). Unknown future enum values pass through unchanged instead of
being dropped.

## Commands and safety

`T/command` accepts trimmed UTF-8 text:

| Payload | Behavior |
|---|---|
| `wake` | If sleeping, request Decaid state `idle`; otherwise no-op |
| `sleep` | Request `sleeping` only from a safe resting state |
| `steam_on` | Restore Streamline's shared remembered steam target through `PUT /workflow` and wake if sleeping; never starts a steam operation |
| `steam_off` | Set the steam target to 0; if actively steaming, request `idle` first |
| `espresso_start` | Start the selected espresso profile from an awake resting state |
| `steam_start` | Start steaming from an awake resting state |
| `hot_water_start` | Start hot-water dispensing from an awake resting state |
| `flush_start` | Start a group-head rinse from an awake resting state |
| `stop` | Stop espresso, steam, hot water, or rinse; otherwise no-op/reject unsafe states |
| `profile <title>` | Select an exact profile title, only from a safe resting state |
| `profile_filename <id>` | Select an exact profile record ID/filename, only from a safe resting state |

Safe resting states are `idle`, `schedIdle`, `heating`, `preheating`, and
`sleeping`. Operations can start only from an awake resting state; sleeping
machines must be woken explicitly first. The common stop command is limited to
espresso, steam, hot water, rinse, and steam-rinse states, and will not interrupt
cleaning, calibration, firmware updates, or unknown future states. All commands
are rejected while the machine is disconnected. Profile and steam-setting
changes are rejected during brewing, hot water, cleaning, or another active
operation. Immediately before an operation start, the bridge calls
`POST /api/v1/machine/heartbeat`; only after that succeeds does it request the
new machine state. This preserves Decaid's device-write ordering and prevents
firmware presence tracking from silently ignoring remote starts. Steam changes
use Decaid's workflow API and its shared
`streamline-app/last-steam-temp` value, with plugin storage as an offline
fallback. Unknown commands and failed preconditions are logged and do nothing.

## Home Assistant discovery

Discovery is opt-in (`HaAutoDiscoveryEnable`, default `false`) and targets
Home Assistant 2025.2 or later. Configuration messages are retained and are
republished on every broker connection. Each entity has a stable unique ID
`de1plus_<unique_id>_<key>` and belongs to one device whose identifier is the
persisted plugin unique ID.

Availability is derived from `T/state`:

- tablet-level entities require `online`;
- machine entities require `online && de1_connected`;
- scale entities require `online && scale_connected`.

The discovery set contains:

- sensors for machine state, temperatures, pressure/flow, targets, water,
  usage counts, scale readings, workflow targets, tablet battery, and shot
  details;
- connectivity, shot-active, and scale-loss binary sensors;
- wake/sleep and steam-heater switches;
- buttons to start espresso, steam, hot water, and rinse, plus a guarded common stop;
- a profile select populated with available profile titles;
- a shot event entity with milestones `Bezug gestartet`, `Bezug beendet`, and
  `Bezug abgebrochen`. Internal phase changes and advance decisions are suppressed.

`T/event/shot` carries a JSON object containing `event_type`, `shot_id`,
`phase`, `source_timestamp`, `scale_lost`, `stop_reason`, and `decision`.
Start is reported on preheating (or pouring if first observed there); successful
completion on finished, and abort/terminal decisions as cancellation. The last
stop decision is carried through to completion. Each milestone is emitted once
per observed lifecycle; existing automations using the old technical event types
must be updated. The initial
shot-state frame after a WebSocket connect is a replay and is deliberately not
published as a Home Assistant event.

The plugin persists the complete list of discovery topics. When discovery is
disabled, or an entity topic changes, it publishes an empty retained payload
to every obsolete topic and then updates the stored list. This prevents ghost
entities after a later Home Assistant or broker restart. Disable discovery and
save once before uninstalling or moving the plugin to another broker.

## Settings keys

The manifest exposes `Host`, `Port`, `Username`, `Password`, `ClientId`,
`TopicPrefix`, `PublishIntervalMs`, `EnableTls`, `HaAutoDiscoveryEnable`,
`HaDiscoveryPrefix`, `HaEntityNamePrefix`, and `HaDeviceName`.

An empty `Host` disables the plugin. Port must be 1–65535 and the publish
interval must be at least 1000 ms; invalid values fall back to safe defaults
and produce a plugin log warning. Custom CA certificates and mutual TLS are
not supported by Decaid's plugin transport yet.

Saving settings reloads the plugin and exercises the real configured
connection. A success log is emitted only after MQTT CONNECT, command-topic
SUBACK, and the first retained state PUBACK. Verification times out after ten
seconds and reports which acknowledgement was missing. Credentials are never
included in diagnostic logs.
