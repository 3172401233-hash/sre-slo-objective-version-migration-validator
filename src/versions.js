import { overlapDuration } from "./time.js";

// 依据版本生效时间把分析窗口切成半开区间，每个区间只归属一个 SLO 版本。
export function buildVersionSegments(window, versions) {
  const boundaries = [
    { at: window.start, versionId: versions[0].id, kind: "window-start" }
  ];
  for (const version of versions) {
    if (version.effectiveAt > window.start && version.effectiveAt < window.end) {
      boundaries.push({
        at: version.effectiveAt,
        versionId: version.id,
        kind: "version-effective"
      });
    }
  }

  const segments = [];
  for (let i = 0; i < boundaries.length; i += 1) {
    const start = boundaries[i].at;
    const end = i + 1 < boundaries.length ? boundaries[i + 1].at : window.end;
    segments.push({ start, end, versionId: boundaries[i].versionId });
  }

  return {
    boundaries,
    segments,
    // 输出版本边界：含窗口边界，便于消费方直接渲染时间轴。
    timeline: [
      { at: window.start, versionId: versions[0].id, kind: "window-start" },
      ...versions
        .filter((version) => version.effectiveAt > window.start && version.effectiveAt < window.end)
        .map((version) => ({ at: version.effectiveAt, versionId: version.id, kind: "version-effective" })),
      {
        at: window.end,
        versionId: boundaries[boundaries.length - 1].versionId,
        kind: "window-end"
      }
    ]
  };
}

export function versionAt(segments, timestamp) {
  for (const segment of segments) {
    if (timestamp >= segment.start && timestamp < segment.end) {
      return segment.versionId;
    }
  }
  return null;
}

// 数据点与某个版本区间的重叠比例，用于跨桶计数按时间加权分摊。
export function overlapRatio(point, segment) {
  const duration = overlapDuration(point.start, point.end, segment.start, segment.end);
  if (duration === 0) {
    return 0;
  }
  return duration / (point.end - point.start);
}
