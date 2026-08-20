import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FeedEngine,
  checkUrl,
  decodeBody,
  extractField,
  fillSecrets,
  renderItems,
  sanitizeSpec,
  type FeedFetchResult,
  type FeedSpec,
} from "./feeds";

// ---------------------------------------------------------------------------
// Extraction / rendering (pure)
// ---------------------------------------------------------------------------

function spec(overrides: Partial<FeedSpec>): FeedSpec {
  return {
    id: "f1",
    name: "测试源",
    everySec: 20,
    surface: "ticker",
    enabled: true,
    request: { url: "https://example.com/quote", encoding: "utf-8" },
    fields: { value: { path: "v" } },
    template: "{value}",
    ...overrides,
  };
}

describe("field extractors", () => {
  test("json path with numeric segments", () => {
    const json = { data: { diff: [{ f2: 342155 }] } };
    expect(extractField({ path: "data.diff.0.f2" }, json, "")).toBe("342155");
  });

  test("scale / digits / plus / suffix shaping", () => {
    expect(extractField({ path: "f", scale: 0.01, digits: 2 }, { f: 342155 }, "")).toBe("3421.55");
    expect(extractField({ path: "f", scale: 0.01, digits: 2, plus: true, suffix: "%" }, { f: 62 }, "")).toBe("+0.62%");
    expect(extractField({ path: "f", scale: 0.01, digits: 2, plus: true, suffix: "%" }, { f: -13 }, "")).toBe("-0.13%");
  });

  test("missing path yields empty string, not an error", () => {
    expect(extractField({ path: "a.b.c" }, { a: 1 }, "")).toBe("");
  });

  test("without shaping options the source text is kept verbatim", () => {
    // No scale/digits/plus → no number parsing, so leading zeros and trailing
    // decimals survive (codes and formatted prices both matter).
    expect(extractField({ path: "code" }, { code: "000001" }, "")).toBe("000001");
    expect(extractField({ index: 1, sep: "~" }, undefined, "x~10874.20")).toBe("10874.20");
  });

  test("regex with capture group", () => {
    const text = 'var hq_str_sh000001="上证指数,3421.55,3400.00";';
    expect(extractField({ regex: '="([^,]+)' }, undefined, text)).toBe("上证指数");
    expect(extractField({ regex: '="[^,]+,([\\d.]+)', digits: 1 }, undefined, text)).toBe("3421.6");
  });

  test("invalid regex is inert", () => {
    expect(extractField({ regex: "([" }, undefined, "x")).toBe("");
  });

  test("index + sep (tencent style)", () => {
    const text = "v_sh000001=\"1~上证指数~000001~3421.55~3400.0\"";
    expect(extractField({ index: 3, sep: "~" }, undefined, text)).toBe("3421.55");
  });

  test("const with prefix", () => {
    expect(extractField({ const: "CNY", prefix: "USD/" }, undefined, "")).toBe("USD/CNY");
  });
});

describe("renderItems", () => {
  test("rows.path fans a JSON array into one item per element", () => {
    const body = JSON.stringify({
      data: { diff: [{ f14: "上证指数", f2: 342155, f3: 62 }, { f14: "深证成指", f2: 1087420, f3: -13 }] },
    });
    const items = renderItems(
      spec({
        rows: { path: "data.diff" },
        fields: {
          label: { path: "f14" },
          value: { path: "f2", scale: 0.01, digits: 2 },
          change: { path: "f3", scale: 0.01, digits: 2, plus: true, suffix: "%" },
        },
        template: "{label} {value} {change}",
        trendField: "change",
      }),
      body,
    );
    expect(items).toEqual([
      { text: "上证指数 3421.55 +0.62%", trend: "up" },
      { text: "深证成指 10874.20 -0.13%", trend: "down" },
    ]);
  });

  test("rows.split walks text lines", () => {
    const body =
      'var hq_str_sh000001="上证指数,3421.55";\nvar hq_str_sz399001="深证成指,10874.20";\n';
    const items = renderItems(
      spec({
        rows: { split: "\n" },
        fields: { label: { regex: '="([^,]+)' }, value: { regex: ',([\\d.]+)' } },
        template: "{label} {value}",
      }),
      body,
    );
    expect(items.map((i) => i.text)).toEqual(["上证指数 3421.55", "深证成指 10874.20"]);
  });

  test("no rows = single item from the whole body", () => {
    const body = JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: 7.1234567 } }] } });
    const items = renderItems(
      spec({
        fields: {
          label: { const: "USD/CNY" },
          value: { path: "chart.result.0.meta.regularMarketPrice", digits: 4 },
        },
        template: "{label} {value}",
      }),
      body,
    );
    expect(items).toEqual([{ text: "USD/CNY 7.1235", trend: null }]);
  });

  test("rows.path pointing at a non-array throws (caught as a pull failure)", () => {
    expect(() => renderItems(spec({ rows: { path: "data" } }), JSON.stringify({ data: 1 }))).toThrow();
  });

  test("rows whose every field is missing are skipped", () => {
    const body = JSON.stringify({ data: { diff: [{ f2: 1 }, {}] } });
    const items = renderItems(
      spec({ rows: { path: "data.diff" }, fields: { v: { path: "f2" } }, template: "{v}" }),
      body,
    );
    expect(items).toHaveLength(1);
  });
});

describe("decodeBody", () => {
  test("gbk bytes decode to Chinese text", () => {
    // "上证指数" in GBK.
    const gbk = new Uint8Array([0xc9, 0xcf, 0xd6, 0xa4, 0xd6, 0xb8, 0xca, 0xfd]);
    expect(decodeBody(gbk, "gbk")).toBe("上证指数");
    // Same bytes read as UTF-8 would be mojibake — the encoding field matters.
    expect(decodeBody(gbk, "utf-8")).not.toBe("上证指数");
  });
});

describe("secrets and url checks", () => {
  test("${secret:NAME} substitution; unknown names collapse to empty", () => {
    expect(fillSecrets("https://x/?k=${secret:TOKEN}", { TOKEN: "abc" })).toBe("https://x/?k=abc");
    expect(fillSecrets("https://x/?k=${secret:NOPE}", {})).toBe("https://x/?k=");
  });

  test("only http/https pass", () => {
    expect(checkUrl("https://example.com")).toBeNull();
    expect(checkUrl("http://192.168.1.10:8080/api")).toBeNull();
    expect(checkUrl("file:///etc/passwd")).not.toBeNull();
    expect(checkUrl("not a url")).not.toBeNull();
  });
});

describe("sanitizeSpec", () => {
  test("clamps everySec, defaults surface/encoding, drops junk fields", () => {
    const s = sanitizeSpec({
      id: "x",
      name: " 名字 ",
      everySec: 1,
      surface: "nonsense",
      request: { url: "https://a/b", encoding: "latin1", headers: { Referer: "https://c", "bad key": "v" } },
      fields: { ok: { path: "a" }, "not ok!": { path: "b" }, alsoBad: "string" },
      template: "{ok}",
    })!;
    expect(s.everySec).toBe(5);
    expect(s.surface).toBe("ticker");
    expect(s.name).toBe("名字");
    expect(s.request.encoding).toBe("utf-8");
    expect(Object.keys(s.request.headers ?? {})).toEqual(["Referer"]);
    expect(Object.keys(s.fields)).toEqual(["ok"]);
  });

  test("rejects specs missing the essentials", () => {
    expect(sanitizeSpec(null)).toBeNull();
    expect(sanitizeSpec({ id: "bad id", name: "n", request: { url: "https://a" }, fields: { a: {} }, template: "t" })).toBeNull();
    expect(sanitizeSpec({ id: "x", name: "n", request: {}, fields: { a: {} }, template: "t" })).toBeNull();
    expect(sanitizeSpec({ id: "x", name: "n", request: { url: "https://a" }, fields: {}, template: "t" })).toBeNull();
    expect(sanitizeSpec({ id: "x", name: "n", request: { url: "https://a" }, fields: { a: {} }, template: "" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Engine behaviour
// ---------------------------------------------------------------------------

const T0 = Date.parse("2026-08-20T10:00:00Z");

interface Harness {
  engine: FeedEngine;
  nowRef: { t: number };
  calls: string[];
  dir: string;
  reply: (body: string, status?: number) => void;
  fail: (message: string) => void;
  hold: () => () => void;
}

function makeEngine(dir?: string): Harness {
  const feedDir = dir ?? mkdtempSync(join(tmpdir(), "kalo-feeds-test-"));
  const nowRef = { t: T0 };
  const calls: string[] = [];
  const state: { body: string; status: number; error: string | null; gate: Promise<void> | null; release: (() => void) | null } = {
    body: JSON.stringify({ v: 1 }),
    status: 200,
    error: null,
    gate: null,
    release: null,
  };
  const engine = new FeedEngine({
    onChange: () => {},
    now: () => nowRef.t,
    dir: feedDir,
    fetchImpl: async (url): Promise<FeedFetchResult> => {
      calls.push(url);
      if (state.gate) await state.gate;
      if (state.error) throw new Error(state.error);
      return { bytes: new TextEncoder().encode(state.body), status: state.status };
    },
  });
  return {
    engine,
    nowRef,
    calls,
    dir: feedDir,
    reply: (body, status = 200) => {
      state.body = body;
      state.status = status;
      state.error = null;
    },
    fail: (message) => {
      state.error = message;
    },
    hold: () => {
      let release!: () => void;
      state.gate = new Promise<void>((r) => (release = r));
      return () => {
        state.gate = null;
        release();
      };
    },
  };
}

describe("FeedEngine", () => {
  test("upsert persists the spec and the first tick pulls it", async () => {
    const h = makeEngine();
    h.reply(JSON.stringify({ v: 42 }));
    expect(h.engine.upsert(spec({}))).toBeNull();
    expect(JSON.parse(readFileSync(join(h.dir, "f1.json"), "utf-8")).id).toBe("f1");

    await h.engine.tick();
    expect(h.calls).toHaveLength(1);
    const info = h.engine.list()[0];
    expect(info.snapshot?.ok).toBe(true);
    expect(info.snapshot?.items).toEqual([{ text: "42", trend: null }]);
    // Snapshot is on disk for the next launch's first paint.
    expect(JSON.parse(readFileSync(join(h.dir, "state", "f1.json"), "utf-8")).items[0].text).toBe("42");
    rmSync(h.dir, { recursive: true, force: true });
  });

  test("interval gates the next pull", async () => {
    const h = makeEngine();
    h.engine.upsert(spec({ everySec: 20 }));
    await h.engine.tick();
    expect(h.calls).toHaveLength(1);

    h.nowRef.t += 19_000;
    await h.engine.tick();
    expect(h.calls).toHaveLength(1);

    h.nowRef.t += 2_000;
    await h.engine.tick();
    expect(h.calls).toHaveLength(2);
    rmSync(h.dir, { recursive: true, force: true });
  });

  test("disabled feeds never pull and report no next time", async () => {
    const h = makeEngine();
    h.engine.upsert(spec({ enabled: false }));
    await h.engine.tick();
    expect(h.calls).toHaveLength(0);
    expect(h.engine.list()[0].nextPullAt).toBeNull();
    rmSync(h.dir, { recursive: true, force: true });
  });

  test("failure keeps the last good items, marks them stale, and backs off", async () => {
    const h = makeEngine();
    h.reply(JSON.stringify({ v: 7 }));
    h.engine.upsert(spec({ everySec: 10 }));
    await h.engine.tick();
    expect(h.engine.list()[0].snapshot?.items[0].text).toBe("7");

    h.fail("HTTP 429");
    h.nowRef.t += 10_000;
    await h.engine.tick();
    let info = h.engine.list()[0];
    expect(info.snapshot?.ok).toBe(false);
    expect(info.snapshot?.error).toContain("429");
    expect(info.snapshot?.stale).toBe(true);
    expect(info.snapshot?.items[0].text).toBe("7");
    expect(info.consecutiveFailures).toBe(1);

    // Backoff: the plain 10s interval is no longer enough.
    h.nowRef.t += 10_000;
    await h.engine.tick();
    expect(h.engine.list()[0].consecutiveFailures).toBe(1);
    h.nowRef.t += 11_000;
    await h.engine.tick();
    expect(h.engine.list()[0].consecutiveFailures).toBe(2);

    // A success resets both the counter and the interval.
    h.reply(JSON.stringify({ v: 8 }));
    h.nowRef.t += 60_000;
    await h.engine.tick();
    info = h.engine.list()[0];
    expect(info.consecutiveFailures).toBe(0);
    expect(info.snapshot?.stale).toBeUndefined();
    expect(info.snapshot?.items[0].text).toBe("8");
    rmSync(h.dir, { recursive: true, force: true });
  });

  test("empty parse result counts as a failure", async () => {
    const h = makeEngine();
    h.reply(JSON.stringify({ other: 1 }));
    h.engine.upsert(spec({}));
    await h.engine.tick();
    const info = h.engine.list()[0];
    expect(info.snapshot?.ok).toBe(false);
    expect(info.consecutiveFailures).toBe(1);
    rmSync(h.dir, { recursive: true, force: true });
  });

  test("non-2xx status is a failure", async () => {
    const h = makeEngine();
    h.reply("{}", 503);
    h.engine.upsert(spec({}));
    await h.engine.tick();
    expect(h.engine.list()[0].snapshot?.error).toContain("503");
    rmSync(h.dir, { recursive: true, force: true });
  });

  test("re-entrancy: a slow response does not stack requests", async () => {
    const h = makeEngine();
    h.engine.upsert(spec({ everySec: 5 }));
    const release = h.hold();
    const first = h.engine.tick();
    h.nowRef.t += 60_000;
    await h.engine.tick();
    expect(h.calls).toHaveLength(1);
    release();
    await first;
    rmSync(h.dir, { recursive: true, force: true });
  });

  test("goes quiet after enough consecutive failures", async () => {
    const h = makeEngine();
    h.fail("boom");
    h.engine.upsert(spec({ everySec: 5 }));
    for (let i = 0; i < 20; i++) {
      h.nowRef.t += 20 * 60_000; // Past any backoff.
      await h.engine.tick();
    }
    expect(h.calls.length).toBe(12);
    rmSync(h.dir, { recursive: true, force: true });
  });

  test("runNow ignores enabled and backoff", async () => {
    const h = makeEngine();
    h.engine.upsert(spec({ enabled: false }));
    expect(await h.engine.runNow("f1")).toBeNull();
    expect(h.calls).toHaveLength(1);
    expect(await h.engine.runNow("nope")).not.toBeNull();
    rmSync(h.dir, { recursive: true, force: true });
  });

  test("headers and url resolve ${secret:...} from secrets.json", async () => {
    const h = makeEngine();
    writeFileSync(join(h.dir, "secrets.json"), JSON.stringify({ TOKEN: "s3cr3t" }));
    h.engine.upsert(spec({ request: { url: "https://example.com/q?k=${secret:TOKEN}" } }));
    await h.engine.tick();
    expect(h.calls[0]).toBe("https://example.com/q?k=s3cr3t");
    rmSync(h.dir, { recursive: true, force: true });
  });

  test("upsert rejects a non-http url", () => {
    const h = makeEngine();
    expect(h.engine.upsert(spec({ request: { url: "file:///etc/passwd" } }))).not.toBeNull();
    expect(h.engine.list()).toHaveLength(0);
    rmSync(h.dir, { recursive: true, force: true });
  });

  test("load round-trips specs and marks restored snapshots stale", async () => {
    const h = makeEngine();
    h.reply(JSON.stringify({ v: 5 }));
    h.engine.upsert(spec({ id: "persist-me" }));
    await h.engine.tick();

    const again = makeEngine(h.dir);
    again.engine.load();
    const info = again.engine.list()[0];
    expect(info.id).toBe("persist-me");
    expect(info.snapshot?.items[0].text).toBe("5");
    expect(info.snapshot?.stale).toBe(true);
    rmSync(h.dir, { recursive: true, force: true });
  });

  test("remove deletes both the spec and its snapshot", async () => {
    const h = makeEngine();
    h.engine.upsert(spec({}));
    await h.engine.tick();
    h.engine.remove("f1");
    expect(h.engine.list()).toHaveLength(0);
    const reloaded = makeEngine(h.dir);
    reloaded.engine.load();
    expect(reloaded.engine.list()).toHaveLength(0);
    rmSync(h.dir, { recursive: true, force: true });
  });

  test("itemsFor collects enabled feeds of one surface", async () => {
    const h = makeEngine();
    h.reply(JSON.stringify({ v: 1 }));
    h.engine.upsert(spec({ id: "a" }));
    h.engine.upsert(spec({ id: "b", surface: "card" }));
    await h.engine.tick();
    expect(h.engine.itemsFor("ticker")).toHaveLength(1);
    expect(h.engine.itemsFor("card")).toHaveLength(1);
    rmSync(h.dir, { recursive: true, force: true });
  });

  test("seedExamples writes bundled sources once", () => {
    const h = makeEngine();
    h.engine.seedExamples();
    const ids = h.engine.list().map((f) => f.id);
    expect(ids).toContain("cn-index");
    const before = h.engine.list().length;

    const again = makeEngine(h.dir);
    again.engine.load();
    again.engine.seedExamples();
    expect(again.engine.list()).toHaveLength(before);
    rmSync(h.dir, { recursive: true, force: true });
  });
});
