/**
 * Left column: the filter tree.
 *
 * Domains come straight from the backend scan (= directories), so nothing
 * here is hardcoded. The three cross-cutting entries above them (全部 /
 * 待审阅 / 收件箱) are views over the same card list.
 */

import type { KnowledgeCardMeta, KnowledgeDomain } from "../../types";
import { DOMAIN_LABEL } from "./template";

/** Which slice of the library the list shows. */
export type NoteFilter =
  | { kind: "all" }
  | { kind: "review" }
  | { kind: "domain"; key: string }
  | { kind: "tag"; tag: string };

export function filterCards(cards: KnowledgeCardMeta[], filter: NoteFilter): KnowledgeCardMeta[] {
  switch (filter.kind) {
    case "all":
      return cards;
    case "review":
      return cards.filter((c) => c.reviewed === false);
    case "domain":
      return cards.filter((c) => c.domain === filter.key);
    case "tag":
      return cards.filter((c) => c.tags.includes(filter.tag));
  }
}

export function sameFilter(a: NoteFilter, b: NoteFilter): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "domain" && b.kind === "domain") return a.key === b.key;
  if (a.kind === "tag" && b.kind === "tag") return a.tag === b.tag;
  return true;
}

export function domainLabel(domain: KnowledgeDomain): string {
  // `_label` wins; the backend already falls back to the key, so only
  // substitute our Chinese table when the label is still the bare key.
  if (domain.label !== domain.key) return domain.label;
  return DOMAIN_LABEL[domain.key] ?? domain.key;
}

export default function DomainTree({
  domains,
  cards,
  filter,
  onSelect,
}: {
  domains: KnowledgeDomain[];
  cards: KnowledgeCardMeta[];
  filter: NoteFilter;
  onSelect: (f: NoteFilter) => void;
}) {
  const pendingReview = cards.filter((c) => c.reviewed === false).length;

  // Tag cloud, most used first; capped so a big library keeps a usable tree.
  const tagCounts = new Map<string, number>();
  for (const c of cards) for (const t of c.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  const tags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 30);

  return (
    <div className="flex min-h-0 flex-col overflow-y-auto py-2">
      <Row
        label="全部笔记"
        count={cards.length}
        active={filter.kind === "all"}
        onClick={() => onSelect({ kind: "all" })}
      />
      <Row
        label="待审阅"
        count={pendingReview}
        emphasize={pendingReview > 0}
        active={filter.kind === "review"}
        onClick={() => onSelect({ kind: "review" })}
      />

      <div className="mt-3 px-3 pb-1 text-xs font-medium text-dim">领域</div>
      {domains.length === 0 && <div className="px-3 py-1 text-xs text-dim">暂无领域目录</div>}
      {domains.map((d) => (
        <Row
          key={d.key}
          label={`${d.icon ? `${d.icon} ` : ""}${domainLabel(d)}`}
          count={d.count}
          color={d.color}
          active={filter.kind === "domain" && filter.key === d.key}
          onClick={() => onSelect({ kind: "domain", key: d.key })}
        />
      ))}

      {tags.length > 0 && (
        <>
          <div className="mt-3 px-3 pb-1 text-xs font-medium text-dim">标签</div>
          {tags.map(([tag, count]) => (
            <Row
              key={tag}
              label={`#${tag}`}
              count={count}
              active={filter.kind === "tag" && filter.tag === tag}
              onClick={() => onSelect({ kind: "tag", tag })}
            />
          ))}
        </>
      )}
    </div>
  );
}

function Row({
  label,
  count,
  active,
  onClick,
  color,
  emphasize,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  /** `_color` from the type note, used as a small leading dot. */
  color?: string;
  /** Draws the count in the accent colour (待审阅 with a backlog). */
  emphasize?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`mx-1 flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-card ${
        active ? "bg-card text-ink" : "text-dim"
      }`}
    >
      {color && (
        <span className="size-2 shrink-0 rounded-full" style={{ background: color }} aria-hidden />
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className={`mono shrink-0 text-[10px] ${emphasize ? "text-accent" : "text-dim"}`}>{count}</span>
    </button>
  );
}
