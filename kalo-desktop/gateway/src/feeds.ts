/**
 * Feeds: declarative periodic data pull (doc/2026-08-20-feeds-declarative-data-pull.md).
 *
 * A feed is "go fetch this URL every N seconds, pull a few fields out of the
 * response, render them into lines". Configuration is data, never code: the
 * extractors below are the whole expressive surface, and there is deliberately
 * no evaluator — these specs get written by an LLM, and a field that could
 * evaluate would be an arbitrary-code hole.
 *
 * Lives in the gateway sidecar for the same reasons the scheduler does (always
 * up, owns the push channel), plus two of its own: Bun ships `fetch` and
 * `TextDecoder("gbk")`, and Chinese market endpoints need both.
 *
 * Files:
 *   ~/.kalo/feeds/<id>.json          spec, one file per source (human/LLM edited)
 *   ~/.kalo/feeds/state/<id>.json    latest snapshot (written by us)
 *   ~/.kalo/feeds/secrets.json       ${secret:NAME} values, never in git
 *
 * Design notes:
 *   - own fast tick (1s) instead of the scheduler's 30s + minute cron: "every
 *     20 seconds" is not expressible as cron, and feeds don't need calendars
 *   - failure is the normal case (rate limits, closed markets, changed fields):
 *     exponential backoff, keep the last good items and mark them stale, never
 *     let a dead source turn the title bar into an error message
 *   - clock and fetch are injectable; tick() is explicit and testable
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { log } from "./protocol";

// ---------------------------------------------------------------------------
// Spec model (mirrors ~/.kalo/feeds/<id>.json)
// ---------------------------------------------------------------------------

/** Where the pulled values show up. M1 implements `ticker` only. */
export type FeedSurface = "ticker" | "card" | "alert" | "note";

export type FeedEncoding = "utf-8" | "gbk";

/** One field extractor. Exactly one of path/regex/index/const applies. */
export interface FeedField {
  /** JSON dotted path; numeric segments index arrays ("data.diff.0.f2"). */
  path?: string;
  /** Text: first match of this pattern, capture group `group` (default 1). */
  regex?: string;
  group?: number;
  /** Text: split the row by `sep` and take segment `index`. */
  index?: number;
  sep?: string;
  /** Literal text (sources that don't carry a name of their own). */
  const?: string;
  // Numeric shaping, applied in this order.
  /** Multiplier — Eastmoney returns fixed-point ints, so 0.01. */
  scale?: number;
  /** Decimal places (rounds). */
  digits?: number;
  /** Prefix positive numbers with "+". */
  plus?: boolean;
  prefix?: string;
  suffix?: string;
}

export interface FeedRequest {
  url: string;
  /** Response charset; GBK is common on Chinese quote endpoints. */
  encoding?: FeedEncoding;
  headers?: Record<string, string>;
}

export interface FeedSpec {
  id: string;
  name: string;
  /** Pull interval in seconds; clamped to >= MIN_EVERY_SEC. */
  everySec: number;
  surface: FeedSurface;
  enabled: boolean;
  request: FeedRequest;
  /** Split the response into rows: JSON array path, or text separator. */
  rows?: { path?: string; split?: string };
  fields: Record<string, FeedField>;
  /** Row template; `{field}` placeholders are replaced by extracted values. */
  template: string;
  /** Field whose sign decides the up/down color. */
  trendField?: string;
}

export type FeedTrend = "up" | "down" | "flat";

export interface FeedItem {
  text: string;
  trend: FeedTrend | null;
}

/** One pull's result; persisted to ~/.kalo/feeds/state/<id>.json. */
export interface FeedSnapshot {
  id: string;
  /** ISO time this pull settled. */
  at: string;
  ok: boolean;
  /** Round-trip duration in ms. */
  ms: number;
  /** On failure these are the last successful items (see `stale`). */
  items: FeedItem[];
  error?: string;
  /** True when `items` predate the latest (failed) pull. */
  stale?: boolean;
}

/** Snapshot row sent upstream: spec + latest values + computed next pull. */
export interface FeedInfo extends FeedSpec {
  snapshot: FeedSnapshot | null;
  nextPullAt: string | null;
  consecutiveFailures: number;
}

interface RuntimeState {
  nextPullAt: number;
  failures: number;
  /** Re-entrancy guard: a slow response must not stack requests. */
  running: boolean;
  snapshot: FeedSnapshot | null;
}

const TICK_MS = 1_000;
const MIN_EVERY_SEC = 5;
const FETCH_TIMEOUT_MS = 3_000;
const MAX_BODY_BYTES = 512 * 1024;
/** Backoff after consecutive failures: everySec * 2^n, capped. */
const MAX_BACKOFF_MS = 10 * 60_000;
/** After this many failures in a row the feed stops touching the network. */
const QUIET_AFTER_FAILURES = 12;

const feedsDir = join(homedir(), ".kalo", "feeds");
const stateDir = join(feedsDir, "state");

// ---------------------------------------------------------------------------
// Response decoding & extraction
// ---------------------------------------------------------------------------

export function decodeBody(bytes: Uint8Array, encoding: FeedEncoding | undefined): string {
  // "gbk" covers GB2312/GB18030 in ICU, which is what the quote endpoints send.
  return new TextDecoder(encoding === "gbk" ? "gbk" : "utf-8").decode(bytes);
}

/** Walk a dotted path; numeric segments index arrays. undefined when absent. */
function atPath(value: unknown, path: string): unknown {
  let cur: any = value;
  for (const seg of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/**
 * Apply the numeric shaping chain. Values are only parsed as numbers when the
 * field asks for shaping — otherwise the source's own text is kept verbatim,
 * so "10874.20" and "000001" survive instead of becoming 10874.2 and 1.
 */
function shape(raw: unknown, f: FeedField): string {
  if (raw === null || raw === undefined) return "";
  const wantsNumber = f.scale !== undefined || f.digits !== undefined || f.plus === true;
  let text = String(raw).trim();
  const num = typeof raw === "number" ? raw : Number(text);
  if (wantsNumber && text !== "" && Number.isFinite(num)) {
    let n = num;
    if (f.scale !== undefined && Number.isFinite(f.scale)) n *= f.scale;
    text = f.digits !== undefined ? n.toFixed(Math.max(0, Math.min(8, f.digits))) : String(n);
    if (f.plus && n > 0) text = `+${text}`;
  }
  return `${f.prefix ?? ""}${text}${f.suffix ?? ""}`;
}

/**
 * Pull one field out of a row. `json` is the parsed row (when the body was
 * JSON), `text` its raw string form — a spec may use either extractor shape
 * regardless of the response's content type.
 */
export function extractField(f: FeedField, json: unknown, text: string): string {
  if (f.const !== undefined) return shape(f.const, f);
  if (f.path !== undefined) return shape(atPath(json, f.path), f);
  if (f.regex !== undefined) {
    let m: RegExpExecArray | null = null;
    try {
      m = new RegExp(f.regex).exec(text);
    } catch {
      return ""; // A bad pattern is a config bug, not a runtime failure.
    }
    return m ? shape(m[f.group ?? 1] ?? "", f) : "";
  }
  if (f.index !== undefined) {
    const parts = text.split(f.sep ?? ",");
    return shape(parts[f.index] ?? "", f);
  }
  return "";
}

function trendOf(value: string | undefined): FeedTrend | null {
  if (value === undefined || value === "") return null;
  const n = Number(value.replace(/[^\d.+-]/g, ""));
  if (!Number.isFinite(n)) return null;
  return n > 0 ? "up" : n < 0 ? "down" : "flat";
}

/**
 * Turn a raw response body into rendered items. Pure — this is the part the
 * tests care about, and the part a dry-run exercises.
 */
export function renderItems(spec: FeedSpec, body: string): FeedItem[] {
  // Rows: JSON array at a path, a text split, or the whole body as one row.
  let rows: Array<{ json: unknown; text: string }>;
  const splitBy = spec.rows?.split;
  if (splitBy !== undefined) {
    rows = body
      .split(splitBy)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => ({ json: undefined, text: line }));
  } else if (spec.rows?.path) {
    const parsed = JSON.parse(body);
    const arr = atPath(parsed, spec.rows.path);
    if (!Array.isArray(arr)) throw new Error(`rows.path "${spec.rows.path}" 不是数组`);
    rows = arr.map((el) => ({ json: el, text: typeof el === "string" ? el : JSON.stringify(el) }));
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = undefined; // Plain-text source: only regex/index extractors apply.
    }
    rows = [{ json: parsed, text: body }];
  }

  const items: FeedItem[] = [];
  for (const row of rows) {
    const values: Record<string, string> = {};
    for (const [key, field] of Object.entries(spec.fields)) {
      values[key] = extractField(field, row.json, row.text);
    }
    const text = spec.template.replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue; // Every field missing = a row worth skipping, not showing.
    items.push({ text, trend: spec.trendField ? trendOf(values[spec.trendField]) : null });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface FeedFetchResult {
  bytes: Uint8Array;
  status: number;
}

export interface FeedEngineDeps {
  /** Called whenever any feed's spec or snapshot changed (broadcast hook). */
  onChange: () => void;
  now?: () => number;
  /** Override the feeds directory (tests). */
  dir?: string;
  /** Override the network layer (tests). */
  fetchImpl?: (url: string, headers: Record<string, string>) => Promise<FeedFetchResult>;
}

export class FeedEngine {
  private specs = new Map<string, FeedSpec>();
  private runtime = new Map<string, RuntimeState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly dir: string;
  private readonly stateDir: string;
  private readonly fetchImpl: (url: string, headers: Record<string, string>) => Promise<FeedFetchResult>;

  constructor(private deps: FeedEngineDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.dir = deps.dir ?? feedsDir;
    this.stateDir = deps.dir ? join(deps.dir, "state") : stateDir;
    this.fetchImpl = deps.fetchImpl ?? httpGet;
  }

  /** Read every `<id>.json` in the feeds dir, plus each cached snapshot. */
  load(): void {
    this.specs.clear();
    this.runtime.clear();
    let names: string[] = [];
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith(".json") && n !== "secrets.json");
    } catch {
      return; // No feeds dir yet.
    }
    for (const name of names) {
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(join(this.dir, name), "utf-8"));
      } catch (err) {
        log(`feed ${name} unreadable:`, err instanceof Error ? err.message : err);
        continue;
      }
      const spec = sanitizeSpec(raw);
      if (!spec) {
        log(`feed ${name} rejected: bad spec`);
        continue;
      }
      this.specs.set(spec.id, spec);
      this.runtime.set(spec.id, {
        nextPullAt: this.now(),
        failures: 0,
        running: false,
        snapshot: this.readSnapshot(spec.id),
      });
    }
    log(`feeds loaded ${this.specs.size} source(s)`);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  list(): FeedInfo[] {
    return [...this.specs.values()].map((spec) => {
      const rt = this.runtime.get(spec.id);
      return {
        ...spec,
        snapshot: rt?.snapshot ?? null,
        nextPullAt: spec.enabled && rt ? new Date(rt.nextPullAt).toISOString() : null,
        consecutiveFailures: rt?.failures ?? 0,
      };
    });
  }

  /** Insert or replace a spec (writes `<id>.json`). Error string on bad input. */
  upsert(raw: unknown): string | null {
    const spec = sanitizeSpec(raw);
    if (!spec) return "数据源格式不正确（缺 id/name/request.url/fields/template）";
    const urlErr = checkUrl(spec.request.url);
    if (urlErr) return urlErr;
    const prev = this.runtime.get(spec.id);
    this.specs.set(spec.id, spec);
    this.runtime.set(spec.id, {
      // Editing a source is an implicit "try it now".
      nextPullAt: this.now(),
      failures: 0,
      running: prev?.running ?? false,
      snapshot: prev?.snapshot ?? this.readSnapshot(spec.id),
    });
    this.writeSpec(spec);
    this.deps.onChange();
    return null;
  }

  remove(id: string): void {
    this.specs.delete(id);
    this.runtime.delete(id);
    for (const file of [join(this.dir, `${id}.json`), join(this.stateDir, `${id}.json`)]) {
      try {
        if (existsSync(file)) unlinkSync(file);
      } catch (err) {
        log(`feed ${id}: cannot delete ${file}:`, err instanceof Error ? err.message : err);
      }
    }
    this.deps.onChange();
  }

  /** Manual "pull now": ignores enabled, backoff and the quiet threshold. */
  async runNow(id: string): Promise<string | null> {
    const spec = this.specs.get(id);
    if (!spec) return `未知数据源：${id}`;
    await this.pull(spec);
    return null;
  }

  /** One pass: pull every enabled feed whose nextPullAt has arrived. */
  async tick(): Promise<void> {
    const now = this.now();
    const due: FeedSpec[] = [];
    for (const spec of this.specs.values()) {
      const rt = this.runtime.get(spec.id);
      if (!rt || !spec.enabled || rt.running) continue;
      if (rt.nextPullAt > now) continue;
      if (rt.failures >= QUIET_AFTER_FAILURES) continue;
      due.push(spec);
    }
    await Promise.all(due.map((spec) => this.pull(spec)));
  }

  /** Items of every enabled feed on a surface, in spec order. */
  itemsFor(surface: FeedSurface): FeedItem[] {
    const out: FeedItem[] = [];
    for (const spec of this.specs.values()) {
      if (!spec.enabled || spec.surface !== surface) continue;
      out.push(...(this.runtime.get(spec.id)?.snapshot?.items ?? []));
    }
    return out;
  }

  // ------------------------------------------------------------------ //

  private async pull(spec: FeedSpec): Promise<void> {
    const rt = this.runtime.get(spec.id);
    if (!rt || rt.running) return;
    rt.running = true;
    const started = this.now();
    try {
      const secrets = this.readSecrets();
      const url = fillSecrets(spec.request.url, secrets);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(spec.request.headers ?? {})) {
        headers[k] = fillSecrets(v, secrets);
      }
      const res = await this.fetchImpl(url, headers);
      if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
      if (res.bytes.byteLength > MAX_BODY_BYTES) {
        throw new Error(`响应超过 ${Math.round(MAX_BODY_BYTES / 1024)}KB 上限`);
      }
      const items = renderItems(spec, decodeBody(res.bytes, spec.request.encoding));
      if (items.length === 0) throw new Error("解析结果为空（检查 rows/fields 路径）");
      rt.failures = 0;
      this.settle(spec, rt, { ok: true, ms: this.now() - started, items });
    } catch (err) {
      rt.failures += 1;
      const message = err instanceof Error ? err.message : String(err);
      // Keep the last good values: a stale number beats an empty title bar.
      this.settle(spec, rt, {
        ok: false,
        ms: this.now() - started,
        items: rt.snapshot?.items ?? [],
        error: message,
        stale: (rt.snapshot?.items?.length ?? 0) > 0,
      });
      if (rt.failures === QUIET_AFTER_FAILURES) {
        log(`feed ${spec.id}: ${rt.failures} consecutive failures, going quiet (${message})`);
      }
    } finally {
      rt.running = false;
      rt.nextPullAt = this.now() + this.intervalMs(spec, rt.failures);
    }
  }

  /** everySec, doubled per consecutive failure, capped. */
  private intervalMs(spec: FeedSpec, failures: number): number {
    const base = Math.max(MIN_EVERY_SEC, spec.everySec) * 1000;
    if (failures === 0) return base;
    return Math.min(base * 2 ** Math.min(failures, 10), MAX_BACKOFF_MS);
  }

  private settle(spec: FeedSpec, rt: RuntimeState, part: Omit<FeedSnapshot, "id" | "at">): void {
    const snapshot: FeedSnapshot = { id: spec.id, at: new Date(this.now()).toISOString(), ...part };
    rt.snapshot = snapshot;
    this.writeSnapshot(snapshot);
    this.deps.onChange();
  }

  private readSnapshot(id: string): FeedSnapshot | null {
    try {
      const raw = JSON.parse(readFileSync(join(this.stateDir, `${id}.json`), "utf-8"));
      if (typeof raw?.id !== "string" || !Array.isArray(raw?.items)) return null;
      // A snapshot from a previous run is by definition not the current value.
      return { ...raw, stale: true } as FeedSnapshot;
    } catch {
      return null;
    }
  }

  private readSecrets(): Record<string, string> {
    try {
      const raw = JSON.parse(readFileSync(join(this.dir, "secrets.json"), "utf-8"));
      return raw && typeof raw === "object" ? raw : {};
    } catch {
      return {};
    }
  }

  private writeSpec(spec: FeedSpec): void {
    writeAtomic(join(this.dir, `${spec.id}.json`), JSON.stringify(spec, null, 2) + "\n");
  }

  private writeSnapshot(snapshot: FeedSnapshot): void {
    try {
      writeAtomic(join(this.stateDir, `${snapshot.id}.json`), JSON.stringify(snapshot, null, 2) + "\n");
    } catch (err) {
      // A read-only disk must not stop the in-memory ticker.
      log(`feed ${snapshot.id}: snapshot write failed:`, err instanceof Error ? err.message : err);
    }
  }

  /** Write the bundled example sources once, if the feeds dir has none. */
  seedExamples(): void {
    try {
      if (existsSync(this.dir) && readdirSync(this.dir).some((n) => n.endsWith(".json") && n !== "secrets.json")) {
        return;
      }
    } catch {
      // Missing dir: fall through and create it with the examples.
    }
    for (const spec of EXAMPLE_FEEDS) {
      this.specs.set(spec.id, spec);
      this.runtime.set(spec.id, { nextPullAt: this.now(), failures: 0, running: false, snapshot: null });
      this.writeSpec(spec);
    }
    log(`feeds seeded ${EXAMPLE_FEEDS.length} example source(s)`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeAtomic(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

/** Replace `${secret:NAME}` with its value; unknown names become empty. */
export function fillSecrets(text: string, secrets: Record<string, string>): string {
  return text.replace(/\$\{secret:([\w.-]+)\}/g, (_, name: string) => secrets[name] ?? "");
}

/** null when the URL is usable as a feed source. */
export function checkUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `URL 无法解析：${url}`;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `只支持 http/https，收到 ${parsed.protocol}`;
  }
  return null;
}

/** GET with a hard timeout and a byte cap. The only network path feeds have. */
async function httpGet(url: string, headers: Record<string, string>): Promise<FeedFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": "kalo-feeds/1.0", ...headers },
      signal: controller.signal,
      redirect: "follow",
    });
    const buf = await res.arrayBuffer();
    return { bytes: new Uint8Array(buf), status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

/** Coerce untrusted JSON into a FeedSpec; null when unusable. */
export function sanitizeSpec(raw: any): FeedSpec | null {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.id !== "string" || !/^[\w-]{1,64}$/.test(raw.id)) return null;
  if (typeof raw.name !== "string" || !raw.name.trim()) return null;
  if (!raw.request || typeof raw.request.url !== "string" || !raw.request.url.trim()) return null;
  if (typeof raw.template !== "string" || !raw.template.trim()) return null;
  if (!raw.fields || typeof raw.fields !== "object") return null;

  const fields: Record<string, FeedField> = {};
  for (const [key, value] of Object.entries<any>(raw.fields)) {
    if (!/^\w{1,32}$/.test(key) || !value || typeof value !== "object") continue;
    fields[key] = {
      path: str(value.path),
      regex: str(value.regex),
      group: num(value.group),
      index: num(value.index),
      sep: str(value.sep),
      const: str(value.const),
      scale: num(value.scale),
      digits: num(value.digits),
      plus: value.plus === true,
      prefix: str(value.prefix),
      suffix: str(value.suffix),
    };
  }
  if (Object.keys(fields).length === 0) return null;

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries<any>(raw.request.headers ?? {})) {
    if (typeof value === "string" && /^[\w-]{1,64}$/.test(key)) headers[key] = value;
  }

  const surface: FeedSurface = ["ticker", "card", "alert", "note"].includes(raw.surface) ? raw.surface : "ticker";
  const rows =
    raw.rows && typeof raw.rows === "object"
      ? { path: str(raw.rows.path), split: str(raw.rows.split) }
      : undefined;

  return {
    id: raw.id,
    name: raw.name.trim(),
    everySec: Math.max(MIN_EVERY_SEC, Math.round(num(raw.everySec) ?? 60)),
    surface,
    enabled: raw.enabled !== false,
    request: {
      url: raw.request.url.trim(),
      encoding: raw.request.encoding === "gbk" ? "gbk" : "utf-8",
      headers: Object.keys(headers).length > 0 ? headers : undefined,
    },
    rows: rows && (rows.path || rows.split) ? rows : undefined,
    fields,
    template: raw.template,
    trendField: str(raw.trendField),
  };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

// ---------------------------------------------------------------------------
// Bundled examples (written once, on a feeds dir with no sources)
// ---------------------------------------------------------------------------

/**
 * Two working sources that double as documentation: one JSON-rows source with
 * fixed-point integers (Eastmoney), one single-row source (exchange rate).
 */
export const EXAMPLE_FEEDS: FeedSpec[] = [
  {
    id: "cn-index",
    name: "A股大盘",
    everySec: 20,
    surface: "ticker",
    enabled: true,
    request: {
      url: "https://push2.eastmoney.com/api/qt/ulist.np/get?fields=f2,f3,f14&secids=1.000001,0.399001,0.399006",
      encoding: "utf-8",
    },
    rows: { path: "data.diff" },
    fields: {
      label: { path: "f14" },
      value: { path: "f2", scale: 0.01, digits: 2 },
      change: { path: "f3", scale: 0.01, digits: 2, plus: true, suffix: "%" },
    },
    template: "{label} {value} {change}",
    trendField: "change",
  },
  {
    // Text + GBK + positional fields — deliberately a different shape from the
    // JSON example above. One line:
    //   var hq_str_fx_susdcny="时间,…,3=昨收,…,8=最新价,9=名称,10=涨跌幅,11=涨跌额,…";
    // Splitting on "," makes those positions the extractor indexes (index 0
    // also carries the `var …="` prefix, which no field reads).
    id: "usd-cny",
    name: "美元人民币",
    everySec: 120,
    surface: "ticker",
    enabled: true,
    request: {
      url: "https://hq.sinajs.cn/list=fx_susdcny",
      encoding: "gbk",
      headers: { Referer: "https://finance.sina.com.cn/" },
    },
    fields: {
      label: { const: "USD/CNY" },
      value: { index: 8, sep: ",", digits: 4 },
      change: { index: 10, sep: ",", digits: 2, plus: true, suffix: "%" },
    },
    template: "{label} {value} {change}",
    trendField: "change",
  },
];
