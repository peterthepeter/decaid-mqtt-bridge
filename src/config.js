export const DEFAULT_PORT = 8883;
export const DEFAULT_PUBLISH_INTERVAL_MS = 60000;
export const MIN_PUBLISH_INTERVAL_MS = 1000;
export const ACTIVE_SHOT_PUBLISH_INTERVAL_MS = 1000;
export const HEATING_PUBLISH_INTERVAL_MS = 2000;
export const IDLE_PUBLISH_INTERVAL_MS = 5000;
export const UNIQUE_ID_KEY = "uniqueId";

export function telemetryPublishIntervalMs(rawState) {
  if (rawState === "sleeping" || rawState === "disconnected" || !rawState) return null;
  if (rawState === "heating" || rawState === "preheating") return HEATING_PUBLISH_INTERVAL_MS;
  if (rawState === "idle" || rawState === "schedIdle") return IDLE_PUBLISH_INTERVAL_MS;
  return ACTIVE_SHOT_PUBLISH_INTERVAL_MS;
}

export function generateUniqueId() {
  const randomValue = Math.floor(Math.random() * 0xffffffff);
  return randomValue.toString(16).padStart(8, "0");
}

export function normalizeConfig(raw, storedUniqueId) {
  const warnings = [];
  const uniqueId = storedUniqueId || generateUniqueId();

  const host = typeof raw.Host === "string" ? raw.Host.trim() : "";
  let port = raw.Port;
  if (port === undefined || port === null || port === "") port = DEFAULT_PORT;
  port = Number(port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    warnings.push(`port must be an integer in 1-65535, got ${raw.Port}`);
    port = DEFAULT_PORT;
  }

  const hasHeartbeatSeconds = raw.HeartbeatSeconds !== undefined
    && raw.HeartbeatSeconds !== null && raw.HeartbeatSeconds !== "";
  let publishIntervalMs = hasHeartbeatSeconds
    ? Number(raw.HeartbeatSeconds) * 1000
    : raw.PublishIntervalMs;
  if (publishIntervalMs === undefined || publishIntervalMs === null || publishIntervalMs === "") {
    publishIntervalMs = DEFAULT_PUBLISH_INTERVAL_MS;
  }
  publishIntervalMs = Number(publishIntervalMs);
  if (!Number.isFinite(publishIntervalMs) || publishIntervalMs < MIN_PUBLISH_INTERVAL_MS) {
    warnings.push(hasHeartbeatSeconds
      ? `heartbeat seconds must be >= 1, got ${raw.HeartbeatSeconds}`
      : `publishIntervalMs must be >= ${MIN_PUBLISH_INTERVAL_MS}, got ${raw.PublishIntervalMs}`);
    publishIntervalMs = DEFAULT_PUBLISH_INTERVAL_MS;
  }

  const enableTls = raw.EnableTls === undefined || raw.EnableTls === null
    ? true
    : Boolean(raw.EnableTls);

  const clientId = typeof raw.ClientId === "string" && raw.ClientId.trim() !== ""
    ? raw.ClientId.trim()
    : `de1plus_${uniqueId}`;

  const topicPrefix = typeof raw.TopicPrefix === "string" && raw.TopicPrefix.trim() !== ""
    ? raw.TopicPrefix.trim()
    : `de1plus/${uniqueId}`;

  return {
    warnings,
    uniqueId,
    config: {
      enabled: host !== "",
      host,
      port,
      username: typeof raw.Username === "string" ? raw.Username : "",
      password: typeof raw.Password === "string" ? raw.Password : "",
      clientId,
      topicPrefix,
      publishIntervalMs,
      enableTls,
      uniqueId,
      haAutoDiscoveryEnable: Boolean(raw.HaAutoDiscoveryEnable),
      haDiscoveryPrefix: typeof raw.HaDiscoveryPrefix === "string" && raw.HaDiscoveryPrefix.trim()
        ? raw.HaDiscoveryPrefix.trim().replace(/\/+$/, "")
        : "homeassistant",
      haEntityNamePrefix: typeof raw.HaEntityNamePrefix === "string"
        ? raw.HaEntityNamePrefix
        : "DE1+ ",
      haDeviceName: typeof raw.HaDeviceName === "string" ? raw.HaDeviceName.trim() : "",
    },
  };
}
