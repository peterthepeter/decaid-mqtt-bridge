export const DECAID_API_BASE = "http://localhost:8080";

export function createDecaidApi({ fetchImpl, log }) {
  // `quiet` is for endpoints polled on every publish: a failed poll must not
  // spam the log every second during an active shot, it just leaves whatever
  // value the caller has cached alone.
  async function getJson(path, { quiet = false } = {}) {
    try {
      const response = await fetchImpl(`${DECAID_API_BASE}${path}`);
      if (!response.ok) {
        if (!quiet) log(`GET ${path} failed: ${response.status}`);
        return null;
      }
      return await response.json();
    } catch (e) {
      if (!quiet) log(`GET ${path} failed: ${e?.message ?? e}`);
      return null;
    }
  }

  async function fetchShotRecord(shotId) {
    return getJson(`/api/v1/shots/${shotId}`);
  }

  async function fetchWorkflow() {
    return getJson("/api/v1/workflow", { quiet: true });
  }

  async function fetchProfiles() {
    return getJson("/api/v1/profiles", { quiet: true });
  }

  async function fetchSettings() {
    return getJson("/api/v1/settings", { quiet: true });
  }

  async function fetchDevices() {
    return getJson("/api/v1/devices", { quiet: true });
  }

  async function fetchMachineInfo() {
    return getJson("/api/v1/machine/info", { quiet: true });
  }

  // These lists are paginated on newer Decaid builds ({items, total, ...}) and
  // a plain array on older ones. Read the lifetime figure out of either, and
  // say so when it is neither, rather than silently keeping a stale count.
  function readCountFromResponse(payload, countKind) {
    if (Array.isArray(payload)) return payload.length;
    if (payload && typeof payload.total === "number") return payload.total;
    log(`${countKind} count: unrecognised response shape, keeping the previous value`);
    return null;
  }

  async function fetchCollectionCount(path, countKind) {
    const payload = await getJson(path, { quiet: true });
    if (!payload) return null;
    return readCountFromResponse(payload, countKind);
  }

  return {
    fetchShotRecord,
    fetchWorkflow,
    fetchProfiles,
    fetchSettings,
    fetchDevices,
    fetchMachineInfo,
    fetchCollectionCount,
  };
}
