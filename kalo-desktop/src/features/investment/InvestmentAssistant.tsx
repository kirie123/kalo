import AppIcon from "../../components/AppIcon";
import ChatView from "../../components/ChatView";
import { chatStore, useChatSelector } from "../../lib/chat-store";
import { useState } from "react";
import type { ResearchContext } from "./code-logic";

export default function InvestmentAssistant({ context, open, onClose }: { context: ResearchContext; open: boolean; onClose: () => void }) {
  const chat = useChatSelector((s) => ({ name: s.sessionName, busy: s.isStreaming || s.connecting }));
  const [dismissed, setDismissed] = useState("");
  const included = dismissed !== context.text;
  const codePage = context.page === "code" || context.label.includes("代码策略");
  const marginPage = context.label.includes("两融观察");
  const ask = (question: string) => {
    void chatStore.sendPrompt(`${question}${included ? `\n\n${context.text}` : ""}`);
  };
  return <aside className="investment-assistant" hidden={!open} aria-label="投行研究助手">
    <header>
      <div><strong>研究助手</strong><small>{chat.name || "新对话"}</small></div>
      <button onClick={onClose} aria-label="收起研究助手"><AppIcon name="close" size={16} /></button>
    </header>
    <div className="investment-assistant-context">{included ? <><details><summary>已带入：{context.label}</summary><pre>{context.text}</pre></details><button onClick={() => setDismissed(context.text)} aria-label="移除研究上下文"><AppIcon name="close" size={14} /></button></> : <button onClick={() => setDismissed("")}>重新带入当前页面</button>}</div>
    <div className="investment-suggestions">
      {marginPage ? <>
      <button disabled={chat.busy} onClick={() => ask("同步最新沪深两融和海康威视两融数据，说明交易日、来源与精度。")}>同步两融数据</button>
      <button disabled={chat.busy} onClick={() => ask("分析当前范围的融资余额变化、融资买入和融券情况，明确缺失、舍入精度与数据时点，不把余额变化当ETF净申购。")}>分析当前两融</button>
      </> : codePage && context.mode === "report" ? <>
      <button disabled={chat.busy} onClick={() => ask("分析当前 reportId 对应的回测，核对 spec 中实际代码和参数，解释策略相对持有基准的差额、成本与风险，不自动更改策略或运行新实验。")}>解读回测结果</button>
      <button disabled={chat.busy} onClick={() => ask("检查当前报告实际运行的代码与参数，结合成交和拒单查找策略问题。保留原研究思路，先说明建议，不自动修改或回测。")}>检查策略逻辑</button>
      </> : codePage && context.mode === "create" ? <>
      <button disabled={chat.busy} onClick={() => ask("根据当前新建实验的证券、周期和策略起点帮助设计策略代码；尚未明确的交易思路先询问，不把示例当作我的最终策略。")}>一起设计策略</button>
      <button disabled={chat.busy} onClick={() => ask("优先按上下文 pendingSync 的证券与周期同步分钟真实数据，否则使用当前选择的 security 与 timeframe；未填写证券时先询问。说明实际覆盖和质量检查结果。")}>同步研究数据</button>
      </> : codePage && (context.mode === "records" || context.mode === "missing") ? <>
      <button disabled={chat.busy} onClick={() => ask("帮助我选择要继续研究的实验，先确认证券和策略目标，不擅自运行回测。")}>讨论实验思路</button>
      </> : codePage ? <>
      <button disabled={chat.busy} onClick={() => ask("检查当前策略草稿的逻辑、所选证券库存规则与费用假设；保留我的研究思路，指出需要验证的问题。")}>检查策略代码</button>
      <button disabled={chat.busy} onClick={() => ask("按当前上下文中的代码草稿和参数实际运行代码回测，解释相对持有底仓的差额、成交与拒单。")}>运行当前代码</button>
      </> : <>
      <button disabled={chat.busy} onClick={() => ask("同步最新免费 ETF 数据，并说明数据覆盖和缺口。")}>同步最新数据</button>
      <button disabled={chat.busy} onClick={() => ask("分析最近 5 个交易日 ETF 净申购，按金额排序，说明缺口和统计口径。")}>分析 5 日资金</button>
      <button disabled={chat.busy} onClick={() => ask("分析双创与行业主题 ETF 最近 5 个交易日的净申购，分组排名并说明数据缺口；若当前快照没有这些标的，请先同步。")}>双创与板块资金</button>
      <button disabled={chat.busy} onClick={() => ask("用 100 万元跑最近 60 个交易日的价格动量轮动回测，其余使用投行默认参数；说明参数、费用、收益和最大回撤。")}>运行动量回测</button>
      </>}
    </div>
    <ChatView promptContext={included ? context.text : undefined} />
  </aside>;
}
