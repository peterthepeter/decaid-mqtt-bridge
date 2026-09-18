import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startE2E, machineSnapshot, waitFor, latestStateDoc, sleep } from "./helpers/fixture.js";

let env;

beforeEach(async () => {
  env = await startE2E();
});

afterEach(async () => {
  await env.stop();
});

const ALL_FIELDS = [
  "online", "de1_connected", "scale_connected", "state", "substate",
  "profile", "profile_filename", "espresso_count", "steaming_count",
  "head_temperature", "mix_temperature", "steam_heater_temperature",
  "water_level_mm", "water_level_ml", "wake_state", "steam_mode", "steam_state",
  "shot_active",
];

test("stateUpdate publishes the full de1app-compatible document, QoS 1, retained", async () => {
  const { broker, plugin } = env;
  await waitFor(() => broker.publishes.some((p) => p.topic.endsWith("/state")));

  plugin.event("stateUpdate", machineSnapshot({
    state: "steam",
    substate: "idle",
    groupTemperature: 96.2,
    mixTemperature: 90.3,
    steamTemperature: 148,
  }));

  await waitFor(() => {
    const doc = latestStateDoc(broker);
    return doc && doc.state === "Steam";
  });
  const publish = broker.publishes.filter((p) => p.topic.endsWith("/state")).pop();
  assert.equal(publish.qos, 1);
  assert.equal(publish.retain, true);
  const doc = JSON.parse(publish.payload);
  for (const field of ALL_FIELDS) {
    assert.ok(field in doc, `missing field ${field}`);
  }
  assert.equal(doc.online, true);
  assert.equal(doc.de1_connected, true);
  assert.equal(doc.scale_connected, false);
  assert.equal(doc.state, "Steam");
  assert.equal(doc.substate, "ready");
  assert.equal(doc.head_temperature, 96.2);
  assert.equal(doc.mix_temperature, 90.3);
  assert.equal(doc.steam_heater_temperature, 148);
  assert.equal(doc.water_level_mm, 0.0);
  assert.equal(doc.water_level_ml, 0);
  assert.equal(doc.wake_state, true);
  assert.equal(doc.steam_mode, "Off");
  assert.equal(doc.steam_state, false);
  assert.equal(doc.shot_active, false);
});

test("identical snapshots are not republished; telemetry changes are coalesced", async () => {
  const { broker, plugin } = env;
  await waitFor(() => broker.publishes.some((p) => p.topic.endsWith("/state")));

  plugin.event("stateUpdate", machineSnapshot());
  await waitFor(() => latestStateDoc(broker)?.state === "Idle");
  const afterFirst = statePublishCount(broker);

  plugin.event("stateUpdate", machineSnapshot());
  await sleep(200);
  assert.equal(statePublishCount(broker), afterFirst);

  plugin.event("stateUpdate", machineSnapshot({ groupTemperature: 94.1 }));
  await waitFor(() => statePublishCount(broker) > afterFirst);
  assert.equal(latestStateDoc(broker).head_temperature, 94.1);
});

test("state transitions publish immediately while idle telemetry uses the 5 second cadence", async () => {
  await env.stop();
  env = await startE2E({ settings: { PublishIntervalMs: 60000 } });
  const { broker, plugin } = env;
  await waitFor(() => broker.publishes.some((p) => p.topic.endsWith("/state")));

  plugin.event("stateUpdate", machineSnapshot({ state: "sleeping" }));
  await waitFor(() => latestStateDoc(broker)?.state === "Sleep");
  const beforeWake = statePublishCount(broker);

  plugin.event("stateUpdate", machineSnapshot({ state: "idle", groupTemperature: 70 }));
  await waitFor(() => latestStateDoc(broker)?.state === "Idle");
  assert.equal(statePublishCount(broker), beforeWake + 1, "wake transition must publish immediately");

  const beforeIdleReading = statePublishCount(broker);
  plugin.event("stateUpdate", machineSnapshot({ state: "idle", groupTemperature: 71 }));
  await sleep(500);
  assert.equal(statePublishCount(broker), beforeIdleReading, "idle measurement must not publish at 1 Hz");
  await waitFor(() => latestStateDoc(broker)?.head_temperature === 71, 6000);
});

test("idle heartbeat republishes the state document at the configured interval", async () => {
  const { broker, plugin } = env;
  await waitFor(() => broker.publishes.some((p) => p.topic.endsWith("/state")));
  plugin.event("stateUpdate", machineSnapshot());
  await waitFor(() => latestStateDoc(broker)?.online === true);
  const initialCount = statePublishCount(broker);
  await waitFor(() => statePublishCount(broker) > initialCount + 1, 5000);
  assert.equal(latestStateDoc(broker).online, true);
});

test("water level stream maps mm to the de1app ml lookup table", async () => {
  const { sim, broker, plugin } = env;
  await waitFor(() => broker.publishes.some((p) => p.topic.endsWith("/state")));
  plugin.event("stateUpdate", machineSnapshot());
  await waitFor(() => latestStateDoc(broker)?.online === true);
  sim.sendWaterLevels({ currentLevel: 40.6, refillLevel: 5.0 });
  await waitFor(() => latestStateDoc(broker)?.water_level_mm === 40.6);
  const doc = latestStateDoc(broker);
  assert.equal(doc.water_level_mm, 40.6);
  assert.equal(doc.water_level_ml, 1104);
});

test("water measurements respect idle cadence and remain silent while sleeping", async () => {
  await env.stop();
  env = await startE2E({ settings: { PublishIntervalMs: 60000 } });
  const { sim, broker, plugin } = env;
  await waitFor(() => latestStateDoc(broker)?.online === true);
  plugin.event("stateUpdate", machineSnapshot({ state: "idle" }));
  await waitFor(() => latestStateDoc(broker)?.state === "Idle");
  const before = statePublishCount(broker);
  sim.sendWaterLevels({ currentLevel: 31.2890625, refillLevel: 5 });
  await sleep(1200);
  assert.equal(statePublishCount(broker), before);
  await waitFor(() => latestStateDoc(broker)?.water_level_mm === 31.2890625, 6000);

  plugin.event("stateUpdate", machineSnapshot({ state: "sleeping" }));
  await waitFor(() => latestStateDoc(broker)?.state === "Sleep");
  const asleep = statePublishCount(broker);
  sim.sendWaterLevels({ currentLevel: 32.12345, refillLevel: 5 });
  await sleep(1200);
  assert.equal(statePublishCount(broker), asleep);
  plugin.event("stateUpdate", machineSnapshot({ state: "idle" }));
  await waitFor(() => latestStateDoc(broker)?.state === "Idle");
  assert.equal(latestStateDoc(broker).water_level_mm, 32.12345);
});

test("sleeping and disconnected machines do not publish noisy or repeated stream frames", async () => {
  await env.stop();
  env = await startE2E({ settings: { PublishIntervalMs: 60000, HaAutoDiscoveryEnable: true } });
  const { sim, broker, plugin } = env;
  await waitFor(() => latestStateDoc(broker)?.online === true);
  plugin.event("stateUpdate", machineSnapshot({ state: "sleeping" }));
  await waitFor(() => latestStateDoc(broker)?.de1_connected === true);
  sim.setScaleStatus("connected");
  await waitFor(() => latestStateDoc(broker)?.scale_connected === true);
  plugin.event("stateUpdate", machineSnapshot({ state: "sleeping" }));
  await waitFor(() => latestStateDoc(broker)?.state === "Sleep");

  async function noiseMustBeSilent() {
    const before = broker.publishes.length;
    for (let i = 0; i < 8; i++) {
      sim.sendWaterLevels({ currentLevel: 31 + i / 100, refillLevel: 5 });
      sim.queueScaleSnapshot({ weight: i / 100, batteryLevel: 90, flow: i / 10 });
      sim.sendShotSettings({ ...sim.state.shotSettings });
      sim.sendShotState({ ...sim.state.shotState, timestamp: new Date().toISOString() });
      sim.sendDevices(sim.state.devices);
      await sleep(100);
    }
    await sleep(500);
    assert.equal(broker.publishes.length, before, "no state, discovery or shot event publishes expected");
  }
  await noiseMustBeSilent();
  sim.sendDevices([]);
  await waitFor(() => latestStateDoc(broker)?.de1_connected === false);
  sim.state.devices = [];
  await noiseMustBeSilent();
});

test("workflow REST poll sets profile and resolves the profile filename", async () => {
  const { sim, broker, plugin } = env;
  await waitFor(() => broker.publishes.some((p) => p.topic.endsWith("/state")));
  plugin.event("stateUpdate", machineSnapshot());
  await waitFor(() => latestStateDoc(broker)?.online === true);
  sim.state.profiles = [
    { id: "lb.json", profile: { title: "Long Black" } },
    { id: "ris.json", profile: { title: "Ristretto" } },
  ];
  sim.state.workflow = { id: "wf-1", profile: { title: "Ristretto" } };

  await waitFor(() => latestStateDoc(broker)?.profile === "Ristretto");
  const doc = latestStateDoc(broker);
  assert.equal(doc.profile, "Ristretto");
  assert.equal(doc.profile_filename, "ris.json");
  const fetches = sim.requests.filter((r) => r.path === "/api/v1/profiles");
  assert.equal(fetches.length, 2, "profile library is refreshed once when a new title is observed");
});

test("profile changes are picked up by the heartbeat poll and resolve against a refreshed library", async () => {
  const { sim, broker, plugin } = env;
  await waitFor(() => broker.publishes.some((p) => p.topic.endsWith("/state")));
  plugin.event("stateUpdate", machineSnapshot());
  await waitFor(() => latestStateDoc(broker)?.online === true);
  sim.state.profiles = [{ id: "lb.json", profile: { title: "Long Black" } }];
  sim.state.workflow = { profile: { title: "Long Black" } };
  await waitFor(() => latestStateDoc(broker)?.profile === "Long Black");

  sim.state.workflow = { profile: { title: "Ristretto" } };
  sim.state.profiles = [...sim.state.profiles, { id: "ris.json", profile: { title: "Ristretto" } }];
  await waitFor(() => latestStateDoc(broker)?.profile === "Ristretto");
  assert.equal(latestStateDoc(broker).profile_filename, "ris.json");
});

test("unknown internal state enum names are published verbatim", async () => {
  const { broker, plugin } = env;
  await waitFor(() => broker.publishes.some((p) => p.topic.endsWith("/state")));
  plugin.event("stateUpdate", machineSnapshot({ state: "futureState", substate: "futureSubstate" }));
  await waitFor(() => latestStateDoc(broker)?.state === "futureState");
  assert.equal(latestStateDoc(broker).substate, "futureSubstate");
});

function statePublishCount(broker) {
  return broker.publishes.filter((p) => p.topic.endsWith("/state")).length;
}
