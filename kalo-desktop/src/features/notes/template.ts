/**
 * New-note template and the display fallbacks for domains.
 *
 * `DOMAIN_LABEL` is *only* a fallback: domains are directories, and
 * `_types/<key>.md` is the real place to set a label. This table exists so
 * the four domains that shipped before `_types/` existed still read as
 * Chinese without the user having to write type notes first.
 */

/** Chinese labels for the pre-`_types/` domains. Not an authoritative list. */
export const DOMAIN_LABEL: Record<string, string> = {
  cards: "通用",
  "training-notes": "训练",
  investing: "投资",
  math: "数学",
  inbox: "收件箱",
  review: "回顾",
};

/** Lifecycle chip colours, keyed by the `status:` frontmatter value. */
export const STATUS_LABEL: Record<string, string> = {
  seed: "萌芽",
  active: "在用",
  stable: "稳定",
  stale: "待清理",
};

export function todayLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Frontmatter + section skeleton prefilled for a new note. */
export function noteTemplate(domain: string, title: string): string {
  return [
    "---",
    `title: ${title}`,
    `domain: ${domain}`,
    "tags: []",
    `date: ${todayLocal()}`,
    "status: seed",
    "source_session: ",
    "---",
    "",
    "## 背景",
    "",
    "",
    "",
    "## 结论",
    "",
    "",
    "",
    "## 证据",
    "",
    "",
    "",
    "## 反例边界",
    "",
  ].join("\n");
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
