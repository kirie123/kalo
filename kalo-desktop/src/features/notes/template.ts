/**
 * New-note template and the display fallbacks for domains.
 *
 * `DOMAIN_LABEL` is *only* a fallback: domains are directories, and
 * `_types/<key>.md` is the real place to set a label. This table covers just
 * the two directories the app seeds itself — topic domains are the user's to
 * create and name, so nothing else is preset here.
 */

/** Chinese labels for the seeded directories. Not an authoritative list. */
export const DOMAIN_LABEL: Record<string, string> = {
  cards: "通用",
  inbox: "收件箱",
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
