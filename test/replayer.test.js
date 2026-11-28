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

function highBurnPoints(prefix, versionId, minutes, requests = 1000) {
  // 错误率 10%，对 target=0.01 的版本燃烧率为 10。
  return minutes.map((minute) => point(`${prefix}-${minute}`, minute, requests, requests * 0.1, versionId));
}

function healthyPoints(prefix, versionId, minutes, requests = 1000) {
  return minutes.map((minute) => point(`${prefix}-${minute}`, minute, requests, 0, versionId));
}

test("规则重叠生效：两条规则独立评估，各自只认本版本数据", () => {
  const input = {
    window: { start: T0, end: T0 + 8 * MINUTE },
    versions: [
      { id: "v1", target: 0.01, effectiveAt: T0 },
      { id: "v2", target: 0.01, effectiveAt: T0 + 4 * MINUTE }
    ],
    points: [
      ...highBurnPoints("old", "v1", [0, 1, 2, 3]),
      ...healthyPoints("new", "v2", [4, 5, 6, 7])
    ],
    backfills: [],
    rules: [
      {
        id: "rule-old",
        versionId: "v1",
        burnRateThreshold: 2,
        lookbackMs: 2 * MINUTE,
        effectiveAt: T0,
        expiresAt: T0 + 6 * MINUTE
      },
      {
        id: "rule-new",
        versionId: "v2",
        burnRateThreshold: 2,
        lookbackMs: 2 * MINUTE,
        effectiveAt: T0 + 4 * MINUTE
      }
    ],
    silences: []
  };

  const result = analyze(input);

  const overlapReview = result.review.find((item) => item.reason === "RULE_OVERLAP_ACTIVE");
  assert.ok(overlapReview);
  assert.deepEqual(overlapReview.ruleIds.sort(), ["rule-new", "rule-old"]);

  const oldOpen = result.alertTransitions.find(
    (transition) => transition.ruleId === "rule-old" && transition.toState === "firing"
  );
  assert.ok(oldOpen);
  assert.equal(oldOpen.incidentId, "INC-0001");

  // 新规则在健康的 v2 数据上始终不应触发。
  assert.ok(
    !result.alertTransitions.some(
      (transition) => transition.ruleId === "rule-new" && transition.toState === "firing"
    )
  );

  // 旧规则到期时事故仍开着：不能自动/追溯关闭，进入人工复核。
  const oldState = result.alertFinalStates.find((state) => state.ruleId === "rule-old");
  assert.equal(oldState.state, "expired-open");
  assert.ok(
    result.review.some(
      (item) => item.reason === "FIRING_RULE_EXPIRED" && item.ruleId === "rule-old"
    )
  );

  const incident = result.incidents.find((item) => item.incidentId === "INC-0001");
  assert.equal(incident.closedAt, null);
  assert.equal(incident.sourceVersionId, "v1");
});

test("规则晚生效不能追溯关闭窗口开始前已经燃烧的事故", () => {
  const input = {
    window: { start: T0, end: T0 + 6 * MINUTE },
    versions: [{ id: "v1", target: 0.01, effectiveAt: T0 }],
    points: [
      ...highBurnPoints("hot", "v1", [0, 1, 2]),
      ...healthyPoints("cool", "v1", [3, 4, 5])
    ],
    backfills: [],
    rules: [
      {
        id: "late-rule",
        versionId: "v1",
        burnRateThreshold: 2,
        lookbackMs: MINUTE,
        effectiveAt: T0 + 2 * MINUTE
      }
    ],
    silences: []
  };

  const result = analyze(input);

  assert.ok(
    result.review.some((item) => item.reason === "RULE_LATE_START" && item.ruleId === "late-rule")
  );

  // 规则在 T0+2min 才生效，首个评估点是生效后的第一个桶结束点 T0+2min；
  // 生效前 T0/T0+1min 的高燃烧期不会被补判，体现"不追溯"。
  const firstTransition = result.alertTransitions[0];
  assert.equal(firstTransition.at, T0 + 2 * MINUTE);
  assert.equal(firstTransition.ruleId, "late-rule");

  // T0+3min 的回看仍包含高燃烧桶 hot-2；T0+4min 起只剩健康桶，事故恢复。
  const resolved = result.alertTransitions.find((item) => item.toState === "resolved");
  assert.equal(resolved.at, T0 + 4 * MINUTE);
  assert.equal(resolved.reason, "threshold-recovered");
});

test("静默期间触发的事故进入 suppressed，静默结束恢复 firing", () => {
  const input = {
    window: { start: T0, end: T0 + 5 * MINUTE },
    versions: [{ id: "v1", target: 0.01, effectiveAt: T0 }],
    points: highBurnPoints("hot", "v1", [0, 1, 2, 3, 4]),
    backfills: [],
    rules: [
      {
        id: "rule-1",
        versionId: "v1",
        burnRateThreshold: 2,
        lookbackMs: MINUTE,
        effectiveAt: T0
      }
    ],
    silences: [
      { id: "sil-1", start: T0 + MINUTE, end: T0 + 3 * MINUTE }
    ]
  };

  const result = analyze(input);
  const states = result.alertTransitions.map((item) => [item.at - T0, item.toState, item.reason]);

  assert.deepEqual(states, [
    [MINUTE, "suppressed", "threshold-breached"],
    [3 * MINUTE, "firing", "silence-ended"]
  ]);

  assert.ok(result.review.some((item) => item.reason === "SILENCE_WHILE_FIRING"));
  const incident = result.incidents[0];
  assert.equal(incident.silenced, true);
});

test("回填数据保留来源版本，且回填驱动的状态翻转被显式标注", () => {
  const input = {
    window: { start: T0, end: T0 + 4 * MINUTE },
    versions: [{ id: "v1", target: 0.01, effectiveAt: T0 }],
    // 实时数据全部健康。
    points: healthyPoints("live", "v1", [0, 1, 2, 3]),
    backfills: [
      {
        id: "bf-1",
        start: T0 + MINUTE,
        end: T0 + 2 * MINUTE,
        arrivedAt: T0 + 90_000,
        requests: 1000,
        errors: 100,
        versionId: "v1"
      }
    ],
    rules: [
      {
        id: "rule-1",
        versionId: "v1",
        burnRateThreshold: 2,
        lookbackMs: MINUTE,
        effectiveAt: T0
      }
    ],
    silences: []
  };

  const result = analyze(input);

  const backfilled = result.series.find((item) => item.id === "live-1");
  assert.equal(backfilled.provenance, "backfill");
  assert.equal(backfilled.sourceVersionId, "v1");
  assert.equal(backfilled.errors, 100);
  assert.equal(backfilled.provenanceChain.length, 2);
  assert.equal(backfilled.provenanceChain[1].eventId, "bf-1");

  const fired = result.alertTransitions.find((item) => item.toState === "firing");
  assert.equal(fired.at, T0 + 2 * MINUTE);
  assert.equal(fired.backfillInfluenced, true);
  assert.ok(
    result.review.some((item) => item.reason === "BACKFILL_ALTERS_STATE")
  );
});

test("回填来源版本与桶内来源版本冲突时双方来源都保留并人工复核", () => {
  const input = {
    window: { start: T0, end: T0 + 3 * MINUTE },
    versions: [
      { id: "v1", target: 0.01, effectiveAt: T0 },
      { id: "v2", target: 0.02, effectiveAt: T0 + 2 * MINUTE }
    ],
    points: [
      point("live-0", 0, 1000, 0, "v1"),
      point("live-1", 1, 1000, 0, "v1")
    ],
    backfills: [
      {
        id: "bf-x",
        start: T0 + MINUTE,
        end: T0 + 2 * MINUTE,
        arrivedAt: T0 + 90_000,
        requests: 1000,
        errors: 10,
        versionId: "v2"
      }
    ],
    rules: [],
    silences: []
  };

  const result = analyze(input);
  const conflict = result.review.find((item) => item.reason === "BACKFILL_VERSION_CONFLICT");
  assert.ok(conflict);
  assert.equal(conflict.backfillId, "bf-x");

  const bucket = result.series.find((item) => item.id === "live-1");
  assert.equal(bucket.sourceVersionId, "v2");
  const chainVersions = bucket.provenanceChain.map((item) => item.versionId);
  assert.deepEqual(chainVersions, ["v1", "v2"]);
});

test("回看窗口覆盖率不足时不做自动翻转并人工复核", () => {
  const input = {
    window: { start: T0, end: T0 + 3 * MINUTE },
    versions: [{ id: "v1", target: 0.01, effectiveAt: T0 }],
    points: [
      point("only-bucket", 0, 1000, 100, "v1")
    ],
    backfills: [],
    rules: [
      {
        id: "rule-1",
        versionId: "v1",
        burnRateThreshold: 2,
        lookbackMs: 10 * MINUTE,
        minCoverage: 0.9,
        effectiveAt: T0
      }
    ],
    silences: []
  };

  const result = analyze(input);
  assert.equal(result.alertTransitions.length, 0);
  assert.ok(
    result.review.some((item) => item.reason === "LOOKBACK_INSUFFICIENT_COVERAGE")
  );
});

test("回看窗口跨版本边界时剔除异版本桶并记录复核", () => {
  const input = {
    window: { start: T0, end: T0 + 6 * MINUTE },
    versions: [
      { id: "v1", target: 0.01, effectiveAt: T0 },
      { id: "v2", target: 0.01, effectiveAt: T0 + 3 * MINUTE }
    ],
    points: [
      ...healthyPoints("a", "v1", [0, 1, 2]),
      ...highBurnPoints("b", "v2", [3, 4, 5])
    ],
    backfills: [],
    rules: [
      {
        id: "rule-v1",
        versionId: "v1",
        burnRateThreshold: 2,
        // 3 分钟回看：在 T0+5min 评估时窗口 [T0+2, T0+5) 同时覆盖 v1/v2，
        // 且全部被数据桶覆盖，覆盖率检查不会先短路。
        lookbackMs: 3 * MINUTE,
        effectiveAt: T0
      }
    ],
    silences: []
  };

  const result = analyze(input);
  // T0+5min 回看 [T0+2, T0+5) 同时包含 v1 与 v2 桶；v2 桶必须被剔除。
  assert.ok(
    result.review.some((item) => item.reason === "CROSS_VERSION_LOOKBACK")
  );
  const v1Rule = result.alertFinalStates.find((item) => item.ruleId === "rule-v1");
  assert.notEqual(v1Rule.state, "firing");
});
