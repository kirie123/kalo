/** 首次使用引导的文案。
 *
 * 这里是**数据**，不是逻辑：OnboardingOverlay 只负责把这张表渲染成
 * eyebrow + 三张要点卡 + 大标题 + 副标题。想加一步、改一句话就在这里改，
 * 不用碰组件——跟 `lib/quick-actions.ts` 是同一条规矩：领域知识只出现在
 * 这类数据表和 skill 的 markdown 里，不该长进组件代码。
 *
 * 最后一步（配置模型）是表单不是文案，所以它只在这里留标题，正文由
 * `ModelStep.tsx` 渲染——`kind: "model"` 就是那个开关。
 */

import type { IconKey } from "./icons";

export interface Bullet {
  icon: IconKey;
  title: string;
  body: string;
}

export interface OnboardingStep {
  /** 顶部那行小字，两侧的破折号由组件加 */
  eyebrow: string;
  /** 底部大标题 */
  title: string;
  /** 大标题下面那行 */
  subtitle: string;
  /** 三张要点卡；`kind: "model"` 的一步不用 */
  bullets?: Bullet[];
  /** 缺省是文案页；"model" 表示这一步渲染配置表单 */
  kind?: "model";
}

export const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    eyebrow: "开始之前",
    title: "一个你自己的桌面 Agent",
    subtitle: "引擎与界面解耦，数据全在本地，能力边界由你划。",
    bullets: [
      {
        icon: "folder",
        title: "选个目录就开工",
        body: "对话绑定一个工作目录，Kalo 在里面读写文件、跑命令；换目录就是换项目。",
      },
      {
        icon: "diff",
        title: "每一步都看得见",
        body: "工具调用可展开、文件改动逐行 diff、上下文占用有圆环，不用猜它做了什么。",
      },
      {
        icon: "archive",
        title: "会话留在你机器上",
        body: "历史以 JSONL 落在 ~/.kalo/agent/sessions/，可回溯、可检索、想搬走就拷走。",
      },
    ],
  },
  {
    eyebrow: "数据与判断分离",
    title: "投资分析：自己攒数据的投研线",
    subtitle: "取数零 token 每天自动跑，判断按需调模型，产物都落在本地。",
    bullets: [
      {
        icon: "database",
        title: "取数层只给事实",
        body: "market-data 是一个统一 CLI：宏观、财报、个股体检数据全有脚本可跑，不下结论。",
      },
      {
        icon: "gauge",
        title: "判断层三个内置 skill",
        body: "宏观风向、个股体检、财报精读——只在你开口时才动模型，问一句给一份。",
      },
      {
        icon: "calendar",
        title: "历史是攒出来的",
        body: "自带一条每日落盘任务，工作日收盘后追加宏观快照；用一天，分位数就准一分。",
      },
    ],
  },
  {
    eyebrow: "越用越懂你",
    title: "知识沉淀：笔记与长期记忆",
    subtitle: "笔记管「世界与结论」，记忆管「用户与当下」，都是本地纯文件。",
    bullets: [
      {
        icon: "note",
        title: "目录即分类，markdown 即真相",
        body: "加一个目录就是加一个域，没有富文本层——你编辑的字节和 Kalo 写的是同一份。",
      },
      {
        icon: "review",
        title: "Agent 自主写，写完待审阅",
        body: "它写的笔记带标记进「待审阅」，你逐条通过或改；覆盖删除都留 .trash/ 副本。",
      },
      {
        icon: "memory",
        title: "记忆常驻上下文",
        body: "偏好、习惯、做过的决定沉淀成记忆卡片，后续对话主动 recall，不用重复交代。",
      },
    ],
  },
  {
    eyebrow: "让机器替你盯着",
    title: "自动化与演化",
    subtitle: "机械的活不烧模型，搜索类的活交给它跑几十上百轮。",
    bullets: [
      {
        icon: "ticker",
        title: "Feeds：声明式秒级拉取",
        body: "一个数据源一个文件，抽几个字段送到顶栏跑马灯；默认带 A 股大盘与美元人民币。",
      },
      {
        icon: "clock",
        title: "定时任务两类活",
        body: "watch 跑本地脚本、输出非空才告警（零 token）；agent 到点起一个无头会话。",
      },
      {
        icon: "evolve",
        title: "演化：把 Agent 当搜索算子",
        body: "你只说清怎么打分，树负责往哪探、模型负责写出来，跑很久才有结果的活交给它。",
      },
    ],
  },
  {
    eyebrow: "最后一步",
    title: "配置模型",
    subtitle: "填一个 API Key，或接入自己的中转 / 本地模型服务，就可以开始了。",
    kind: "model",
  },
];
