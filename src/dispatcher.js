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
const STEAM_STORE_PATH = "/api/v1/store/streamline-app/last-steam-temp";
const MIN_STEAM_TEMPERATURE = 135;

export class CommandDispatcher {
  constructor({
    fetchImpl,
    currentStateProvider,
    machineConnectedProvider = () => true,
    workflowProvider = () => null,
    rememberedSteamTemperatureProvider = () => null,
    rememberSteamTemperature = () => {},
    workflowUpdated = () => {},
  }) {
    this._fetch = fetchImpl;
    this._currentStateProvider = currentStateProvider;
    this._machineConnectedProvider = machineConnectedProvider;
    this._workflowProvider = workflowProvider;
    this._rememberedSteamTemperatureProvider = rememberedSteamTemperatureProvider;
    this._rememberSteamTemperature = rememberSteamTemperature;
    this._workflowUpdated = workflowUpdated;
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

  async _getJson(path) {
    const response = await this._fetch(`${DECAID_API_BASE}${path}`);
    if (!response.ok) return null;
    return response.json();
  }

  async _currentWorkflow() {
    return (await this._getJson("/api/v1/workflow")) ?? this._workflowProvider?.() ?? null;
  }

  async _rememberedSteamTemperature() {
    const shared = await this._getJson(STEAM_STORE_PATH);
    if (Number.isFinite(shared) && shared >= MIN_STEAM_TEMPERATURE) return Math.round(shared);
    const local = this._rememberedSteamTemperatureProvider?.();
    return Number.isFinite(local) && local >= MIN_STEAM_TEMPERATURE ? Math.round(local) : null;
  }

  async _updateSteamTarget(targetTemperature) {
    const result = await this._request("PUT", "/api/v1/workflow", {
      steamSettings: { targetTemperature },
    });
    if (result.ok) this._workflowUpdated?.({ steamSettings: { targetTemperature } });
    return result;
  }

  async _setSteamHeater(enabled) {
    const connectionError = this._connectionError();
    if (connectionError) return connectionError;
    const state = this._state();
    if (!SAFE_RESTING_STATES.has(state) && !(state === "steam" && !enabled)) {
      return { ok: false, reason: `machine in use (${state ?? "unknown"}); steam setting unchanged` };
    }
    if (!enabled && state === "steam") {
      const stopped = await this._putState("idle");
      if (!stopped.ok) return stopped;
    }

    const workflow = await this._currentWorkflow();
    const currentTarget = workflow?.steamSettings?.targetTemperature;
    let targetSteamTemp = 0;
    if (enabled) {
      if (Number.isFinite(currentTarget) && currentTarget >= MIN_STEAM_TEMPERATURE) {
        return state === "sleeping" ? this._putState("idle") : { ok: true, noop: true };
      }
      targetSteamTemp = await this._rememberedSteamTemperature();
      if (targetSteamTemp === null) {
        return { ok: false, reason: "no remembered steam temperature in Decaid" };
      }
    } else {
      if (Number.isFinite(currentTarget) && currentTarget >= MIN_STEAM_TEMPERATURE) {
        this._rememberSteamTemperature(currentTarget);
        // Match Streamline: the shared value is best effort because the local
        // plugin value remains available if Decaid's KV store is unavailable.
        await this._request("POST", STEAM_STORE_PATH, Math.round(currentTarget)).catch(() => null);
      } else if (state !== "steam") {
        return { ok: true, noop: true };
      }
    }

    const updated = await this._updateSteamTarget(targetSteamTemp);
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
    // Decaid enables firmware user-presence tracking. Without this heartbeat
    // the machine can report an ordinary resting state through the mapped API
    // while internally rejecting remote operation requests as userNotPresent.
    // Decaid's device-write queue preserves heartbeat-before-state ordering.
    const presence = await this._request("POST", "/api/v1/machine/heartbeat");
    if (!presence.ok) {
      return { ok: false, reason: `presence heartbeat failed (${presence.status})` };
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
