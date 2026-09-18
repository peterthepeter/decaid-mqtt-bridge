export const STATE_MAP = {
  booting: "Init",
  busy: "Busy",
  idle: "Idle",
  schedIdle: "SchedIdle",
  sleeping: "Sleep",
  heating: "Idle",
  preheating: "Idle",
  espresso: "Espresso",
  hotWater: "HotWater",
  flush: "HotWaterRinse",
  steam: "Steam",
  steamRinse: "SteamRinse",
  skipStep: "SkipToNext",
  cleaning: "Clean",
  descaling: "Descale",
  calibration: "ShortCal",
  selfTest: "SelfTest",
  airPurge: "AirPurge",
  needsWater: "Refill",
  error: "FatalError",
  fwUpgrade: "FWUpgrade",
};

export const SUBSTATE_MAP = {
  idle: "ready",
  preparingForShot: "heating",
  preinfusion: "preinfusion",
  pouring: "pouring",
  pouringDone: "ending",
  cleaningStart: "CleanInit",
  cleaningGroup: "CleanGroup",
  cleanSoaking: "CleanSoak",
  cleaningSteam: "CleanGroup",
  errorNaN: "Error_NaN",
  errorInf: "Error_Inf",
  errorGeneric: "Error_Generic",
  errorAcc: "Error_ACC",
  errorTSensor: "Error_TSensor",
  errorPSensor: "Error_PSensor",
  errorWLevel: "Error_WLevel",
  errorDip: "Error_DIP",
  errorAssertion: "Error_Assertion",
  errorUnsafe: "Error_Unsafe",
  errorInvalidParam: "Error_InvalidParm",
  errorFlash: "Error_Flash",
  errorOOM: "Error_OOM",
  errorDeadline: "Error_Deadline",
  errorHiCurrent: "Error_HiCurrent",
  errorLoCurrent: "Error_LoCurrent",
  errorBootFill: "Error_BootFill",
  errorNoAC: "Error_NoAC",
};

export function mapState(internal) {
  if (internal === null || internal === undefined) return undefined;
  return STATE_MAP[internal] ?? internal;
}

export function mapSubstate(internal) {
  if (internal === null || internal === undefined) return undefined;
  return SUBSTATE_MAP[internal] ?? internal;
}

export function deriveWakeState(publishedState) {
  return publishedState !== "Sleep";
}

export function deriveSteamFields(publishedState, steamDisabled, ecoSteamOn) {
  if (publishedState === "Sleep" || steamDisabled) {
    return { steam_mode: "Off", steam_state: false };
  }
  if (ecoSteamOn) {
    return { steam_mode: "Eco", steam_state: true };
  }
  return { steam_mode: "On", steam_state: true };
}

export function isShotActive(publishedState, substate) {
  return publishedState === "Espresso";
}
