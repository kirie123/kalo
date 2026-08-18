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

export class FeishuConnection {
  readonly client: Client;

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
        "im.message.receive_v1": async (data: any) => {
          const msg = data?.event?.message;
          const sender = data?.event?.sender?.sender_id?.open_id;
          // §3.4: only the paired user is admitted, and only plain text.
          if (sender !== this.creds.boundOpenId) return;
          if (msg?.message_type !== "text") return;
          const text = parseTextContent(msg.content);
          if (!text) return;
          try {
            this.deps.onText?.(text, msg.message_id);
          } catch (err) {
            log("inbound handler failed:", err instanceof Error ? err.message : err);
          }
        },
      }),
    });
  }

  /** Send a text message to the bound user; returns the message id. */
  async sendText(text: string): Promise<string> {
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
