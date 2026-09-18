import { test } from "node:test";
import assert from "node:assert/strict";
import { startE2E, connectConsumer, waitFor, latestStateDoc, sleep, machineSnapshot } from "./helpers/fixture.js";
import { startBroker } from "./helpers/broker.js";
import { loadMqttPlugin } from "./helpers/plugin-runner.js";

async function findClosedPort() {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

test("broker unreachable at load: connection errors are logged and retries continue", async () => {
  const deadPort = await findClosedPort();
  const plugin = await loadMqttPlugin({
    sim: { port: 1 },
    settings: {
      Host: "127.0.0.1",
      Port: deadPort,
      EnableTls: false,
      PublishIntervalMs: 1000,
    },
  });
  try {
    await sleep(5500);
    const errors = plugin.logs.filter((l) => l.includes("broker error"));
    assert.ok(errors.length >= 2, `expected repeated connection failures, logs: ${plugin.logs.join(" | ")}`);
  } finally {
    await plugin.unload();
  }
});

test("broker restart mid-session: plugin reconnects and republishes live state", async () => {
  const env = await startE2E();
  const { broker, plugin, sim } = env;
  let restarted = null;
  try {
    await waitFor(() => broker.connections.length > 0);
    const brokerPort = broker.port;

    await broker.close();
    restarted = await startBroker({ port: brokerPort });
    assert.equal(restarted.port, brokerPort);

    await waitFor(() => restarted.connections.length > 0, 20000);
    plugin.event("stateUpdate", machineSnapshot());
    await waitFor(() => latestStateDoc(restarted)?.online === true
      && latestStateDoc(restarted)?.de1_connected === true, 10000);
    assert.equal(latestStateDoc(restarted).de1_connected, true);
  } finally {
    await plugin.unload();
    await restarted?.close();
    await broker.close();
    await sim.stop();
  }
});

test("abnormal client death triggers the last will offline document", async () => {
  const env = await startE2E();
  const { broker, plugin } = env;
  try {
    await waitFor(() => broker.connections.length > 0);
    const prefix = broker.connections[0].id.replace("de1plus_", "de1plus/");
    plugin.event("stateUpdate", machineSnapshot());
    await waitFor(() => latestStateDoc(broker)?.online === true);

    const consumer = await connectConsumer(broker.port, `${prefix}/state`);
    const killed = broker.crashClient(broker.connections[0].id);
    assert.equal(killed, true);

    await waitFor(() => {
      const docs = consumer.messages
        .filter((m) => m.topic === `${prefix}/state`)
        .map((m) => JSON.parse(m.payload));
      return docs.some((d) => d.online === false);
    }, 10000);
    const last = consumer.messages.filter((m) => m.topic === `${prefix}/state`).pop();
    assert.deepEqual(JSON.parse(last.payload), { online: false, de1_connected: false });
    await consumer.close();
  } finally {
    await plugin.unload();
    await broker.close();
    await env.sim.stop();
  }
});

test("unload closes transports, publishes the offline document and stops publishing", async () => {
  const env = await startE2E();
  const { broker, plugin, sim } = env;
  try {
    await waitFor(() => broker.connections.length > 0);
    const prefix = broker.connections[0].id.replace("de1plus_", "de1plus/");
    plugin.event("stateUpdate", machineSnapshot());
    await waitFor(() => latestStateDoc(broker)?.online === true);

    await plugin.unload();
    await waitFor(() => plugin.shim.liveTransportCount() === 0);
    await waitFor(() => {
      const last = broker.publishes.filter((p) => p.topic === `${prefix}/state`).pop();
      return last && JSON.parse(last.payload).online === false;
    }, 5000);
    const lastState = broker.publishes.filter((p) => p.topic === `${prefix}/state`).pop();
    assert.deepEqual(JSON.parse(lastState.payload), { online: false, de1_connected: false });
    const offlineCount = broker.publishes.filter((p) => p.topic === `${prefix}/state`).length;
    await sleep(1500);
    assert.equal(broker.publishes.filter((p) => p.topic === `${prefix}/state`).length, offlineCount);
  } finally {
    await plugin.unload();
    await broker.close();
    await sim.stop();
  }
});

test("broker rejecting MQTT 5 falls back to MQTT 3.1.1", async () => {
  const env = await startE2E({ maxProtocolVersion: 4 });
  const { broker, plugin } = env;
  try {
    await waitFor(() => broker.connections.some((c) => c.version === 4), 10000);
    assert.equal(broker.connections[0].version, 4, "rejection must not register a v5 session");
    await waitFor(() => broker.publishes.some((p) => p.topic.endsWith("/state")), 5000);
    assert.ok(plugin.logs.some((l) => l.includes("retrying with MQTT 3.1.1")));
  } finally {
    await plugin.unload();
    await broker.close();
    await env.sim.stop();
  }
});

test("EnableTls opens a tls-kind transport", async () => {
  const env = await startE2E({ settings: { EnableTls: true } });
  const { broker, plugin } = env;
  try {
    await sleep(1500);
    const tlsOpens = plugin.shim.openCalls.filter((o) => o.kind === "tls");
    assert.ok(tlsOpens.length > 0, "expected tls transport attempts");
    assert.ok(tlsOpens.every((o) => o.port === broker.port && o.host === "127.0.0.1"));
    assert.equal(broker.connections.length, 0, "plain broker cannot complete a TLS handshake");
  } finally {
    await plugin.unload();
    await broker.close();
    await env.sim.stop();
  }
});

test("wrong broker credentials are rejected and retried", async () => {
  const env = await startE2E({
    authenticate: ({ username, password }) => username === "user" && password === "good",
    settings: { Username: "user", Password: "bad" },
  });
  const { broker, plugin } = env;
  try {
    await sleep(2500);
    assert.equal(broker.connections.length, 0);
    assert.equal(broker.publishes.filter((p) => p.topic.endsWith("/state")).length, 0);
    await plugin.waitForLog(/broker error/, 5000);
    assert.equal(plugin.logs.some((line) => line.includes("MQTT connection verified")), false);
  } finally {
    await plugin.unload();
    await broker.close();
    await env.sim.stop();
  }
});

test("correct broker credentials connect and publish", async () => {
  const env = await startE2E({
    authenticate: ({ username, password }) => username === "user" && password === "good",
    settings: { Username: "user", Password: "good" },
  });
  const { broker, plugin } = env;
  try {
    await waitFor(() => broker.connections.length > 0);
    assert.equal(broker.connections[0].username, "user");
    await waitFor(() => broker.publishes.some((p) => p.topic.endsWith("/state")), 5000);
    await plugin.waitForLog(/MQTT connection verified: MQTT 5 over TCP, credentials accepted, command subscription and QoS 1 publish successful/);
  } finally {
    await plugin.unload();
    await broker.close();
    await env.sim.stop();
  }
});
