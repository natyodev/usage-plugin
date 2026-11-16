import { isPercent, isRecord, parseInstant } from "../domain.ts";
import type { Instant, Miss, Window, Windows } from "../domain.ts";
import type { FetchContext, FetchResult } from "./index.ts";

const LOGIN_FILE = ".claude/.credentials.json";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

const WINDOW_KEYS = [
  { key: "five_hour", label: "5 hour", minutes: 5 * 60 },
  { key: "seven_day", label: "7 day", minutes: 7 * 24 * 60 },
] as const;

export async function fetchClaude(ctx: FetchContext): Promise<FetchResult> {
  const file = await ctx.readLogin(LOGIN_FILE);
  if (file.kind !== "json") return file;

  const login = parseLogin(file.value, ctx.now);
  if (login.kind !== "login") return login;

  const reply = await ctx.get(
    USAGE_URL,
    { Authorization: `Bearer ${login.accessToken}`, "anthropic-beta": "oauth-2025-04-20" },
    // Claude Code's own client reads a 403 from this endpoint as "slow down".
    { alsoRateLimited: [403] },
  );
  if (reply.kind !== "json") return reply;

  const usage = parseUsage(reply.body);
  if (usage.kind !== "windows") return usage;
  return { kind: "windows", windows: usage.windows, plan: login.plan };
}

interface Login {
  readonly kind: "login";
  readonly accessToken: string;
  readonly plan: string | null;
}

/**
 * A login past its own `expiresAt` is expired without a request, because the endpoint rate
 * limits after about eight calls. A login with no usable `expiresAt` is left to the provider.
 * The refresh token is never read.
 */
export function parseLogin(
  credentials: unknown,
  now: Instant,
): Login | Extract<Miss, { kind: "signedOut" | "loginExpired" }> {
  const oauth = isRecord(credentials) ? credentials.claudeAiOauth : undefined;
  if (!isRecord(oauth)) return { kind: "signedOut" };

  const { accessToken, expiresAt, subscriptionType } = oauth;
  if (typeof accessToken !== "string" || accessToken === "") return { kind: "signedOut" };
  if (typeof expiresAt === "number" && expiresAt <= now) return { kind: "loginExpired" };
  return { kind: "login", accessToken, plan: typeof subscriptionType === "string" ? subscriptionType : null };
}

/**
 * A window that is missing, null, or has a null `utilization` does not exist for this account
 * and is skipped. Anything else that does not parse is `unreadable`, never a default.
 */
export function parseUsage(
  body: unknown,
): { readonly kind: "windows"; readonly windows: Windows } | Extract<Miss, { kind: "unreadable" }> {
  if (!isRecord(body)) return unreadable("reply is not an object");

  const windows: Window[] = [];
  for (const { key, label, minutes } of WINDOW_KEYS) {
    const raw = body[key];
    if (raw === undefined || raw === null) continue;
    if (!isRecord(raw)) return unreadable(`${key} is not an object`);

    const { utilization, resets_at } = raw;
    if (utilization === null) continue;
    if (!isPercent(utilization)) return unreadable(`${key}.utilization is not a number`);

    let resetsAt: Instant | null = null;
    if (resets_at !== undefined && resets_at !== null) {
      resetsAt = parseInstant(resets_at);
      if (resetsAt === null) return unreadable(`${key}.resets_at is not a time`);
    }
    windows.push({ label, usedPercent: utilization, resetsAt, detail: [], minutes });
  }

  const [first, ...rest] = windows;
  if (first === undefined) return unreadable("reply has neither five_hour nor seven_day");
  return { kind: "windows", windows: [first, ...rest] };
}

function unreadable(detail: string): Extract<Miss, { kind: "unreadable" }> {
  return { kind: "unreadable", detail };
}
