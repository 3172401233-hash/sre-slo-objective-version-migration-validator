import { REVIEW } from "./reasons.js";
import { mergeAdjacent, overlapDuration } from "./time.js";
import { buildVersionSegments, overlapRatio } from "./versions.js";

function createAccumulator() {
  return {
    requests: 0,
    errors: 0,
    errorBudget: 0,
    matchedRequests: 0,
    matchedErrors: 0,
    excludedRequests: 0,
    excludedErrors: 0
  };
}

function round(value) {
  // 统一保留 10 位小数，规避浮点展示噪声，不参与判定逻辑。
  return Number(value.toFixed(10));
}

// 版本化预算计算：
// 1. 按版本边界切窗；2. 逐桶按重叠比例把计数分摊进所属版本；
// 3. 来源版本与区间版本不一致的计数剔除并报人工复核；
// 4. 跨版本绝不合并燃烧率，只汇总剩余预算总额。
export function calculateBudgets(input) {
  const review = [...input.review];
  const { window, versions } = input;
  const targetById = new Map(versions.map((version) => [version.id, version.target]));
  const { boundaries, segments, timeline } = buildVersionSegments(window, versions);

  const accumulators = new Map(
    versions.map((version) => [version.id, createAccumulator()])
  );

  for (const point of input.series ?? input.points) {
    const withinWindow = overlapDuration(point.start, point.end, window.start, window.end);
    if (withinWindow === 0) {
      continue;
    }

    let fullyMatched = true;
    for (const segment of segments) {
      const ratio = overlapRatio(point, segment);
      if (ratio === 0) {
        continue;
      }
      const requests = point.requests * ratio;
      const errors = point.errors * ratio;
      const accumulator = accumulators.get(segment.versionId);

      if (point.sourceVersionId !== segment.versionId) {
        fullyMatched = false;
        accumulator.excludedRequests += requests;
        accumulator.excludedErrors += errors;
        review.push({
          reason: REVIEW.VERSION_MISMATCH,
          at: Math.max(point.start, segment.start),
          pointId: point.id,
          expectedVersion: segment.versionId,
          sourceVersion: point.sourceVersionId,
          detail: `数据点来源版本 ${point.sourceVersionId} 落在 ${segment.versionId} 区间，计数已剔除，不能跨版本拼接燃烧率`
        });
        continue;
      }

      accumulator.requests += requests;
      accumulator.errors += errors;
      accumulator.matchedRequests += requests;
      accumulator.matchedErrors += errors;
    }

    if (!fullyMatched) {
      // 标记留给调用方/测试断言使用，不改变上面的复核记录。
      point.hasVersionMismatch = true;
    }
  }

  const versionResults = versions.map((version) => {
    const accumulator = accumulators.get(version.id);
    const target = version.target;
    const errorBudget = accumulator.requests * target;
    const errorRate = accumulator.requests > 0 ? accumulator.errors / accumulator.requests : 0;
    const burnRate = errorBudget > 0 ? accumulator.errors / errorBudget : 0;
    const remainingBudget = errorBudget - accumulator.errors;
    const exhausted = errorBudget > 0 && accumulator.errors >= errorBudget;

    const owningSegments = segments.filter((segment) => segment.versionId === version.id);
    const series = input.series ?? input.points;
    for (const segment of owningSegments) {
      const hasData = series.some(
        (point) => overlapDuration(point.start, point.end, segment.start, segment.end) > 0
      );
      if (!hasData) {
        review.push({
          reason: REVIEW.EMPTY_WINDOW,
          at: segment.start,
          versionId: version.id,
          detail: `版本 ${version.id} 的区间 [${segment.start}, ${segment.end}) 没有任何指标桶，预算结果无法被数据证实`
        });
      }
    }

    return {
      versionId: version.id,
      target,
      effectiveAt: version.effectiveAt,
      requests: round(accumulator.requests),
      errors: round(accumulator.errors),
      errorBudget: round(errorBudget),
      errorRate: round(errorRate),
      burnRate: round(burnRate),
      remainingBudget: round(remainingBudget),
      exhausted,
      excludedRequests: round(accumulator.excludedRequests),
      excludedErrors: round(accumulator.excludedErrors),
      segments: owningSegments.map((segment) => ({ start: segment.start, end: segment.end }))
    };
  });

  // 剩余预算是同量纲的绝对错误数，可以安全求和；燃烧率刻意不提供跨版本合并值。
  const totalRemainingBudget = round(
    versionResults.reduce((sum, result) => sum + result.remainingBudget, 0)
  );
  const totalErrorBudget = round(
    versionResults.reduce((sum, result) => sum + result.errorBudget, 0)
  );

  // 可合并区间：相邻且归属同版本的区间才允许合并（不同版本之间天然断裂）。
  const mergeableIntervals = mergeAdjacent(
    segments.map((segment) => ({
      start: segment.start,
      end: segment.end,
      key: segment.versionId
    }))
  ).map((segment) => ({ start: segment.start, end: segment.end, versionId: segment.key }));

  return {
    window,
    versionBoundaries: timeline,
    boundaries,
    versionBudgets: versionResults,
    totalErrorBudget,
    totalRemainingBudget,
    crossVersionBurnRate: null,
    crossVersionBurnRateNote:
      "跨版本目标值不同，燃烧率不可直接拼接；如需整体视角，只汇总绝对剩余预算。",
    mergeableIntervals,
    review
  };
}

// 供回放器复用：在某个时间点向前回看 lookbackMs，只统计与规则版本一致的数据。
// versionSegments 非空时，优先用版本区间判断回看窗口是否跨越版本边界。
export function summarizeLookback(series, rule, at, targetById, versionSegments = []) {
  const lookbackStart = at - rule.lookbackMs;
  let requests = 0;
  let errors = 0;
  let coveredMs = 0;
  let crossedVersionBoundary = false;

  if (versionSegments.length > 0) {
    const touchedVersions = new Set();
    for (const segment of versionSegments) {
      if (Math.max(segment.start, lookbackStart) < Math.min(segment.end, at)) {
        touchedVersions.add(segment.versionId);
      }
    }
    crossedVersionBoundary = touchedVersions.size > 1;
  }

  for (const point of series) {
    const duration = overlapDuration(point.start, point.end, lookbackStart, at);
    if (duration === 0) {
      continue;
    }
    const ratio = duration / (point.end - point.start);
    // 覆盖率基于全部实际存在的桶，异版本桶随后再从燃烧率计算中剔除。
    coveredMs += duration;
    if (point.sourceVersionId !== rule.versionId) {
      if (versionSegments.length === 0) {
        crossedVersionBoundary = true;
      }
      continue;
    }
    requests += point.requests * ratio;
    errors += point.errors * ratio;
  }

  const target = targetById.get(rule.versionId);
  const errorBudget = requests * target;
  const burnRate = errorBudget > 0 ? errors / errorBudget : 0;
  const coverage = Math.min(1, coveredMs / rule.lookbackMs);

  return {
    lookbackStart,
    requests: round(requests),
    errors: round(errors),
    burnRate: round(burnRate),
    coverage: round(coverage),
    crossedVersionBoundary
  };
}
