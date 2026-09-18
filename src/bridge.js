import mqtt from "mqtt";
import { HostTransportStream } from "./host-transport-stream.js";
import { offlineStateMessage } from "./state-doc.js";

export const MAX_RECONNECT_ATTEMPTS = 15;
export const BASE_RECONNECT_DELAY_MS = 2000;
export const MAX_RECONNECT_DELAY_MS = 64000;
export const CONNECTION_VERIFICATION_TIMEOUT_MS = 10000;

export function createMqttBridge({ host, config, onCommand, log }) {
  const stateTopic = `${config.topicPrefix}/state`;
  const commandTopic = `${config.topicPrefix}/command`;

  let client = null;
  let reconnectTimer = null;
  let disposed = false;
  let attempts = 0;
  let onConnected = null;
  let protocolVersion = 5;
  let connectionGeneration = 0;
  let verification = null;

  function clearVerification() {
    if (verification?.timer) clearTimeout(verification.timer);
    verification = null;
  }

  function failVerification(message) {
    if (!verification) return;
    log(`MQTT connection verification failed: ${message}`);
    clearVerification();
  }

  function maybeCompleteVerification(generation) {
    if (!verification || verification.generation !== generation) return;
    if (!verification.subscribed || !verification.published) return;
    const protocol = protocolVersion === 5 ? "MQTT 5" : "MQTT 3.1.1";
    const transport = config.enableTls ? "TLS" : "TCP";
    const credentials = config.username ? ", credentials accepted" : "";
    log(`MQTT connection verified: ${protocol} over ${transport}${credentials}, command subscription and QoS 1 publish successful`);
    clearVerification();
  }

  function beginVerification(generation) {
    clearVerification();
    verification = {
      generation,
      subscribed: false,
      published: false,
      timer: setTimeout(() => {
        if (!verification || verification.generation !== generation) return;
        const pending = [
          verification.subscribed ? null : "command subscription",
          verification.published ? null : "QoS 1 state acknowledgement",
        ].filter(Boolean).join(" and ");
        failVerification(`timed out waiting for ${pending}`);
      }, CONNECTION_VERIFICATION_TIMEOUT_MS),
    };
  }

  function openStream() {
    const stream = new HostTransportStream(host.transport, {
      kind: config.enableTls ? "tls" : "tcp",
      host: config.host,
      port: config.port,
    });
    stream.open().catch((e) => stream.emit("error", e));
    return stream;
  }

  function scheduleReconnect() {
    if (disposed) return;
    if (attempts >= MAX_RECONNECT_ATTEMPTS) {
      log(`giving up after ${attempts} reconnect attempts`);
      return;
    }
    const delay = Math.min(
      BASE_RECONNECT_DELAY_MS * 2 ** attempts,
      MAX_RECONNECT_DELAY_MS,
    );
    attempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!disposed) start();
    }, delay);
  }

  function start() {
    if (disposed || client) return;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    client = new mqtt.MqttClient(openStream, {
      clientId: config.clientId,
      username: config.username || undefined,
      password: config.password || undefined,
      clean: true,
      reconnectPeriod: 0,
      keepalive: Math.ceil((config.publishIntervalMs + 3000) / 1000),
      protocolVersion,
      will: {
        topic: stateTopic,
        payload: JSON.stringify(offlineStateMessage()),
        qos: 1,
        retain: true,
      },
    });
    client.on("connect", () => {
      attempts = 0;
      const generation = ++connectionGeneration;
      beginVerification(generation);
      client.subscribe(commandTopic, { qos: 1 }, (error, granted) => {
        if (!verification || verification.generation !== generation) return;
        const rejected = Array.isArray(granted) && granted.some((entry) => entry?.qos === 128);
        if (error || rejected) {
          failVerification(`command subscription rejected${error ? `: ${error.message}` : ""}`);
          return;
        }
        verification.subscribed = true;
        maybeCompleteVerification(generation);
      });
      if (onConnected) onConnected();
    });
    client.on("message", onCommand);
    client.on("error", (e) => {
      log(`broker error: ${e?.message ?? e}`);
      if (protocolVersion === 5 && /protocol version/i.test(String(e?.message ?? e))) {
        protocolVersion = 4;
        log("broker rejected MQTT 5; retrying with MQTT 3.1.1");
        const dead = client;
        client = null;
        killClient(dead);
        if (!disposed) start();
      }
    });
    client.on("close", () => {
      failVerification("connection closed before verification completed");
      const dead = client;
      client = null;
      if (dead) killClient(dead);
      scheduleReconnect();
    });
  }

  function killClient(dead) {
    dead.removeAllListeners();
    dead.on("error", () => {});
    dead.end(true);
  }

  function stop() {
    disposed = true;
    clearVerification();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (client) {
      const dead = client;
      client = null;
      if (dead.connected) {
        dead.publish(stateTopic, JSON.stringify(offlineStateMessage()), { qos: 1, retain: true }, () => {
          killClient(dead);
        });
      } else {
        killClient(dead);
      }
    }
  }

  function reset() {
    stop();
    disposed = false;
    attempts = 0;
  }

  function publishState(stateMessage, onPublished) {
    if (!client?.connected) return false;
    const generation = verification?.generation;
    client.publish(stateTopic, JSON.stringify(stateMessage), { qos: 1, retain: true }, (error) => {
      if (!error && generation !== undefined && verification?.generation === generation) {
        verification.published = true;
        maybeCompleteVerification(generation);
      } else if (error && generation !== undefined && verification?.generation === generation) {
        failVerification(`state publish rejected: ${error.message}`);
      }
      onPublished?.(error);
    });
    return true;
  }

  function publish(topic, payload, { qos = 1, retain = false } = {}, onPublished) {
    if (!client?.connected) return false;
    const wirePayload = typeof payload === "string" ? payload : JSON.stringify(payload);
    client.publish(topic, wirePayload, { qos, retain }, onPublished);
    return true;
  }

  return {
    start,
    stop,
    reset,
    publish,
    publishState,
    get connected() {
      return Boolean(client?.connected);
    },
    get reconnectAttempts() {
      return attempts;
    },
    topics: { stateTopic, commandTopic },
    set onConnectedHandler(fn) {
      onConnected = fn;
    },
  };
}
