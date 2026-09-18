import mqtt from "mqtt";
import { createDecaidSim } from "./decaid-sim.js";
import { startBroker, waitFor } from "./broker.js";
import { loadMqttPlugin } from "./plugin-runner.js";

export async function startE2E({ settings = {}, authenticate, seedStore, port, simSetup, maxProtocolVersion } = {}) {
  const sim = createDecaidSim();
  const simPort = await sim.start();
  simSetup?.(sim);
  const broker = await startBroker({ authenticate, port, maxProtocolVersion });

  const plugin = await loadMqttPlugin({
    sim: { port: simPort },
    settings: {
      Host: "127.0.0.1",
      Port: broker.port,
      EnableTls: false,
      PublishIntervalMs: 1000,
      ...settings,
    },
    seedStore,
  });

  async function stop() {
    await plugin.unload();
    await broker.close();
    await sim.stop();
  }

  return { sim, simPort, broker, plugin, stop };
}

export async function connectConsumer(brokerPort, topic) {
  const client = mqtt.connect(`mqtt://127.0.0.1:${brokerPort}`, { clean: true });
  await new Promise((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });
  const messages = [];
  client.on("message", (topic_, payload) => {
    messages.push({ topic: topic_, payload: payload.toString("utf8") });
  });
  await new Promise((resolve) => {
    client.subscribe(topic, { qos: 1 }, resolve);
  });
  return {
    client,
    messages,
    lastState: () => {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].topic === topic) return JSON.parse(messages[i].payload);
      }
      return null;
    },
    close: () => new Promise((resolve) => client.end(true, {}, resolve)),
  };
}

export function machineSnapshot(overrides = {}) {
  const {
    state = "idle",
    substate = "idle",
    groupTemperature = 93.5,
    mixTemperature = 88.1,
    steamTemperature = 4,
    pressure = 9.2,
    flow = 2.1,
  } = overrides;
  return {
    timestamp: new Date().toISOString(),
    state: { state, substate },
    flow,
    pressure,
    targetFlow: 2.0,
    targetPressure: 9.0,
    mixTemperature,
    groupTemperature,
    targetMixTemperature: 93.0,
    targetGroupTemperature: 94.0,
    profileFrame: {},
    steamTemperature,
  };
}

export function shotRecord(id, { weight = 18.5, durationMs = 28400, actualYield } = {}) {
  const start = "2026-09-09T07:15:00.000Z";
  const end = new Date(new Date(start).getTime() + durationMs).toISOString();
  return {
    id,
    timestamp: start,
    ...(actualYield === undefined ? {} : { annotations: { actualDoseWeight: 18.0, actualYield } }),
    measurements: [
      { machine: { timestamp: start, state: { state: "espresso", substate: "pouring" } }, scale: null },
      {
        machine: { timestamp: end, state: { state: "idle", substate: "idle" } },
        scale: { timestamp: end, weight, batteryLevel: 87, timerValue: durationMs, flow: 1.8 },
      },
    ],
  };
}

export { waitFor, sleep } from "./broker.js";

export function latestStateDoc(broker) {
  const msgs = broker.publishes.filter((p) => p.topic.endsWith("/state"));
  if (msgs.length === 0) return null;
  return JSON.parse(msgs[msgs.length - 1].payload);
}
