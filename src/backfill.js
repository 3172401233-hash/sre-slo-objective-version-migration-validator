import { REVIEW } from "./reasons.js";
import { overlapDuration } from "./time.js";

// 回填按到达顺序处理。回填会替换同时间桶的实时点（或之前的回填），
// 但必须保留 sourceVersionId 与 provenance 链，禁止抹掉来源。
export function applyBackfills(points, backfills) {
  const review = [];
  const series = points.map((point) => ({
    ...point,
    sourceVersionId: point.versionId,
    provenance: "live",
    provenanceChain: [
      {
        kind: "live",
        eventId: point.id,
        versionId: point.versionId
      }
    ]
  }));

  for (const backfill of backfills) {
    const matches = [];
    for (let index = 0; index < series.length; index += 1) {
      if (overlapDuration(series[index].start, series[index].end, backfill.start, backfill.end) > 0) {
        matches.push(index);
      }
    }

    if (matches.length === 0) {
      // 回填的桶在实时序列里不存在：作为新桶补入，之后统一排序。
      series.push({
        id: `backfill:${backfill.id}`,
        start: backfill.start,
        end: backfill.end,
        requests: backfill.requests,
        errors: backfill.errors,
        versionId: backfill.versionId,
        sourceVersionId: backfill.versionId,
        provenance: "backfill",
        provenanceChain: [
          {
            kind: "backfill",
            eventId: backfill.id,
            versionId: backfill.versionId,
            arrivedAt: backfill.arrivedAt
          }
        ]
      });
      continue;
    }

    for (const index of matches) {
      const target = series[index];
      if (target.sourceVersionId !== backfill.versionId) {
        review.push({
          reason: REVIEW.BACKFILL_VERSION_CONFLICT,
          at: backfill.arrivedAt,
          pointId: target.id,
          backfillId: backfill.id,
          detail: `回填来源版本 ${backfill.versionId} 与桶内来源版本 ${target.sourceVersionId} 不一致，已保留双方来源记录`
        });
      }
      // 回填权威：计数以回填为准，来源版本沿用回填声明。
      target.requests = backfill.requests;
      target.errors = backfill.errors;
      target.versionId = backfill.versionId;
      target.sourceVersionId = backfill.versionId;
      target.provenance = "backfill";
      target.provenanceChain.push({
        kind: "backfill",
        eventId: backfill.id,
        versionId: backfill.versionId,
        arrivedAt: backfill.arrivedAt
      });
    }
  }

  series.sort((a, b) => a.start - b.start || a.end - b.end);
  return { series, review };
}
