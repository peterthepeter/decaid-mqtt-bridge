import { mapState, mapSubstate, deriveWakeState, deriveSteamFields } from "./mapping.js";

const WATER_LEVEL_FIELDS = ["water_level_mm", "water_level_ml"];

const SHOT_FIELDS = ["shot_active", "shot_id", "shot_started_at", "shot_duration_s", "shot_weight_g"];

const BASE_FIELDS = [
  "online",
  "de1_connected",
  "scale_connected",
  "state",
  "substate",
  "profile",
  "profile_filename",
  "espresso_count",
  "steaming_count",
  "head_temperature",
  "mix_temperature",
  "steam_heater_temperature",
  "water_level_mm",
  "water_level_ml",
  "wake_state",
  "steam_mode",
  "steam_state",
];

export function offlineStateMessage() {
  return { online: false, de1_connected: false };
}

export function buildStateMessage(input) {
  const {
    snapshot,
    online = Boolean(snapshot),
    machineConnected = Boolean(snapshot),
    scaleConnected = false,
    scaleSnapshot = null,
    waterLevelMm = null,
    refillLevelMm = null,
    profile = null,
    profileFilename = null,
    workflow = null,
    settings = null,
    shotSettings = null,
    shotState = null,
    espressoCount = 0,
    steamingCount = 0,
    shot = null,
  } = input;

  if (!snapshot || !machineConnected) {
    const disconnected = { online: Boolean(online), de1_connected: false };
    addFinite(disconnected, "tablet_battery_percent", settings?.chargingState?.batteryPercent);
    return disconnected;
  }

  const state = mapState(snapshot.state?.state ?? snapshot.state);
  const substate = mapSubstate(snapshot.state?.substate ?? snapshot.substate);
  const steamDisabled = !Number.isFinite(shotSettings?.targetSteamTemp)
    || shotSettings.targetSteamTemp < 135;
  const steam = deriveSteamFields(state, steamDisabled, false);

  const stateMessage = {
    online: true,
    de1_connected: true,
    scale_connected: Boolean(scaleConnected),
    state,
    substate,
    profile: profile ?? "",
    profile_filename: profileFilename ?? "",
    espresso_count: espressoCount,
    steaming_count: steamingCount,
    head_temperature: snapshot.groupTemperature,
    mix_temperature: snapshot.mixTemperature,
    steam_heater_temperature: snapshot.steamTemperature,
    water_level_mm: waterLevelMm ?? 0.0,
    water_level_ml: mmToMl(waterLevelMm),
    wake_state: deriveWakeState(state),
    steam_mode: steam.steam_mode,
    steam_state: steam.steam_state,
  };

  addFinite(stateMessage, "refill_level_mm", refillLevelMm);
  addFinite(stateMessage, "pressure", snapshot.pressure);
  addFinite(stateMessage, "target_pressure", snapshot.targetPressure);
  addFinite(stateMessage, "flow", snapshot.flow);
  addFinite(stateMessage, "target_flow", snapshot.targetFlow);
  addFinite(stateMessage, "target_group_temperature", snapshot.targetGroupTemperature);
  addFinite(stateMessage, "target_mix_temperature", snapshot.targetMixTemperature);

  addFinite(stateMessage, "scale_weight_g", scaleSnapshot?.weight);
  addFinite(stateMessage, "scale_weight_flow_g_s", scaleSnapshot?.weightFlow);
  addFinite(stateMessage, "scale_battery_percent", scaleSnapshot?.battery);
  addFinite(stateMessage, "scale_timer_ms", scaleSnapshot?.timerValue);

  addFinite(stateMessage, "target_steam_temperature", shotSettings?.targetSteamTemp);
  addFinite(stateMessage, "target_steam_duration_s", shotSettings?.targetSteamDuration);
  addFinite(stateMessage, "target_hot_water_temperature", shotSettings?.targetHotWaterTemp);
  addFinite(stateMessage, "target_hot_water_volume_ml", shotSettings?.targetHotWaterVolume);
  addFinite(stateMessage, "target_hot_water_duration_s", shotSettings?.targetHotWaterDuration);
  addFinite(stateMessage, "target_shot_volume_ml", shotSettings?.targetShotVolume);
  addFinite(stateMessage, "configured_group_temperature", shotSettings?.groupTemp);

  addFinite(stateMessage, "target_dose_g", workflow?.context?.targetDoseWeight);
  addFinite(stateMessage, "target_yield_g", workflow?.context?.targetYield);
  addFinite(stateMessage, "tablet_battery_percent", settings?.chargingState?.batteryPercent);
  addString(stateMessage, "shot_phase", shotState?.state);
  addString(stateMessage, "last_shot_stop_reason", shotState?.stopReason);
  if (typeof shotState?.scaleLost === "boolean") {
    stateMessage.scale_lost_during_shot = shotState.scaleLost;
  }

  stateMessage.shot_active = shot ? Boolean(shot.active) : false;
  if (shot?.id !== undefined && shot?.id !== null) stateMessage.shot_id = shot.id;
  if (shot?.startedAt !== undefined && shot?.startedAt !== null) stateMessage.shot_started_at = shot.startedAt;
  if (shot?.durationS !== undefined && shot?.durationS !== null) stateMessage.shot_duration_s = shot.durationS;
  if (shot?.weightG !== undefined && shot?.weightG !== null) stateMessage.shot_weight_g = shot.weightG;

  return stateMessage;
}

function addFinite(target, key, value) {
  if (typeof value === "number" && Number.isFinite(value)) target[key] = value;
}

function addString(target, key, value) {
  if (typeof value === "string" && value) target[key] = value;
}

export function mmToMl(mm) {
  if (mm === null || mm === undefined || !Number.isFinite(mm)) return 0;
  return waterTankLevelToMilliliters(mm);
}

export const WATER_TANK_MM_TO_ML = [
  0, 16, 43, 70, 97, 124, 151, 179, 206, 233, 261, 288, 316, 343, 371, 398,
  426, 453, 481, 509, 537, 564, 592, 620, 648, 676, 704, 732, 760, 788, 816,
  844, 872, 900, 929, 957, 985, 1013, 1042, 1070, 1104, 1138, 1172, 1207,
  1242, 1277, 1312, 1347, 1382, 1417, 1453, 1488, 1523, 1559, 1594, 1630,
  1665, 1701, 1736, 1772, 1808, 1843, 1879, 1915, 1951, 1986, 2022, 2058,
];

export const WATER_TANK_FULL_ML = 2058;

export function waterTankLevelToMilliliters(mm) {
  const index = Math.trunc(mm);
  if (index < 0 || index >= WATER_TANK_MM_TO_ML.length) {
    return WATER_TANK_FULL_ML;
  }
  return WATER_TANK_MM_TO_ML[index];
}

export function stateFieldOrder() {
  return [...BASE_FIELDS, ...SHOT_FIELDS, ...WATER_LEVEL_FIELDS];
}
