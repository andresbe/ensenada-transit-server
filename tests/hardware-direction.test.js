const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  defaultHardwareDirectionConfig,
  evaluateHardwareDirection,
  hardwareDirectionConfigFromEnv,
  hardwareDirectionGeometryFingerprint,
} = require("../dist/tracking/hardwareDirection");

const routeId = "route";
const points = Array.from({ length: 41 }, (_, index) => ({
  latitude: 31.86,
  longitude: -116.62 + index * 0.0005,
}));
const variants = [
  {
    id: "ida",
    routeId,
    direction: "ida",
    points,
    totalDistanceMeters: 1900,
    updatedAt: "2026-11-21T01:33:31.301Z",
  },
  {
    id: "vuelta",
    routeId,
    direction: "vuelta",
    points: [...points].reverse(),
    totalDistanceMeters: 1900,
    updatedAt: "2026-11-21T01:33:31.301Z",
  },
];
const fingerprint = hardwareDirectionGeometryFingerprint(variants);
const context = (assignmentId = "assignment", assignedRouteVariantId = "ida", geometryFingerprint = fingerprint) => ({
  assignmentId,
  routeId,
  assignedRouteVariantId,
  geometryFingerprint,
});
const baseTime = Date.parse("2026-11-20T14:00:00Z");
const observation = (index, timestamp, patch = {}) => ({
  ...points[index],
  timestamp,
  speedMps: 4,
  heading: 90,
  satellites: 9,
  ...patch,
});

function feed(indices, options = {}) {
  const interval = options.interval ?? 30000;
  const start = options.start ?? baseTime;
  const ctx = options.context ?? context();
  let state = options.state;
  let result;
  for (let offset = 0; offset < indices.length; offset++) {
    const index = indices[offset];
    const direction = offset === 0 || index >= indices[offset - 1] ? 90 : 270;
    result = evaluateHardwareDirection(
      ctx,
      variants,
      state,
      observation(index, start + offset * interval, {
        heading: direction,
        ...(options.patch ?? {}),
      }),
      options.config ?? defaultHardwareDirectionConfig,
    );
    state = result.state;
  }
  return { state, result, nextTime: start + indices.length * interval };
}

function confirmedIda(interval = 30000) {
  return feed([4, 6, 8, 10], { interval });
}

function idaAtTerminal() {
  const initial = confirmedIda();
  return feed([12, 16, 20, 24, 28, 32, 36, 40], {
    state: initial.state,
    start: initial.nextTime,
  });
}

test("normal ida and Teltonika-style 30-second observations confirm without heading dependence", () => {
  const { state, result } = feed([4, 6, 8, 10], { patch: { heading: undefined } });
  assert.equal(state.detectedRouteVariantId, "ida");
  assert.equal(state.detectionConfidence, "high");
  assert.equal(result.reason, "initial_direction_confirmed");
  assert.equal(result.switched, false);
});

test("normal vuelta and Ruptela-style 60-second observations confirm from mid-route", () => {
  const { state, result } = feed([30, 28, 26, 24], {
    interval: 60000,
    patch: { heading: 270 },
  });
  assert.equal(state.detectedRouteVariantId, "vuelta");
  assert.equal(result.reason, "initial_direction_confirmed");
});

test("ida to vuelta and vuelta to ida transitions require sustained terminal evidence", () => {
  const terminal = idaAtTerminal();
  const returned = feed([38, 36, 34], {
    state: terminal.state,
    start: terminal.nextTime,
  });
  assert.equal(returned.state.detectedRouteVariantId, "vuelta");
  assert.equal(returned.result.reason, "direction_switched_terminal");
  assert.equal(returned.result.switched, true);

  const westTerminal = feed([30, 24, 18, 12, 6, 0], {
    state: returned.state,
    start: returned.nextTime,
  });
  const outboundAgain = feed([2, 4, 6], {
    state: westTerminal.state,
    start: westTerminal.nextTime,
  });
  assert.equal(outboundAgain.state.detectedRouteVariantId, "ida");
  assert.equal(outboundAgain.result.reason, "direction_switched_terminal");
});

test("stationary GPS noise and poor fixes cannot change a confirmed direction", () => {
  const initial = confirmedIda();
  let state = initial.state;
  for (let index = 0; index < 8; index++) {
    const noisy = evaluateHardwareDirection(
      context(),
      variants,
      state,
      {
        latitude: points[10].latitude + (index % 2 ? 0.00008 : -0.00008),
        longitude: points[10].longitude + (index % 2 ? -0.00008 : 0.00008),
        timestamp: initial.nextTime + index * 30000,
        speedMps: 0,
        heading: index % 2 ? 270 : 90,
        satellites: index === 7 ? 2 : 8,
      },
    );
    state = noisy.state;
    assert.notEqual(noisy.reason, "direction_switched_geometric");
  }
  assert.equal(state.detectedRouteVariantId, "ida");
  assert.equal(state.candidateRouteVariantId, undefined);
});

test("a short temporary U-turn does not satisfy geometric switch hysteresis", () => {
  const initial = feed([8, 10, 12, 14, 16], {});
  const config = { ...defaultHardwareDirectionConfig, minDisplacementMeters: 10 };
  const uTurn = feed([15, 14, 13, 12], {
    state: initial.state,
    start: initial.nextTime,
    config,
  });
  assert.equal(uTurn.state.detectedRouteVariantId, "ida");
  assert.equal(uTurn.result.reason, "candidate_evidence");
  const recovered = feed([14, 16, 18], {
    state: uTurn.state,
    start: uTurn.nextTime,
    config,
  });
  assert.equal(recovered.state.detectedRouteVariantId, "ida");
  assert.equal(recovered.state.candidateRouteVariantId, undefined);
});

test("oppositely ordered shared geometry is disambiguated by displacement and progress", () => {
  const { result, state } = feed([18, 16, 14, 12]);
  assert.equal(state.detectedRouteVariantId, "vuelta");
  assert.ok(result.metrics.vuelta.progressDeltaMeters > 0);
  assert.ok(result.metrics.ida.progressDeltaMeters < 0);
  assert.equal(result.metrics.vuelta.strongEvidence, true);
});

test("signal loss rebaselines motion while preserving the last confirmed direction", () => {
  const initial = confirmedIda();
  const gap = evaluateHardwareDirection(
    context(),
    variants,
    initial.state,
    observation(14, initial.nextTime + 11 * 60 * 1000),
  );
  assert.equal(gap.reason, "signal_gap_rebaseline");
  assert.equal(gap.state.detectedRouteVariantId, "ida");
  assert.equal(gap.state.candidateRouteVariantId, undefined);
  const recovered = evaluateHardwareDirection(
    context(),
    variants,
    gap.state,
    observation(16, initial.nextTime + 11.5 * 60 * 1000),
  );
  assert.equal(recovered.reason, "confirmed_direction_supported");
});

test("duplicate and delayed observations are idempotent and do not alter evidence", () => {
  const initial = confirmedIda();
  const before = structuredClone(initial.state);
  const duplicate = evaluateHardwareDirection(
    context(), variants, initial.state,
    observation(11, initial.state.lastObservationAt),
  );
  assert.equal(duplicate.reason, "duplicate");
  assert.deepEqual(duplicate.state, before);
  const delayed = evaluateHardwareDirection(
    context(), variants, initial.state,
    observation(9, initial.state.lastObservationAt - 1000),
  );
  assert.equal(delayed.reason, "out_of_order");
  assert.deepEqual(delayed.state, before);
});

test("persisted state survives backend restart and devices remain independent", () => {
  const first = confirmedIda();
  const restored = structuredClone(first.state);
  const afterRestart = evaluateHardwareDirection(
    context(), variants, restored,
    observation(12, first.nextTime),
  );
  assert.equal(afterRestart.state.detectedRouteVariantId, "ida");
  assert.equal(afterRestart.reason, "confirmed_direction_supported");

  const other = feed([30, 28, 26, 24], {
    context: context("other-assignment"),
    interval: 60000,
  });
  assert.equal(other.state.detectedRouteVariantId, "vuelta");
  assert.equal(afterRestart.state.detectedRouteVariantId, "ida");
});

test("assignment and geometry changes discard stale detected state", () => {
  const initial = confirmedIda();
  const assignmentReset = evaluateHardwareDirection(
    context("new-assignment", "vuelta"),
    variants,
    initial.state,
    observation(20, initial.nextTime),
  );
  assert.equal(assignmentReset.reason, "assignment_changed");
  assert.equal(assignmentReset.state.detectedRouteVariantId, undefined);
  assert.equal(assignmentReset.state.assignedRouteVariantId, "vuelta");

  const geometryReset = evaluateHardwareDirection(
    context("assignment", "ida", "f".repeat(64)),
    variants,
    initial.state,
    observation(20, initial.nextTime),
  );
  assert.equal(geometryReset.reason, "geometry_changed");
  assert.equal(geometryReset.state.detectedRouteVariantId, undefined);
});

test("unrealistic jumps, off-route movement and one opposite sample cannot flip direction", () => {
  const initial = confirmedIda();
  const jump = evaluateHardwareDirection(
    context(), variants, initial.state,
    { ...observation(40, initial.nextTime + 1000), longitude: -115.5 },
  );
  assert.equal(jump.reason, "unrealistic_jump");
  assert.equal(jump.state.detectedRouteVariantId, "ida");
  const poorHdop = evaluateHardwareDirection(
    context(), variants, initial.state,
    observation(12, initial.nextTime, { hdop: 12 }),
  );
  assert.equal(poorHdop.reason, "poor_gps_quality");
  assert.equal(poorHdop.state.detectedRouteVariantId, "ida");
  const oneOpposite = evaluateHardwareDirection(
    context(), variants, initial.state,
    observation(8, initial.nextTime, { heading: 270 }),
  );
  assert.equal(oneOpposite.state.detectedRouteVariantId, "ida");
  assert.equal(oneOpposite.state.candidateRouteVariantId, "vuelta");
});

test("environment tuning accepts bounded values and rejects incoherent thresholds", () => {
  const configured = hardwareDirectionConfigFromEnv({
    HARDWARE_DIRECTION_SWITCH_OBSERVATIONS: "6",
    HARDWARE_DIRECTION_SWITCH_DISTANCE_METERS: "450",
    HARDWARE_DIRECTION_MAX_OBSERVATION_GAP_SECONDS: "900",
  });
  assert.equal(configured.switchEvidenceCount, 6);
  assert.equal(configured.switchDistanceMeters, 450);
  assert.equal(configured.maxObservationGapSeconds, 900);
  assert.throws(
    () => hardwareDirectionConfigFromEnv({ HARDWARE_DIRECTION_SWITCH_OBSERVATIONS: "3.5" }),
    /integer/,
  );
  assert.throws(
    () => hardwareDirectionConfigFromEnv({
      HARDWARE_DIRECTION_MAX_ROUTE_DISTANCE_METERS: "40",
      HARDWARE_DIRECTION_STRONG_ROUTE_DISTANCE_METERS: "50",
    }),
    /cannot exceed/,
  );
  assert.throws(
    () => hardwareDirectionConfigFromEnv({
      HARDWARE_DIRECTION_SWITCH_OBSERVATIONS: "3",
      HARDWARE_DIRECTION_MIN_STRONG_OBSERVATIONS: "4",
    }),
    /cannot exceed/,
  );
});
