/**
 * Feishu connection: official SDK client (REST) + WebSocket long connection.
 *
 * The WS client is outbound-only (no public URL needed), handles heartbeat
 * and auto-reconnect internally, and refreshes tenant_access_token itself.
 * Inbound messages are ignored in P0 (read-only progress push); the bound
 * open_id whitelist will matter from P2 on.
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

export class FeishuConnection {
  readonly client: Client;

  constructor(private creds: FeishuCredentials) {
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
        // P0: inbound messages are dropped; P2 will turn them into commands.
        "im.message.receive_v1": async (data: any) => {
          const sender = data?.event?.sender?.sender_id?.open_id;
          if (sender !== this.creds.boundOpenId) return; // whitelist
          log("inbound message ignored (P0 read-only)");
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
