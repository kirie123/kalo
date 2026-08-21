/**
 * Carrier-layer tests.
 *
 * The bug these exist to prevent: feishu.ts read `data.event.message`, but
 * EventDispatcher flattens the v2 envelope and drops the `event` key, so every
 * field was undefined, the sender check failed, and the bot silently ignored
 * every inbound message while still pushing outbound ones.
 *
 * These tests therefore drive a REAL EventDispatcher with a REAL v2 envelope
 * rather than hand-rolling the post-parse shape. Asserting against our own
 * assumption is exactly what let the bug through; this asserts against the SDK.
 */

import { describe, expect, test } from "bun:test";
import { EventDispatcher } from "@larksuiteoapi/node-sdk";
import { FeishuConnection, parseTextContent } from "./feishu";
import type { FeishuCredentials } from "./credentials";

const BOUND = "ou_bound_user";

function creds(over: Partial<FeishuCredentials> = {}): FeishuCredentials {
  return {
    appId: "cli_test",
    appSecret: "secret",
    boundOpenId: BOUND,
    domain: "feishu",
    boundAt: "2026-08-17T00:00:00.000Z",
    ...over,
  };
}

/** A schema-2.0 event exactly as Feishu puts it on the wire. */
function envelope(
  over: { openId?: string; messageId?: string; type?: string; text?: string } = {},
) {
  return {
    schema: "2.0",
    header: {
      event_id: "evt_1",
      event_type: "im.message.receive_v1",
      create_time: "1755400000000",
      token: "t",
      app_id: "cli_test",
      tenant_key: "tk",
    },
    event: {
      sender: {
        sender_id: { open_id: over.openId ?? BOUND, union_id: "on_x", user_id: "u_x" },
        sender_type: "user",
        tenant_key: "tk",
      },
      message: {
        message_id: over.messageId ?? "om_1",
        chat_id: "oc_1",
        chat_type: "p2p",
        message_type: over.type ?? "text",
        content: JSON.stringify({ text: over.text ?? "你好" }),
        create_time: "1755400000000",
      },
    },
  };
}

/**
 * Build a connection plus a dispatcher wired to its real handler, mirroring
 * how start() registers it. Returns the delivered texts.
 */
function harness(over: Partial<FeishuCredentials> = {}) {
  const received: Array<{ text: string; messageId: string }> = [];
  const conn = new FeishuConnection(creds(over), {
    onText: (text, messageId) => received.push({ text, messageId }),
  });
  // Reach the same private method start() registers. Casting keeps the
  // production signature honest while still exercising the real code path.
  const ingest = (conn as any).ingest.bind(conn);
  const dispatcher = new EventDispatcher({}).register({
    "im.message.receive_v1": async (data: any) => ingest(data),
  });
  const deliver = (payload: unknown) => dispatcher.invoke(payload as any, { needCheck: false });
  return { conn, received, deliver };
}

describe("inbound admission", () => {
  test("a text message from the bound user reaches onText", async () => {
    const { received, deliver } = harness();
    await deliver(envelope({ text: "跑一下测试" }));
    expect(received).toEqual([{ text: "跑一下测试", messageId: "om_1" }]);
  });

  test("the SDK flattens the envelope — `event` is gone after parse", async () => {
    // Pins the contract the original bug got wrong. If a future SDK stops
    // flattening, this fails loudly instead of the bot going quietly mute.
    let seen: any = null;
    const dispatcher = new EventDispatcher({}).register({
      "im.message.receive_v1": async (data: any) => {
        seen = data;
      },
    });
    await dispatcher.invoke(envelope() as any, { needCheck: false });
    expect(seen.event).toBeUndefined();
    expect(seen.message.message_id).toBe("om_1");
    expect(seen.sender.sender_id.open_id).toBe(BOUND);
  });

  test("a message from any other user is rejected", async () => {
    const { received, deliver } = harness();
    await deliver(envelope({ openId: "ou_someone_else" }));
    expect(received).toEqual([]);
  });

  test("non-text messages are rejected", async () => {
    const { received, deliver } = harness();
    await deliver(envelope({ type: "image" }));
    expect(received).toEqual([]);
  });

  test("a redelivered message_id is admitted only once", async () => {
    const { received, deliver } = harness();
    await deliver(envelope({ messageId: "om_dup" }));
    await deliver(envelope({ messageId: "om_dup" }));
    expect(received).toHaveLength(1);
  });

  test("distinct messages with identical text are both admitted", async () => {
    // De-dup must key on message_id, not content: asking the same thing twice
    // is legitimate.
    const { received, deliver } = harness();
    await deliver(envelope({ messageId: "om_a", text: "/status" }));
    await deliver(envelope({ messageId: "om_b", text: "/status" }));
    expect(received.map((r) => r.messageId)).toEqual(["om_a", "om_b"]);
  });

  test("empty text is dropped", async () => {
    const { received, deliver } = harness();
    await deliver(envelope({ text: "" }));
    expect(received).toEqual([]);
  });

  test("close() stops ingestion (§3.4: no ingest after unbind)", async () => {
    const { conn, received, deliver } = harness();
    conn.close();
    await deliver(envelope({ messageId: "om_after_unbind" }));
    expect(received).toEqual([]);
  });

  test("a throwing onText does not escape into the SDK", async () => {
    // The dispatcher turns a rejected handler into a 500 on the WS channel;
    // one bad line must not take the connection down.
    const conn = new FeishuConnection(creds(), {
      onText: () => {
        throw new Error("boom");
      },
    });
    const ingest = (conn as any).ingest.bind(conn);
    const dispatcher = new EventDispatcher({}).register({
      "im.message.receive_v1": async (data: any) => ingest(data),
    });
    // The handler resolves (with no value) instead of rejecting: that is what
    // keeps the SDK from logging a failed invoke and 500-ing the WS reply.
    await expect(
      dispatcher.invoke(envelope() as any, { needCheck: false }),
    ).resolves.toBeUndefined();
  });
});

describe("close()", () => {
  test("blocks outbound sends so a stale connection cannot reach the user", async () => {
    const conn = new FeishuConnection(creds());
    conn.close();
    await expect(conn.sendText("hi")).rejects.toThrow("连接已断开");
    await expect(conn.updateText("om_1", "hi")).rejects.toThrow("连接已断开");
  });

  test("addReaction stays best-effort after close", async () => {
    const conn = new FeishuConnection(creds());
    conn.close();
    await expect(conn.addReaction("om_1", "DONE")).resolves.toBeUndefined();
  });
});

describe("parseTextContent", () => {
  test("extracts the text field", () => {
    expect(parseTextContent(JSON.stringify({ text: "hi" }))).toBe("hi");
  });

  test("returns empty for malformed or non-string input", () => {
    expect(parseTextContent("not json")).toBe("");
    expect(parseTextContent(undefined)).toBe("");
    expect(parseTextContent(JSON.stringify({ image_key: "k" }))).toBe("");
  });
});
