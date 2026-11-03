import ChatView from "../../components/ChatView";
import { chatStore, useChatSelector } from "../../lib/chat-store";

export default function InvestmentAssistant({ snapshotId, onClose }: { snapshotId?: string; onClose: () => void }) {
  const chat = useChatSelector((s) => ({ name: s.sessionName, busy: s.isStreaming || s.connecting }));
  const ask = (question: string) => {
    const context = snapshotId ? `\n投行面板当前快照 ID：${snapshotId}。除同步后明确改用新快照外，请沿用此快照。` : "\n投行尚未同步数据，请先同步免费数据。";
    void chatStore.sendPrompt(`${question}${context}`);
  };
  return <aside className="investment-assistant" aria-label="投行研究助手">
    <header>
      <div><strong>研究助手</strong><small>{chat.name || "新对话"}</small></div>
      <button onClick={onClose} aria-label="收起研究助手">×</button>
    </header>
    <div className="investment-assistant-context"><span className="investment-badge">{snapshotId ? `快照 ${snapshotId.slice(0, 8)}` : "尚无研究数据"}</span><span>结果呈现在研究面板</span></div>
    <div className="investment-suggestions">
      <button disabled={chat.busy} onClick={() => ask("同步最新免费 ETF 数据，并说明数据覆盖和缺口。")}>同步最新数据</button>
      <button disabled={chat.busy} onClick={() => ask("分析最近 5 个交易日 ETF 净申购，按金额排序，说明缺口和统计口径。")}>分析 5 日资金</button>
      <button disabled={chat.busy} onClick={() => ask("用 100 万元跑最近 60 个交易日的价格动量轮动回测，其余使用投行默认参数；说明参数、费用、收益和最大回撤。")}>运行动量回测</button>
    </div>
    <ChatView />
  </aside>;
}
