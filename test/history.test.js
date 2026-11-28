import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../src/index.js";

const T0 = 1_000_000;
const MINUTE = 60_000;

function point(id, minute, requests, errors, versionId) {
  return {
    id,
    start: T0 + minute * MINUTE,
    end: T0 + (minute + 1) * MINUTE,
    requests,
    errors,
    versionId
  };
}

test("历史窗口变化：同一指标在不同窗口下得到可复现的不同预算", () => {
  const points = [0, 1, 2, 3, 4, 5].map((minute) =>
    point(`p-${minute}`, minute, 1000, 20, "v1")
  );

  const narrow = analyze({
    window: { start: T0, end: T0 + 2 * MINUTE },
    versions: [{ id: "v1", target: 0.01, effectiveAt: T0 }],
    points,
    backfills: [],
    rules: [],
    silences: []
  });

  const wide = analyze({
    window: { start: T0, end: T0 + 6 * MINUTE },
    versions: [{ id: "v1", target: 0.01, effectiveAt: T0 }],
    points,
    backfills: [],
    rules: [],
    silences: []
  });

  const narrowBudget = narrow.versionBudgets[0];
  const wideBudget = wide.versionBudgets[0];

  assert.equal(narrowBudget.requests, 2000);
  assert.equal(narrowBudget.errorBudget, 20);
  assert.equal(narrowBudget.exhausted, true);

  assert.equal(wideBudget.requests, 6000);
  assert.equal(wideBudget.errorBudget, 60);
  assert.equal(wideBudget.exhausted, true);
  assert.equal(wideBudget.burnRate, narrowBudget.burnRate); // 同错误率下燃烧率相同
  assert.notDeepEqual(narrow.versionBoundaries, wide.versionBoundaries);
});

test("历史窗口收缩后，窗口外的数据点被标记为越界且不计入预算", () => {
  const result = analyze({
    window: { start: T0 + MINUTE, end: T0 + 3 * MINUTE },
    versions: [{ id: "v1", target: 0.01, effectiveAt: T0 + MINUTE }],
    points: [
      point("outside", 0, 1000, 500, "v1"),
      point("inside-1", 1, 1000, 1, "v1"),
      point("inside-2", 2, 1000, 1, "v1")
    ],
    backfills: [],
    rules: [],
    silences: []
  });

  assert.ok(result.review.some((item) => item.reason === "POINT_OUTSIDE_WINDOW"));
  assert.equal(result.versionBudgets[0].requests, 2000);
  assert.equal(result.versionBudgets[0].errors, 2);
});

test("非法输入被显式拒绝", () => {
  const valid = {
    window: { start: T0, end: T0 + MINUTE },
    versions: [{ id: "v1", target: 0.01, effectiveAt: T0 }],
    points: [point("p1", 0, 100, 1, "v1")],
    backfills: [],
    rules: [],
    silences: []
  };

  assert.throws(
    () => analyze({ ...valid, versions: [{ id: "v1", target: 1.5, effectiveAt: T0 }] }),
    /target/
  );
  assert.throws(
    () => analyze({ ...valid, points: [point("p1", 0, 10, 20, "v1")] }),
    /errors 不能大于 requests/
  );
  assert.throws(
    () => analyze({
      ...valid,
      points: [{ ...point("p1", 0, 10, 1, "v1"), versionId: "ghost" }]
    }),
    /未知版本/
  );
  assert.throws(
    () => analyze({
      ...valid,
      points: [
        point("p1", 0, 10, 1, "v1"),
        { ...point("p1", 0, 10, 1, "v1"), id: "p2" }
      ]
    }),
    /占据同一时间桶/
  );
});

test("端到端：目标切换 + 规则重叠 + 回填 + 静默的完整离线回放", () => {
  const result = analyze({
    window: { start: T0, end: T0 + 8 * MINUTE },
    versions: [
      { id: "v1", target: 0.01, effectiveAt: T0 },
      { id: "v2", target: 0.02, effectiveAt: T0 + 4 * MINUTE }
    ],
    points: [
      // v1 实时数据健康，靠回填把 p2 变成高燃烧桶来触发事故。
      point("p0", 0, 1000, 1, "v1"),
      point("p1", 1, 1000, 1, "v1"),
      point("p2", 2, 1000, 1, "v1"),
      point("p3", 3, 1000, 1, "v1"),
      point("p4", 4, 1000, 5, "v2"),
      point("p5", 5, 1000, 5, "v2"),
      point("p6", 6, 1000, 5, "v2"),
      point("p7", 7, 1000, 5, "v2")
    ],
    backfills: [
      {
        id: "bf-1",
        start: T0 + 2 * MINUTE,
        end: T0 + 3 * MINUTE,
        arrivedAt: T0 + 150_000,
        requests: 1000,
        errors: 100,
        versionId: "v1"
      }
    ],
    rules: [
      {
        id: "old-rule",
        versionId: "v1",
        burnRateThreshold: 2,
        lookbackMs: 2 * MINUTE,
        effectiveAt: T0,
        expiresAt: T0 + 6 * MINUTE
      },
      {
        id: "new-rule",
        versionId: "v2",
        burnRateThreshold: 2,
        lookbackMs: 2 * MINUTE,
        effectiveAt: T0 + 4 * MINUTE
      }
    ],
    silences: [
      { id: "sil-1", start: T0 + MINUTE, end: T0 + 2 * MINUTE, ruleId: "old-rule" }
    ]
  });

  assert.equal(result.requiresManualReview, true);
  assert.equal(result.mode, "offline");
  assert.ok(result.alertTransitions.length > 0);
  assert.ok(result.incidents.every((incident) => incident.sourceVersionId));
  assert.ok(
    result.review.some((item) => item.reason === "RULE_OVERLAP_ACTIVE")
  );
  assert.ok(
    result.review.some((item) => item.reason === "BACKFILL_ALTERS_STATE")
  );
  assert.equal(result.crossVersionBurnRate, null);

  const reasons = new Set(result.review.map((item) => item.reason));
  assert.ok(reasons.has("RULE_LATE_START"));

  // 回填桶的来源链同时包含实时与回填记录。
  const backfilled = result.series.find((item) => item.id === "p2");
  assert.equal(backfilled.errors, 100);
  assert.deepEqual(
    backfilled.provenanceChain.map((item) => item.kind),
    ["live", "backfill"]
  );
});
