import { test } from "node:test";
import assert from "node:assert/strict";
import { createShotEventMapper } from "../src/shot-events.js";

const frame = (state, decision = null, shotId = "shot-1") => ({
  event: decision ? "decision" : "state", state, decision, shotId,
  timestamp: "2026-09-18T13:22:00Z", scaleLost: false,
});

test("shot milestones suppress phases and duplicates, retaining the stop reason", () => {
  const map = createShotEventMapper();
  assert.equal(map(frame("idle", null, null), true), null);
  assert.equal(map(frame("preheating")).event_type, "Bezug gestartet");
  assert.equal(map(frame("pouring")), null);
  assert.equal(map(frame("pouring", { kind: "advance", reason: "profileAdvance" })), null);
  assert.equal(map(frame("pouring", { kind: "stop", reason: "targetWeight" })), null);
  assert.equal(map(frame("stopping")), null);
  const end = map(frame("finished"));
  assert.equal(end.event_type, "Bezug beendet");
  assert.equal(end.stop_reason, "targetWeight");
  assert.equal(map(frame("finished")), null);
  assert.equal(map(frame("idle")), null);
  assert.equal(map(frame("preheating", null, "shot-2")).event_type, "Bezug gestartet");
});

test("abort and terminal failure emit once, not a subsequent successful end", () => {
  for (const kind of ["abort", "terminal"]) {
    const map = createShotEventMapper();
    map(frame("preheating"));
    const aborted = map(frame("preheating", { kind, reason: "error" }));
    assert.equal(aborted.event_type, "Bezug abgebrochen");
    assert.equal(aborted.stop_reason, "error");
    assert.equal(map(frame("finished")), null);
  }
});

test("reconnection snapshots initialize silently without duplicating milestones", () => {
  const map = createShotEventMapper();
  assert.equal(map(frame("pouring"), true), null);
  assert.equal(map(frame("pouring")), null);
  assert.equal(map(frame("finished")).event_type, "Bezug beendet");
  assert.equal(map(frame("finished"), true), null);
  assert.equal(map(frame("finished")), null);
});
