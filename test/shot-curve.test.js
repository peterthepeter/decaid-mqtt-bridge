import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_CURVE_POINTS, readShotCurve } from "../src/shot-curve.js";

function sample(ms, state = "espresso", extra = {}) {
  return { machine: { timestamp: new Date(1760000000000 + ms).toISOString(),
    state: { state }, pressure: 8.126, flow: 2.4, targetFlow: 2.5,
    mixTemperature: 91, ...extra }, scale: { weight: ms / 1000, weightFlow: 1.8 } };
}

test("curve uses only recorded Espresso data with aligned arrays and optional gaps", () => {
  const first = sample(0);
  const second = sample(250, "espresso", { pressure: NaN });
  second.scale = null;
  const last = sample(500); last.scale.weight = -200;
  const curve = readShotCurve({ id: "s1", annotations: { actualYield: 33.6 },
    workflow: { profile: { title: "Lever" } },
    measurements: [sample(-1000, "flush"), first, second, last, sample(1000, "steam")] });
  assert.deepEqual(curve.time_s, [0, 0.25, 0.5]);
  assert.deepEqual(curve.pressure, [8.13, null, 8.13]);
  assert.deepEqual(curve.weight, [0, null, null]);
  assert.deepEqual(curve.weight_flow, [1.8, null, 1.8]);
  assert.deepEqual(curve.target_pressure, [null, null, null]);
  assert.equal(curve.duration_s, 0.5);
  assert.equal(curve.yield_g, 33.6);
  assert.equal(curve.profile, "Lever");
});

test("non-espresso operations and unusable records never yield a curve", () => {
  for (const state of ["steam", "hotWater", "flush", "cleaning", "descaling", "sleeping", "idle"]) {
    assert.equal(readShotCurve({ id: state, measurements: [sample(0, state), sample(250, state)] }), null);
  }
  for (const record of [null, {}, { measurements: [] }, { measurements: [sample(0)] },
    { measurements: [sample(0), sample(250)] },
    { id: "s1", measurements: [sample(0, "espresso", { pressure: null, flow: null }),
      sample(250, "espresso", { pressure: "9", flow: undefined })] }]) {
    assert.equal(readShotCurve(record), null);
  }
});

test("bad, duplicate and backwards timestamps are skipped without misaligning values", () => {
  const curve = readShotCurve({ measurements: [sample(0), sample(0), sample(-1),
    sample(1, "espresso", { timestamp: "broken" }), sample(500)] }, "fallback");
  assert.equal(curve.shot_id, "fallback");
  assert.deepEqual(curve.time_s, [0, 0.5]);
});

test("large records are bounded, preserving first/last points and time alignment", () => {
  const measurements = Array.from({ length: 5000 }, (_, i) => sample(i * 250));
  const curve = readShotCurve({ id: "long", measurements });
  assert.equal(curve.source_samples, 5000);
  assert.equal(curve.time_s.length, MAX_CURVE_POINTS);
  assert.equal(curve.time_s[0], 0);
  assert.equal(curve.time_s.at(-1), 1249.75);
  assert.equal(curve.weight.at(-1), 1249.75);
  assert.ok(curve.time_s.every((t, i, a) => i === 0 || t > a[i - 1]));
  for (const value of Object.values(curve)) {
    if (Array.isArray(value)) assert.equal(value.length, MAX_CURVE_POINTS);
  }
});
