/**
 * The four ways a run goes wrong, counted from the folded tree.
 *
 * A run that is failing usually still *looks* fine — nodes appear, the cost
 * ticks up, the curve is drawn. The difference between "working" and "wasting
 * twenty dollars" is a ratio the panel has to compute and say out loud.
 *
 * The four modes, in the order they occur in a run's life:
 *   1. 改写失败 — the agent never produced a valid child.
 *   2. 评测失败 — children exist but the eval refuses to score them.
 *   3. 改了但没变好 — everything runs; nothing improves.
 *   4. 涨分但过拟合 — the training score climbs while the holdout does not.
 */

import type { EraNode, EraTree } from "./types";

export type DiagnosisId = "mutation_failed" | "eval_failed" | "no_progress" | "overfit";

export interface Diagnosis {
  id: DiagnosisId;
  tone: "warn" | "danger";
  title: string;
  /** What was measured. */
  detail: string;
  /** What to do about it. */
  hint: string;
  /** Nodes to look at first. */
  nodeIds: number[];
}

/** Nodes with a usable score: evaluated, and evaluated successfully. */
function scored(tree: EraTree): EraNode[] {
  return tree.nodes.filter((n) => n.score !== null && n.evalOk);
}

export function diagnose(tree: EraTree): Diagnosis[] {
  const out: Diagnosis[] = [];
  const children = tree.nodes.filter((n) => n.parent !== null);
  const done = children.filter((n) => !n.mutating);

  // 1. 改写失败 ------------------------------------------------------------
  const mutFailed = done.filter((n) => !n.mutationOk);
  if (mutFailed.length >= 2 && mutFailed.length / Math.max(1, done.length) >= 0.3) {
    out.push({
      id: "mutation_failed",
      tone: "danger",
      title: "改写反复失败",
      detail: `${mutFailed.length}/${done.length} 个节点没能完成改写`,
      hint: "多半是改写超时、模型没有配好，或者任务描述让 agent 无从下手。看看失败节点的「指令」和「引擎轨迹」两个标签页。",
      nodeIds: mutFailed.slice(-3).map((n) => n.id),
    });
  }

  // 2. 评测失败 ------------------------------------------------------------
  const evaluated = tree.nodes.filter((n) => n.score !== null);
  const evalFailed = evaluated.filter((n) => !n.evalOk);
  if (evalFailed.length >= 2 && evalFailed.length / Math.max(1, evaluated.length) >= 0.3) {
    const timeouts = evalFailed.filter((n) => (n.evalReason ?? "").includes("timeout")).length;
    out.push({
      id: "eval_failed",
      tone: "danger",
      title: "评测大面积失败",
      detail: `${evalFailed.length}/${evaluated.length} 次评测失败${timeouts ? `，其中 ${timeouts} 次超时` : ""}`,
      hint: timeouts
        ? "改写后的程序通常比 seed 慢。把 --eval-timeout 调大，或者让评测用更小的数据集。"
        : "看失败节点的「评测输出」。常见原因是改写破坏了评测脚本依赖的接口（函数名、输出格式）——把这些约束写进任务描述里。",
      nodeIds: evalFailed.slice(-3).map((n) => n.id),
    });
  }

  // 3. 改了但没变好 --------------------------------------------------------
  const ok = scored(tree);
  const seed = tree.nodes.find((n) => n.parent === null && n.score !== null && n.evalOk);
  if (seed && ok.length >= 5) {
    const sign = tree.metricGoal === "max" ? 1 : -1;
    const better = ok.filter((n) => n.id !== seed.id && sign * (n.score as number) > sign * (seed.score as number));
    if (better.length === 0) {
      out.push({
        id: "no_progress",
        tone: "warn",
        title: "跑了这么多，没有一个比 seed 好",
        detail: `${ok.length - 1} 个成功评测的子节点，没有一个超过 seed 的 ${seed.score}`,
        hint: "先在某个子节点的「改了什么」里确认改动真的落到文件上了——如果那里是空的，多半是待演化文件被 .era-fixtures 保护住了，每次评测前都被还原。改动确实存在却分数不动，就是评测对这类改动不敏感。",
        nodeIds: ok.slice(-3).map((n) => n.id),
      });
    }
  }

  // 4. 涨分但过拟合 --------------------------------------------------------
  const withHoldout = ok.filter((n) => n.holdoutScore !== null && n.holdoutOk !== false);
  if (withHoldout.length >= 2 && seed) {
    const sign = tree.metricGoal === "max" ? 1 : -1;
    const worst = withHoldout.filter((n) => {
      const trainGain = sign * ((n.score as number) - (seed.score as number));
      const holdGain = sign * ((n.holdoutScore as number) - (seed.holdoutScore ?? (n.holdoutScore as number)));
      return trainGain > 0 && holdGain <= 0;
    });
    if (worst.length >= 2) {
      out.push({
        id: "overfit",
        tone: "warn",
        title: "训练分在涨，留出分没跟上",
        detail: `${worst.length}/${withHoldout.length} 个节点训练分变好、留出分没变好`,
        hint: "改动可能是在迎合评测数据本身，而不是把问题解决得更好。扩大评测集，或者把留出集的分数当成最终标准。",
        nodeIds: worst.slice(-3).map((n) => n.id),
      });
    }
  }

  return out;
}
