import { describe, expect, it } from "vitest";
import { explainProbeError } from "./probe";

/** 这里测的是「一句让人知道下一步该干什么的中文」——测试连通失败时，
 *  界面上唯一有价值的东西就是这句话，其余（起会话、发 prompt、删文件）
 *  都要真进程真网络，测不了也不该假装测。 */

describe("explainProbeError", () => {
  it("引擎不认这个模型时，指向模型 ID", () => {
    const r = explainProbeError("Model not found: deepseek/deepseek-chat-x");
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("模型 ID");
    // 原文要留着给用户展开，别把线索吃掉
    expect(r.detail).toContain("deepseek-chat-x");
  });

  it("没配 Key 时，顺便说清本地服务也要填占位 Key", () => {
    const r = explainProbeError("No API key for provider: ollama");
    expect(r.summary).toContain("API Key");
    expect(r.summary).toContain("占位");
  });

  it("连不上就说连不上，不要把它混进 HTTP 状态码那一支", () => {
    for (const raw of [
      "request to http://localhost:11434/v1/chat/completions failed, reason: connect ECONNREFUSED 127.0.0.1:11434",
      "fetch failed",
      "getaddrinfo ENOTFOUND api.deepseek.com",
    ]) {
      expect(explainProbeError(raw).summary).toContain("连不上服务地址");
    }
  });

  it("provider 的报文压成一行，并按状态码给出原因", () => {
    const r = explainProbeError(
      'OpenAI API error (401): {"error":{"message":"Authentication Fails","type":"authentication_error"}}',
    );
    expect(r.summary).toContain("Authentication Fails");
    expect(r.summary).toContain("Key 无效");
    expect(r.summary).not.toContain("\n");
  });

  it("限流与服务端故障各自给出等一等的提示", () => {
    expect(explainProbeError('429 {"error":{"message":"Rate limit reached"}}').summary).toContain("限流");
    expect(explainProbeError('503 {"error":{"message":"Overloaded"}}').summary).toContain("服务端故障");
  });

  it("没见过的报文原样透出，不编造原因", () => {
    const r = explainProbeError("something went sideways");
    expect(r.summary).toBe("something went sideways");
  });

  it("空报文也要有话说", () => {
    expect(explainProbeError("   ").summary).toContain("没有给出原因");
  });
});
