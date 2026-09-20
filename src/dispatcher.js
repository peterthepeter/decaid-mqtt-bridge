import { DECAID_API_BASE } from "./decaid-api.js";

const SAFE_RESTING_STATES = new Set(["idle", "schedIdle", "heating", "preheating", "sleeping"]);
const STARTABLE_STATES = new Set(["idle", "schedIdle", "heating", "preheating"]);
const STOPPABLE_STATES = new Set(["espresso", "steam", "hotWater", "flush", "steamRinse"]);
const START_STATE_BY_COMMAND = {
  espresso_start: "espresso",
  steam_start: "steam",
  hot_water_start: "hotWater",
  flush_start: "flush",
};
const REQUIRED_SHOT_SETTINGS = [
  "steamSetting", "targetSteamTemp", "targetSteamDuration", "targetHotWaterTemp",
  "targetHotWaterVolume", "targetHotWaterDuration", "targetShotVolume", "groupTemp",
];

export class CommandDispatcher {
  constructor({
    fetchImpl,
    currentStateProvider,
    machineConnectedProvider = () => true,
    shotSettingsProvider = () => null,
    workflowProvider = () => null,
  }) {
    this._fetch = fetchImpl;
    this._currentStateProvider = currentStateProvider;
    this._machineConnectedProvider = machineConnectedProvider;
    this._shotSettingsProvider = shotSettingsProvider;
    this._workflowProvider = workflowProvider;
  }

  async dispatch(parsed) {
    switch (parsed.kind) {
      case "wake": return this._wake();
      case "sleep": return this._sleep();
      case "steam_on": return this._setSteamHeater(true);
      case "steam_off": return this._setSteamHeater(false);
      case "espresso_start":
      case "steam_start":
      case "hot_water_start":
      case "flush_start": return this._startOperation(parsed.kind);
      case "stop": return this._stopOperation();
      case "profile": return this._selectProfileByTitle(parsed.argument);
      case "profile_filename": return this._selectProfileById(parsed.argument);
      default: return { ok: false, reason: "unknown command" };
    }
  }

  _state() {
    return this._currentStateProvider?.() ?? null;
  }

  _connectionError() {
    return this._machineConnectedProvider?.() ? null : { ok: false, reason: "machine disconnected" };
  }

  async _request(method, path, body) {
    const response = await this._fetch(`${DECAID_API_BASE}${path}`, {
      method,
      ...(body === undefined ? {} : {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    });
    return { ok: response.ok, status: response.status };
  }

  _putState(stateName) {
    return this._request("PUT", `/api/v1/machine/state/${stateName}`);
  }

  async _wake() {
    const connectionError = this._connectionError();
    if (connectionError) return connectionError;
    if (this._state() !== "sleeping") return { ok: true, noop: true };
    return this._putState("idle");
  }

  async _sleep() {
    const connectionError = this._connectionError();
    if (connectionError) return connectionError;
    const state = this._state();
    if (!SAFE_RESTING_STATES.has(state)) {
      return { ok: false, reason: `machine in use (${state ?? "unknown"}); not sleeping` };
    }
    if (state === "sleeping") return { ok: true, noop: true };
    return this._putState("sleeping");
  }

  _validatedShotSettings() {
    const settings = this._shotSettingsProvider?.();
    if (!settings || REQUIRED_SHOT_SETTINGS.some((key) => !Number.isFinite(settings[key]))) return null;
    return Object.fromEntries(REQUIRED_SHOT_SETTINGS.map((key) => [key, settings[key]]));
  }

  async _setSteamHeater(enabled) {
    const connectionError = this._connectionError();
    if (connectionError) return connectionError;
    const state = this._state();
    if (!SAFE_RESTING_STATES.has(state) && !(state === "steam" && !enabled)) {
      return { ok: false, reason: `machine in use (${state ?? "unknown"}); steam setting unchanged` };
    }
    const settings = this._validatedShotSettings();
    if (!settings) return { ok: false, reason: "no fresh, valid shot settings" };

    let targetSteamTemp = 0;
    if (enabled) {
      const configured = this._workflowProvider?.()?.steamSettings?.targetTemperature;
      if (!Number.isFinite(configured) || configured < 135) {
        return { ok: false, reason: "workflow has no valid steam temperature" };
      }
      targetSteamTemp = configured;
    }

    if (!enabled && state === "steam") {
      const stopped = await this._putState("idle");
      if (!stopped.ok) return stopped;
    }
    const updated = await this._request("POST", "/api/v1/machine/shotSettings", {
      ...settings,
      targetSteamTemp,
    });
    if (updated.ok && enabled && state === "sleeping") return this._putState("idle");
    return updated;
  }

  async _startOperation(command) {
    const connectionError = this._connectionError();
    if (connectionError) return connectionError;
    const state = this._state();
    if (!STARTABLE_STATES.has(state)) {
      const reason = state === "sleeping"
        ? "machine sleeping; wake it before starting an operation"
        : `machine not ready (${state ?? "unknown"}); operation not started`;
      return { ok: false, reason };
    }
    return this._putState(START_STATE_BY_COMMAND[command]);
  }

  async _stopOperation() {
    const connectionError = this._connectionError();
    if (connectionError) return connectionError;
    const state = this._state();
    if (STARTABLE_STATES.has(state) || state === "sleeping") return { ok: true, noop: true };
    if (!STOPPABLE_STATES.has(state)) {
      return { ok: false, reason: `machine state ${state ?? "unknown"} is not safe to stop remotely` };
    }
    return this._putState("idle");
  }

  async _profiles() {
    const response = await this._fetch(`${DECAID_API_BASE}/api/v1/profiles`);
    if (!response.ok) return [];
    const records = await response.json();
    return Array.isArray(records) ? records : [];
  }

  _selectProfileByTitle(title) {
    return this._selectProfile((record) => record.profile?.title === title);
  }

  _selectProfileById(id) {
    return this._selectProfile((record) => record.id === id || record.filename === id);
  }

  async _selectProfile(predicate) {
    const connectionError = this._connectionError();
    if (connectionError) return connectionError;
    const state = this._state();
    if (!SAFE_RESTING_STATES.has(state)) {
      return { ok: false, reason: `machine in use (${state ?? "unknown"}); profile unchanged` };
    }
    const record = (await this._profiles()).find(predicate);
    if (!record) return { ok: false, reason: "profile not found" };
    return this._request("POST", "/api/v1/machine/profile", record.profile);
  }
}
