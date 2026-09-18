import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeConfig, generateUniqueId, UNIQUE_ID_KEY, telemetryPublishIntervalMs } from "../src/config.js";
import { STATE_MAP, SUBSTATE_MAP, mapState, mapSubstate, deriveWakeState, deriveSteamFields, isShotActive } from "../src/mapping.js";
import { buildStateMessage, offlineStateMessage, waterTankLevelToMilliliters } from "../src/state-doc.js";
import { parseCommand } from "../src/commands.js";
import { CommandDispatcher } from "../src/dispatcher.js";
import { createCommandHandler } from "../src/command-handler.js";
import { createDecaidApi } from "../src/decaid-api.js";
import { buildDiscoveryMessages } from "../src/discovery.js";
import { readFileSync } from "node:fs";

test("generateUniqueId returns 8 hex chars", () => {
  const id = generateUniqueId();
  assert.match(id, /^[0-9a-f]{8}$/);
});

test("normalizeConfig applies de1app-compatible defaults", () => {
  const { config, warnings, uniqueId } = normalizeConfig({ Host: "broker.local" }, "abcd1234");
  assert.deepEqual(warnings, []);
  assert.equal(uniqueId, "abcd1234");
  assert.equal(config.enabled, true);
  assert.equal(config.host, "broker.local");
  assert.equal(config.port, 8883);
  assert.equal(config.enableTls, true);
  assert.equal(config.publishIntervalMs, 60000);
  assert.equal(config.clientId, "de1plus_abcd1234");
  assert.equal(config.topicPrefix, "de1plus/abcd1234");
});

test("normalizeConfig disables when host is empty", () => {
  const { config } = normalizeConfig({}, null);
  assert.equal(config.enabled, false);
  assert.match(config.uniqueId, /^[0-9a-f]{8}$/);
});

test("normalizeConfig validates port and interval", () => {
  const { warnings } = normalizeConfig({ Host: "h", Port: 0, PublishIntervalMs: 10 }, null);
  assert.equal(warnings.length, 2);
  const ok = normalizeConfig({ Host: "h", Port: 1883, PublishIntervalMs: 1000, EnableTls: false }, null);
  assert.deepEqual(ok.warnings, []);
  assert.equal(ok.config.port, 1883);
  assert.equal(ok.config.publishIntervalMs, 1000);
  assert.equal(ok.config.enableTls, false);
});

test("telemetry cadence follows machine activity while transitions stay separate", () => {
  assert.equal(telemetryPublishIntervalMs("espresso"), 1000);
  assert.equal(telemetryPublishIntervalMs("steam"), 1000);
  assert.equal(telemetryPublishIntervalMs("heating"), 2000);
  assert.equal(telemetryPublishIntervalMs("preheating"), 2000);
  assert.equal(telemetryPublishIntervalMs("idle"), 5000);
  assert.equal(telemetryPublishIntervalMs("schedIdle"), 5000);
  assert.equal(telemetryPublishIntervalMs("sleeping"), null);
  assert.equal(telemetryPublishIntervalMs("disconnected"), null);
});

test("heartbeat seconds override legacy milliseconds without changing old installations", () => {
  for (const seconds of [undefined, null, ""]) {
    const { config } = normalizeConfig({ HeartbeatSeconds: seconds, PublishIntervalMs: 90000, ClientId: "existing-client" }, "abc");
    assert.equal(config.publishIntervalMs, 90000);
    assert.equal(config.clientId, "existing-client");
  }
  assert.equal(normalizeConfig({ HeartbeatSeconds: 60, PublishIntervalMs: 1000 }, "abc").config.publishIntervalMs, 60000);
  assert.equal(normalizeConfig({ HeartbeatSeconds: "90" }, "abc").config.publishIntervalMs, 90000);
  assert.equal(normalizeConfig({ HeartbeatSeconds: 1 }, "abc").config.publishIntervalMs, 1000);
  for (const seconds of [0, -1, 0.5, "invalid", Infinity]) {
    const { config, warnings } = normalizeConfig({ HeartbeatSeconds: seconds }, "abc");
    assert.equal(config.publishIntervalMs, 60000);
    assert.equal(warnings.length, 1);
  }
});

test("tablet settings put normal setup first and preserve compatibility fields", () => {
  const manifest = JSON.parse(readFileSync(new URL("../mqtt.reaplugin/manifest.json", import.meta.url), "utf8"));
  const keys = Object.keys(manifest.settings);
  assert.deepEqual(keys.slice(0, 8), ["Host", "Port", "EnableTls", "Username", "Password", "HaAutoDiscoveryEnable", "HaDeviceName", "HeartbeatSeconds"]);
  for (const key of keys.slice(8)) assert.ok(manifest.settings[key].label.startsWith("Advanced:"));
  assert.equal(manifest.settings.Password.secure, true);
  assert.equal(manifest.settings.HeartbeatSeconds.default, 60);
  assert.match(manifest.settings.HeartbeatSeconds.description, /brewing.*heating.*idle/);
  assert.ok(manifest.settings.ClientId);
  assert.equal(manifest.settings.PublishIntervalMs, undefined);
});

test("state map covers every entry exactly once", () => {
  assert.equal(Object.keys(STATE_MAP).length, 21);
  assert.equal(Object.keys(SUBSTATE_MAP).length, 27);
  assert.equal(mapState("sleeping"), "Sleep");
  assert.equal(mapState("heating"), "Idle");
  assert.equal(mapSubstate("idle"), "ready");
  assert.equal(mapSubstate("preparingForShot"), "heating");
  assert.equal(mapSubstate("errorDip"), "Error_DIP");
});

test("unknown internal values fall back to enum name", () => {
  assert.equal(mapState("futureState"), "futureState");
  assert.equal(mapSubstate("futureSubstate"), "futureSubstate");
});

test("derived fields follow the documented rules", () => {
  assert.equal(deriveWakeState("Idle"), true);
  assert.equal(deriveWakeState("Sleep"), false);
  assert.deepEqual(deriveSteamFields("Sleep", false, true), { steam_mode: "Off", steam_state: false });
  assert.deepEqual(deriveSteamFields("Idle", true, false), { steam_mode: "Off", steam_state: false });
  assert.deepEqual(deriveSteamFields("Idle", false, true), { steam_mode: "Eco", steam_state: true });
  assert.deepEqual(deriveSteamFields("Idle", false, false), { steam_mode: "On", steam_state: true });
});

test("isShotActive covers every substate of an espresso", () => {
  for (const substate of ["heating", "preinfusion", "pouring", "ending", "ready"]) {
    assert.equal(isShotActive("Espresso", substate), true, `Espresso/${substate}`);
  }
});

test("isShotActive ignores steam, flush and hot water", () => {
  // These all report a `pouring` substate of their own; none of them is a shot.
  for (const state of ["Steam", "SteamRinse", "HotWater", "HotWaterRinse"]) {
    assert.equal(isShotActive(state, "pouring"), false, `${state}/pouring`);
    assert.equal(isShotActive(state, "heating"), false, `${state}/heating`);
  }
  assert.equal(isShotActive("Idle", "pouring"), false);
  assert.equal(isShotActive("Idle", "preinfusion"), false);
  assert.equal(isShotActive("Idle", "ready"), false);
});

test("offline document has exactly online and de1_connected", () => {
  assert.deepEqual(offlineStateMessage(), { online: false, de1_connected: false });
});

test("state document when machine disconnected contains only availability fields", () => {
  const doc = buildStateMessage({ snapshot: null });
  assert.deepEqual(Object.keys(doc), ["online", "de1_connected"]);
});

test("state document contains all de1app fields plus shot fields", () => {
  const doc = buildStateMessage({
    snapshot: {
      state: { state: "idle", substate: "pouring" },
      groupTemperature: 93.5,
      mixTemperature: 88.1,
      steamTemperature: 4.2,
    },
    scaleConnected: true,
    waterLevelMm: 40,
    profile: "Ristretto",
    profileFilename: "ristretto.json",
    espressoCount: 42,
    steamingCount: 10,
    shotSettings: { targetSteamTemp: 150 },
    shot: { active: true, weightG: 12.4 },
  });
  assert.equal(doc.online, true);
  assert.equal(doc.de1_connected, true);
  assert.equal(doc.scale_connected, true);
  assert.equal(doc.state, "Idle");
  assert.equal(doc.substate, "pouring");
  assert.equal(doc.profile, "Ristretto");
  assert.equal(doc.profile_filename, "ristretto.json");
  assert.equal(doc.espresso_count, 42);
  assert.equal(doc.steaming_count, 10);
  assert.equal(doc.head_temperature, 93.5);
  assert.equal(doc.mix_temperature, 88.1);
  assert.equal(doc.steam_heater_temperature, 4.2);
  assert.equal(doc.wake_state, true);
  assert.equal(doc.steam_mode, "On");
  assert.equal(doc.steam_state, true);
  assert.equal(doc.shot_active, true);
  assert.equal(doc.shot_weight_g, 12.4);
});

test("post-shot fields populate from the completed shot", () => {
  const doc = buildStateMessage({
    snapshot: { state: { state: "idle", substate: "idle" } },
    shot: {
      active: false,
      id: "shot-1",
      startedAt: "2026-09-09T07:15:00Z",
      durationS: 28.4,
      weightG: 18.5,
    },
  });
  assert.equal(doc.shot_active, false);
  assert.equal(doc.shot_id, "shot-1");
  assert.equal(doc.shot_started_at, "2026-09-09T07:15:00Z");
  assert.equal(doc.shot_duration_s, 28.4);
  assert.equal(doc.shot_weight_g, 18.5);
});

test("waterTankLevelToMilliliters matches the de1app lookup table", () => {
  assert.equal(waterTankLevelToMilliliters(0), 0);
  assert.equal(waterTankLevelToMilliliters(1), 16);
  assert.equal(waterTankLevelToMilliliters(40), 1104);
  assert.equal(waterTankLevelToMilliliters(40.9), 1104);
  assert.equal(waterTankLevelToMilliliters(67), 2058);
  assert.equal(waterTankLevelToMilliliters(68), 2058);
  assert.equal(waterTankLevelToMilliliters(200), 2058);
  assert.equal(waterTankLevelToMilliliters(-1), 2058);
  assert.equal(waterTankLevelToMilliliters(40), 1104);
});

test("parseCommand handles the de1app grammar", () => {
  assert.deepEqual(parseCommand("wake"), { kind: "wake", argument: null });
  assert.deepEqual(parseCommand("  sleep "), { kind: "sleep", argument: null });
  assert.deepEqual(parseCommand("steam_on"), { kind: "steam_on", argument: null });
  assert.deepEqual(parseCommand("steam_off"), { kind: "steam_off", argument: null });
  assert.deepEqual(parseCommand("profile Ristretto"), { kind: "profile", argument: "Ristretto" });
  assert.deepEqual(parseCommand("profile My  Double  Name "), { kind: "profile", argument: "My  Double  Name " });
  assert.deepEqual(parseCommand("profile_filename long_black.tcl"), {
    kind: "profile_filename",
    argument: "long_black.tcl",
  });
  assert.equal(parseCommand("profile"), null);
  assert.equal(parseCommand("profile "), null);
  assert.equal(parseCommand("profile_filename"), null);
  assert.equal(parseCommand("explode"), null);
  assert.equal(parseCommand(""), null);
  assert.equal(parseCommand(null), null);
});

function mockFetch(routes) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, method: (init.method ?? "GET").toUpperCase(), body: init.body ?? null });
      const handler = routes.find((r) => r.match.test(url) && r.method === (init.method ?? "GET").toUpperCase());
      if (!handler) return { ok: false, status: 404 };
      return handler.respond(calls[calls.length - 1]);
    },
  };
}

test("dispatcher wakes a sleeping machine through the safe idle path", async () => {
  const stateProviderCalls = [];
  const { fetchImpl, calls } = mockFetch([
    {
      match: /^http:\/\/localhost:8080\/api\/v1\/machine\/state\/idle$/,
      method: "PUT",
      respond: () => ({ ok: true, status: 200 }),
    },
  ]);
  const dispatcher = new CommandDispatcher({
    fetchImpl,
    currentStateProvider: () => {
      stateProviderCalls.push(1);
      return "sleeping";
    },
  });

  const wake = await dispatcher.dispatch({ kind: "wake", argument: null });
  assert.equal(wake.ok, true);
  assert.equal(calls[0].method, "PUT");
  assert.equal(calls[0].url, "http://localhost:8080/api/v1/machine/state/idle");
});

test("dispatcher refuses sleep when the machine is in use", async () => {
  const { fetchImpl, calls } = mockFetch([]);
  const dispatcher = new CommandDispatcher({
    fetchImpl,
    currentStateProvider: () => "espresso",
  });
  const result = await dispatcher.dispatch({ kind: "sleep", argument: null });
  assert.equal(result.ok, false);
  assert.match(result.reason, /in use/);
  assert.equal(calls.length, 0);
});

test("dispatcher sleeps only from Idle", async () => {
  const { fetchImpl, calls } = mockFetch([
    {
      match: /\/state\/sleeping$/,
      method: "PUT",
      respond: () => ({ ok: true, status: 200 }),
    },
  ]);
  const dispatcher = new CommandDispatcher({
    fetchImpl,
    currentStateProvider: () => "idle",
  });
  const result = await dispatcher.dispatch({ kind: "sleep", argument: null });
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, "http://localhost:8080/api/v1/machine/state/sleeping");
});

test("steam_on updates the heater setting and wakes without starting steam", async () => {
  const { fetchImpl, calls } = mockFetch([
    {
      match: /\/machine\/shotSettings$/,
      method: "POST",
      respond: () => ({ ok: true, status: 200 }),
    },
    {
      match: /\/state\/idle$/,
      method: "PUT",
      respond: () => ({ ok: true, status: 200 }),
    },
  ]);
  const dispatcher = new CommandDispatcher({
    fetchImpl,
    currentStateProvider: () => "sleeping",
    shotSettingsProvider: () => ({
      steamSetting: 0,
      targetSteamTemp: 0,
      targetSteamDuration: 30,
      targetHotWaterTemp: 80,
      targetHotWaterVolume: 100,
      targetHotWaterDuration: 20,
      targetShotVolume: 60,
      groupTemp: 93,
    }),
    workflowProvider: () => ({ steamSettings: { targetTemperature: 145 } }),
  });
  const result = await dispatcher.dispatch({ kind: "steam_on", argument: null });
  assert.equal(result.ok, true);
  assert.deepEqual(
    calls.map((c) => c.url),
    [
      "http://localhost:8080/api/v1/machine/shotSettings",
      "http://localhost:8080/api/v1/machine/state/idle",
    ],
  );
  assert.equal(JSON.parse(calls[0].body).targetSteamTemp, 145);
});

test("profile command resolves by title then posts the profile", async () => {
  const { fetchImpl, calls } = mockFetch([
    {
      match: /\/api\/v1\/profiles$/,
      method: "GET",
      respond: () => ({
        ok: true,
        status: 200,
        json: async () => [
          { id: "ristretto.json", profile: { title: "Ristretto" } },
          { id: "long_black.json", profile: { title: "Long Black" } },
        ],
      }),
    },
    {
      match: /\/api\/v1\/machine\/profile$/,
      method: "POST",
      respond: () => ({ ok: true, status: 200 }),
    },
  ]);
  const dispatcher = new CommandDispatcher({
    fetchImpl,
    currentStateProvider: () => "idle",
  });
  const result = await dispatcher.dispatch({ kind: "profile", argument: "Long Black" });
  assert.equal(result.ok, true);
  assert.equal(calls[1].url, "http://localhost:8080/api/v1/machine/profile");
  assert.deepEqual(JSON.parse(calls[1].body), { title: "Long Black" });
});

test("profile command ignores unknown titles", async () => {
  const { fetchImpl, calls } = mockFetch([
    {
      match: /\/api\/v1\/profiles$/,
      method: "GET",
      respond: () => ({ ok: true, status: 200, json: async () => [] }),
    },
  ]);
  const dispatcher = new CommandDispatcher({
    fetchImpl,
    currentStateProvider: () => "idle",
  });
  const result = await dispatcher.dispatch({ kind: "profile", argument: "Nope" });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 1);
});

test("profile_filename command resolves by record id", async () => {
  const { fetchImpl, calls } = mockFetch([
    {
      match: /\/api\/v1\/profiles$/,
      method: "GET",
      respond: () => ({
        ok: true,
        status: 200,
        json: async () => [{ id: "lb.json", profile: { title: "Long Black" } }],
      }),
    },
    {
      match: /\/api\/v1\/machine\/profile$/,
      method: "POST",
      respond: () => ({ ok: true, status: 200 }),
    },
  ]);
  const dispatcher = new CommandDispatcher({
    fetchImpl,
    currentStateProvider: () => "idle",
  });
  const result = await dispatcher.dispatch({ kind: "profile_filename", argument: "lb.json" });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(calls[1].body), { title: "Long Black" });
});

test("command handler logs unknown payloads", async () => {
  const logs = [];
  const applied = [];
  const dispatcher = {
    dispatch: async (parsed) => {
      applied.push(parsed);
      return { ok: true };
    },
  };
  const handler = createCommandHandler(dispatcher, (msg) => logs.push(msg));
  handler("t/c", "explode");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(applied.length, 0);
  assert.match(logs[0], /unknown MQTT command/);
  handler("t/c", "wake");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(applied[0], { kind: "wake", argument: null });
});

test("UNIQUE_ID_KEY is stable", () => {
  assert.equal(UNIQUE_ID_KEY, "uniqueId");
});

test("Home Assistant discovery groups stable entities under one device", () => {
  const config = {
    uniqueId: "abcd1234",
    topicPrefix: "de1plus/abcd1234",
    haDiscoveryPrefix: "homeassistant",
    haEntityNamePrefix: "DE1+ ",
    haDeviceName: "",
  };
  const messages = buildDiscoveryMessages(config, {
    model: "DE1PRO",
    serialNumber: "1234",
    version: "1352",
  }, ["Medium", "Ristretto"]);
  assert.ok(messages.length >= 40);
  assert.equal(new Set(messages.map((message) => message.topic)).size, messages.length);
  const head = messages.find((message) => message.payload.unique_id === "de1plus_abcd1234_head_temp");
  assert.equal(head.topic, "homeassistant/sensor/de1plus_abcd1234_head_temp/config");
  assert.equal(head.payload.state_topic, "de1plus/abcd1234/state");
  assert.deepEqual(head.payload.device.identifiers, ["abcd1234"]);
  assert.equal(head.payload.device.model, "DE1PRO");
  for (const [key, precision] of [["water_level", 0], ["water_level_mm", 1]]) {
    const sensor = messages.find((message) => message.payload.unique_id === `de1plus_abcd1234_${key}`);
    assert.equal(sensor.payload.suggested_display_precision, precision);
  }
  for (const key of ["flow", "target_flow", "scale_weight_flow"]) {
    const sensor = messages.find((message) => message.payload.unique_id === `de1plus_abcd1234_${key}`);
    assert.equal(sensor.payload.suggested_display_precision, 2);
    // Presentation precision must not round the underlying measurement.
    assert.ok(!sensor.payload.value_template.includes("round"));
  }
  const profile = messages.find((message) => message.payload.unique_id.endsWith("profile_select"));
  assert.deepEqual(profile.payload.options, ["Medium", "Ristretto"]);
  const event = messages.find((message) => message.payload.unique_id.endsWith("shot_event"));
  assert.equal(event.payload.state_topic, "de1plus/abcd1234/event/shot");
  assert.deepEqual(event.payload.event_types, ["Bezug gestartet", "Bezug beendet", "Bezug abgebrochen"]);
});

test("decaid api returns parsed json and logs failures on non-quiet endpoints", async () => {
  const logs = [];
  const { fetchImpl } = mockFetch([
    {
      match: /\/api\/v1\/workflow$/,
      method: "GET",
      respond: () => ({ ok: true, status: 200, json: async () => ({ profile: { title: "X" } }) }),
    },
  ]);
  const api = createDecaidApi({ fetchImpl, log: (m) => logs.push(m) });
  assert.deepEqual(await api.fetchWorkflow(), { profile: { title: "X" } });
  assert.equal(await api.fetchShotRecord("nope"), null);
  assert.match(logs[0], /GET \/api\/v1\/shots\/nope failed: 404/);
});

test("decaid api quiet endpoints fail silently", async () => {
  const logs = [];
  const { fetchImpl } = mockFetch([]);
  const api = createDecaidApi({ fetchImpl, log: (m) => logs.push(m) });
  assert.equal(await api.fetchWorkflow(), null);
  assert.equal(await api.fetchProfiles(), null);
  assert.equal(await api.fetchCollectionCount("/api/v1/shots?limit=1", "espresso"), null);
  assert.deepEqual(logs, []);
});

test("decaid api reads lifetime counts from both response shapes", async () => {
  const logs = [];
  const { fetchImpl } = mockFetch([
    {
      match: /\/api\/v1\/shots\?/,
      method: "GET",
      respond: () => ({ ok: true, status: 200, json: async () => ({ items: [], total: 42 }) }),
    },
    {
      match: /\/api\/v1\/steams\?/,
      method: "GET",
      respond: () => ({ ok: true, status: 200, json: async () => [{ id: "s1" }, { id: "s2" }] }),
    },
    {
      match: /\/api\/v1\/weird\?/,
      method: "GET",
      respond: () => ({ ok: true, status: 200, json: async () => ({ items: [] }) }),
    },
  ]);
  const api = createDecaidApi({ fetchImpl, log: (m) => logs.push(m) });
  assert.equal(await api.fetchCollectionCount("/api/v1/shots?limit=1", "espresso"), 42);
  assert.equal(await api.fetchCollectionCount("/api/v1/steams?limit=1", "steaming"), 2);
  assert.equal(await api.fetchCollectionCount("/api/v1/weird?limit=1", "weird"), null);
  assert.match(logs[0], /weird count: unrecognised response shape/);
});

test("decaid api logs exceptions on non-quiet endpoints", async () => {
  const logs = [];
  const api = createDecaidApi({
    fetchImpl: async () => {
      throw new Error("boom");
    },
    log: (m) => logs.push(m),
  });
  assert.equal(await api.fetchShotRecord("x"), null);
  assert.match(logs[0], /GET \/api\/v1\/shots\/x failed: boom/);
});
