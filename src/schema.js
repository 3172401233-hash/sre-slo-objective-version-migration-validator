import { REVIEW } from "./reasons.js";
import { assertInterval, assertFiniteInteger } from "./time.js";

function requireObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} 必须是对象`);
  }
}

function requireNonNegativeInteger(value, name) {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} 必须是非负整数，实际值: ${String(value)}`);
  }
}

function requireId(value, name, seen) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} 必须是非空字符串`);
  }
  if (seen.has(value)) {
    throw new Error(`重复的 id: ${value}（字段 ${name}）`);
  }
  seen.add(value);
}

// 归一化并校验整份离线输入。review 在归一化阶段即可同步收集结构性问题。
export function normalizeInput(input) {
  requireObject(input, "input");
  const {
    versions,
    window: rawWindow,
    points,
    backfills = [],
    rules,
    silences = []
  } = input;

  if (!Array.isArray(versions) || versions.length === 0) {
    throw new TypeError("input.versions 必须是非空数组");
  }
  if (!Array.isArray(points)) {
    throw new TypeError("input.points 必须是数组");
  }
  if (!Array.isArray(rules)) {
    throw new TypeError("input.rules 必须是数组");
  }
  for (const name of ["backfills", "silences"]) {
    if (!Array.isArray(input[name === "backfills" ? "backfills" : "silences"])) {
      throw new TypeError(`input.${name} 必须是数组`);
    }
  }

  const review = [];

  requireObject(rawWindow, "input.window");
  const window = {
    start: rawWindow.start,
    end: rawWindow.end
  };
  assertInterval(window.start, window.end, "input.window");

  const versionIds = new Set();
  const normalizedVersions = versions.map((version) => {
    requireObject(version, "versions[]");
    requireId(version.id, "versions[].id", versionIds);
    const target = Number(version.target);
    if (!Number.isFinite(target) || target <= 0 || target >= 1) {
      throw new RangeError(`版本 ${version.id} 的 target 必须落在 (0, 1) 区间`);
    }
    assertFiniteInteger(version.effectiveAt, `versions[${version.id}].effectiveAt`);
    if (version.effectiveAt < window.start || version.effectiveAt > window.end) {
      throw new RangeError(`版本 ${version.id} 的 effectiveAt 超出窗口范围`);
    }
    return { id: version.id, target, effectiveAt: version.effectiveAt };
  });

  // 版本按生效时间排序；同一时刻只允许一个版本生效。
  normalizedVersions.sort((a, b) => a.effectiveAt - b.effectiveAt);
  for (let i = 1; i < normalizedVersions.length; i += 1) {
    if (normalizedVersions[i].effectiveAt === normalizedVersions[i - 1].effectiveAt) {
      throw new Error(`版本 ${normalizedVersions[i - 1].id} 与 ${normalizedVersions[i].id} 生效时间相同`);
    }
  }

  const pointIds = new Set();
  const normalizedPoints = points.map((point) => {
    requireObject(point, "points[]");
    requireId(point.id, "points[].id", pointIds);
    assertInterval(point.start, point.end, `points[${point.id}]`);
    requireNonNegativeInteger(point.requests, `points[${point.id}].requests`);
    requireNonNegativeInteger(point.errors, `points[${point.id}].errors`);
    if (point.errors > point.requests) {
      throw new RangeError(`数据点 ${point.id} 的 errors 不能大于 requests`);
    }
    if (typeof point.versionId !== "string" || !versionIds.has(point.versionId)) {
      throw new Error(`数据点 ${point.id} 引用了未知版本: ${String(point.versionId)}`);
    }
    if (point.end <= window.start || point.start >= window.end) {
      review.push({
        reason: REVIEW.POINT_OUTSIDE_WINDOW,
        at: point.start,
        pointId: point.id,
        detail: "数据点与分析窗口无交集，已忽略"
      });
    }
    return {
      id: point.id,
      start: point.start,
      end: point.end,
      requests: point.requests,
      errors: point.errors,
      versionId: point.versionId,
      provenance: "live"
    };
  });

  const bucketKeys = new Map();
  for (const point of normalizedPoints) {
    const key = `${point.start}:${point.end}`;
    if (bucketKeys.has(key)) {
      throw new Error(
        `数据点 ${point.id} 与 ${bucketKeys.get(key)} 占据同一时间桶 [${point.start}, ${point.end})`
      );
    } else {
      bucketKeys.set(key, point.id);
    }
  }

  const backfillIds = new Set();
  const normalizedBackfills = backfills.map((event) => {
    requireObject(event, "backfills[]");
    requireId(event.id, "backfills[].id", backfillIds);
    assertInterval(event.start, event.end, `backfills[${event.id}]`);
    assertFiniteInteger(event.arrivedAt, `backfills[${event.id}].arrivedAt`);
    requireNonNegativeInteger(event.requests, `backfills[${event.id}].requests`);
    requireNonNegativeInteger(event.errors, `backfills[${event.id}].errors`);
    if (event.errors > event.requests) {
      throw new RangeError(`回填 ${event.id} 的 errors 不能大于 requests`);
    }
    if (typeof event.versionId !== "string" || !versionIds.has(event.versionId)) {
      throw new Error(`回填 ${event.id} 引用了未知版本: ${String(event.versionId)}`);
    }
    return {
      id: event.id,
      start: event.start,
      end: event.end,
      arrivedAt: event.arrivedAt,
      requests: event.requests,
      errors: event.errors,
      versionId: event.versionId
    };
  });
  normalizedBackfills.sort((a, b) => a.arrivedAt - b.arrivedAt);

  const ruleIds = new Set();
  const normalizedRules = rules.map((rule) => {
    requireObject(rule, "rules[]");
    requireId(rule.id, "rules[].id", ruleIds);
    if (typeof rule.versionId !== "string" || rule.versionId.trim() === "") {
      review.push({
        reason: REVIEW.RULE_MISSING_VERSION,
        at: rule.effectiveAt ?? window.start,
        ruleId: rule.id,
        detail: "规则未声明来源版本，无法绑定预算"
      });
    } else if (!versionIds.has(rule.versionId)) {
      review.push({
        reason: REVIEW.RULE_UNKNOWN_VERSION,
        at: rule.effectiveAt ?? window.start,
        ruleId: rule.id,
        detail: `规则引用未知版本 ${rule.versionId}`
      });
    }
    const threshold = Number(rule.burnRateThreshold);
    if (!Number.isFinite(threshold) || threshold <= 0) {
      throw new RangeError(`规则 ${rule.id} 的 burnRateThreshold 必须为正数`);
    }
    const lookbackMs = rule.lookbackMs;
    requireNonNegativeInteger(lookbackMs, `rules[${rule.id}].lookbackMs`);
    if (lookbackMs === 0) {
      throw new RangeError(`规则 ${rule.id} 的 lookbackMs 必须大于 0`);
    }
    assertFiniteInteger(rule.effectiveAt, `rules[${rule.id}].effectiveAt`);
    if (rule.expiresAt !== undefined && rule.expiresAt !== null) {
      assertFiniteInteger(rule.expiresAt, `rules[${rule.id}].expiresAt`);
      if (rule.expiresAt <= rule.effectiveAt) {
        throw new RangeError(`规则 ${rule.id} 的 expiresAt 必须晚于 effectiveAt`);
      }
    }
    return {
      id: rule.id,
      versionId: typeof rule.versionId === "string" ? rule.versionId : null,
      burnRateThreshold: threshold,
      lookbackMs,
      effectiveAt: rule.effectiveAt,
      expiresAt: rule.expiresAt ?? null,
      minCoverage: rule.minCoverage ?? 0.9
    };
  });

  const silenceIds = new Set();
  const normalizedSilences = silences.map((silence) => {
    requireObject(silence, "silences[]");
    requireId(silence.id, "silences[].id", silenceIds);
    assertInterval(silence.start, silence.end, `silences[${silence.id}]`);
    if (
      silence.ruleId !== undefined &&
      silence.ruleId !== null &&
      typeof silence.ruleId !== "string"
    ) {
      throw new TypeError(`静默 ${silence.id} 的 ruleId 必须是字符串或 null`);
    }
    return {
      id: silence.id,
      start: silence.start,
      end: silence.end,
      ruleId: silence.ruleId ?? null
    };
  });
  normalizedSilences.sort((a, b) => a.start - b.start);

  return {
    window,
    versions: normalizedVersions,
    points: normalizedPoints,
    backfills: normalizedBackfills,
    rules: normalizedRules,
    silences: normalizedSilences,
    review
  };
}
