import { applyBackfills } from "./backfill.js";
import { calculateBudgets } from "./calculator.js";
import { replayAlerts } from "./replayer.js";
import { normalizeInput } from "./schema.js";

// 离线分析唯一入口：归一化 -> 回填 -> 预算 -> 回放。
// 整个流程不访问任何线上监控系统，只消费调用方提供的历史输入。
export function analyze(input) {
  const normalized = normalizeInput(input);
  const { series, review: backfillReview } = applyBackfills(
    normalized.points,
    normalized.backfills
  );
  normalized.review.push(...backfillReview);
  normalized.series = series;

  const budgets = calculateBudgets(normalized);
  const replay = replayAlerts(normalized, budgets);

  const review = dedupeReview([...budgets.review, ...replay.review]);

  return {
    mode: "offline",
    generatedFrom: {
      window: normalized.window,
      versionCount: normalized.versions.length,
      pointCount: series.length,
      backfillCount: normalized.backfills.length,
      ruleCount: normalized.rules.length,
      silenceCount: normalized.silences.length
    },
    window: normalized.window,
    versionBoundaries: budgets.versionBoundaries,
    mergeableIntervals: budgets.mergeableIntervals,
    versionBudgets: budgets.versionBudgets,
    totalErrorBudget: budgets.totalErrorBudget,
    totalRemainingBudget: budgets.totalRemainingBudget,
    crossVersionBurnRate: budgets.crossVersionBurnRate,
    crossVersionBurnRateNote: budgets.crossVersionBurnRateNote,
    series: series.map((point) => ({
      id: point.id,
      start: point.start,
      end: point.end,
      requests: point.requests,
      errors: point.errors,
      versionId: point.versionId,
      sourceVersionId: point.sourceVersionId,
      provenance: point.provenance,
      provenanceChain: point.provenanceChain
    })),
    alertTransitions: replay.transitions,
    alertFinalStates: replay.finalStates,
    incidents: replay.incidents,
    review,
    requiresManualReview: review.length > 0
  };
}

function dedupeReview(entries) {
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    const key = JSON.stringify(entry);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(entry);
    }
  }
  result.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  return result;
}
