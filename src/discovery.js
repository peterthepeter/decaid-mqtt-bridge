import { SHOT_EVENT_TYPES } from "./shot-events.js";

export const DISCOVERY_TOPICS_KEY = "haDiscoveryTopics";

const SENSOR_DEFINITIONS = [
  ["State", "state", "state", {}],
  ["Substate", "substate", "substate", {}],
  ["Water Level", "water_level", "water_level_ml", { device_class: "volume_storage", state_class: "measurement", unit_of_measurement: "mL", suggested_display_precision: 0, icon: "mdi:water" }],
  ["Water Level Height", "water_level_mm", "water_level_mm", { device_class: "distance", state_class: "measurement", unit_of_measurement: "mm", suggested_display_precision: 1, icon: "mdi:cup-water" }],
  ["Refill Threshold", "refill_threshold", "refill_level_mm", { device_class: "distance", unit_of_measurement: "mm", icon: "mdi:water-alert" }],
  ["Head Temperature", "head_temp", "head_temperature", { device_class: "temperature", state_class: "measurement", unit_of_measurement: "°C" }],
  ["Mix Temperature", "mix_temp", "mix_temperature", { device_class: "temperature", state_class: "measurement", unit_of_measurement: "°C" }],
  ["Steam Temperature", "steam_temp", "steam_heater_temperature", { device_class: "temperature", state_class: "measurement", unit_of_measurement: "°C" }],
  ["Target Group Temperature", "target_group_temp", "target_group_temperature", { device_class: "temperature", state_class: "measurement", unit_of_measurement: "°C" }],
  ["Target Mix Temperature", "target_mix_temp", "target_mix_temperature", { device_class: "temperature", state_class: "measurement", unit_of_measurement: "°C" }],
  ["Configured Group Temperature", "configured_group_temp", "configured_group_temperature", { device_class: "temperature", unit_of_measurement: "°C" }],
  ["Pressure", "pressure", "pressure", { device_class: "pressure", state_class: "measurement", unit_of_measurement: "bar" }],
  ["Target Pressure", "target_pressure", "target_pressure", { device_class: "pressure", state_class: "measurement", unit_of_measurement: "bar" }],
  ["Flow", "flow", "flow", { state_class: "measurement", unit_of_measurement: "mL/s", suggested_display_precision: 2, icon: "mdi:water" }],
  ["Target Flow", "target_flow", "target_flow", { state_class: "measurement", unit_of_measurement: "mL/s", suggested_display_precision: 2, icon: "mdi:water" }],
  ["Espresso Count", "espresso_count", "espresso_count", { state_class: "total_increasing", icon: "mdi:coffee" }],
  ["Steaming Count", "steaming_count", "steaming_count", { state_class: "total_increasing", icon: "mdi:weather-dust" }],
  ["Target Steam Temperature", "target_steam_temp", "target_steam_temperature", { device_class: "temperature", unit_of_measurement: "°C" }],
  ["Target Steam Duration", "target_steam_duration", "target_steam_duration_s", { device_class: "duration", unit_of_measurement: "s" }],
  ["Target Hot Water Temperature", "target_hot_water_temp", "target_hot_water_temperature", { device_class: "temperature", unit_of_measurement: "°C" }],
  ["Target Hot Water Volume", "target_hot_water_volume", "target_hot_water_volume_ml", { device_class: "volume", unit_of_measurement: "mL" }],
  ["Target Hot Water Duration", "target_hot_water_duration", "target_hot_water_duration_s", { device_class: "duration", unit_of_measurement: "s" }],
  ["Target Shot Volume", "target_shot_volume", "target_shot_volume_ml", { device_class: "volume", unit_of_measurement: "mL" }],
  ["Scale Weight", "scale_weight", "scale_weight_g", { device_class: "weight", state_class: "measurement", unit_of_measurement: "g", availability: "scale" }],
  ["Scale Weight Flow", "scale_weight_flow", "scale_weight_flow_g_s", { state_class: "measurement", unit_of_measurement: "g/s", suggested_display_precision: 2, icon: "mdi:water", availability: "scale" }],
  ["Scale Battery", "scale_battery", "scale_battery_percent", { device_class: "battery", state_class: "measurement", unit_of_measurement: "%", availability: "scale" }],
  ["Scale Timer", "scale_timer", "scale_timer_ms", { device_class: "duration", unit_of_measurement: "ms", availability: "scale" }],
  ["Shot Phase", "shot_phase", "shot_phase", { icon: "mdi:coffee-maker" }],
  ["Last Shot Stop Reason", "last_shot_stop_reason", "last_shot_stop_reason", { icon: "mdi:information-outline" }],
  ["Shot Weight", "shot_weight", "shot_weight_g", { device_class: "weight", state_class: "measurement", unit_of_measurement: "g" }],
  ["Shot Duration", "shot_duration", "shot_duration_s", { device_class: "duration", unit_of_measurement: "s" }],
  ["Shot Started At", "shot_started_at", "shot_started_at", { device_class: "timestamp" }],
  ["Target Dose", "target_dose", "target_dose_g", { device_class: "weight", unit_of_measurement: "g" }],
  ["Target Yield", "target_yield", "target_yield_g", { device_class: "weight", unit_of_measurement: "g" }],
  ["Tablet Battery", "tablet_battery", "tablet_battery_percent", { device_class: "battery", state_class: "measurement", unit_of_measurement: "%", availability: "online" }],
];

const BINARY_SENSOR_DEFINITIONS = [
  ["Machine Connected", "machine_connected", "de1_connected", { device_class: "connectivity", availability: "online" }],
  ["Scale Connected", "scale_connected", "scale_connected", { device_class: "connectivity", availability: "online" }],
  ["Shot Active", "shot_active", "shot_active", {}],
  ["Scale Lost During Shot", "scale_lost_during_shot", "scale_lost_during_shot", { device_class: "problem" }],
];

function entityId(config, key) {
  return `de1plus_${config.uniqueId}_${key}`;
}

function topicFor(config, component, key) {
  return `${config.haDiscoveryPrefix}/${component}/${entityId(config, key)}/config`;
}

function availability(config, kind = "machine") {
  const expression = kind === "online"
    ? "value_json.online"
    : kind === "scale"
      ? "value_json.online and value_json.scale_connected"
      : "value_json.online and value_json.de1_connected";
  return [{
    topic: `${config.topicPrefix}/state`,
    value_template: `{{ ${expression} }}`,
    payload_available: "True",
    payload_not_available: "False",
  }];
}

function device(config, metadata = {}) {
  const info = {
    identifiers: [config.uniqueId],
    name: config.haDeviceName || `Decent Espresso ${metadata.model || "DE1+"}`,
    manufacturer: "Decent Espresso",
    model: metadata.model || "Decaid",
  };
  if (metadata.serialNumber) info.serial_number = metadata.serialNumber;
  if (metadata.version) info.sw_version = metadata.version;
  return info;
}

function common(config, metadata, name, key, availabilityKind) {
  return {
    name: `${config.haEntityNamePrefix}${name}`,
    unique_id: entityId(config, key),
    availability: availability(config, availabilityKind),
    device: device(config, metadata),
    origin: { name: "Decaid MQTT Bridge", sw_version: "0.2.3" },
  };
}

function stateEntity(config, metadata, component, definition) {
  const [name, key, field, options] = definition;
  const { availability: availabilityKind, ...componentOptions } = options;
  return {
    topic: topicFor(config, component, key),
    payload: {
      ...common(config, metadata, name, key, availabilityKind),
      state_topic: `${config.topicPrefix}/state`,
      value_template: `{{ value_json.${field} | default(None) }}`,
      ...componentOptions,
    },
  };
}

export function buildDiscoveryMessages(config, metadata = {}, profileOptions = []) {
  const messages = [
    ...SENSOR_DEFINITIONS.map((definition) => stateEntity(config, metadata, "sensor", definition)),
    ...BINARY_SENSOR_DEFINITIONS.map((definition) => {
      const message = stateEntity(config, metadata, "binary_sensor", definition);
      message.payload.payload_on = "True";
      message.payload.payload_off = "False";
      return message;
    }),
  ];

  for (const [name, key, field, payloadOn, payloadOff, icon] of [
    ["On", "switch", "wake_state", "wake", "sleep", "mdi:coffee-maker"],
    ["Steam Heater On", "steam_switch", "steam_state", "steam_on", "steam_off", "mdi:heat-wave"],
  ]) {
    messages.push({
      topic: topicFor(config, "switch", key),
      payload: {
        ...common(config, metadata, name, key),
        state_topic: `${config.topicPrefix}/state`,
        value_template: `{{ value_json.${field} }}`,
        state_on: "True",
        state_off: "False",
        command_topic: `${config.topicPrefix}/command`,
        payload_on: payloadOn,
        payload_off: payloadOff,
        qos: 1,
        retain: false,
        icon,
      },
    });
  }

  for (const [name, key, payloadPress, icon] of [
    ["Start Espresso", "espresso_start", "espresso_start", "mdi:coffee"],
    ["Start Steam", "steam_start", "steam_start", "mdi:weather-dust"],
    ["Start Hot Water", "hot_water_start", "hot_water_start", "mdi:cup-water"],
    ["Start Rinse", "flush_start", "flush_start", "mdi:water-sync"],
    ["Stop", "stop", "stop", "mdi:stop-circle-outline"],
  ]) {
    messages.push({
      topic: topicFor(config, "button", key),
      payload: {
        ...common(config, metadata, name, key),
        command_topic: `${config.topicPrefix}/command`,
        payload_press: payloadPress,
        qos: 1,
        retain: false,
        icon,
      },
    });
  }

  if (profileOptions.length > 0) {
    messages.push({
      topic: topicFor(config, "select", "profile_select"),
      payload: {
        ...common(config, metadata, "Profile", "profile_select"),
        state_topic: `${config.topicPrefix}/state`,
        value_template: "{{ value_json.profile }}",
        command_topic: `${config.topicPrefix}/command`,
        command_template: "profile {{ value }}",
        qos: 1,
        retain: false,
        options: profileOptions,
        icon: "mdi:chart-bell-curve",
      },
    });
  }

  messages.push({
    topic: topicFor(config, "event", "shot_event"),
    payload: {
      ...common(config, metadata, "Shot Event", "shot_event"),
      state_topic: `${config.topicPrefix}/event/shot`,
      event_types: SHOT_EVENT_TYPES,
      icon: "mdi:coffee-maker",
    },
  });
  return messages;
}

export function discoveryTopicList(config) {
  return buildDiscoveryMessages(config).map((message) => message.topic);
}
