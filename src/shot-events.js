export const SHOT_EVENT_TYPES = ["Bezug gestartet", "Bezug beendet", "Bezug abgebrochen"];

// Keep only the current lifecycle, never an unbounded history of shot IDs.
export function createShotEventMapper() {
  let shotId = null;
  let phase = "idle";
  let started = false;
  let closed = false;
  let stopDecision = null;

  return (frame, replay = false) => {
    if (frame.shotId !== shotId || (frame.state === "preheating" && phase === "idle")) {
      shotId = frame.shotId ?? null;
      started = false;
      closed = false;
      stopDecision = null;
    }
    const kind = frame.decision?.kind;
    if (["stop", "abort", "terminal"].includes(kind)) stopDecision = frame.decision;
    let eventType = null;
    if (!closed && (kind === "abort" || kind === "terminal")) {
      closed = true;
      eventType = SHOT_EVENT_TYPES[2];
    } else if (!closed && frame.state === "finished") {
      closed = true;
      eventType = SHOT_EVENT_TYPES[1];
    } else if (!closed && !started && ["preheating", "pouring"].includes(frame.state)) {
      started = true;
      eventType = SHOT_EVENT_TYPES[0];
    }
    phase = frame.state;
    if (replay || !eventType) return null;
    return {
      event_type: eventType,
      shot_id: frame.shotId ?? null,
      phase: frame.state,
      source_timestamp: frame.timestamp,
      scale_lost: Boolean(frame.scaleLost),
      stop_reason: eventType === SHOT_EVENT_TYPES[0] ? null : stopDecision?.reason ?? null,
      decision: eventType === SHOT_EVENT_TYPES[0] ? null : stopDecision,
    };
  };
}
