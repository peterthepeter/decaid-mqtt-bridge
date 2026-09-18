import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startE2E, connectConsumer, waitFor, sleep, latestStateDoc, machineSnapshot } from "./helpers/fixture.js";

let env;

beforeEach(async () => {
  env = await startE2E({
    simSetup: (sim) => {
      sim.state.shots = [
        { id: "s1", timestamp: "2026-09-09T07:00:00.000Z", measurements: [] },
        { id: "s2", timestamp: "2026-09-09T07:05:00.000Z", measurements: [] },
      ];
      sim.state.steams = [{ id: "st1", timestamp: "2026-09-09T07:06:00.000Z" }];
    },
  });
});

afterEach(async () => {
  await env.stop();
});

test("plugin connects with de1app-compatible client identity, will and command subscription", async () => {
  const { broker } = env;
  await waitFor(() => broker.connections.length > 0);
  const conn = broker.connections[0];
  const prefix = conn.id.replace("de1plus_", "de1plus/");
  assert.match(conn.id, /^de1plus_[0-9a-f]{8}$/);
  assert.equal(conn.clean, true);
  assert.equal(conn.version, 5);
  assert.equal(conn.username, null);
  assert.equal(conn.keepaliveS, 4);
  assert.deepEqual(conn.will, {
    topic: `${prefix}/state`,
    payload: JSON.stringify({ online: false, de1_connected: false }),
    qos: 1,
    retain: true,
  });
  await waitFor(() => broker.subscriptions.length > 0);
  assert.deepEqual(broker.subscriptions, [
    { topic: `${prefix}/command`, qos: 1, clientId: conn.id },
  ]);
});

test("plugin persists the generated unique id across reloads", async () => {
  const { broker, plugin } = env;
  await waitFor(() => broker.connections.length > 0);
  const uniqueId = plugin.shim.store.get("uniqueId");
  assert.match(uniqueId, /^[0-9a-f]{8}$/);
  await env.stop();

  const second = await startE2E({ seedStore: { uniqueId } });
  try {
    await waitFor(() => second.broker.connections.length > 0);
    assert.equal(second.broker.connections[0].id, `de1plus_${uniqueId}`);
    assert.equal(second.broker.connections[0].will.topic, `de1plus/${uniqueId}/state`);
  } finally {
    await second.stop();
  }
});

test("empty broker host keeps the integration disabled", async () => {
  await env.stop();
  const disabled = await startE2E({ settings: { Host: "" } });
  try {
    await sleep(300);
    assert.equal(disabled.broker.connections.length, 0);
    assert.equal(disabled.plugin.shim.liveTransportCount(), 0);
    assert.ok(disabled.plugin.logs.some((l) => l.includes("disabled")));
  } finally {
    await disabled.stop();
  }
});

test("consumer receives the initial retained state document on subscribe", async () => {
  const { broker } = env;
  await waitFor(() => broker.publishes.some((p) => p.topic.endsWith("/state")));
  const conn = broker.connections[0];
  const prefix = conn.id.replace("de1plus_", "de1plus/");
  const consumer = await connectConsumer(broker.port, `${prefix}/state`);
  try {
    await waitFor(() => consumer.messages.some((m) => m.topic === `${prefix}/state`));
    const retained = consumer.messages.filter((m) => m.topic === `${prefix}/state`);
    assert.ok(retained.length >= 1);
    const doc = JSON.parse(retained[retained.length - 1].payload);
    assert.deepEqual(doc, { online: true, de1_connected: false, tablet_battery_percent: 77 });
  } finally {
    await consumer.close();
  }
});

test("counts refresh from shot and steam history on connect", async () => {
  const { broker, plugin } = env;
  await waitFor(() => broker.publishes.some((p) => p.topic.endsWith("/state")));
  plugin.event("stateUpdate", machineSnapshot());
  await waitFor(() => {
    const doc = latestStateDoc(broker);
    return doc && doc.espresso_count === 2 && doc.steaming_count === 1;
  });
  assert.equal(latestStateDoc(broker).espresso_count, 2);
  assert.equal(latestStateDoc(broker).steaming_count, 1);
});
