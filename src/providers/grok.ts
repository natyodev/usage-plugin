import { isPercent, isRecord, parseInstant } from "../domain.ts";
import type { Instant, Miss, Window, WindowDetail } from "../domain.ts";
import type { FetchContext, FetchResult } from "./index.ts";

const LOGIN_FILE = ".grok/auth.json";
const LOGIN_KEY_PREFIX = "https://auth.x.ai::";
/** Without `?format=credits` the endpoint answers an older shape whose values are all zero. */
const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

const WEEKLY = "USAGE_PERIOD_TYPE_WEEKLY";
const PRODUCT_LABELS: ReadonlyMap<string, string> = new Map([
  ["GrokBot", "Chat"],
  ["GrokBuild", "Build"],
]);

export async function fetchGrok(ctx: FetchContext): Promise<FetchResult> {
  const file = await ctx.readLogin(LOGIN_FILE);
  if (file.kind !== "json") return file;

  const login = parseLogin(file.value, ctx.now);
  if (login.kind !== "login") return login;

  const reply = await ctx.get(BILLING_URL, { Authorization: `Bearer ${login.key}` });
  if (reply.kind !== "json") return reply;

  const billing = parseBilling(reply.body);
  if (billing.kind !== "window") return billing;
  return { kind: "windows", windows: [billing.window], plan: null };
}

interface Login {
  readonly kind: "login";
  readonly key: string;
}

export function parseLogin(
  auth: unknown,
  now: Instant,
): Login | Extract<Miss, { kind: "signedOut" | "loginExpired" | "unreadable" }> {
  if (!isRecord(auth)) return { kind: "signedOut" };

  const logins = Object.entries(auth).filter(([name]) => name.startsWith(LOGIN_KEY_PREFIX));
  if (logins.length > 1) return unreadable(`${LOGIN_FILE} holds ${logins.length} x.ai logins`);
  const login = logins[0]?.[1];
  if (!isRecord(login)) return { kind: "signedOut" };

  const { key } = login;
  if (typeof key !== "string" || key === "") return { kind: "signedOut" };
  const expiresAt = parseInstant(login.expires_at);
  if (expiresAt !== null && expiresAt <= now) return { kind: "loginExpired" };
  return { kind: "login", key };
}

export function parseBilling(
  body: unknown,
): { readonly kind: "window"; readonly window: Window } | Extract<Miss, { kind: "unreadable" }> {
  const config = isRecord(body) ? body.config : undefined;
  if (!isRecord(config)) return unreadable("reply has no config object");

  const { creditUsagePercent, currentPeriod, productUsage } = config;
  if (!isPercent(creditUsagePercent)) return unreadable("config.creditUsagePercent is not a number");
  if (!isRecord(currentPeriod)) return unreadable("config.currentPeriod is not an object");

  if (currentPeriod.type !== WEEKLY) return unreadable("config.currentPeriod.type is not weekly");
  const resetsAt = parseInstant(currentPeriod.end);
  if (resetsAt === null) return unreadable("config.currentPeriod.end is not a time");

  const detail = parseProductUsage(productUsage);
  if (detail === null) return unreadable("config.productUsage is not a list of products with a percent");
  return { kind: "window", window: { label: "Weekly", usedPercent: creditUsagePercent, resetsAt, detail, minutes: 7 * 24 * 60 } };
}

function parseProductUsage(productUsage: unknown): WindowDetail[] | null {
  if (productUsage === undefined || productUsage === null) return [];
  if (!Array.isArray(productUsage)) return null;

  const detail: WindowDetail[] = [];
  for (const entry of productUsage) {
    if (!isRecord(entry)) return null;
    const { product, usagePercent } = entry;
    if (typeof product !== "string" || product === "" || !isPercent(usagePercent)) return null;
    detail.push({ label: PRODUCT_LABELS.get(product) ?? product, usedPercent: usagePercent });
  }
  return detail;
}

function unreadable(detail: string): Extract<Miss, { kind: "unreadable" }> {
  return { kind: "unreadable", detail };
}
