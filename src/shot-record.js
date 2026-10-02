// Decaid stores local timestamps without an offset. Parse them in the tablet's
// timezone and publish an explicit UTC timestamp for Home Assistant.
export function readCompletedShot(record, fallbackId) {
  const measurements = Array.isArray(record.measurements) ? record.measurements : [];
  const first = measurements[0];
  const last = measurements[measurements.length - 1];
  const startMs = timestampMs(first?.machine?.timestamp);
  const endMs = timestampMs(last?.machine?.timestamp);
  const recordedMs = timestampMs(record.timestamp) ?? startMs;
  const actualYield = record.annotations?.actualYield;
  let weightG = validWeight(actualYield) ? actualYield : null;
  if (weightG === null) {
    // Cup removal can leave a negative final sample; retain the last usable
    // measurement rather than reporting it as beverage yield.
    for (let index = measurements.length - 1; index >= 0; index -= 1) {
      const weight = measurements[index]?.scale?.weight;
      if (validWeight(weight)) {
        weightG = weight;
        break;
      }
    }
  }
  return {
    active: false,
    id: record.id ?? fallbackId,
    startedAt: recordedMs === null ? null : new Date(recordedMs).toISOString(),
    durationS: startMs === null || endMs === null ? null : Math.max(0, (endMs - startMs) / 1000),
    weightG,
    profile: typeof record.workflow?.profile?.title === "string" ? record.workflow.profile.title : null,
    stopReason: typeof record.stopReason === "string" ? record.stopReason : null,
  };
}

function timestampMs(value) {
  if (typeof value !== "string" || !value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function validWeight(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
