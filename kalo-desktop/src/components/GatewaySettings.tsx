import { useCallback, useEffect, useRef, useState } from "react";
import {
  gatewayPairCancel,
  gatewayPairStart,
  gatewayStatus,
  gatewayUnbind,
  onGatewayStatus,
} from "../lib/pi-bridge";
import type { GatewayStatus } from "../types";
import { Section } from "./SettingsPage";

const STATE_LABEL: Record<GatewayStatus["state"], string> = {
  starting: "网关启动中",
  disconnected: "未连接",
  pairing: "等待扫码",
  connecting: "正在连接",
  connected: "已连接",
  error: "出错",
  unavailable: "网关未安装",
};

const STATE_COLOR: Record<GatewayStatus["state"], string> = {
  starting: "text-dim",
  disconnected: "text-dim",
  pairing: "text-[var(--warn,#d29922)]",
  connecting: "text-[var(--warn,#d29922)]",
  connected: "text-[var(--ok)]",
  error: "text-[var(--danger)]",
  unavailable: "text-[var(--danger)]",
};

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * IM gateway tab: Feishu QR pairing, live connection status, unbind.
 * All logic lives in the Rust-managed gateway sidecar; this panel only
 * issues commands and renders `gateway-status` events.
 */
export default function GatewaySettings() {
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [busy, setBusy] = useState(false);
  /** Countdown for the pairing QR validity. */
  const [qrSeconds, setQrSeconds] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    gatewayStatus().then(setStatus).catch(() => {});
    const un = onGatewayStatus(setStatus);
    return () => {
      void un.then((f) => f());
    };
  }, []);

  // Countdown while a QR is showing.
  useEffect(() => {
    if (status?.state === "pairing" && status.qrDataUrl) {
      setQrSeconds(status.expiresIn ?? 300);
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = setInterval(() => {
        setQrSeconds((s) => (s > 0 ? s - 1 : 0));
      }, 1000);
      return () => {
        if (timerRef.current) clearInterval(timerRef.current);
      };
    }
    if (timerRef.current) clearInterval(timerRef.current);
  }, [status?.state, status?.qrDataUrl, status?.expiresIn]);

  const run = useCallback(async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      setStatus((s) => (s ? { ...s, state: "error", message: errText(err) } : s));
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const pairing = status?.state === "pairing";
  const connected = status?.state === "connected";

  return (
    <>
      <Section title="飞书连接">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-dim">状态：</span>
          <span className={`font-medium ${status ? STATE_COLOR[status.state] : "text-dim"}`}>
            {status ? STATE_LABEL[status.state] : "读取中…"}
          </span>
          {connected && status?.user && (
            <span className="mono truncate text-xs text-dim" title={status.user}>
              {status.user}
            </span>
          )}
        </div>

        {status?.message && (
          <p className="mt-2 rounded-md border border-edge bg-base px-3 py-2 text-xs leading-relaxed text-dim">
            {status.message}
          </p>
        )}

        {status?.state === "unavailable" && (
          <p className="mt-2 text-xs leading-relaxed text-dim">
            未找到网关可执行文件（kalo-gateway）。请先运行 <code className="md-inline-code">scripts/build-gateway.sh</code>{" "}
            构建并放置到 binaries 目录，或设置 <code className="md-inline-code">KALO_GATEWAY_PATH</code> 环境变量。
          </p>
        )}

        {/* Pairing QR */}
        {pairing && status.qrDataUrl && (
          <div className="mt-3 flex flex-col items-center gap-2 rounded-md border border-edge bg-base p-4">
            <img src={status.qrDataUrl} alt="飞书扫码二维码" className="h-48 w-48" />
            <p className="text-xs text-dim">请使用飞书 App 扫码授权（{Math.floor(qrSeconds / 60)}:{String(qrSeconds % 60).padStart(2, "0")} 后过期）</p>
          </div>
        )}

        <div className="mt-3 flex gap-2">
          {!connected && !pairing && (
            <button
              onClick={() => void run(gatewayPairStart)}
              disabled={busy || status?.state === "unavailable"}
              className="rounded-md bg-accent px-3 py-1.5 text-sm text-[var(--accent-contrast)] hover:opacity-90 disabled:opacity-40"
            >
              {busy ? "处理中…" : "连接飞书"}
            </button>
          )}
          {pairing && (
            <button
              onClick={() => void run(gatewayPairCancel)}
              disabled={busy}
              className="rounded-md border border-edge px-3 py-1.5 text-sm hover:bg-base disabled:opacity-40"
            >
              取消扫码
            </button>
          )}
          {connected && (
            <button
              onClick={() => {
                if (window.confirm("解绑后将停止在手机上接收 agent 进度推送，确定解绑？")) {
                  void run(gatewayUnbind);
                }
              }}
              disabled={busy}
              className="rounded-md border border-edge px-3 py-1.5 text-sm text-dim hover:text-[var(--danger)] disabled:opacity-40"
            >
              解绑并停止
            </button>
          )}
        </div>
      </Section>

      <Section title="工作方式">
        <p className="text-sm leading-relaxed text-dim">
          连接后，Kalo 会通过独立的网关子进程与飞书云端建立 WebSocket
          长连接（无需公网地址）。每个会话开始、执行工具、完成或失败时，会向扫码者推送一条持续更新的进度消息。
        </p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs leading-relaxed text-dim">
          <li>扫码时会自动创建一个飞书自建应用并绑定扫码者，凭据保存在本地 ~/.kalo/agent/feishu.json。</li>
          <li>仅扫码者本人可收到推送；进度内容为状态与截断摘要，不包含完整文件内容。</li>
          <li>当前版本为只读推送（P0）；双向指令与审批交互将在后续版本提供。</li>
        </ul>
      </Section>
    </>
  );
}
