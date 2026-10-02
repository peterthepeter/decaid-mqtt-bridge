import { test } from "node:test";
import assert from "node:assert/strict";
import { readCompletedShot } from "../src/shot-record.js";

test("Decaid local shot timestamps become explicit timestamps and retain the recorded profile", () => {
  const shot = readCompletedShot({
    id: "shot-1", timestamp: "2026-10-02T09:29:17.183109",
    workflow: { profile: { title: "Advanced spring lever" } },
    annotations: { actualYield: 32.9 }, stopReason: "targetWeight",
    measurements: [
      { machine: { timestamp: "2026-10-02T09:29:17.171107" }, scale: { weight: 0 } },
      { machine: { timestamp: "2026-10-02T09:29:44.621267" }, scale: { weight: 29.6 } },
    ],
  });
  assert.equal(shot.startedAt, new Date("2026-10-02T09:29:17.183109").toISOString());
  assert.equal(shot.durationS, 27.45);
  assert.equal(shot.weightG, 32.9);
  assert.equal(shot.profile, "Advanced spring lever");
  assert.equal(shot.stopReason, "targetWeight");
});

test("completed yield ignores negative cup-removal samples and malformed annotations", () => {
  for (const actualYield of [undefined, -296.7, "32.9", NaN]) {
    const shot = readCompletedShot({
      annotations: { actualYield },
      measurements: [{ scale: { weight: 31.2 } }, { scale: { weight: -296.7 } }],
    }, "shot-2");
    assert.equal(shot.weightG, 31.2);
    assert.equal(shot.id, "shot-2");
  }
});

test("missing timestamps and yield stay unknown instead of becoming epoch dates or negative results", () => {
  const shot = readCompletedShot({ timestamp: null, measurements: [
    { machine: { timestamp: null }, scale: { weight: -296.7 } },
    { machine: { timestamp: "invalid" } },
  ] }, "empty");
  assert.equal(shot.startedAt, null);
  assert.equal(shot.durationS, null);
  assert.equal(shot.weightG, null);
});
