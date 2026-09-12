import { describe, expect, it } from "vitest";
import {
  applyProviderEntry,
  buildProviderEntry,
  defaultContextK,
  defaultMaxOutK,
  LOCAL_KEY_PLACEHOLDER,
  normalizeBaseUrl,
  parseModelIds,
  previousEntryFor,
  readAuthHeader,
  readCapability,
  type ProviderFormState,
} from "./provider-config";
import type { ProviderConfig } from "../types";

function form(overrides: Partial<ProviderFormState> = {}): ProviderFormState {
  return {
    name: "my-relay",
    api: "anthropic-messages",
    baseUrl: "https://gw.example.com/yanjiuyuan",
    apiKey: "sk-test",
    modelLines: "claude-opus-5",
    contextK: "200",
    maxOutK: "",
    reasoning: true,
    images: true,
    authHeader: true,
    noDeveloperRole: false,
    noReasoningEffort: false,
    ...overrides,
  };
}

describe("normalizeBaseUrl", () => {
  it("trims whitespace and trailing slashes", () => {
    expect(normalizeBaseUrl("  https://gw.example.com/v1///  ", "anthropic-messages")).toBe(
      "https://gw.example.com/v1",
    );
  });

  it("appends /v1 for a bare localhost OpenAI-compatible host", () => {
    expect(normalizeBaseUrl("http://localhost:11434", "openai-completions")).toBe(
      "http://localhost:11434/v1",
    );
    expect(normalizeBaseUrl("http://127.0.0.1:1234", "openai-responses")).toBe(
      "http://127.0.0.1:1234/v1",
    );
  });

  it("leaves a path, a remote host, or an Anthropic endpoint alone", () => {
    expect(normalizeBaseUrl("http://localhost:11434/api", "openai-completions")).toBe(
      "http://localhost:11434/api",
    );
    expect(normalizeBaseUrl("https://api.example.com", "openai-completions")).toBe(
      "https://api.example.com",
    );
    // Anthropic Messages must keep the bare host: the engine appends /v1/messages.
    expect(normalizeBaseUrl("https://gw.example.com/yanjiuyuan", "anthropic-messages")).toBe(
      "https://gw.example.com/yanjiuyuan",
    );
  });
});

describe("parseModelIds", () => {
  it("trims, drops blanks and keeps order", () => {
    expect(parseModelIds(" a \n\n  b\nc  \n")).toEqual(["a", "b", "c"]);
  });
});

describe("readCapability", () => {
  it("reports none for an empty list and all only when every model has it", () => {
    expect(readCapability([], "images")).toBe("none");
    expect(readCapability([{ id: "a", input: ["text", "image"] }], "images")).toBe("all");
    expect(readCapability([{ id: "a" }, { id: "b" }], "images")).toBe("none");
    expect(readCapability([{ id: "a", input: ["text", "image"] }, { id: "b" }], "images")).toBe(
      "mixed",
    );
  });

  it("treats reasoning as a strict true", () => {
    expect(readCapability([{ id: "a", reasoning: true }], "reasoning")).toBe("all");
    expect(readCapability([{ id: "a", reasoning: false }], "reasoning")).toBe("none");
    expect(
      readCapability([{ id: "a", reasoning: true }, { id: "b" }], "reasoning"),
    ).toBe("mixed");
  });
});

describe("readAuthHeader", () => {
  it("is on only for an explicit true", () => {
    expect(readAuthHeader(undefined)).toBe(false);
    expect(readAuthHeader({ baseUrl: "u", api: "anthropic-messages", models: [] })).toBe(false);
    expect(
      readAuthHeader({ baseUrl: "u", api: "anthropic-messages", models: [], authHeader: true }),
    ).toBe(true);
  });
});

describe("defaultContextK / defaultMaxOutK", () => {
  const cfg = (models: ProviderConfig["models"]): ProviderConfig => ({
    baseUrl: "u",
    api: "anthropic-messages",
    models,
  });

  it("prefers a declared window, then the Ollama cap, then 200K", () => {
    expect(defaultContextK("pz", cfg([{ id: "a", contextWindow: 400000 }]))).toBe("400");
    expect(defaultContextK("ollama", cfg([{ id: "a" }]))).toBe("128");
    expect(defaultContextK("pz", cfg([{ id: "a" }]))).toBe("200");
  });

  it("leaves the max output empty unless a model declares one", () => {
    expect(defaultMaxOutK(cfg([{ id: "a", maxTokens: 64000 }]))).toBe("64");
    expect(defaultMaxOutK(cfg([{ id: "a" }]))).toBe("");
  });
});

describe("buildProviderEntry", () => {
  it("writes the capability switches into every model", () => {
    const entry = buildProviderEntry(
      form({ modelLines: "a\nb", reasoning: true, images: false, contextK: "128", maxOutK: "64" }),
    );
    expect(entry.models).toEqual([
      { id: "a", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 64000 },
      { id: "b", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 64000 },
    ]);
  });

  it("drops the numeric overrides when the fields are emptied", () => {
    const previous: ProviderConfig = {
      baseUrl: "u",
      api: "anthropic-messages",
      models: [{ id: "a", contextWindow: 200000, maxTokens: 64000 }],
    };
    const entry = buildProviderEntry(form({ contextK: "", maxOutK: "" }), previous);
    expect(entry.models[0].contextWindow).toBeUndefined();
    expect(entry.models[0].maxTokens).toBeUndefined();
    expect("contextWindow" in entry.models[0]).toBe(false);
  });

  it("ignores a non-numeric / zero K value instead of writing NaN", () => {
    const entry = buildProviderEntry(form({ contextK: "0", maxOutK: "abc" }));
    expect(entry.models[0].contextWindow).toBeUndefined();
    expect(entry.models[0].maxTokens).toBeUndefined();
  });

  it("keeps unmanaged provider fields (authHeader, headers, oauth, name)", () => {
    const previous = {
      baseUrl: "old",
      api: "openai-completions" as const,
      authHeader: true,
      headers: { "x-tenant": "acme" },
      oauth: "radius",
      modelOverrides: { a: { maxTokens: 1 } },
      models: [{ id: "a" }],
    } as unknown as ProviderConfig;
    const entry = buildProviderEntry(form({ authHeader: false }), previous);
    expect(entry.headers).toEqual({ "x-tenant": "acme" });
    expect(entry.oauth).toBe("radius");
    expect(entry.modelOverrides).toEqual({ a: { maxTokens: 1 } });
    // authHeader is form-managed, so unchecking it removes the flag.
    expect("authHeader" in entry).toBe(false);
    expect(entry.baseUrl).toBe("https://gw.example.com/yanjiuyuan");
  });

  it("keeps unmanaged model fields and renames nothing", () => {
    const previous: ProviderConfig = {
      baseUrl: "u",
      api: "anthropic-messages",
      models: [
        { id: "a", name: "Opus (prod)", cost: { input: 1, output: 2 }, contextWindow: 200000 },
      ],
    };
    const entry = buildProviderEntry(form({ modelLines: "a\nnew-model" }), previous);
    expect(entry.models[0]).toMatchObject({
      id: "a",
      name: "Opus (prod)",
      cost: { input: 1, output: 2 },
      reasoning: true,
      input: ["text", "image"],
    });
    expect(entry.models[1]).toEqual({
      id: "new-model",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 200000,
    });
  });

  it("persists a placeholder key when the key field is blank", () => {
    expect(buildProviderEntry(form({ apiKey: "  " })).apiKey).toBe(LOCAL_KEY_PLACEHOLDER);
  });

  it("writes compat only for the unticked switches, and clears it when both are ticked", () => {
    const entry = buildProviderEntry(form({ noDeveloperRole: true, noReasoningEffort: true }));
    expect(entry.compat).toEqual({ supportsDeveloperRole: false, supportsReasoningEffort: false });
    expect("compat" in buildProviderEntry(form())).toBe(false);
  });

  it("is the fix for the reported bug: a fresh entry is not text-only anymore", () => {
    const entry = buildProviderEntry(form({ images: true, reasoning: true }));
    expect(entry.models[0].input).toContain("image");
    expect(entry.models[0].reasoning).toBe(true);
  });
});

describe("previousEntryFor", () => {
  const base: Record<string, ProviderConfig> = {
    pz: { baseUrl: "u", api: "anthropic-messages", models: [] },
  };

  it("prefers the target entry", () => {
    expect(previousEntryFor(base, "pz", "other")).toBe(base.pz);
  });

  it("falls back to the pre-rename id so unmanaged fields survive a rename", () => {
    expect(previousEntryFor(base, "renamed", "pz")).toBe(base.pz);
  });

  it("returns undefined for a brand-new provider", () => {
    expect(previousEntryFor(base, "new", undefined)).toBeUndefined();
  });
});

describe("applyProviderEntry", () => {
  const base: Record<string, ProviderConfig> = {
    pz: { baseUrl: "u", api: "anthropic-messages", models: [] },
    deepseek: { baseUrl: "u2", api: "openai-completions", models: [] },
  };

  it("adds a new provider without touching the others", () => {
    const next = applyProviderEntry(base, "new", {
      baseUrl: "u3",
      api: "anthropic-messages",
      models: [],
    });
    expect(Object.keys(next)).toEqual(["pz", "deepseek", "new"]);
    expect(next.deepseek).toBe(base.deepseek);
  });

  it("moves an entry when the provider is renamed", () => {
    const next = applyProviderEntry(
      base,
      "renamed",
      { baseUrl: "u", api: "anthropic-messages", models: [] },
      "pz",
    );
    expect(Object.keys(next)).toEqual(["deepseek", "renamed"]);
  });
});
