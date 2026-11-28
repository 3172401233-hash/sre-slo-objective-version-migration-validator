# SLO 版本化预算计算器与告警状态回放器

面向 **离线指标** 的 SLO 版本迁移分析工具。当 SLO 目标在窗口中途变化、
旧告警规则与新规则重叠生效时，本工具：

- 按版本边界切分窗口，分别计算每个 SLO 版本的错误预算与燃烧率；
- 回放每条告警规则的状态机，重建事故的打开、静默、恢复与到期过程；
- 处理回填数据并完整保留来源版本与来源链；
- 输出版本边界、可合并区间、告警转换和需要人工复核的部分。

> **只处理离线指标。** 本工具不连接任何线上监控、告警或工单系统，
> 不发起实时查询，也不会自动关闭线上事故。所有结论仅基于调用方提供的
> 历史输入文件，输出用于离线审计与人工决策。

## 运行环境

- Node.js `24.16.0`（`engines` 字段已声明）
- 纯 ESM，零第三方依赖，仅使用 Node 内置模块

## 快速开始

```bash
node --test
node src/cli.js examples/input.example.json
node src/cli.js examples/input.example.json /tmp/result.json
```

编程调用：

```js
import { readFile } from "node:fs/promises";
import { analyze } from "./src/index.js";

const input = JSON.parse(await readFile("input.json", "utf8"));
const result = analyze(input);
```

## 输入契约

所有时间戳均为毫秒级整数，所有区间均为半开区间 `[start, end)`。

| 字段 | 说明 |
| --- | --- |
| `window` | 离线分析窗口 `{ start, end }` |
| `versions` | SLO 版本列表，按 `effectiveAt` 生效，`target` 为 `(0,1)` 之间的错误率目标 |
| `points` | 历史指标桶，含 `requests`/`errors` 与该桶的来源 `versionId` |
| `backfills` | 回填事件，含到达时间 `arrivedAt` 与回填声明的 `versionId` |
| `rules` | 告警规则，含燃烧率阈值、回看时长、生效/到期时间与绑定版本 |
| `silences` | 静默区间，`ruleId` 为 `null` 时对所有规则生效 |

数据桶必须按时间升序且互不重叠；`errors` 不得大于 `requests`；
引用的版本必须存在，否则输入会被显式拒绝。

## 关键语义

### 版本化预算

- 窗口按 `effectiveAt` 切成版本区间，跨边界的桶按时间重叠比例把计数分摊进各区间。
- 桶的来源版本与所在区间版本不一致时，该部分计数从预算中剔除并写入人工复核，
  **绝不跨版本拼接燃烧率**。
- `crossVersionBurnRate` 恒为 `null`；跨版本只汇总同量纲的绝对剩余预算
  （`totalRemainingBudget`）。
- 相邻且归属同一版本的区间可合并，输出在 `mergeableIntervals`；
  不同版本之间天然断裂，不会被合并。

### 告警状态回放

- 每条规则独立维护状态机：`inactive → firing/suppressed → resolved`，
  规则在事故未关闭时到期则进入 `expired-open`。
- 规则只在自身 `effectiveAt` 之后参与评估，**晚生效的规则不会追溯关闭
  生效前的事故**，只产生 `RULE_LATE_START` 复核记录。
- 规则重叠生效时各自独立评估，只统计与自身来源版本一致的数据，
  重叠区间通过 `RULE_OVERLAP_ACTIVE` 显式标注。
- 回看窗口跨版本边界时剔除异版本桶并记录 `CROSS_VERSION_LOOKBACK`；
  覆盖率低于 `minCoverage`（默认 0.9）时不做自动状态翻转。

### 回填与来源保留

- 回填按 `arrivedAt` 顺序处理，权威替换同时间桶的实时计数。
- 被回填的桶保留完整 `provenanceChain`（实时记录 + 每次回填记录），
  并以回填声明的 `sourceVersionId` 为准。
- 回填与桶内来源版本冲突时双方来源都保留，并记录
  `BACKFILL_VERSION_CONFLICT`；回填驱动的状态翻转记录
  `BACKFILL_ALTERS_STATE` 且转换条目标记 `backfillInfluenced`。

## 输出结构

- `versionBoundaries`：窗口与版本生效边界时间轴
- `mergeableIntervals`：可合并的同版本区间
- `versionBudgets`：各版本请求数、错误数、预算、错误率、燃烧率、剩余预算、剔除计数
- `totalErrorBudget` / `totalRemainingBudget`：跨版本绝对预算汇总
- `alertTransitions`：告警状态转换（含时间、规则、事故 ID、原因与来源链）
- `alertFinalStates` / `incidents`：各规则最终状态与事故全生命周期
- `review` / `requiresManualReview`：人工复核条目及原因码

复核原因码定义见 `src/reasons.js`，涵盖版本不匹配、规则重叠、规则晚生效、
回看覆盖率不足、跨版本回看、回填冲突、静默期触发、规则到期未关闭等场景。

## 代码结构

```
src/
  index.js       离线分析唯一入口：归一化 -> 回填 -> 预算 -> 回放
  schema.js      输入校验与归一化
  backfill.js    回填合并与来源链保留
  versions.js    版本边界切分
  calculator.js  版本化预算计算与回看窗口汇总
  replayer.js    告警规则调度与状态机回放
  reasons.js     人工复核原因码
  time.js        半开区间与时间工具
  cli.js         文件输入的命令行入口
test/            node:test 测试（目标切换、规则重叠、回填、历史窗口变化等）
```
