import { useEffect, useRef, useState } from "react";
import AppIcon from "../../components/AppIcon";
import { chatStore, useChatSelector } from "../../lib/chat-store";
import { researchContext, type ResearchContext } from "./code-logic";
import { acceptsStrategyExample, strategyExperimentPrompt, strategyIdeaError, strategyIdeaExample, strategyIdeaKey, strategyIdeaLimit } from "./experiment-request";

export default function ExperimentIdea({ busy, onAsk, onContext }: {
  busy: boolean; onAsk: () => void; onContext: (context: ResearchContext) => void;
}) {
  const [saved] = useState(() => {
    try { return { text: localStorage.getItem(strategyIdeaKey) ?? "", error: "" }; }
    catch { return { text: "", error: "未能读取本机暂存的策略描述，请检查本机存储。" }; }
  });
  const [idea, setIdea] = useState(saved.text);
  const [storageError, setStorageError] = useState(saved.error);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const dispatching = useRef(false);
  const composing = useRef(false);
  const compositionEndedAt = useRef(-Infinity);
  const chatBusy = useChatSelector(s => s.isStreaming || !!s.connecting || s.isCompacting || !!s.pendingAsk || s.inputQueue.length > 0);
  const hasAttachments = useChatSelector(s => s.attachments.length > 0);
  const disabled = busy || chatBusy || hasAttachments || sending;
  useEffect(() => {
    onContext(researchContext("新建策略想法", { page: "code", mode: "idea", idea, instruction: "本次为独立新实验，仅以这份策略想法为准，不继承历史证券或参数。" }));
  }, [idea, onContext]);
  const change = (value: string) => {
    setIdea(value); setSubmitted(false); setError("");
    try { localStorage.setItem(strategyIdeaKey, value); setStorageError(""); }
    catch { setStorageError("策略描述未能暂存，请复制后再离开此页。"); }
  };
  const submit = async () => {
    const state = chatStore.getSnapshot();
    if (dispatching.current || busy || state.isStreaming || state.connecting || state.isCompacting || state.pendingAsk || state.inputQueue.length || state.attachments.length) return;
    const validation = strategyIdeaError(idea);
    if (validation) { setError(validation); return; }
    dispatching.current = true; setSending(true); setError(""); onAsk();
    try {
      // Explicit empty attachments leave the chat composer's unrelated drafts untouched.
      const accepted = await chatStore.sendPrompt(strategyExperimentPrompt(idea), undefined, []);
      setSubmitted(accepted);
      if (!accepted) setError("未能发送给研究助手，描述已保留。请查看右侧错误后重试。");
    } catch (reason) { setError(`发送失败，描述已保留：${String(reason)}`); }
    finally { dispatching.current = false; setSending(false); }
  };
  return <div className="experiment-idea">
    <div className="experiment-idea-label"><label htmlFor="experiment-strategy-idea">描述你的策略</label>{idea === "" && <span id="experiment-example-hint"><kbd>Tab</kbd> 填入示例</span>}</div>
    <textarea id="experiment-strategy-idea" autoFocus value={idea} maxLength={strategyIdeaLimit} onChange={e => change(e.target.value)} placeholder={`例如：${strategyIdeaExample}`}
      aria-describedby={idea === "" ? "experiment-example-hint" : undefined}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; compositionEndedAt.current = Date.now(); }}
      onKeyDown={e => {
        if (acceptsStrategyExample(idea, e.nativeEvent, composing.current || Date.now() - compositionEndedAt.current < 500)) {
          e.preventDefault(); change(strategyIdeaExample);
        }
      }} />
    <p className="investment-footnote">助手选数据、写代码并回测，完成后直接展示曲线。</p>
    <div className="experiment-idea-actions"><span role="status">{sending ? "正在发送…" : hasAttachments ? "研究助手有未发送附件，请先处理后开始新实验" : chatBusy ? "研究助手处理中，可在右侧补充或停止" : submitted ? "已交给研究助手，请在右侧查看执行情况" : ""}</span>{hasAttachments && <button onClick={onAsk}>查看研究助手</button>}<button className="investment-primary" disabled={disabled || !!strategyIdeaError(idea)} onClick={() => void submit()}><AppIcon name="sparkles" size={16} />{sending ? "正在发送" : "开始研究并回测"}</button></div>
    {(error || storageError) && <p className="investment-warning" role="alert">{error || storageError}</p>}
    {strategyIdeaError(idea) && idea.trim() && <p className="investment-warning">{strategyIdeaError(idea)}</p>}
  </div>;
}
