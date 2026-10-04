import { test } from "node:test";
import assert from "node:assert/strict";
import { startE2E, machineSnapshot, waitFor, latestStateDoc, connectConsumer } from "./helpers/fixture.js";
import { startBroker } from "./helpers/broker.js";

function record(id = "curve", state = "espresso") {
  return { id, timestamp: "2026-10-04T08:00:00Z", annotations: { actualYield: 34 },
    workflow: { profile: { title: "Recorded profile" } },
    measurements: [0, 250, 500].map((ms, i) => ({
      machine: { ...machineSnapshot({ state, pressure: i * 3 }),
        timestamp: new Date(Date.parse("2026-10-04T08:00:00Z") + ms).toISOString() },
      scale: { weight: i * 15, weightFlow: 2 },
    })) };
}
const curves = broker => broker.publishes.filter(p => p.topic.endsWith("/shot/last"));
const lastCurve = broker => {
  const last = curves(broker).at(-1);
  return last ? JSON.parse(last.payload) : null;
};

test("startup discovers and retains one curve sensor, available independently of the machine", async () => {
  const env = await startE2E({ settings: { HaAutoDiscoveryEnable: true },
    simSetup: sim => { sim.state.shots = [record()]; } });
  let consumer;
  try {
    await waitFor(() => lastCurve(env.broker));
    const discovery = await waitFor(() => env.broker.publishes.find(p => p.topic.endsWith("_last_shot_curve/config")));
    const config = JSON.parse(discovery.payload);
    assert.equal(config.availability, undefined);
    assert.equal(config.state_topic, config.json_attributes_topic);
    assert.equal(config.value_template, "{{ value_json.shot_id }}");
    assert.equal(curves(env.broker)[0].retain, true);
    assert.equal(curves(env.broker)[0].qos, 1);
    consumer = await connectConsumer(env.broker.port, config.state_topic);
    await waitFor(() => consumer.lastState());
    assert.deepEqual(consumer.lastState().pressure, [0, 3, 6]);
    assert.equal(consumer.lastState().profile, "Recorded profile");
    assert.equal(consumer.lastState().yield_g, 34);
    env.plugin.event("stateUpdate", machineSnapshot());
    await waitFor(() => latestStateDoc(env.broker)?.state === "Idle");
    assert.equal(latestStateDoc(env.broker).time_s, undefined);
    assert.equal(curves(env.broker).length, 1, "live telemetry must not republish large arrays");
  } finally { await consumer?.close(); await env.stop(); }
});

test("only usable espresso records replace curves; new shots and other operations preserve them", async () => {
  const env = await startE2E({ simSetup: sim => { sim.state.shots = [record()]; } });
  try {
    await waitFor(() => lastCurve(env.broker));
    for (const state of ["steam", "hotWater", "flush", "cleaning", "descaling"]) {
      env.plugin.event("stateUpdate", machineSnapshot({ state }));
      env.sim.state.shots.push(record(state, state));
      env.plugin.event("shotStored", { id: state });
      await waitFor(() => latestStateDoc(env.broker)?.shot_id === state);
      assert.equal(lastCurve(env.broker).shot_id, "curve");
    }
    env.plugin.event("stateUpdate", machineSnapshot({ state: "espresso" }));
    await waitFor(() => latestStateDoc(env.broker)?.shot_active === true);
    assert.equal(lastCurve(env.broker).shot_id, "curve");
    assert.equal(curves(env.broker).length, 1);
    env.sim.state.shots.push(record("new"));
    env.plugin.event("shotStored", { id: "new" });
    await waitFor(() => lastCurve(env.broker)?.shot_id === "new");
    env.sim.state.shots.push({ id: "empty", measurements: [] });
    env.plugin.event("shotStored", { id: "empty" });
    await waitFor(() => latestStateDoc(env.broker)?.shot_id === "empty");
    assert.equal(lastCurve(env.broker).shot_id, "new");
  } finally { await env.stop(); }
});

test("MQTT broker restart restores retained curves without requiring a new shot", async () => {
  const env = await startE2E({ simSetup: sim => { sim.state.shots = [record()]; } });
  let restarted;
  try {
    await waitFor(() => lastCurve(env.broker));
    await env.broker.close();
    restarted = await startBroker({ port: env.broker.port });
    await waitFor(() => lastCurve(restarted), 20000);
    assert.equal(lastCurve(restarted).shot_id, "curve");
    assert.equal(curves(restarted)[0].retain, true);
  } finally { await env.stop(); await restarted?.close(); }
});
