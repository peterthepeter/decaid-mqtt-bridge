import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import mqtt from "mqtt";
import { startE2E, machineSnapshot, waitFor, latestStateDoc, sleep } from "./helpers/fixture.js";

let env;

beforeEach(async () => {
  env = await startE2E();
});

afterEach(async () => {
  await env.stop();
});

async function sendCommand(broker, command) {
  const sender = mqtt.connect(`mqtt://127.0.0.1:${broker.port}`, { clean: true });
  await new Promise((resolve, reject) => {
    sender.once("connect", resolve);
    sender.once("error", reject);
  });
  await new Promise((resolve, reject) => {
    sender.publish(commandTopic(broker), command, { qos: 1 }, (e) => (e ? reject(e) : resolve()));
  });
  await new Promise((resolve) => sender.end(true, {}, resolve));
}

function commandTopic(broker) {
  return `${broker.connections[0].id.replace("de1plus_", "de1plus/")}/command`;
}

test("wake command wakes a sleeping machine through the safe idle state", async () => {
  const { broker, sim, plugin } = env;
  plugin.event("stateUpdate", machineSnapshot({ state: "sleeping" }));
  await waitFor(() => latestStateDoc(broker)?.state === "Sleep");
  await sendCommand(broker, "wake");
  await waitFor(() => sim.requests.some((r) => r.method === "PUT" && r.path === "/api/v1/machine/state/idle"));
});

test("sleep command only acts from Idle", async () => {
  const { broker, sim, plugin } = env;
  await waitFor(() => broker.publishes.some((p) => p.topic.endsWith("/state")));
  plugin.event("stateUpdate", machineSnapshot({ state: "espresso", substate: "pouring" }));
  await waitFor(() => latestStateDoc(broker)?.state === "Espresso");

  await sendCommand(broker, "sleep");
  await sleep(300);
  assert.equal(sim.requests.some((r) => r.path === "/api/v1/machine/state/sleeping"), false);
  await plugin.waitForLog(/command sleep not applied: machine in use/);

  plugin.event("stateUpdate", machineSnapshot({ state: "idle", substate: "idle" }));
  await waitFor(() => latestStateDoc(broker)?.state === "Idle");
  await sendCommand(broker, "sleep");
  await waitFor(() => sim.requests.some((r) => r.method === "PUT" && r.path === "/api/v1/machine/state/sleeping"));
});

test("steam_on enables the heater and wakes without starting a steam operation", async () => {
  const { broker, sim, plugin } = env;
  sim.state.workflow.steamSettings.targetTemperature = 0;
  await waitFor(() => broker.publishes.some((p) => p.topic.endsWith("/state")));
  plugin.event("stateUpdate", machineSnapshot({ state: "sleeping", substate: "idle" }));
  await waitFor(() => latestStateDoc(broker)?.state === "Sleep"
    && latestStateDoc(broker)?.target_steam_temperature === 0);

  await sendCommand(broker, "steam_on");
  await waitFor(() => {
    return sim.requests.some((r) => r.method === "PUT" && r.path === "/api/v1/workflow")
      && sim.requests.some((r) => r.method === "PUT" && r.path === "/api/v1/machine/state/idle");
  });
  const put = sim.requests.find((r) => r.method === "PUT" && r.path === "/api/v1/workflow");
  assert.deepEqual(JSON.parse(put.body), { steamSettings: { targetTemperature: 145 } });
  assert.equal(sim.requests.some((r) => r.path === "/api/v1/machine/state/steam"), false);
});

test("steam_off stops active steam and disables its heater setting", async () => {
  const { broker, sim, plugin } = env;
  sim.sendShotSettings({ ...sim.state.shotSettings, targetSteamTemp: 145 });
  plugin.event("stateUpdate", machineSnapshot({ state: "steam" }));
  await waitFor(() => latestStateDoc(broker)?.state === "Steam"
    && latestStateDoc(broker)?.target_steam_temperature === 145);
  await sendCommand(broker, "steam_off");
  await waitFor(() => sim.requests.some((r) => r.method === "PUT" && r.path === "/api/v1/workflow"));
  assert.ok(sim.requests.some((r) => r.method === "PUT" && r.path === "/api/v1/machine/state/idle"));
  const put = sim.requests.find((r) => r.method === "PUT" && r.path === "/api/v1/workflow");
  assert.deepEqual(JSON.parse(put.body), { steamSettings: { targetTemperature: 0 } });
  assert.equal(sim.state.store["streamline-app/last-steam-temp"], 145);
});

test("operation commands start from idle and stop active beverage operations", async () => {
  const { broker, sim, plugin } = env;
  plugin.event("stateUpdate", machineSnapshot({ state: "idle", substate: "idle" }));
  await waitFor(() => latestStateDoc(broker)?.state === "Idle");

  for (const [command, state] of [
    ["espresso_start", "espresso"],
    ["steam_start", "steam"],
    ["hot_water_start", "hotWater"],
    ["flush_start", "flush"],
  ]) {
    await sendCommand(broker, command);
    await waitFor(() => sim.requests.some((r) => r.method === "PUT" && r.path === `/api/v1/machine/state/${state}`));
  }

  plugin.event("stateUpdate", machineSnapshot({ state: "espresso", substate: "pouring" }));
  await waitFor(() => latestStateDoc(broker)?.state === "Espresso");
  await sendCommand(broker, "stop");
  await waitFor(() => sim.requests.some((r) => r.method === "PUT" && r.path === "/api/v1/machine/state/idle"));
});

test("operation commands reject sleeping, busy, unsafe, and disconnected states", async () => {
  const { broker, sim, plugin } = env;

  plugin.event("stateUpdate", machineSnapshot({ state: "sleeping" }));
  await waitFor(() => latestStateDoc(broker)?.state === "Sleep");
  await sendCommand(broker, "espresso_start");
  await plugin.waitForLog(/command espresso_start not applied: machine sleeping/);

  plugin.event("stateUpdate", machineSnapshot({ state: "steam" }));
  await waitFor(() => latestStateDoc(broker)?.state === "Steam");
  await sendCommand(broker, "espresso_start");
  await plugin.waitForLog(/command espresso_start not applied: machine not ready/);

  plugin.event("stateUpdate", machineSnapshot({ state: "cleaning" }));
  await waitFor(() => latestStateDoc(broker)?.state === "Clean");
  await sendCommand(broker, "stop");
  await plugin.waitForLog(/command stop not applied: machine state cleaning is not safe/);

  sim.sendDevices([{ type: "machine", state: "disconnected" }]);
  await waitFor(() => latestStateDoc(broker)?.de1_connected === false);
  await sendCommand(broker, "steam_start");
  await plugin.waitForLog(/command steam_start not applied: machine disconnected/);

  assert.equal(sim.requests.some((r) => [
    "/api/v1/machine/state/espresso",
    "/api/v1/machine/state/steam",
    "/api/v1/machine/state/idle",
  ].includes(r.path)), false);
});

test("profile command selects by title and posts the profile body", async () => {
  const { broker, sim, plugin } = env;
  plugin.event("stateUpdate", machineSnapshot());
  await waitFor(() => latestStateDoc(broker)?.state === "Idle");
  sim.state.profiles = [
    { id: "lb.json", profile: { title: "Long Black", steps: [] } },
  ];
  await sendCommand(broker, "profile Long Black");
  await waitFor(() => sim.requests.some((r) => r.method === "POST" && r.path === "/api/v1/machine/profile"));
  const post = sim.requests.find((r) => r.method === "POST" && r.path === "/api/v1/machine/profile");
  assert.deepEqual(JSON.parse(post.body), { title: "Long Black", steps: [] });
});

test("profile_filename command selects by record id", async () => {
  const { broker, sim, plugin } = env;
  plugin.event("stateUpdate", machineSnapshot());
  await waitFor(() => latestStateDoc(broker)?.state === "Idle");
  sim.state.profiles = [{ id: "ris.json", profile: { title: "Ristretto" } }];
  await sendCommand(broker, "profile_filename ris.json");
  await waitFor(() => sim.requests.some((r) => r.method === "POST" && r.path === "/api/v1/machine/profile"));
  const post = sim.requests.find((r) => r.method === "POST" && r.path === "/api/v1/machine/profile");
  assert.deepEqual(JSON.parse(post.body), { title: "Ristretto" });
});

test("unknown commands are ignored, missing profiles are rejected", async () => {
  const { broker, sim, plugin } = env;
  plugin.event("stateUpdate", machineSnapshot());
  await waitFor(() => latestStateDoc(broker)?.state === "Idle");
  sim.state.profiles = [];
  await sendCommand(broker, "explode");
  await sendCommand(broker, "profile Does Not Exist");
  await sleep(400);
  assert.equal(sim.requests.some((r) => r.method === "POST"), false);
  assert.equal(sim.requests.some((r) => r.method === "PUT"), false);
  assert.ok(plugin.logs.some((l) => l.includes("ignoring unknown MQTT command: explode")));
  await plugin.waitForLog(/command profile not applied/);
});
