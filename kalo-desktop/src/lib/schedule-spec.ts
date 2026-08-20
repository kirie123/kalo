/** 定时规则的「人话 ↔ cron」双向转换。
 *
 *  存储格式仍然是 5 字段 cron（gateway 的 scheduler 只认这个，不动它）；
 *  界面上不让用户碰 cron。绝大多数定时任务落在「每天几点 / 工作日几点 /
 *  每周几 / 每月几号 / 每隔多少分钟」这几种形状里，用频率 + 时刻来表达
 *  既准确又不用解释什么是「分 时 日 月 周」。
 *
 *  表达不了的（比如 `0 9,18 * * *` 这种一天两次）落到 custom，直接编辑
 *  cron 原文——逃生口留着，但不是默认路径。
 */

export type ScheduleFreq =
  | "minutes"  // 每隔 N 分钟
  | "hourly"   // 每小时的第 N 分
  | "daily"    // 每天 HH:MM
  | "weekdays" // 工作日 HH:MM（周一到周五，最常用，单独成项）
  | "weekly"   // 每周某几天 HH:MM
  | "monthly"  // 每月某日 HH:MM
  | "custom";  // 直接写 cron

export interface ScheduleSpec {
  freq: ScheduleFreq;
  /** freq=minutes：间隔分钟数。 */
  everyMin: number;
  /** freq=hourly/daily/weekdays/weekly/monthly：分钟。 */
  minute: number;
  /** 小时（minutes/hourly 用不到）。 */
  hour: number;
  /** freq=weekly：0=周日 … 6=周六。 */
  weekdays: number[];
  /** freq=monthly：几号。 */
  dom: number;
  /** freq=custom：cron 原文。 */
  cron: string;
}

export const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];

/** 新建任务的默认值：每天 09:00。给一个具体时刻而不是空白，
 *  用户不填也能存出一条合法任务。 */
export function defaultSpec(): ScheduleSpec {
  return { freq: "daily", everyMin: 10, minute: 0, hour: 9, weekdays: [1], dom: 1, cron: "" };
}

const pad = (n: number) => String(n).padStart(2, "0");

export function buildCron(spec: ScheduleSpec): string {
  const { minute: m, hour: h } = spec;
  switch (spec.freq) {
    case "minutes":
      return `*/${spec.everyMin} * * * *`;
    case "hourly":
      return `${m} * * * *`;
    case "daily":
      return `${m} ${h} * * *`;
    case "weekdays":
      return `${m} ${h} * * 1-5`;
    case "weekly": {
      // 七天全选等价于每天，交给 daily 的写法，读回来也更自然
      const days = [...new Set(spec.weekdays)].sort((a, b) => a - b);
      if (days.length === 0 || days.length === 7) return `${m} ${h} * * *`;
      return `${m} ${h} * * ${days.join(",")}`;
    }
    case "monthly":
      return `${m} ${h} ${spec.dom} * *`;
    case "custom":
      return spec.cron.trim();
  }
}

/** 展开一个 cron 字段为具体取值；语法与 gateway 的 parseCron 保持一致
 *  （`*` / `a` / `a-b` / `a-b/n` / `*​/n` / 逗号列表），看不懂就返回 null。 */
function expand(field: string, min: number, max: number): number[] | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const mm = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part.trim());
    if (!mm) return null;
    const star = mm[1] === "*";
    const lo = star ? min : Number(mm[1]);
    const hi = star ? max : mm[2] !== undefined ? Number(mm[2]) : mm[3] !== undefined ? max : lo;
    const step = mm[3] !== undefined ? Number(mm[3]) : 1;
    if (step < 1 || lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

/** cron → 界面状态。认不出来的一律落到 custom，不猜。 */
export function parseSpec(cron: string): ScheduleSpec {
  const base = defaultSpec();
  const raw = cron.trim();
  const custom: ScheduleSpec = { ...base, freq: "custom", cron: raw };
  const f = raw.split(/\s+/);
  if (f.length !== 5) return custom;
  const [fMin, fHour, fDom, fMon, fDow] = f;

  // 月份不是 * 就超出了这套模型（"每年三月"这种交给 custom）
  if (fMon !== "*") return custom;

  // 每隔 N 分钟：*/N * * * *
  const everyMin = /^\*\/(\d+)$/.exec(fMin);
  if (everyMin && fHour === "*" && fDom === "*" && fDow === "*") {
    const n = Number(everyMin[1]);
    if (n >= 1 && n <= 59) return { ...base, freq: "minutes", everyMin: n, cron: raw };
  }

  const mins = expand(fMin, 0, 59);
  if (!mins || mins.length !== 1) return custom;
  const minute = mins[0];

  if (fHour === "*") {
    if (fDom !== "*" || fDow !== "*") return custom;
    return { ...base, freq: "hourly", minute, cron: raw };
  }

  const hours = expand(fHour, 0, 23);
  if (!hours || hours.length !== 1) return custom;
  const hour = hours[0];

  // 日与周同时限定时 cron 是「或」的语义，这套模型表达不了
  if (fDom !== "*" && fDow !== "*") return custom;

  if (fDom !== "*") {
    const doms = expand(fDom, 1, 31);
    if (!doms || doms.length !== 1) return custom;
    return { ...base, freq: "monthly", minute, hour, dom: doms[0], cron: raw };
  }

  if (fDow === "*") return { ...base, freq: "daily", minute, hour, cron: raw };

  const dow = expand(fDow, 0, 7);
  if (!dow) return custom;
  const days = [...new Set(dow.map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b);
  if (days.length === 7) return { ...base, freq: "daily", minute, hour, cron: raw };
  if (days.join(",") === "1,2,3,4,5") {
    return { ...base, freq: "weekdays", minute, hour, cron: raw };
  }
  return { ...base, freq: "weekly", minute, hour, weekdays: days, cron: raw };
}

/** cron → 一句中文，用在任务列表与编辑框的预览行。 */
export function describeCron(cron: string): string {
  const s = parseSpec(cron);
  const at = `${pad(s.hour)}:${pad(s.minute)}`;
  switch (s.freq) {
    case "minutes":
      return `每 ${s.everyMin} 分钟`;
    case "hourly":
      return `每小时第 ${s.minute} 分`;
    case "daily":
      return `每天 ${at}`;
    case "weekdays":
      return `工作日 ${at}`;
    case "weekly":
      return `每周${s.weekdays.map((d) => WEEKDAY_LABELS[d]).join("、")} ${at}`;
    case "monthly":
      return `每月 ${s.dom} 日 ${at}`;
    case "custom":
      return cron.trim() || "未设置";
  }
}

/** 存盘前的校验，返回错误文案；null 表示可以存。 */
export function validateSpec(spec: ScheduleSpec): string | null {
  if (spec.freq === "custom") {
    if (spec.cron.trim().split(/\s+/).length !== 5) {
      return "cron 表达式需为 5 个字段（分 时 日 月 周）";
    }
    return null;
  }
  if (spec.freq === "minutes" && !(spec.everyMin >= 1 && spec.everyMin <= 59)) {
    return "间隔需在 1-59 分钟之间";
  }
  if (spec.freq === "weekly" && spec.weekdays.length === 0) {
    return "至少选择一天";
  }
  return null;
}
