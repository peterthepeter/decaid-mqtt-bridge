import { normalizeConfig, generateUniqueId, UNIQUE_ID_KEY, telemetryPublishIntervalMs } from "./config.js";
import { buildStateMessage } from "./state-doc.js";
import { mapState, mapSubstate, isShotActive } from "./mapping.js";
import { CommandDispatcher } from "./dispatcher.js";
import { createCommandHandler } from "./command-handler.js";
import { createMqttBridge } from "./bridge.js";
import { createLoopbackJsonStream } from "./loopback.js";
import { createStorageAdapter } from "./storage.js";
import { createDecaidApi } from "./decaid-api.js";
import { buildDiscoveryMessages, DISCOVERY_TOPICS_KEY } from "./discovery.js";
import { createShotEventMapper } from "./shot-events.js";

export const PLUGIN_ID = "mqtt.reaplugin";
const REMEMBERED_STEAM_TEMPERATURE_KEY = "rememberedSteamTemperature";

export function createPlugin(host) {
  const mapShotEvent = createShotEventMapper();
  const log = (message) => {
    try { host.log(`[mqtt] ${message}`); } catch {}
  };
  const storage = createStorageAdapter(host);
  const api = createDecaidApi({ fetchImpl: fetch, log });

  let config = null;
  let bridge = null;
  let heartbeatTimer = null;
  let telemetryPublishTimer = null;
  let publishSequence = Promise.resolve();
  let lastPublishedAt = 0;
  let streams = [];
  let dispatcher = null;
  let stopping = false;

  const runtime = {
    snapshot: null,
    machineConnected: false,
    scaleConnected: false,
    scaleSnapshot: null,
    waterLevelMm: null,
    refillLevelMm: null,
    shotSettings: null,
    shotState: null,
    shotStreamFirstFrame: true,
    workflow: null,
    settings: null,
    metadata: null,
    profiles: [],
    profile: "",
    profileFilename: "",
    espressoCount: 0,
    steamingCount: 0,
    shotWeightG: null,
    shot: null,
    lastState: null,
    lastSubstate: null,
    lastPublishedStateJson: null,
    previousDiscoveryTopics: [],
    discoverySignature: "",
    rememberedSteamTemperature: null,
  };

  function shotFields() {
    const active = runtime.shot?.active === true;
    return {
      active,
      id: active ? null : runtime.shot?.id ?? null,
      startedAt: active ? null : runtime.shot?.startedAt ?? null,
      durationS: active ? null : runtime.shot?.durationS ?? null,
      weightG: active ? runtime.shotWeightG : runtime.shot?.weightG ?? runtime.shotWeightG,
    };
  }

  function currentStateMessage() {
    return buildStateMessage({
      snapshot: runtime.snapshot,
      online: true,
      machineConnected: runtime.machineConnected,
      scaleConnected: runtime.scaleConnected,
      scaleSnapshot: runtime.scaleSnapshot,
      waterLevelMm: runtime.waterLevelMm,
      refillLevelMm: runtime.refillLevelMm,
      profile: runtime.profile,
      profileFilename: runtime.profileFilename,
      workflow: runtime.workflow,
      settings: runtime.settings,
      shotSettings: runtime.shotSettings,
      shotState: runtime.shotState,
      espressoCount: runtime.espressoCount,
      steamingCount: runtime.steamingCount,
      shot: runtime.shot ? shotFields() : null,
    });
  }

  function armHeartbeat() {
    if (heartbeatTimer || !bridge) return;
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = null;
      enqueuePublish({ refreshStatic: true, refreshCounts: true, force: true });
    }, config.publishIntervalMs);
  }

  function enqueuePublish(options = {}) {
    if (stopping) return publishSequence;
    publishSequence = publishSequence
      .then(() => publishNow(options))
      .catch((error) => log(`publish failed: ${error?.message ?? error}`));
    return publishSequence;
  }

  function cancelTelemetryPublish() {
    if (!telemetryPublishTimer) return;
    clearTimeout(telemetryPublishTimer);
    telemetryPublishTimer = null;
  }

  function queueTelemetryPublish(rawState) {
    const intervalMs = telemetryPublishIntervalMs(rawState);
    if (!bridge || !runtime.machineConnected || intervalMs === null || telemetryPublishTimer) return;
    const delay = Math.max(0, intervalMs - (Date.now() - lastPublishedAt));
    telemetryPublishTimer = setTimeout(() => {
      telemetryPublishTimer = null;
      enqueuePublish();
    }, delay);
  }

  async function publishNow({ refreshStatic = false, refreshCounts = false, discovery = false, fullStatic = false, force = false } = {}) {
    if (!bridge?.connected) return;
    let discoveryChanged = false;
    if (refreshStatic) discoveryChanged = await refreshStaticData({ refreshCounts, fullStatic });
    if (!bridge?.connected) return;
    if (discovery || discoveryChanged) syncDiscovery();
    const stateMessage = currentStateMessage();
    const stateJson = JSON.stringify(stateMessage);
    if (!force && stateJson === runtime.lastPublishedStateJson) return;
    runtime.lastPublishedStateJson = stateJson;
    lastPublishedAt = Date.now();
    bridge.publishState(stateMessage, (error) => {
      if (error) log(`state publish failed: ${error?.message ?? error}`);
    });
    armHeartbeat();
  }

  function applyWorkflow(workflow) {
    runtime.workflow = workflow;
    const title = workflow?.profile?.title;
    runtime.profile = typeof title === "string" ? title : "";
    const match = runtime.profiles.find((record) => record?.profile?.title === runtime.profile);
    runtime.profileFilename = match?.id ?? match?.filename ?? "";
  }

  function profileOptions() {
    return [...new Set(runtime.profiles
      .map((record) => record?.profile?.title)
      .filter((title) => typeof title === "string" && title))];
  }

  async function refreshStaticData({ refreshCounts = false, fullStatic = false } = {}) {
    const previousSignature = runtime.discoverySignature;
    const [workflow, profiles, settings, devices, machineInfo] = await Promise.all([
      api.fetchWorkflow(),
      fullStatic ? api.fetchProfiles() : null,
      fullStatic ? api.fetchSettings() : null,
      fullStatic ? api.fetchDevices() : null,
      fullStatic ? api.fetchMachineInfo() : null,
    ]);
    if (Array.isArray(profiles)) runtime.profiles = profiles;
    if (workflow) applyWorkflow(workflow);
    else if (runtime.workflow) applyWorkflow(runtime.workflow);
    if (!fullStatic && runtime.profile && !runtime.profileFilename) {
      const refreshedProfiles = await api.fetchProfiles();
      if (Array.isArray(refreshedProfiles)) {
        runtime.profiles = refreshedProfiles;
        applyWorkflow(runtime.workflow);
      }
    }
    if (settings) runtime.settings = settings;
    if (Array.isArray(devices)) applyDevices(devices);
    if (machineInfo && typeof machineInfo === "object") runtime.metadata = machineInfo;
    if (refreshCounts) await refreshUsageCounts();
    runtime.discoverySignature = JSON.stringify({
      metadata: runtime.metadata,
      profiles: profileOptions(),
    });
    return previousSignature !== runtime.discoverySignature;
  }

  async function refreshUsageCounts() {
    const [espressoCount, steamingCount] = await Promise.all([
      api.fetchCollectionCount("/api/v1/shots?limit=1", "espresso"),
      api.fetchCollectionCount("/api/v1/steams?limit=1", "steaming"),
    ]);
    if (espressoCount !== null) runtime.espressoCount = espressoCount;
    if (steamingCount !== null) runtime.steamingCount = steamingCount;
  }

  function syncDiscovery() {
    if (!bridge?.connected) return;
    const messages = config.haAutoDiscoveryEnable
      ? buildDiscoveryMessages(config, runtime.metadata ?? {}, profileOptions())
      : [];
    const currentTopics = new Set(messages.map((message) => message.topic));
    for (const oldTopic of runtime.previousDiscoveryTopics) {
      if (!currentTopics.has(oldTopic)) bridge.publish(oldTopic, "", { qos: 1, retain: true });
    }
    for (const message of messages) {
      bridge.publish(message.topic, message.payload, { qos: 1, retain: true });
    }
    runtime.previousDiscoveryTopics = [...currentTopics];
    storage.write(DISCOVERY_TOPICS_KEY, runtime.previousDiscoveryTopics);
    log(config.haAutoDiscoveryEnable
      ? `published ${messages.length} Home Assistant discovery entities`
      : "Home Assistant discovery disabled; retained entities retracted");
  }

  function publishShotEvent(event) {
    if (!bridge?.connected || !config.haAutoDiscoveryEnable) return;
    bridge.publish(`${config.topicPrefix}/event/shot`, event, { qos: 1, retain: false });
  }

  function applyDevices(devices) {
    const connected = devices.some((device) => device?.type === "machine" && device?.state === "connected");
    if (connected !== runtime.machineConnected) {
      runtime.machineConnected = connected;
      if (!connected) cancelTelemetryPublish();
      enqueuePublish();
    }
  }

  function applyDevicesPayload(payload) {
    const devices = Array.isArray(payload) ? payload : payload?.devices;
    if (Array.isArray(devices)) applyDevices(devices);
  }

  function onStateUpdate(payload) {
    if (!payload || typeof payload !== "object") return;
    runtime.snapshot = payload;
    runtime.machineConnected = true;
    const rawState = payload.state?.state ?? payload.state;
    const rawSubstate = payload.state?.substate ?? payload.substate;
    const state = mapState(rawState);
    const substate = mapSubstate(rawSubstate) ?? "";
    const active = isShotActive(state, substate);
    const transitioned = rawState !== runtime.lastState || rawSubstate !== runtime.lastSubstate;
    runtime.lastState = rawState;
    runtime.lastSubstate = rawSubstate;
    if (active && runtime.shot?.active !== true) {
      runtime.shot = { active: true };
      runtime.shotWeightG = null;
    } else if (!active && runtime.shot?.active === true) {
      runtime.shot = { ...runtime.shot, active: false };
    }
    if (transitioned) {
      cancelTelemetryPublish();
      enqueuePublish();
    } else {
      queueTelemetryPublish(rawState);
    }
  }

  async function onShotStored(payload) {
    const shotId = payload?.id;
    if (!shotId) return;
    const record = await api.fetchShotRecord(shotId);
    if (!record) return;
    const measurements = Array.isArray(record.measurements) ? record.measurements : [];
    const first = measurements[0];
    const last = measurements[measurements.length - 1];
    let durationS = null;
    const startMs = new Date(first?.machine?.timestamp).getTime();
    const endMs = new Date(last?.machine?.timestamp).getTime();
    if (Number.isFinite(startMs) && Number.isFinite(endMs)) durationS = Math.max(0, (endMs - startMs) / 1000);
    const actualYield = record.annotations?.actualYield;
    const finalWeight = Number.isFinite(actualYield) ? actualYield : last?.scale?.weight ?? null;
    if (!Number.isFinite(actualYield)) log(`shot ${shotId} has no actualYield; using the last scale sample`);
    runtime.shot = {
      active: false,
      id: record.id ?? shotId,
      startedAt: record.timestamp ?? null,
      durationS,
      weightG: finalWeight,
    };
    runtime.shotWeightG = finalWeight;
    await enqueuePublish({ refreshStatic: true, refreshCounts: true });
  }

  function addStream(options) {
    const stream = createLoopbackJsonStream({ host, log, ...options });
    streams.push(stream);
    stream.start();
  }

  function startStreams() {
    addStream({
      path: "/ws/v1/scale/snapshot",
      onJson: (sample) => {
        if (!sample || typeof sample !== "object") return;
        runtime.scaleSnapshot = sample;
        runtime.scaleConnected = true;
        if (Number.isFinite(sample.weight)) {
          runtime.shotWeightG = sample.weight;
          if (runtime.shot?.active) runtime.shot.weightG = sample.weight;
        }
        queueTelemetryPublish(runtime.lastState);
      },
      onStatus: (status) => {
        const connected = status === "connected";
        if (runtime.scaleConnected !== connected) {
          runtime.scaleConnected = connected;
          if (!connected) runtime.scaleSnapshot = null;
          enqueuePublish();
        }
      },
      onClose: () => {
        if (runtime.scaleConnected) {
          runtime.scaleConnected = false;
          runtime.scaleSnapshot = null;
          enqueuePublish();
        }
      },
    });
    addStream({
      path: "/ws/v1/machine/waterLevels",
      onJson: (levels) => {
        if (!Number.isFinite(levels?.currentLevel) || !Number.isFinite(levels?.refillLevel)) return;
        runtime.waterLevelMm = levels.currentLevel;
        runtime.refillLevelMm = levels.refillLevel;
        queueTelemetryPublish(runtime.lastState);
      },
    });
    addStream({
      path: "/ws/v1/machine/shotSettings",
      onJson: (settings) => {
        if (!settings || typeof settings !== "object") return;
        if (JSON.stringify(settings) === JSON.stringify(runtime.shotSettings)) return;
        runtime.shotSettings = settings;
        enqueuePublish();
      },
    });
    addStream({
      path: "/ws/v1/machine/shotState",
      onOpen: () => { runtime.shotStreamFirstFrame = true; },
      onJson: (frame) => {
        if (!frame || typeof frame !== "object" || typeof frame.event !== "string") return;
        const decision = frame.decision;
        const stopReason = decision && ["stop", "abort", "terminal"].includes(decision.kind)
          ? decision.reason
          : runtime.shotState?.stopReason;
        const changed = frame.state !== runtime.shotState?.state
          || frame.scaleLost !== runtime.shotState?.scaleLost
          || stopReason !== runtime.shotState?.stopReason;
        runtime.shotState = { ...frame, stopReason };
        const event = mapShotEvent(frame, runtime.shotStreamFirstFrame);
        runtime.shotStreamFirstFrame = false;
        if (event) publishShotEvent(event);
        if (changed || event) enqueuePublish();
      },
    });
    addStream({
      path: "/ws/v1/devices",
      onJson: applyDevicesPayload,
      onClose: () => {
        if (runtime.machineConnected) {
          runtime.machineConnected = false;
          enqueuePublish();
        }
      },
    });
  }

  function startServices() {
    stopping = false;
    dispatcher = new CommandDispatcher({
      fetchImpl: fetch,
      currentStateProvider: () => runtime.lastState,
      machineConnectedProvider: () => runtime.machineConnected,
      workflowProvider: () => runtime.workflow,
      rememberedSteamTemperatureProvider: () => runtime.rememberedSteamTemperature,
      rememberSteamTemperature: (temperature) => {
        runtime.rememberedSteamTemperature = Math.round(temperature);
        storage.write(REMEMBERED_STEAM_TEMPERATURE_KEY, runtime.rememberedSteamTemperature);
      },
      workflowUpdated: (patch) => applyWorkflow({
        ...(runtime.workflow ?? {}),
        ...patch,
        steamSettings: {
          ...(runtime.workflow?.steamSettings ?? {}),
          ...(patch.steamSettings ?? {}),
        },
      }),
    });
    bridge = createMqttBridge({
      host,
      config,
      onCommand: createCommandHandler(dispatcher, log, () => {
        enqueuePublish({ refreshStatic: true });
      }),
      log,
    });
    bridge.onConnectedHandler = () => {
      enqueuePublish({ refreshStatic: true, refreshCounts: true, discovery: true, fullStatic: true, force: true });
    };
    bridge.start();
    startStreams();
  }

  async function stopAll() {
    stopping = true;
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    if (telemetryPublishTimer) clearTimeout(telemetryPublishTimer);
    heartbeatTimer = null;
    telemetryPublishTimer = null;
    const streamsToStop = streams;
    streams = [];
    await Promise.all(streamsToStop.map((stream) => stream.stop().catch(() => {})));
    if (bridge) bridge.stop();
    bridge = null;
    dispatcher = null;
  }

  return {
    id: PLUGIN_ID,
    async onLoad(settings) {
      const [storedUniqueId, storedDiscoveryTopics, rememberedSteamTemperature] = await Promise.all([
        storage.read(UNIQUE_ID_KEY),
        storage.read(DISCOVERY_TOPICS_KEY),
        storage.read(REMEMBERED_STEAM_TEMPERATURE_KEY),
      ]);
      const { config: normalized, uniqueId, warnings } = normalizeConfig(settings, storedUniqueId);
      if (!storedUniqueId) storage.write(UNIQUE_ID_KEY, uniqueId || generateUniqueId());
      runtime.previousDiscoveryTopics = Array.isArray(storedDiscoveryTopics) ? storedDiscoveryTopics : [];
      runtime.rememberedSteamTemperature = Number.isFinite(rememberedSteamTemperature)
        ? rememberedSteamTemperature
        : null;
      for (const warning of warnings) log(`config warning: ${warning}`);
      config = normalized;
      if (!config.enabled) {
        log("disabled: no broker host configured");
        return;
      }
      startServices();
    },
    async onUnload() {
      await stopAll();
    },
    onEvent(event) {
      if (storage.resolvePendingRead(event)) return;
      switch (event?.name) {
        case "stateUpdate": onStateUpdate(event.payload); break;
        case "shotStored": onShotStored(event.payload).catch((error) => log(`shot processing failed: ${error?.message ?? error}`)); break;
        case "workflowUpdated":
          applyWorkflow(event.payload);
          enqueuePublish({ discovery: true });
          break;
        case "shutdown": stopAll(); break;
        default: break;
      }
    },
  };
}
