/**
 * Feishu connection: official SDK client (REST) + WebSocket long connection.
 *
 * The WS client is outbound-only (no public URL needed), handles heartbeat
 * and auto-reconnect internally, and refreshes tenant_access_token itself.
 * Inbound messages are admitted only from the bound open_id and handed up as
 * plain text — this class is a carrier, all parsing lives in channel.ts.
 */

import {
  AppType,
  Client,
  Domain,
  EventDispatcher,
  LoggerLevel,
  WSClient,
} from "@larksuiteoapi/node-sdk";
import type { FeishuCredentials } from "./credentials";
import { log } from "./protocol";

export interface FeishuDeps {
  /** Called with the plain text of a message from the bound user. */
  onText?: (text: string, messageId: string) => void;
}

/**
 * How many recent message ids to remember for de-duplication. The WS client
 * re-delivers events across a reconnect, and a redelivered line would open a
 * second session for a message the user sent once.
 */
const SEEN_LIMIT = 512;

export class FeishuConnection {
  readonly client: Client;
  /** Insertion-ordered; trimmed from the front once it exceeds SEEN_LIMIT. */
  private seen = new Set<string>();
  private closed = false;

  constructor(private creds: FeishuCredentials, private deps: FeishuDeps = {}) {
    const domain = creds.domain === "lark" ? Domain.Lark : Domain.Feishu;
    this.client = new Client({
      appId: creds.appId,
      appSecret: creds.appSecret,
      domain,
      appType: AppType.SelfBuild,
      loggerLevel: LoggerLevel.warn,
    });
  }

  /** Start the WS long connection. Resolves once the SDK reports started. */
  async start(): Promise<void> {
    const domain = this.creds.domain === "lark" ? Domain.Lark : Domain.Feishu;
    const ws = new WSClient({
      appId: this.creds.appId,
      appSecret: this.creds.appSecret,
      domain,
      loggerLevel: LoggerLevel.warn,
      autoReconnect: true,
    });
    await ws.start({
      eventDispatcher: new EventDispatcher({ loggerLevel: LoggerLevel.warn }).register({
        "im.message.receive_v1": async (data: any) => this.ingest(data),
      }),
    });
  }

  /**
   * Admit one inbound event. Exported through `start()` only, but kept as a
   * named method so tests can drive it through a real EventDispatcher.
   *
   * NOTE on the payload shape: EventDispatcher.parse() FLATTENS the v2
   * envelope — it spreads `event` onto the top level and drops the `event`
   * key itself (node-sdk lib/index.js, RequestHandle.parse). So the fields
   * live at `data.message` / `data.sender`, NOT `data.event.message`. Reading
   * the nested path yielded undefined for every message, which silently
   * failed the sender check below and made the bot look mute. The `?? data`
   * fallback keeps this working if a future SDK stops flattening.
   */
  private ingest(data: any): void {
    if (this.closed) return;
    const ev = data?.event ?? data;
    const msg = ev?.message;
    const sender = ev?.sender?.sender_id?.open_id;

    const messageId: unknown = msg?.message_id;
    if (typeof messageId !== "string" || !messageId) {
      log("inbound dropped: no message_id");
      return;
    }
    // A reconnect can redeliver an event we already acted on.
    if (this.seen.has(messageId)) {
      log(`inbound dropped: duplicate ${messageId}`);
      return;
    }
    this.remember(messageId);

    // §3.4: only the paired user is admitted, and only plain text. Both
    // rejections are logged — a silent drop here is exactly what made the
    // original bug invisible.
    if (sender !== this.creds.boundOpenId) {
      log(`inbound ignored: sender ${sender ?? "unknown"} is not the bound user`);
      return;
    }
    if (msg?.message_type !== "text") {
      log(`inbound ignored: unsupported message_type ${msg?.message_type ?? "unknown"}`);
      return;
    }
    const text = parseTextContent(msg.content);
    if (!text) {
      log(`inbound ignored: empty text in ${messageId}`);
      return;
    }
    try {
      this.deps.onText?.(text, messageId);
    } catch (err) {
      log("inbound handler failed:", err instanceof Error ? err.message : err);
    }
  }

  private remember(messageId: string): void {
    this.seen.add(messageId);
    if (this.seen.size > SEEN_LIMIT) {
      // Sets iterate in insertion order, so this evicts the oldest ids.
      const excess = this.seen.size - SEEN_LIMIT;
      let dropped = 0;
      for (const id of this.seen) {
        this.seen.delete(id);
        if (++dropped >= excess) break;
      }
    }
  }

  /**
   * Stop admitting inbound messages.
   *
   * The socket itself stays up: WSClient exposes only `start()` (no stop/
   * close) and, with autoReconnect, re-dials itself. So unbind cannot truly
   * tear the connection down — this flag is what actually enforces "after
   * unbind there is no ingest" (§3.4). Sends are blocked too, so a stale
   * connection object can never reach the user.
   */
  close(): void {
    this.closed = true;
    this.seen.clear();
  }

  /** Send a text message to the bound user; returns the message id. */
  async sendText(text: string): Promise<string> {
    if (this.closed) throw new Error("连接已断开");
    const res = await this.client.im.v1.message.create({
      params: { receive_id_type: "open_id" },
      data: {
        receive_id: this.creds.boundOpenId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });
    if (res.code !== 0 || !res.data?.message_id) {
      throw new Error(`发送消息失败：${res.code} ${res.msg ?? ""}`.trimEnd());
    }
    return res.data.message_id;
  }

  /** Edit an existing text message in place (progress updates). */
  async updateText(messageId: string, text: string): Promise<void> {
    if (this.closed) throw new Error("连接已断开");
    const res = await this.client.im.v1.message.update({
      path: { message_id: messageId },
      data: { msg_type: "text", content: JSON.stringify({ text }) },
    });
    if (res.code !== 0) {
      throw new Error(`更新消息失败：${res.code} ${res.msg ?? ""}`.trimEnd());
    }
  }

  /** Best-effort reaction (non-fatal by design). */
  async addReaction(messageId: string, emojiType: string): Promise<void> {
    if (this.closed) return;
    try {
      await this.client.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
    } catch (err) {
      log(`reaction ${emojiType} failed:`, err instanceof Error ? err.message : err);
    }
  }
}

/** Feishu text payload is a JSON string: {"text":"..."}. */
export function parseTextContent(content: unknown): string {
  if (typeof content !== "string") return "";
  try {
    const parsed = JSON.parse(content);
    return typeof parsed?.text === "string" ? parsed.text : "";
  } catch {
    return "";
  }
}
