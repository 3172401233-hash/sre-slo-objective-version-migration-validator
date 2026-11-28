import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../src/index.js";
import { calculateBudgets } from "../src/calculator.js";
import { normalizeInput } from "../src/schema.js";
import { applyBackfills } from "../src/backfill.js";

const T0 = 1_000_000;
const MINUTE = 60_000;

function point(id, startOffset, requests, errors, versionId, durationMs = MINUTE) {
  return {
    id,
    start: T0 + startOffset * MINUTE,
    end: T0 + startOffset * MINUTE + durationMs,
    requests,
    errors,
    versionId
  };
}

function baseInput(overrides = {}) {
  return {
    window: { start: T0, end: T0 + 10 * MINUTE },
    versions: [
      { id: "v1", target: 0.01, effectiveAt: T0 },
      { id: "v2", target: 0.02, effectiveAt: T0 + 5 * MINUTE }
    ],
    points: [
      point("p1", 0, 1000, 5, "v1"),
      point("p2", 1, 1000, 5, "v1"),
      point("p3", 2, 1000, 5, "v1"),
      point("p4", 3, 1000, 5, "v1"),
      point("p5", 4, 1000, 5, "v1"),
      point("p6", 5, 1000, 5, "v2"),
      point("p7", 6, 1000, 5, "v2"),
      point("p8", 7, 1000, 5, "v2"),
      point("p9", 8, 1000, 5, "v2"),
      point("p10", 9, 1000, 5, "v2")
    ],
    backfills: [],
    rules: [],
    silences: [],
    ...overrides
  };
}

function runCalc(input) {
  const normalized = normalizeInput(input);
  const { series, review } = applyBackfills(normalized.points, normalized.backfills);
  normalized.series = series;
  normalized.review.push(...review);
  return calculateBudgets(normalized);
}

test("目标切换：各版本独立计算预算且不拼接跨版本燃烧率", () => {
  const result = runCalc(baseInput());

  assert.deepEqual(
    result.versionBoundaries.map((item) => [item.at, item.versionId, item.kind]),
    [
      [T0, "v1", "window-start"],
      [T0 + 5 * MINUTE, "v2", "version-effective"],
      [T0 + 10 * MINUTE, "v2", "window-end"]
    ]
  );

  const v1 = result.versionBudgets.find((item) => item.versionId === "v1");
  const v2 = result.versionBudgets.find((item) => item.versionId === "v2");

  assert.equal(v1.requests, 5000);
  assert.equal(v1.errors, 25);
  assert.equal(v1.errorBudget, 50); // 5000 * 0.01
  assert.equal(v1.burnRate, 0.5); // 25 / 50
  assert.equal(v1.remainingBudget, 25);

  assert.equal(v2.requests, 5000);
  assert.equal(v2.errors, 25);
  assert.equal(v2.errorBudget, 100); // 5000 * 0.02
  assert.equal(v2.burnRate, 0.25); // 25 / 100
  assert.equal(v2.remainingBudget, 75);

  assert.equal(result.totalErrorBudget, 150);
  assert.equal(result.totalRemainingBudget, 100);
  assert.equal(result.crossVersionBurnRate, null);
  assert.match(result.crossVersionBurnRateNote, /不可直接拼接/);
});

test("版本边界输出可合并区间，跨版本区间不会被合并", () => {
  const input = baseInput({
    versions: [
      { id: "v1", target: 0.01, effectiveAt: T0 },
      { id: "v2", target: 0.02, effectiveAt: T0 + 3 * MINUTE },
      { id: "v3", target: 0.015, effectiveAt: T0 + 7 * MINUTE }
    ],
    points: [
      point("p1", 0, 100, 1, "v1"),
      point("p2", 1, 100, 1, "v1"),
      point("p3", 2, 100, 1, "v1"),
      point("p4", 3, 100, 1, "v2"),
      point("p5", 4, 100, 1, "v2"),
      point("p6", 5, 100, 1, "v2"),
      point("p7", 6, 100, 1, "v2"),
      point("p8", 7, 100, 1, "v3"),
      point("p9", 8, 100, 1, "v3"),
      point("p10", 9, 100, 1, "v3")
    ]
  });

  const result = runCalc(input);
  assert.deepEqual(
    result.mergeableIntervals.map((item) => [item.start - T0, item.end - T0, item.versionId]),
    [
      [0, 3 * MINUTE, "v1"],
      [3 * MINUTE, 7 * MINUTE, "v2"],
      [7 * MINUTE, 10 * MINUTE, "v3"]
    ]
  );

  // 同一版本被新版本隔开时不会跨越中间版本合并。
  const toggled = baseInput({
    versions: [
      { id: "v1", target: 0.01, effectiveAt: T0 },
      { id: "v2", target: 0.02, effectiveAt: T0 + 3 * MINUTE },
      { id: "v1", target: 0.01, effectiveAt: T0 + 7 * MINUTE }
    ]
  });
  assert.throws(() => runCalc(toggled), /重复的 id/);
});

test("来源版本与区间版本不一致的桶被剔除并产生人工复核", () => {
  const input = baseInput();
  // 第 6 个桶处于 v2 区间，却带着 v1 的来源版本。
  input.points[5].versionId = "v1";

  const result = runCalc(input);
  const mismatch = result.review.find((item) => item.reason === "POINT_VERSION_MISMATCH");
  assert.ok(mismatch);
  assert.equal(mismatch.sourceVersion, "v1");
  assert.equal(mismatch.expectedVersion, "v2");

  const v2 = result.versionBudgets.find((item) => item.versionId === "v2");
  assert.equal(v2.requests, 4000);
  assert.equal(v2.excludedRequests, 1000);
  assert.equal(v2.excludedErrors, 5);
});

test("跨边界数据桶按重叠比例分摊，且只计入来源匹配的版本", () => {
  const input = {
    window: { start: T0, end: T0 + 4 * MINUTE },
    versions: [
      { id: "v1", target: 0.01, effectiveAt: T0 },
      { id: "v2", target: 0.02, effectiveAt: T0 + 2 * MINUTE }
    ],
    points: [
      // 一个两分钟的桶跨越版本边界。
      {
        id: "span",
        start: T0 + MINUTE,
        end: T0 + 3 * MINUTE,
        requests: 2000,
        errors: 20,
        versionId: "v1"
      }
    ],
    backfills: [],
    rules: [],
    silences: []
  };

  const result = runCalc(input);
  const v1 = result.versionBudgets.find((item) => item.versionId === "v1");
  const v2 = result.versionBudgets.find((item) => item.versionId === "v2");

  assert.equal(v1.requests, 1000);
  assert.equal(v1.errors, 10);
  // v2 区间的一半因来源版本不匹配被剔除。
  assert.equal(v2.requests, 0);
  assert.equal(v2.excludedRequests, 1000);
  assert.ok(result.review.some((item) => item.reason === "POINT_VERSION_MISMATCH"));
});

test("无数据的版本区间进入人工复核列表", () => {
  const input = baseInput({
    points: baseInput().points.slice(0, 5)
  });
  const result = runCalc(input);
  assert.ok(
    result.review.some((item) => item.reason === "EMPTY_WINDOW_SEGMENT" && item.versionId === "v2")
  );
});

test("analyze 顶层输出保留每个数据桶的来源版本与来源链", () => {
  const result = analyze(baseInput());
  assert.equal(result.mode, "offline");
  assert.equal(result.series[0].sourceVersionId, "v1");
  assert.equal(result.series[0].provenance, "live");
  assert.deepEqual(result.series[0].provenanceChain[0], {
    kind: "live",
    eventId: "p1",
    versionId: "v1"
  });
});
