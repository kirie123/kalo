/**
 * Browser tab: one address bar over one iframe.
 *
 * An iframe (not an embedded system webview) on purpose: it needs no Rust side
 * and works for the case this tab exists for — previewing a dev server the
 * agent just started (`http://localhost:3000`). The price is that sites sending
 * `X-Frame-Options` / `frame-ancestors` refuse to render; the empty state says
 * so and the toolbar has «在系统浏览器打开» (`open_path`, which hands the URL to
 * the OS untouched).
 */

import { useEffect, useRef, useState } from "react";
import { browserTitle, normalizeUrl } from "../lib/browser-url";
import { chatStore } from "../lib/chat-store";
import { panelTabs, type PanelTab } from "../lib/panel-tabs";
import { openPath } from "../lib/pi-bridge";

type BrowserModel = Extract<PanelTab, { kind: "browser" }>;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default function BrowserTab({ tab }: { tab: BrowserModel }) {
  const [draft, setDraft] = useState(tab.url);
  // Bumped to force a reload: same-URL navigation must still re-fetch.
  const [nonce, setNonce] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(tab.url);
  }, [tab.url]);

  // A brand-new tab has nowhere to go: put the cursor in the address bar.
  useEffect(() => {
    if (!tab.url) inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const go = (raw: string) => {
    const url = normalizeUrl(raw);
    if (!url) return;
    panelTabs.setBrowserUrl(tab.id, url);
    setNonce((n) => n + 1);
  };

  const openExternal = () => {
    if (!tab.url) return;
    void openPath(tab.url).catch((e) => chatStore.pushToast(`打开失败：${errText(e)}`, "error"));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-edge px-2">
        <button
          onClick={() => setNonce((n) => n + 1)}
          disabled={!tab.url}
          title="重新加载"
          className="shrink-0 rounded p-1 text-dim hover:bg-card hover:text-ink disabled:opacity-30"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
            <path d="M13.5 8a5.5 5.5 0 11-1.6-3.9M13.5 2.5v2.6h-2.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") go(draft);
            if (e.key === "Escape") setDraft(tab.url);
          }}
          placeholder="输入网址后回车（如 localhost:3000）"
          spellCheck={false}
          className="mono min-w-0 flex-1 rounded-md border border-edge bg-card px-2 py-1 text-xs text-dim outline-none placeholder:text-dim/60 focus:text-ink"
        />
        <button
          onClick={openExternal}
          disabled={!tab.url}
          title="在系统浏览器打开"
          className="shrink-0 rounded p-1 text-dim hover:bg-card hover:text-ink disabled:opacity-30"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
            <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5L9 7M2.5 13.5L7 9" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      <div className="min-h-0 flex-1 bg-white">
        {tab.url ? (
          <iframe
            key={nonce}
            src={tab.url}
            title={browserTitle(tab.url)}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
            referrerPolicy="no-referrer"
            className="h-full w-full border-0"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-xs text-dim">
            <span>在上方输入网址回车打开</span>
            <span className="text-[10px] leading-relaxed">
              本地服务（如 <span className="mono">http://localhost:3000</span>）可直接预览。
              <br />
              部分站点拒绝被嵌入，会显示空白 —— 用右上角「在系统浏览器打开」。
            </span>
          </div>
        )}
      </div>
    </div>
  );
}