import { REVIEW } from "./reasons.js";
import { summarizeLookback } from "./calculator.js";
import { buildVersionSegments } from "./versions.js";

function isRuleActive(rule, at) {
  if (at < rule.effectiveAt) {
    return false;
  }
  return rule.expiresAt === null || at < rule.expiresAt;
}

function isSilenced(silences, ruleId, at) {
  return silences.some(
    (silence) =>
      at >= silence.start &&
      at < silence.end &&
      (silence.ruleId === null || silence.ruleId === ruleId)
  );
}

function pushTransition(transitions, entry) {
  const last = transitions[transitions.length - 1];
  // 同一时刻、同一规则、同一目标状态只保留一条，避免回放噪声。
  if (
    last &&
    last.at === entry.at &&
    last.ruleId === entry.ruleId &&
    last.toState === entry.toState
  ) {
    return;
  }
  transitions.push(entry);
}

// 告警状态离线回放器：
// - 每条规则独立维护状态机，规则晚生效不追溯关闭历史事故；
// - 回看窗口跨版本或覆盖率不足时不做自动判定，转人工复核；
// - 回填导致的判定翻转保留来源链并显式标注。
export function replayAlerts(input, budgets) {
  const review = [...budgets.review];
  const transitions = [];
  const silences = input.silences;
  const series = input.series ?? input.points;
  const targetById = new Map(input.versions.map((version) => [version.id, version.target]));
  const { segments: versionSegments } = buildVersionSegments(input.window, input.versions);

  // 记录规则在窗口开始前是否已生效，用于判断"晚生效"。
  for (const rule of input.rules) {
    if (rule.effectiveAt > input.window.start) {
      review.push({
        reason: REVIEW.RULE_LATE_START,
        at: rule.effectiveAt,
        ruleId: rule.id,
        detail: `规则 ${rule.id} 晚于窗口开始生效，生效前的事故不会被该规则追溯关闭`
      });
    }
  }

  // 检测规则重叠生效区间（同一时间段两条规则都 active）。
  const sortedRules = [...input.rules].sort((a, b) => a.effectiveAt - b.effectiveAt);
  for (let i = 0; i < sortedRules.length; i += 1) {
    for (let j = i + 1; j < sortedRules.length; j += 1) {
      const left = sortedRules[i];
      const right = sortedRules[j];
      const overlapStart = Math.max(left.effectiveAt, right.effectiveAt);
      const leftEnd = left.expiresAt ?? Infinity;
      const rightEnd = right.expiresAt ?? Infinity;
      const overlapEnd = Math.min(leftEnd, rightEnd);
      if (overlapEnd > overlapStart) {
        review.push({
          reason: REVIEW.RULE_OVERLAP,
          at: overlapStart,
          ruleIds: [left.id, right.id],
          detail: `规则 ${left.id} 与 ${right.id} 在 [${overlapStart}, ${overlapEnd}) 重叠生效，按各自来源版本独立评估`
        });
      }
    }
  }

  const states = new Map(
    input.rules.map((rule) => [
      rule.id,
      {
        ruleId: rule.id,
        versionId: rule.versionId,
        state: "inactive",
        incidentId: null,
        since: null,
        lastEvaluation: null
      }
    ])
  );

  const incidents = new Map();
  let incidentSequence = 0;

  function openIncident(rule, at, summary, provenanceChain) {
    incidentSequence += 1;
    const incidentId = `INC-${String(incidentSequence).padStart(4, "0")}`;
    const silenced = isSilenced(silences, rule.id, at);
    incidents.set(incidentId, {
      incidentId,
      ruleId: rule.id,
      sourceVersionId: rule.versionId,
      openedAt: at,
      closedAt: null,
      closeReason: null,
      silenced,
      openProvenance: provenanceChain,
      reviewReasons: []
    });
    const state = states.get(rule.id);
    state.state = silenced ? "suppressed" : "firing";
    state.incidentId = incidentId;
    state.since = at;
    pushTransition(transitions, {
      at,
      ruleId: rule.id,
      incidentId,
      fromState: state.lastEvaluation ? "resolved" : "inactive",
      toState: state.state,
      reason: "threshold-breached",
      burnRate: summary.burnRate,
      threshold: rule.burnRateThreshold,
      backfillInfluenced: provenanceChain.some((entry) => entry.kind === "backfill"),
      provenance: provenanceChain
    });
    if (silenced) {
      review.push({
        reason: REVIEW.SILENCE_WHILE_FIRING,
        at,
        ruleId: rule.id,
        incidentId,
        detail: "事故触发时命中静默，状态记为 suppressed 而非 firing"
      });
    }
  }

  function closeIncident(rule, at, reason) {
    const state = states.get(rule.id);
    if (!state.incidentId) {
      return;
    }
    const incident = incidents.get(state.incidentId);
    incident.closedAt = at;
    incident.closeReason = reason;
    pushTransition(transitions, {
      at,
      ruleId: rule.id,
      incidentId: state.incidentId,
      fromState: state.state,
      toState: "resolved",
      reason,
      provenance: []
    });
    state.state = "resolved";
    state.incidentId = null;
    state.since = at;
  }

  // 评估时间点 = 每个数据桶的 end（落在窗口内）。规则只在自身生效之后才参与评估，
  // 保证晚生效的规则不会对生效前的数据做任何追溯判定。
  const allEvaluationTimes = [...new Set(series.map((point) => point.end))]
    .filter((at) => at > input.window.start && at <= input.window.end)
    .sort((a, b) => a - b);

  for (const at of allEvaluationTimes) {
    // 先处理静默状态翻转，再评估阈值。
    for (const rule of input.rules) {
      if (!isRuleActive(rule, at)) {
        continue;
      }
      const state = states.get(rule.id);
      const silencedNow = isSilenced(silences, rule.id, at);
      if (state.incidentId) {
        const incident = incidents.get(state.incidentId);
        if (silencedNow && state.state === "firing") {
          state.state = "suppressed";
          incident.silenced = true;
          pushTransition(transitions, {
            at,
            ruleId: rule.id,
            incidentId: state.incidentId,
            fromState: "firing",
            toState: "suppressed",
            reason: "silence-started",
            provenance: []
          });
        } else if (!silencedNow && state.state === "suppressed") {
          state.state = "firing";
          pushTransition(transitions, {
            at,
            ruleId: rule.id,
            incidentId: state.incidentId,
            fromState: "suppressed",
            toState: "firing",
            reason: "silence-ended",
            provenance: []
          });
        }
      }
    }

    for (const rule of input.rules) {
      const state = states.get(rule.id);
      state.lastEvaluation = at;

      // 规则尚未生效：跳过，且保留既有状态，不产生任何转换。
      if (at < rule.effectiveAt) {
        continue;
      }

      if (!isRuleActive(rule, at)) {
        // 规则在事故未关闭时到期：不自动 resolve，转人工复核。
        if (state.incidentId) {
          const incident = incidents.get(state.incidentId);
          if (!incident.reviewReasons.includes(REVIEW.FIRING_RULE_EXPIRED)) {
            incident.reviewReasons.push(REVIEW.FIRING_RULE_EXPIRED);
            review.push({
              reason: REVIEW.FIRING_RULE_EXPIRED,
              at,
              ruleId: rule.id,
              incidentId: state.incidentId,
              detail: "规则到期时事故仍未关闭，系统不追溯裁决，保留 open 状态等待人工处理"
            });
          }
          state.state = "expired-open";
        } else if (state.state !== "resolved") {
          state.state = "inactive";
        }
        continue;
      }

      if (!targetById.has(rule.versionId)) {
        // 未知版本规则在 schema 阶段已记录，这里跳过自动评估。
        continue;
      }

      const summary = summarizeLookback(series, rule, at, targetById, versionSegments);
      const provenanceChain = collectProvenance(series, rule, at);

      if (summary.coverage < rule.minCoverage) {
        review.push({
          reason: REVIEW.LOOKBACK_INSUFFICIENT,
          at,
          ruleId: rule.id,
          detail: `回看覆盖率 ${summary.coverage} 低于阈值 ${rule.minCoverage}，本次不做自动状态翻转`
        });
        continue;
      }
      if (summary.crossedVersionBoundary) {
        review.push({
          reason: REVIEW.CROSS_VERSION_LOOKBACK,
          at,
          ruleId: rule.id,
          detail: "回看窗口跨越 SLO 版本边界，异版本桶已剔除，燃烧率仅基于同版本数据"
        });
      }

      const breaching = summary.burnRate >= rule.burnRateThreshold;
      if (breaching && !state.incidentId) {
        openIncident(rule, at, summary, provenanceChain);
        if (provenanceChain.some((entry) => entry.kind === "backfill")) {
          review.push({
            reason: REVIEW.BACKFILL_ALTERS_STATE,
            at,
            ruleId: rule.id,
            incidentId: states.get(rule.id).incidentId,
            detail: "事故触发依据包含回填数据，状态翻转保留回填来源链"
          });
        }
      } else if (!breaching && state.incidentId) {
        const before = state.state;
        closeIncident(rule, at, "threshold-recovered");
        if (provenanceChain.some((entry) => entry.kind === "backfill")) {
          review.push({
            reason: REVIEW.BACKFILL_ALTERS_STATE,
            at,
            ruleId: rule.id,
            detail: `事故由回填数据判定恢复（原状态 ${before}），已保留来源链`
          });
        }
      }
    }
  }

  // 窗口结束时仍未关闭的事故统一标注，交人工复核。
  for (const incident of incidents.values()) {
    if (incident.closedAt === null) {
      const reason = REVIEW.FIRING_RULE_EXPIRED;
      if (!incident.reviewReasons.includes(reason)) {
        incident.reviewReasons.push(reason);
      }
    }
  }

  const finalStates = [...states.values()].map((state) => ({ ...state }));

  return {
    evaluationTimes: allEvaluationTimes,
    transitions,
    finalStates,
    incidents: [...incidents.values()],
    review
  };
}

// 收集回看窗口内实际参与计算的数据桶来源链，用于回放结果溯源。
function collectProvenance(series, rule, at) {
  const lookbackStart = at - rule.lookbackMs;
  const chain = [];
  for (const point of series) {
    if (point.end <= lookbackStart || point.start >= at) {
      continue;
    }
    if (point.sourceVersionId !== rule.versionId) {
      continue;
    }
    for (const entry of point.provenanceChain ?? []) {
      chain.push({
        pointId: point.id,
        kind: entry.kind,
        eventId: entry.eventId,
        versionId: entry.versionId,
        arrivedAt: entry.arrivedAt ?? null
      });
    }
  }
  return chain;
}
