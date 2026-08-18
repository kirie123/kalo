/**
 * Setting up a run by describing it.
 *
 * The thing that stops people using era is not the flags — `--budget 20` was
 * never hard. It is that a run needs a seed directory and a working `eval.py`,
 * and most ideas arrive as a sentence rather than as a directory. So this
 * wizard does not translate a sentence into form fields; it hands the sentence
 * to an ordinary kalo session that has filesystem tools, and that session
 * *creates the material on disk* — seed, scorer, and an `era-run.json`
 * describing how to run it.
 *
 * That means the wizard's own job is small: pick a directory, collect the
 * description, hand off, and afterwards notice that `era-run.json` appeared.
 * The skill that shapes the session is user-editable, so the whole behaviour
 * is configurable without touching this file.
 */

import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { chatStore } from "../../lib/chat-store";
import { SPEC_FILE, rememberWorkspace } from "./runs";

/** The skill the handoff session is asked to follow. */
export const DESIGNER_SKILL = "era-experiment-designer";

const EXAMPLES = [
  "我有一个把 PDF 里的表格抽成 CSV 的脚本，抽得不太准，想让它自己改到更准。",
  "写一个函数从这堆日志里提取错误类型，越准越好，我有 200 条标好的样本。",
  "这个 SQL 查询要跑 40 秒，想让它更快，但结果必须完全一样。",
];

export function buildHandoffPrompt(dir: string, description: string): string {
  return [
    `请用 ${DESIGNER_SKILL} 技能，在目录 ${dir} 里为我准备一次演化实验。`,
    "",
    "我想做的事：",
    description.trim(),
    "",
    `准备好之后，把配置写成 ${dir}/${SPEC_FILE}，然后告诉我可以回「演化」面板验证了。`,
  ].join("\n");
}

interface EraWizardProps {
  /** Called after the handoff session has been started. */
  onHandoff: (dir: string) => void;
  onCancel: () => void;
}

export default function EraWizard({ onHandoff, onCancel }: EraWizardProps) {
  const [dir, setDir] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const pick = async () => {
    const picked = await open({ directory: true }).catch(() => null);
    if (typeof picked === "string") setDir(picked);
  };

  const go = async () => {
    if (!dir || !text.trim()) return;
    setBusy(true);
    try {
      rememberWorkspace(dir);
      chatStore.newChat();
      await chatStore.setCwd(dir);
      await chatStore.sendPrompt(buildHandoffPrompt(dir, text));
      onHandoff(dir);
    } catch (e) {
      chatStore.pushToast(`没能开始会话：${e instanceof Error ? e.message : String(e)}`, "error");
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-edge bg-card p-3">
        <div className="text-sm font-medium">用一句话说清楚要优化什么</div>
        <p className="mt-1 text-xs leading-relaxed text-dim">
          接下来会开一个普通的 kalo 会话，由它在你选的目录里把实验材料准备好：
          一份可运行的初始代码（seed）、一个能打印出分数的评测脚本，以及一份配置。
          你不需要提前写好任何东西——说清楚"什么算更好"就够了，其余可以在会话里边聊边定。
        </p>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-dim">放在哪个目录</span>
        <div className="flex gap-2">
          <input
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            placeholder="选择一个空目录，或已经有代码的目录"
            className="mono min-w-0 flex-1 rounded-md border border-edge bg-base px-2 py-1.5 text-xs outline-none focus:border-dim"
          />
          <button
            onClick={() => void pick()}
            className="shrink-0 rounded-md border border-edge px-3 py-1.5 text-xs text-dim hover:text-ink"
          >
            浏览…
          </button>
        </div>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-dim">想优化什么，什么算更好</span>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          placeholder="例如：我有一个把 PDF 表格抽成 CSV 的脚本，抽得不太准，想让它自己改准一点。我有 30 份人工核对过的结果可以对照。"
          className="w-full resize-y rounded-md border border-edge bg-base px-2 py-1.5 text-sm outline-none focus:border-dim"
        />
      </label>

      <div className="flex flex-wrap gap-1.5">
        {EXAMPLES.map((e) => (
          <button
            key={e}
            onClick={() => setText(e)}
            className="rounded border border-edge px-2 py-1 text-left text-[10px] text-dim hover:text-ink"
          >
            {e}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={() => void go()}
          disabled={busy || !dir || !text.trim()}
          className="rounded-md border border-dim px-3 py-1.5 text-sm text-ink hover:bg-card disabled:opacity-40"
        >
          {busy ? "正在开会话…" : "让 kalo 去准备"}
        </button>
        <button onClick={onCancel} className="text-sm text-dim hover:text-ink">
          取消
        </button>
        <span className="ml-auto text-[10px] text-dim">
          准备好后回到这里，会自动读出 {SPEC_FILE}
        </span>
      </div>
    </div>
  );
}
