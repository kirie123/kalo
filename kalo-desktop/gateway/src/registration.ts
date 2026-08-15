/**
 * Feishu / Lark scan-to-create-app registration (device-code flow).
 *
 * Mirrors the flow proven in hermes-agent's feishu adapter:
 *   POST {accounts}/oauth/v1/app/registration  (form-encoded)
 *     action=init   → verify client_secret support
 *     action=begin  → device_code + verification_uri_complete (QR URL)
 *     action=poll   → authorization_pending | access_denied | expired_token
 *                     | client_id/client_secret (+ user_info.open_id)
 * A `tenant_brand=lark` poll response switches to the Lark (international)
 * domain automatically.
 */

import { toDataURL as renderQrDataUrl } from "qrcode";

const ACCOUNTS_URLS = {
  feishu: "https://accounts.feishu.cn",
  lark: "https://accounts.larksuite.com",
} as const;

const OPEN_URLS = {
  feishu: "https://open.feishu.cn",
  lark: "https://open.larksuite.com",
} as const;

const REGISTRATION_PATH = "/oauth/v1/app/registration";
const REQUEST_TIMEOUT_MS = 15_000;

export type FeishuDomain = "feishu" | "lark";

export interface RegistrationBegin {
  deviceCode: string;
  qrUrl: string;
  interval: number;
  expireIn: number;
}

export interface RegistrationResult {
  appId: string;
  appSecret: string;
  openId: string;
  domain: FeishuDomain;
}

export class RegistrationDenied extends Error {
  constructor(
    public reason: "access_denied" | "expired_token" | "cancelled" | "timeout",
    message: string,
  ) {
    super(message);
  }
}

async function postRegistration(
  domain: FeishuDomain,
  form: Record<string, string>,
): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(ACCOUNTS_URLS[domain] + REGISTRATION_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      signal: controller.signal,
    });
    // The endpoint returns JSON even on 4xx (authorization_pending is a 400).
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`registration endpoint returned non-JSON (HTTP ${res.status})`);
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function beginRegistration(domain: FeishuDomain = "feishu"): Promise<RegistrationBegin> {
  const init = await postRegistration(domain, { action: "init" });
  const methods: unknown[] = init?.supported_auth_methods ?? [];
  if (!methods.includes("client_secret")) {
    throw new Error(
      `Feishu 注册环境不支持 client_secret 授权（支持：${methods.join(", ") || "无"}）`,
    );
  }

  const res = await postRegistration(domain, {
    action: "begin",
    archetype: "PersonalAgent",
    auth_method: "client_secret",
    request_user_info: "open_id",
  });
  const deviceCode: unknown = res?.device_code;
  if (typeof deviceCode !== "string" || !deviceCode) {
    throw new Error("注册接口未返回 device_code");
  }
  let qrUrl: string = res?.verification_uri_complete ?? "";
  if (qrUrl) qrUrl += (qrUrl.includes("?") ? "&" : "?") + "from=kalo";
  return {
    deviceCode,
    qrUrl,
    interval: Number(res?.interval) || 5,
    expireIn: Number(res?.expire_in) || 600,
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Poll until the user scans the QR. Resolves with credentials on success;
 * throws RegistrationDenied on denial/expiry/cancel/timeout, Error on
 * unrecoverable protocol failures (the first network error is retried
 * inline, matching hermes behaviour).
 */
export async function pollRegistration(opts: {
  begin: RegistrationBegin;
  domain?: FeishuDomain;
  isCancelled: () => boolean;
}): Promise<RegistrationResult> {
  const { begin, isCancelled } = opts;
  let domain: FeishuDomain = opts.domain ?? "feishu";
  let domainSwitched = false;
  const deadline = Date.now() + begin.expireIn * 1000;

  while (Date.now() < deadline) {
    if (isCancelled()) throw new RegistrationDenied("cancelled", "已取消扫码");
    let res: any;
    try {
      res = await postRegistration(domain, {
        action: "poll",
        device_code: begin.deviceCode,
        tp: "ob_app",
      });
    } catch (err) {
      // Transient network failure — keep polling.
      await sleep(begin.interval * 1000);
      continue;
    }

    const userInfo = res?.user_info ?? {};
    if (userInfo?.tenant_brand === "lark" && !domainSwitched) {
      domain = "lark";
      domainSwitched = true;
      // Fall through: the server may return credentials in this same response.
    }

    if (typeof res?.client_id === "string" && typeof res?.client_secret === "string") {
      const openId: unknown = userInfo?.open_id;
      return {
        appId: res.client_id,
        appSecret: res.client_secret,
        openId: typeof openId === "string" ? openId : "",
        domain,
      };
    }

    const error: unknown = res?.error;
    if (error === "access_denied" || error === "expired_token") {
      throw new RegistrationDenied(
        error,
        error === "access_denied" ? "扫码授权被拒绝" : "二维码已过期，请重试",
      );
    }
    // authorization_pending or unknown — keep polling.
    await sleep(begin.interval * 1000);
  }
  throw new RegistrationDenied("timeout", "扫码超时，请重试");
}

export async function qrDataUrl(url: string): Promise<string> {
  return renderQrDataUrl(url, { margin: 1, width: 420 });
}

/**
 * Verify bot connectivity via /open-apis/bot/v3/info (raw HTTP, best-effort).
 * Returns the bot name, or null when the probe fails.
 */
export async function probeBot(
  appId: string,
  appSecret: string,
  domain: FeishuDomain,
): Promise<string | null> {
  const base = OPEN_URLS[domain];
  try {
    const tokenRes = await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    const token = (await tokenRes.json()) as any;
    if (!token?.tenant_access_token) return null;

    const botRes = await fetch(`${base}/open-apis/bot/v3/info`, {
      headers: { Authorization: `Bearer ${token.tenant_access_token}` },
    });
    const bot = (await botRes.json()) as any;
    if (bot?.code !== 0) return null;
    return bot?.bot?.app_name ?? bot?.bot?.bot_name ?? null;
  } catch {
    return null;
  }
}
