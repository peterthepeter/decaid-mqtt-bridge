import http from "node:http";
import net from "node:net";
import { WebSocketServer } from "ws";

export function createDecaidSim() {
  const state = {
    shots: [],
    steams: [],
    profiles: [],
    workflow: {
      profile: { title: "" },
      steamSettings: { targetTemperature: 145 },
      context: { targetDoseWeight: 18, targetYield: 36 },
    },
    settings: { chargingState: { batteryPercent: 77 } },
    machineInfo: { model: "DE1XL", serialNumber: "TEST-123", version: "0.8.5", GHC: false },
    store: { "streamline-app/last-steam-temp": 145 },
    devices: [{ type: "machine", state: "connected" }],
    shotSettings: {
      steamSetting: 0,
      targetSteamTemp: 0,
      targetSteamDuration: 30,
      targetHotWaterTemp: 90,
      targetHotWaterVolume: 200,
      targetHotWaterDuration: 30,
      targetShotVolume: 0,
      groupTemp: 93,
    },
    shotState: { event: "state", state: "idle", timestamp: "2026-09-09T07:00:00.000Z", scaleLost: false },
    scaleStatus: "disconnected",
    pendingScaleSamples: [],
  };
  const requests = [];
  const scaleSockets = new Set();
  const waterSockets = new Set();
  const shotSettingsSockets = new Set();
  const shotStateSockets = new Set();
  const deviceSockets = new Set();

  const server = httpServer();

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url, "http://localhost").pathname;
    const supported = new Set([
      "/ws/v1/scale/snapshot",
      "/ws/v1/machine/waterLevels",
      "/ws/v1/machine/shotSettings",
      "/ws/v1/machine/shotState",
      "/ws/v1/devices",
    ]);
    if (!supported.has(path)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (path === "/ws/v1/scale/snapshot") {
        scaleSockets.add(ws);
        if (state.scaleStatus) {
          ws.send(JSON.stringify({ status: state.scaleStatus }));
        }
        for (const sample of state.pendingScaleSamples.splice(0)) {
          ws.send(JSON.stringify(sample));
        }
      } else if (path === "/ws/v1/machine/waterLevels") {
        waterSockets.add(ws);
      } else if (path === "/ws/v1/machine/shotSettings") {
        shotSettingsSockets.add(ws);
        ws.send(JSON.stringify(state.shotSettings));
      } else if (path === "/ws/v1/machine/shotState") {
        shotStateSockets.add(ws);
        ws.send(JSON.stringify(state.shotState));
      } else {
        deviceSockets.add(ws);
        ws.send(JSON.stringify({ devices: state.devices }));
      }
      ws.on("close", () => {
        scaleSockets.delete(ws);
        waterSockets.delete(ws);
        shotSettingsSockets.delete(ws);
        shotStateSockets.delete(ws);
        deviceSockets.delete(ws);
      });
    });
  });

  function sendScaleSnapshot(sample) {
    for (const ws of scaleSockets) ws.send(JSON.stringify(sample));
  }

  function queueScaleSnapshot(sample) {
    state.pendingScaleSamples.push(sample);
    sendScaleSnapshot(sample);
  }

  function sendWaterLevels(levels) {
    for (const ws of waterSockets) ws.send(JSON.stringify(levels));
  }

  function sendShotSettings(settings) {
    state.shotSettings = settings;
    for (const ws of shotSettingsSockets) ws.send(JSON.stringify(settings));
  }

  function sendShotState(frame) {
    state.shotState = frame;
    for (const ws of shotStateSockets) ws.send(JSON.stringify(frame));
  }

  function sendDevices(devices) {
    state.devices = devices;
    for (const ws of deviceSockets) ws.send(JSON.stringify({ devices }));
  }

  function start() {
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    });
  }

  function stop() {
    for (const ws of [
      ...scaleSockets,
      ...waterSockets,
      ...shotSettingsSockets,
      ...shotStateSockets,
      ...deviceSockets,
    ]) {
      try {
        ws.terminate();
      } catch {}
    }
    scaleSockets.clear();
    waterSockets.clear();
    shotSettingsSockets.clear();
    shotStateSockets.clear();
    deviceSockets.clear();
    return new Promise((resolve) => server.close(resolve));
  }

  function httpServer() {
    return http.createServer((req, res) => {
      handler(req, res).catch(() => {
        res.writeHead(500);
        res.end();
      });
    });
  }

  async function handler(req, res) {
    const url = new URL(req.url, "http://localhost");
    const record = { method: req.method, path: url.pathname, body: null };
    requests.push(record);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    record.body = raw || null;

    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (req.method === "GET" && url.pathname === "/api/v1/shots") return json(200, state.shotsList ?? state.shots);
    if (req.method === "GET" && url.pathname === "/api/v1/steams") return json(200, state.steams);
    if (req.method === "GET" && url.pathname === "/api/v1/profiles") return json(200, state.profiles);
    if (req.method === "GET" && url.pathname === "/api/v1/workflow") return json(200, state.workflow);
    if (req.method === "GET" && url.pathname === "/api/v1/settings") return json(200, state.settings);
    if (req.method === "GET" && url.pathname === "/api/v1/machine/info") return json(200, state.machineInfo);
    if (req.method === "GET" && url.pathname === "/api/v1/devices") return json(200, state.devices);
    if (req.method === "POST" && url.pathname === "/api/v1/machine/heartbeat") {
      return json(200, { timeout: 1800 });
    }
    const storeMatch = url.pathname.match(/^\/api\/v1\/store\/([^/]+)\/([^/]+)$/);
    if (req.method === "GET" && storeMatch) {
      const key = `${decodeURIComponent(storeMatch[1])}/${decodeURIComponent(storeMatch[2])}`;
      return Object.hasOwn(state.store, key) ? json(200, state.store[key]) : json(404, { error: "not found" });
    }
    if (req.method === "POST" && storeMatch) {
      const key = `${decodeURIComponent(storeMatch[1])}/${decodeURIComponent(storeMatch[2])}`;
      state.store[key] = raw ? JSON.parse(raw) : null;
      return json(200, { ok: true });
    }
    const shotMatch = url.pathname.match(/^\/api\/v1\/shots\/([^/]+)$/);
    if (req.method === "GET" && shotMatch) {
      const shot = state.shots.find((s) => s.id === decodeURIComponent(shotMatch[1]));
      return shot ? json(200, shot) : json(404, { error: "not found" });
    }
    const stateMatch = url.pathname.match(/^\/api\/v1\/machine\/state\/([^/]+)$/);
    if (req.method === "PUT" && stateMatch) {
      record.stateName = decodeURIComponent(stateMatch[1]);
      return json(200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/v1/machine/profile") {
      record.profileBody = raw ? JSON.parse(raw) : null;
      return json(200, { ok: true });
    }
    if (req.method === "PUT" && url.pathname === "/api/v1/workflow") {
      record.workflowBody = raw ? JSON.parse(raw) : null;
      state.workflow = {
        ...state.workflow,
        ...record.workflowBody,
        steamSettings: {
          ...state.workflow.steamSettings,
          ...(record.workflowBody?.steamSettings ?? {}),
        },
      };
      if (Number.isFinite(record.workflowBody?.steamSettings?.targetTemperature)) {
        state.shotSettings.targetSteamTemp = record.workflowBody.steamSettings.targetTemperature;
        sendShotSettings({ ...state.shotSettings });
      }
      return json(200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/v1/machine/shotSettings") {
      record.shotSettingsBody = raw ? JSON.parse(raw) : null;
      state.shotSettings = record.shotSettingsBody;
      return json(200, { ok: true });
    }
    return json(404, { error: "not found" });
  }

  return {
    start,
    stop,
    requests,
    state,
    sendScaleSnapshot,
    queueScaleSnapshot,
    sendWaterLevels,
    sendShotSettings,
    sendShotState,
    sendDevices,
    shotStateConnectionCount() {
      return shotStateSockets.size;
    },
    setScaleStatus(status) {
      state.scaleStatus = status;
      for (const ws of scaleSockets) ws.send(JSON.stringify({ status }));
    },
  };
}
