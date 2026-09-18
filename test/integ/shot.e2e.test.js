import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startE2E, machineSnapshot, shotRecord, waitFor, latestStateDoc, sleep } from "./helpers/fixture.js";

let env;

beforeEach(async () => {
  env = await startE2E();
});

afterEach(async () => {
  await env.stop();
});

test("shot lifecycle: activation cadence, live weight, completion record", async () => {
  const { sim, broker, plugin } = env;
  await waitFor(() => broker.publishes.some((p) => p.topic.endsWith("/state")));

  // A real shot reports the Espresso state throughout, preinfusion included.
  plugin.event("stateUpdate", machineSnapshot({ state: "espresso", substate: "preinfusion" }));
  await waitFor(() => latestStateDoc(broker)?.shot_active === true);

  sim.setScaleStatus("connected");
  const before = statePublishCount(broker);
  sim.queueScaleSnapshot({ timestamp: new Date().toISOString(), weight: 3.2, batteryLevel: 90, timerValue: 1200, flow: 2.2 });
  await waitFor(() => latestStateDoc(broker)?.shot_weight_g === 3.2);

  sim.queueScaleSnapshot({ timestamp: new Date().toISOString(), weight: 8.7, batteryLevel: 90, timerValue: 4000, flow: 2.0 });
  await waitFor(() => latestStateDoc(broker)?.shot_weight_g === 8.7);

  const duringShot = statePublishCount(broker) - before;
  await sleep(2100);
  const withHeartbeat = statePublishCount(broker) - before;
  assert.ok(withHeartbeat >= duringShot + 1, `expected 1s cadence during shot, got ${withHeartbeat} publishes`);

  plugin.event("stateUpdate", machineSnapshot({ state: "idle", substate: "idle" }));
  await waitFor(() => latestStateDoc(broker)?.shot_active === false);

  sim.state.shots = [shotRecord("shot-123")];
  plugin.event("shotStored", { id: "shot-123" });
  await waitFor(() => latestStateDoc(broker)?.shot_id === "shot-123");
  const doc = latestStateDoc(broker);
  assert.equal(doc.shot_id, "shot-123");
  assert.equal(doc.shot_started_at, "2026-09-09T07:15:00.000Z");
  assert.equal(doc.shot_duration_s, 28.4);
  assert.equal(doc.shot_weight_g, 18.5);
  assert.equal(doc.shot_active, false);

  const fetches = sim.requests.filter((r) => r.path === "/api/v1/shots/shot-123");
  assert.equal(fetches.length, 1);
});

test("final shot message publishes the settled yield, not the last scale sample", async () => {
  const { sim, broker, plugin } = env;
  await waitFor(() => broker.publishes.some((p) => p.topic.endsWith("/state")));
  plugin.event("stateUpdate", machineSnapshot());
  await waitFor(() => latestStateDoc(broker)?.de1_connected === true);

  // The measurement series stops at flow-stop while coffee is still dripping,
  // so its last sample reads low. Decaid records the settled figure on the shot.
  sim.state.shots = [shotRecord("shot-yield", { weight: 26.3, actualYield: 33.6 })];
  plugin.event("shotStored", { id: "shot-yield" });

  await waitFor(() => latestStateDoc(broker)?.shot_id === "shot-yield");
  assert.equal(latestStateDoc(broker).shot_weight_g, 33.6);
});

test("final shot message falls back to the last sample when no yield was recorded", async () => {
  const { sim, broker, plugin } = env;
  await waitFor(() => broker.publishes.some((p) => p.topic.endsWith("/state")));
  plugin.event("stateUpdate", machineSnapshot());
  await waitFor(() => latestStateDoc(broker)?.de1_connected === true);

  sim.state.shots = [shotRecord("shot-noyield", { weight: 21.4 })];
  plugin.event("shotStored", { id: "shot-noyield" });

  await waitFor(() => latestStateDoc(broker)?.shot_id === "shot-noyield");
  assert.equal(latestStateDoc(broker).shot_weight_g, 21.4);
  await plugin.waitForLog(/has no actualYield/);
});

test("espresso count reads the total from a paginated shots response", async () => {
  const { sim, broker, plugin } = env;
  await waitFor(() => broker.publishes.some((p) => p.topic.endsWith("/state")));
  plugin.event("stateUpdate", machineSnapshot());
  await waitFor(() => latestStateDoc(broker)?.de1_connected === true);

  // Newer Decaid builds paginate this list, so the lifetime figure is `total`
  // and the array length is just the page size.
  sim.state.shotsList = { items: [{ id: "s1" }], total: 492, limit: 1, offset: 0 };
  sim.state.steams = { items: [], total: 7, limit: 1, offset: 0 };
  sim.state.shots = [shotRecord("s1")];
  plugin.event("shotStored", { id: "s1" });

  await waitFor(() => latestStateDoc(broker)?.espresso_count === 492);
  assert.equal(latestStateDoc(broker).steaming_count, 7);
});

test("steaming after a shot does not reopen it or wipe the yield", async () => {
  const { sim, broker, plugin } = env;
  await waitFor(() => broker.publishes.some((p) => p.topic.endsWith("/state")));

  // Pull a shot and let it finish with a recorded yield.
  plugin.event("stateUpdate", machineSnapshot({ state: "espresso", substate: "pouring" }));
  await waitFor(() => latestStateDoc(broker)?.shot_active === true);
  plugin.event("stateUpdate", machineSnapshot({ state: "idle", substate: "idle" }));
  sim.state.shots = [shotRecord("shot-steam", { weight: 26.3, actualYield: 34.7 })];
  plugin.event("shotStored", { id: "shot-steam" });
  await waitFor(() => latestStateDoc(broker)?.shot_weight_g === 34.7);

  // Cup comes off the scale, then the user steams. Steam reports its own
  // `pouring` substate, which used to read as a new shot and replace the yield.
  sim.setScaleStatus("connected");
  sim.queueScaleSnapshot({ timestamp: new Date().toISOString(), weight: 0.2, batteryLevel: 90, timerValue: 0, flow: 0 });
  plugin.event("stateUpdate", machineSnapshot({ state: "steam", substate: "pouring" }));
  await waitFor(() => latestStateDoc(broker)?.state === "Steam");
  await sleep(1500);

  const doc = latestStateDoc(broker);
  assert.equal(doc.state, "Steam");
  assert.equal(doc.shot_active, false, "steaming must not read as a shot");
  assert.equal(doc.shot_id, "shot-steam", "the finished shot must survive steaming");
  assert.equal(doc.shot_weight_g, 34.7, "the settled yield must not be replaced by the live scale");
});

test("shotStored failure keeps the document publishable", async () => {
  const { sim, broker, plugin } = env;
  await waitFor(() => broker.publishes.some((p) => p.topic.endsWith("/state")));
  sim.state.shots = [];
  plugin.event("shotStored", { id: "missing" });
  await plugin.waitForLog(/\/api\/v1\/shots\/missing failed/);
  plugin.event("stateUpdate", machineSnapshot({ groupTemperature: 91.0 }));
  await waitFor(() => latestStateDoc(broker)?.head_temperature === 91.0);
  assert.equal(latestStateDoc(broker).online, true);
});

test("scale disconnect marks scale_connected false without blocking publishing", async () => {
  const { sim, broker, plugin } = env;
  await waitFor(() => broker.publishes.some((p) => p.topic.endsWith("/state")));
  plugin.event("stateUpdate", machineSnapshot());
  await waitFor(() => latestStateDoc(broker)?.online === true);
  sim.setScaleStatus("connected");
  await waitFor(() => latestStateDoc(broker)?.scale_connected === true);
  sim.setScaleStatus("disconnected");
  await waitFor(() => latestStateDoc(broker)?.scale_connected === false);
  plugin.event("stateUpdate", machineSnapshot({ groupTemperature: 90.0 }));
  await waitFor(() => latestStateDoc(broker)?.head_temperature === 90.0);
});

function statePublishCount(broker) {
  return broker.publishes.filter((p) => p.topic.endsWith("/state")).length;
}
