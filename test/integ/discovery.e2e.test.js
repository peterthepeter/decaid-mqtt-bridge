import { test } from "node:test";
import assert from "node:assert/strict";
import { startE2E, waitFor } from "./helpers/fixture.js";

test("Home Assistant discovery publishes one retained device with stable entities", async () => {
  const env = await startE2E({
    settings: { HaAutoDiscoveryEnable: true },
    seedStore: { uniqueId: "abc12345" },
    simSetup: (sim) => {
      sim.state.profiles = [
        { id: "medium.json", profile: { title: "Medium" } },
        { id: "lever.json", profile: { title: "Lever" } },
      ];
      sim.state.workflow.profile = { title: "Medium" };
    },
  });
  try {
    const discovery = await waitFor(() => {
      const messages = env.broker.publishes.filter((p) => p.topic.startsWith("homeassistant/"));
      return messages.length >= 40 ? messages : null;
    });
    assert.ok(discovery.every((message) => message.qos === 1 && message.retain === true));

    const payloads = discovery.map((message) => JSON.parse(message.payload));
    assert.ok(payloads.every((payload) => payload.device.identifiers[0] === "abc12345"));
    assert.equal(new Set(payloads.map((payload) => payload.unique_id)).size, payloads.length);
    assert.ok(discovery.some((message) => message.topic === "homeassistant/sensor/de1plus_abc12345_pressure/config"));

    const profile = payloads.find((payload) => payload.unique_id === "de1plus_abc12345_profile_select");
    assert.deepEqual(profile.options, ["Medium", "Lever"]);
    assert.equal(profile.command_template, "profile {{ value }}");
    const operationButtons = payloads.filter((payload) => [
      "espresso_start", "steam_start", "hot_water_start", "flush_start", "stop",
    ].some((key) => payload.unique_id === `de1plus_abc12345_${key}`));
    assert.equal(operationButtons.length, 5);
    assert.ok(operationButtons.every((payload) => payload.command_topic === "de1plus/abc12345/command"));
  } finally {
    await env.stop();
  }
});

test("GHC machines publish guarded virtual operation buttons", async () => {
  const env = await startE2E({
    settings: { HaAutoDiscoveryEnable: true },
    seedStore: { uniqueId: "ghc12345" },
    simSetup: (sim) => { sim.state.machineInfo.GHC = true; },
  });
  try {
    await waitFor(() => env.broker.publishes.some((p) => p.topic.endsWith("_steam_switch/config")));
    const operationKeys = ["espresso_start", "steam_start", "hot_water_start", "flush_start", "stop"];
    assert.ok(operationKeys.every((key) => env.broker.publishes.some((message) =>
      message.topic.endsWith(`_${key}/config`) && message.payload !== "",
    )));
  } finally {
    await env.stop();
  }
});

test("disabling discovery retracts all retained topics remembered from the previous run", async () => {
  const oldTopics = [
    "homeassistant/sensor/de1plus_abc12345_pressure/config",
    "homeassistant/switch/de1plus_abc12345_switch/config",
  ];
  const env = await startE2E({
    settings: { HaAutoDiscoveryEnable: false },
    seedStore: { uniqueId: "abc12345", haDiscoveryTopics: oldTopics },
  });
  try {
    await waitFor(() => oldTopics.every((topic) => env.broker.publishes.some(
      (message) => message.topic === topic && message.payload === "" && message.retain === true,
    )));
    assert.deepEqual([...env.plugin.shim.store.get("haDiscoveryTopics")], []);
  } finally {
    await env.stop();
  }
});

test("shot event discovery ignores the reconnect replay and publishes live events without retain", async () => {
  const env = await startE2E({
    settings: { HaAutoDiscoveryEnable: true },
    seedStore: { uniqueId: "abc12345" },
  });
  try {
    const eventTopic = "de1plus/abc12345/event/shot";
    await waitFor(() => env.broker.publishes.some((p) => p.topic.includes("/event/") && p.topic.endsWith("/config")));
    await waitFor(() => env.sim.shotStateConnectionCount() === 1);
    assert.equal(env.broker.publishes.some((message) => message.topic === eventTopic), false);

    env.sim.sendShotState({ event: "state", shotId: "shot-1", state: "preheating",
      timestamp: "2026-09-09T07:00:00.000Z", scaleLost: false });

    env.sim.sendShotState({
      event: "decision",
      shotId: "shot-1",
      state: "pouring",
      timestamp: "2026-09-09T07:00:01.000Z",
      scaleConnected: true,
      scaleLost: false,
      machineHasAutonomousSAW: false,
      decision: { kind: "stop", reason: "targetWeight" },
    });
    env.sim.sendShotState({ event: "state", shotId: "shot-1", state: "finished",
      timestamp: "2026-09-09T07:00:02.000Z", scaleLost: false });
    const message = await waitFor(() => env.broker.publishes.find((p) => p.topic === eventTopic && JSON.parse(p.payload).event_type === "Bezug beendet"));
    assert.equal(message.qos, 1);
    assert.equal(message.retain, false);
    assert.deepEqual(JSON.parse(message.payload), {
      event_type: "Bezug beendet",
      shot_id: "shot-1",
      phase: "finished",
      source_timestamp: "2026-09-09T07:00:02.000Z",
      scale_lost: false,
      stop_reason: "targetWeight",
      decision: { kind: "stop", reason: "targetWeight" },
    });
    assert.deepEqual(env.broker.publishes.filter((p) => p.topic === eventTopic)
      .map((p) => JSON.parse(p.payload).event_type), ["Bezug gestartet", "Bezug beendet"]);
  } finally {
    await env.stop();
  }
});
