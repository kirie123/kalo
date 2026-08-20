import { useCallback, useEffect, useState } from "react";
import { chatStore } from "../lib/chat-store";
import { fmtClock, fmtEvery, trendClass } from "../lib/feed-view";
import {
  appPaths,
  feedList,
  feedRemove,
  feedRun,
  feedUpsert,
  onFeedError,
  onFeedStatus,
  openPath,
} from "../lib/pi-bridge";
import type { FeedInfo } from "../types";
import { Section } from "./SettingsPage";

/**
 * 数据源 panel: the feed table lives in the gateway sidecar (see
 * doc/2026-08-20-feeds-declarative-data-pull.md); this panel issues feed_*
 * commands and renders `feed-status` snapshots.
 *
 * Editing a spec is deliberately not a form — specs are JSON files under
 * ~/.kalo/feeds/, written by hand or by an agent, so 编辑 just opens the file
 * with the system default app. This panel covers the operations that need to be
 * one click away: 启用/停用, 立即拉取, 最近快照, 删除.
 */

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default function FeedsSettings() {
  const [feeds, setFeeds] = useState<FeedInfo[] | null>(null);
  /** Which rows have their snapshot expanded. */
  const [open, setOpen] = useState<Record<string, boolean>>({});
  /** `~/.kalo/feeds`, for the 编辑 buttons; "" until app_paths resolves. */
  const [feedsDir, setFeedsDir] = useState("");

  useEffect(() => {
    feedList()
      .then(setFeeds)
      .catch((err) => chatStore.pushToast(`加载数据源失败：${errText(err)}`, "error"));
    appPaths()
      .then((p) => setFeedsDir(`${p.kaloRoot}/feeds`))
      .catch(() => {
        // No Tauri (browser dev) — the 编辑 buttons just stay hidden.
      });
    const unStatus = onFeedStatus(setFeeds);
    const unError = onFeedError((msg) => chatStore.pushToast(msg, "error"));
    return () => {
      void unStatus.then((f) => f());
      void unError.then((f) => f());
    };
  }, []);

  const toggle = useCallback(async (f: FeedInfo) => {
    // The engine's own fields (snapshot/nextPullAt/…) are ignored by upsert;
    // sending the whole object back keeps the spec intact.
    try {
      await feedUpsert({ ...f, enabled: !f.enabled });
    } catch (err) {
      chatStore.pushToast(`更新数据源失败：${errText(err)}`, "error");
    }
  }, []);

  const runNow = useCallback(async (f: FeedInfo) => {
    try {
      await feedRun(f.id);
    } catch (err) {
      chatStore.pushToast(`拉取失败：${errText(err)}`, "error");
    }
  }, []);

  const remove = useCallback(async (f: FeedInfo) => {
    if (!window.confirm(`确定删除数据源「${f.name}」？其定义文件与快照都会被删除。`)) return;
    try {
      await feedRemove(f.id);
      chatStore.pushToast(`已删除 ${f.name}`, "info");
    } catch (err) {
      chatStore.pushToast(`删除失败：${errText(err)}`, "error");
    }
  }, []);

  // Editing is "open the JSON in your editor" on purpose: the extractor shape
  // is one-of-four and nested, so a form would cost more than it buys.
  const edit = useCallback(
    async (f: FeedInfo) => {
      try {
        await openPath(`${feedsDir}/${f.id}.json`);
      } catch (err) {
        chatStore.pushToast(`打开失败：${errText(err)}`, "error");
      }
    },
    [feedsDir],
  );

  return (
    <Section title="数据源">
      {feeds === null ? (
        <p className="text-xs text-dim">加载中…</p>
      ) : feeds.length === 0 ? (
        <p className="text-xs text-dim">
          暂无数据源。数据源是"定期 GET 一个地址、按声明把字段拼成一行文本"的机制，
          适合行情、汇率、构建状态这类机械的定期拉取；定义文件放在{" "}
          <code className="md-inline-code">~/.kalo/feeds/</code>。
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {feeds.map((f) => {
            const snap = f.snapshot;
            const failing = f.consecutiveFailures > 0;
            return (
              <div key={f.id} className="rounded-md border border-edge bg-base px-3 py-2">
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm">{f.name}</span>
                      <span className="shrink-0 rounded border border-edge px-1 py-px text-[10px] text-dim">
                        {f.surface}
                      </span>
                      {failing && (
                        <span className="shrink-0 text-[10px] text-[var(--danger)]">
                          连续失败 {f.consecutiveFailures} 次
                        </span>
                      )}
                      {snap?.stale && !failing && <span className="shrink-0 text-[10px] text-dim">旧值</span>}
                    </div>
                    <div className="mono truncate text-xs text-dim">
                      每 {fmtEvery(f.everySec)} · 下次 {f.enabled ? fmtClock(f.nextPullAt) : "已停用"} · 上次{" "}
                      {fmtClock(snap?.at)}
                      {snap ? ` (${snap.ms}ms)` : ""}
                    </div>
                    <div className="mono truncate text-[10px] text-dim" title={f.request.url}>
                      {f.request.url}
                    </div>
                  </div>
                  <button
                    onClick={() => void toggle(f)}
                    title={f.enabled ? "点击停用" : "点击启用"}
                    className={`shrink-0 rounded-md border px-2 py-1 text-xs ${
                      f.enabled ? "border-dim text-ink" : "border-edge text-dim"
                    } hover:text-ink`}
                  >
                    {f.enabled ? "启用中" : "已停用"}
                  </button>
                  <button
                    onClick={() => void runNow(f)}
                    title="立即拉取一次（无视开关与间隔）"
                    className="shrink-0 rounded-md border border-edge px-2 py-1 text-xs text-dim hover:text-ink"
                  >
                    立即拉取
                  </button>
                  <button
                    onClick={() => setOpen((v) => ({ ...v, [f.id]: !v[f.id] }))}
                    className="shrink-0 rounded-md border border-edge px-2 py-1 text-xs text-dim hover:text-ink"
                  >
                    {open[f.id] ? "收起" : "最近快照"}
                  </button>
                  {feedsDir && (
                    <button
                      onClick={() => void edit(f)}
                      title={`打开 ${f.id}.json`}
                      className="shrink-0 rounded-md border border-edge px-2 py-1 text-xs text-dim hover:text-ink"
                    >
                      编辑
                    </button>
                  )}
                  <button
                    onClick={() => void remove(f)}
                    className="shrink-0 rounded-md border border-edge px-2 py-1 text-xs text-dim hover:text-[var(--danger)]"
                  >
                    删除
                  </button>
                </div>

                {snap?.error && (
                  <div className="mono mt-1.5 break-all text-[10px] text-[var(--danger)]">{snap.error}</div>
                )}

                {open[f.id] && (
                  <div className="mt-1.5 border-t border-edge pt-1.5">
                    {!snap ? (
                      <p className="text-[10px] text-dim">还没有拉取过。</p>
                    ) : snap.items.length === 0 ? (
                      <p className="text-[10px] text-dim">这次拉取没有解析出任何一行。</p>
                    ) : (
                      <div className="flex flex-col gap-0.5">
                        {snap.items.map((item, i) => (
                          <div key={i} className={`mono truncate text-[11px] ${trendClass(item.trend)}`}>
                            {item.text}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {feedsDir && (
        <button
          onClick={() =>
            void openPath(feedsDir, true).catch((err) =>
              chatStore.pushToast(`打开目录失败：${errText(err)}`, "error"),
            )
          }
          title={feedsDir}
          className="mt-2 rounded-md border border-edge px-3 py-1.5 text-sm text-dim hover:text-ink"
        >
          打开数据源目录
        </button>
      )}

      <p className="mt-3 text-xs leading-relaxed text-dim">
        每个数据源是一个 JSON 文件：<code className="md-inline-code">~/.kalo/feeds/&lt;id&gt;.json</code>
        ，快照写在 <code className="md-inline-code">state/&lt;id&gt;.json</code>，需要鉴权的地址用{" "}
        <code className="md-inline-code">${"{secret:NAME}"}</code> 引用{" "}
        <code className="md-inline-code">secrets.json</code>。文件在网关启动时加载，手工新增或改名后需重启应用；
        <code className="md-inline-code">ticker</code> 型数据源会滚动显示在窗口顶栏。
      </p>
    </Section>
  );
}
