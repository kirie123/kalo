import { useState } from "react";
import type { OrchestratorView, WorkbenchRequest } from "../../../shared/workbench";

const STATUS: Record<OrchestratorView["status"], string> = {
  idle: "空闲", starting: "启动中", running: "处理中", closing: "收尾中",
};

/**
 * The workbench's dispatcher panel: one conversation with the assistant.
 * It is not a chat session in the sidebar; it never appears in the session list.
 */
export default function AssistantPanel({ view, busy, perform, onError }: {
  view?: OrchestratorView; busy: boolean;
  perform: (request: WorkbenchRequest) => Promise<void>; onError: (message: string) => void;
}) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(true);
  const [answer, setAnswer] = useState("");
  const messages = view?.messages ?? [];
  const question = view?.question;

  async function send(message: string) {
    if (!message.trim()) return;
    setText("");
    await perform({ action: "orchestrate", actionId: "", text: message });
  }

  return <section className="wb-assistant" data-open={open || undefined}>
    <header>
      <button className="wb-assistant-toggle" aria-expanded={open} onClick={() => setOpen(v => !v)}>
        <strong>助理</strong>
        <span className="wb-assistant-status">{view ? STATUS[view.status] : "空闲"}</span>
        {view && view.pending > 0 && <span className="wb-assistant-pending">{view.pending} 条待处理</span>}
      </button>
      {open && messages.length > 0 && <span className="wb-assistant-hint">它负责拆任务和派活，不亲自干活</span>}
    </header>
    {open && <>
      {messages.length > 0 && <ol className="wb-assistant-thread">
        {messages.slice(-20).map((message, index) => <li key={index} data-role={message.role}>
          <small>{message.role === "user" ? "你" : "助理"} · {new Date(message.at).toLocaleTimeString()}</small>
          <p>{message.text}</p>
        </li>)}
      </ol>}
      {question ? <form className="wb-assistant-question" onSubmit={e => {
        e.preventDefault();
        void perform({ action: "orchestrator_answer", actionId: "", questionId: question.id, answer } as WorkbenchRequest)
          .then(() => setAnswer(""));
      }}>
        <h3>{question.text}</h3>
        <div className="wb-options">{question.options.map(option => <button key={option} type="button" className="wb-button" aria-pressed={answer === option} onClick={() => setAnswer(option)}>{option}</button>)}</div>
        <div className="wb-row">
          <input value={answer} onChange={e => setAnswer(e.target.value)} placeholder="回答助理的问题" />
          <button className="wb-button wb-primary" disabled={busy || !answer.trim()}>回答</button>
        </div>
      </form> : <form className="wb-assistant-compose" onSubmit={e => { e.preventDefault(); void send(text); }}>
        <input value={text} onChange={e => setText(e.target.value)} maxLength={12000}
          placeholder="和助理说要点什么：它会拆任务、派给 worker，再把结果交回来" />
        <button className="wb-button wb-primary" disabled={busy || !text.trim() || view?.status === "running"}>发送</button>
      </form>}
      {view?.status === "running" && <p className="wb-assistant-note">助理正在处理，你的消息会排在当前轮之后。</p>}
      {view?.status === "idle" && messages.length === 0 && <p className="wb-assistant-note">
        助理还没有运行。它需要一个可用模型；发送后如果失败，检查设置里的默认模型。
      </p>}
    </>}
    {!open && <p className="wb-assistant-note">助理已折叠，点标题展开。</p>}
  </section>;
}
