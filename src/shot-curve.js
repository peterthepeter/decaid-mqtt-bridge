import { mapState } from "./mapping.js";
import { readCompletedShot } from "./shot-record.js";

export const MAX_CURVE_POINTS = 512;

const FIELDS = {
  pressure: ["machine", "pressure"],
  flow: ["machine", "flow"],
  target_pressure: ["machine", "targetPressure"],
  target_flow: ["machine", "targetFlow"],
  temperature: ["machine", "mixTemperature"],
  target_temperature: ["machine", "targetMixTemperature"],
  group_temperature: ["machine", "groupTemperature"],
  weight: ["scale", "weight"],
  weight_flow: ["scale", "weightFlow"],
};

// Read recorded espresso samples, never the live machine/scale state. A single
// shared time axis keeps all series aligned, including gaps in optional data.
export function readShotCurve(record, fallbackId) {
  if (!Array.isArray(record?.measurements)) return null;
  const samples = [];
  let previousMs = -Infinity;
  for (const sample of record.measurements) {
    const machine = sample?.machine;
    if (mapState(machine?.state?.state ?? machine?.state) !== "Espresso") continue;
    const ms = typeof machine.timestamp === "string" ? Date.parse(machine.timestamp) : NaN;
    if (!Number.isFinite(ms) || ms <= previousMs) continue;
    samples.push({ sample, ms });
    previousMs = ms;
  }
  if (samples.length < 2) return null;
  if (!samples.some(({ sample }) => Number.isFinite(sample.machine.pressure)
    || Number.isFinite(sample.machine.flow))) return null;

  const shot = readCompletedShot(record, fallbackId);
  if (typeof shot.id !== "string" || !shot.id) return null;
  const startMs = samples[0].ms;
  const count = Math.min(samples.length, MAX_CURVE_POINTS);
  const selected = Array.from({ length: count }, (_, i) =>
    samples[Math.round(i * (samples.length - 1) / (count - 1))]);
  const series = Object.fromEntries(Object.entries(FIELDS).map(([name, [section, field]]) => [
    name,
    selected.map(({ sample }) => {
      const value = sample[section]?.[field];
      return Number.isFinite(value) && (name !== "weight" || value >= 0)
        ? Math.round(value * 100) / 100 : null;
    }),
  ]));
  return {
    schema_version: 1,
    shot_id: shot.id,
    started_at: shot.startedAt,
    profile: shot.profile,
    duration_s: (samples[samples.length - 1].ms - startMs) / 1000,
    yield_g: shot.weightG,
    stop_reason: shot.stopReason,
    source_samples: samples.length,
    time_s: selected.map(({ ms }) => (ms - startMs) / 1000),
    ...series,
  };
}
