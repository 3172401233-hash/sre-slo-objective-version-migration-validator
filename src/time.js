// 区间均为半开区间 [start, end)，时间戳为毫秒级整数（与 Date.now() 一致）。

export function assertFiniteInteger(value, name) {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new TypeError(`${name} 必须是有限整数时间戳，实际值: ${String(value)}`);
  }
}

export function assertInterval(start, end, label = "interval") {
  assertFiniteInteger(start, `${label}.start`);
  assertFiniteInteger(end, `${label}.end`);
  if (end <= start) {
    throw new RangeError(`${label} 必须满足 start < end，收到 [${start}, ${end})`);
  }
}

// 两个半开区间的交集长度；无交集时返回 0。
export function overlapDuration(aStart, aEnd, bStart, bEnd) {
  const start = Math.max(aStart, bStart);
  const end = Math.min(aEnd, bEnd);
  return Math.max(0, end - start);
}

export function contains(intervalStart, intervalEnd, point) {
  return point >= intervalStart && point < intervalEnd;
}

// 判断一串互不重叠的半开区间是否按时间升序排列。
export function isSortedNonOverlapping(buckets) {
  for (let i = 1; i < buckets.length; i += 1) {
    if (buckets[i].start < buckets[i - 1].end) {
      return false;
    }
  }
  return true;
}

// 合并相邻（端点相接）且 key 相同的区间，返回合并后的 [start,end,key] 列表。
export function mergeAdjacent(segments) {
  const merged = [];
  for (const segment of segments) {
    const last = merged[merged.length - 1];
    if (
      last &&
      last.key === segment.key &&
      last.end === segment.start
    ) {
      last.end = segment.end;
    } else {
      merged.push({ start: segment.start, end: segment.end, key: segment.key });
    }
  }
  return merged;
}
