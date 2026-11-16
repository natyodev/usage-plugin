import { describe, expect, test } from "bun:test";
import { DIRECT, instant } from "../../src/domain.ts";
import { fetchClaude, parseLogin, parseUsage } from "../../src/providers/claude.ts";
import { attempt } from "../../src/providers/index.ts";
import type { FetchContext, GetOptions } from "../../src/providers/index.ts";
import {
  caseWith,
  CLAUDE,
  CLAUDE_LOGIN_PATH,
  deadlineFromNow,
  fetchEnv,
  fixtureCase,
  LIVE_LOGIN,
  percent,
  T0,
  tempDir,
  window,
  writeFileUnder,
} from "../support.ts";

const RESET = "2026-11-16T06:30:00.046620+00:00";
const RESET_AT = instant(Date.UTC(2026, 10, 16, 6, 30, 0, 46));

function replyWith(status: number, headers: Record<string, string> = {}, body: unknown = {}) {
  return caseWith({ reply: { status, headers, body }, login: LIVE_LOGIN });
}

describe("the claude-ok fixture", () => {
  test("becomes a reading with the 5 hour and 7 day windows, stamped by the core", async () => {
    const outcome = await attempt(CLAUDE, fetchEnv());
    expect(outcome).toEqual({
      kind: "reading",
      reading: {
        provider: CLAUDE.id,
        plan: "max",
        windows: [window("5 hour", 66, 1410, 300), window("7 day", 12, 282600, 10080)],
        takenAt: T0,
        via: DIRECT,
      },
    });
  });

  test("costs exactly one request, logged with its URL", async () => {
    const env = fetchEnv();
    await attempt(CLAUDE, env);
    expect(env.requests).toEqual([
      {
        event: "request",
        provider: CLAUDE.id,
        via: "fixture",
        method: "GET",
        url: "https://api.anthropic.com/api/oauth/usage",
      },
    ]);
  });
});

describe("parseUsage", () => {
  test("ignores every key it does not know, null or not", () => {
    const parsed = parseUsage({
      five_hour: { utilization: 5, resets_at: RESET, limit_dollars: null, brand_new: { nested: [1, 2] } },
      seven_day: { utilization: 9.5, resets_at: RESET },
      seven_day_opus: null,
      tangelo: { utilization: "not a window we read" },
      limits: [{ kind: "session", percent: 5 }],
    });
    expect(parsed).toEqual({
      kind: "windows",
      windows: [
        { label: "5 hour", usedPercent: percent(5), resetsAt: RESET_AT, detail: [], minutes: 300 },
        { label: "7 day", usedPercent: percent(9.5), resetsAt: RESET_AT, detail: [], minutes: 10080 },
      ],
    });
  });

  test.each([
    ["missing", { five_hour: { utilization: 40, resets_at: RESET } }],
    ["null", { five_hour: { utilization: 40, resets_at: RESET }, seven_day: null }],
    ["present with a null utilization", { five_hour: { utilization: 40, resets_at: RESET }, seven_day: { utilization: null } }],
  ])("reads the 5 hour window alone when seven_day is %s", (_case, body) => {
    expect(parseUsage(body)).toEqual({
      kind: "windows",
      windows: [{ label: "5 hour", usedPercent: percent(40), resetsAt: RESET_AT, detail: [], minutes: 300 }],
    });
  });

  test("reads the 7 day window alone when five_hour is missing", () => {
    expect(parseUsage({ seven_day: { utilization: 3, resets_at: RESET } })).toMatchObject({
      kind: "windows",
      windows: [{ label: "7 day", usedPercent: 3 }],
    });
  });

  test("keeps a percent above 100", () => {
    expect(parseUsage({ five_hour: { utilization: 104, resets_at: RESET } })).toMatchObject({
      windows: [{ usedPercent: 104 }],
    });
  });

  test.each([[null], [undefined]])("reads a window with resets_at %p as having no reset time", (resetsAt) => {
    expect(parseUsage({ five_hour: { utilization: 0, resets_at: resetsAt } })).toMatchObject({
      windows: [{ usedPercent: 0, resetsAt: null }],
    });
  });

  test.each([
    ["a body that is not an object", "five hours"],
    ["an array body", []],
    ["a body with neither window", { seven_day_opus: null }],
    ["a utilization that is a string", { five_hour: { utilization: "66", resets_at: RESET } }],
    ["a window with no utilization key", { five_hour: { resets_at: RESET } }],
    ["a negative utilization", { five_hour: { utilization: -1, resets_at: RESET } }],
    ["a window that is not an object", { five_hour: 66 }],
    ["a resets_at that is not a time", { five_hour: { utilization: 66, resets_at: "soon" } }],
    ["a resets_at that only ends in a number", { five_hour: { utilization: 66, resets_at: "SECRET-BODY-5" } }],
    ["a resets_at with no offset", { five_hour: { utilization: 66, resets_at: "2026-11-16T06:30:00" } }],
  ])("reads %s as unreadable, never as a default", (_case, body) => {
    expect(parseUsage(body).kind).toBe("unreadable");
  });

  test("names the unreadable field without quoting the reply", () => {
    const parsed = parseUsage({ five_hour: { utilization: "value-from-the-reply", resets_at: RESET } });
    expect(parsed).toMatchObject({ kind: "unreadable", detail: expect.stringContaining("five_hour.utilization") });
    expect(JSON.stringify(parsed)).not.toContain("value-from-the-reply");
  });
});

describe("parseLogin", () => {
  test("reads the access token and the plan", () => {
    expect(parseLogin(LIVE_LOGIN, T0)).toEqual({ kind: "login", accessToken: "fixture-access-token", plan: "max" });
  });

  test.each([
    ["a file with no claudeAiOauth", { somethingElse: {} }],
    ["a claudeAiOauth with no access token", { claudeAiOauth: { refreshToken: "fixture-refresh-token" } }],
    ["an access token that is not a string", { claudeAiOauth: { accessToken: 42 } }],
    ["an empty access token", { claudeAiOauth: { accessToken: "" } }],
    ["a file that is not an object", "fixture-access-token"],
    ["null", null],
  ])("reads %s as signed out", (_case, credentials) => {
    expect(parseLogin(credentials, T0)).toEqual({ kind: "signedOut" });
  });

  test("reads a login at or past its own expiry time as expired", () => {
    const expiring = (expiresAt: number) => ({ claudeAiOauth: { accessToken: "fixture-access-token", expiresAt } });
    expect(parseLogin(expiring(T0), T0)).toEqual({ kind: "loginExpired" });
    expect(parseLogin(expiring(T0 - 1), T0)).toEqual({ kind: "loginExpired" });
    expect(parseLogin(expiring(T0 + 1), T0).kind).toBe("login");
  });

  test.each([[undefined], ["2100-01-01"], [null]])("leaves a login with expiresAt %p to the provider", (expiresAt) => {
    const credentials = { claudeAiOauth: { accessToken: "fixture-access-token", expiresAt } };
    expect(parseLogin(credentials, T0).kind).toBe("login");
  });

  test("reads a plan that is not a string as unknown", () => {
    const credentials = { claudeAiOauth: { accessToken: "fixture-access-token", subscriptionType: 7 } };
    expect(parseLogin(credentials, T0)).toMatchObject({ kind: "login", plan: null });
  });
});

describe("what Claude's answer becomes", () => {
  test("401 is an expired login", async () => {
    const env = fetchEnv({ fixtures: replyWith(401) });
    expect(await attempt(CLAUDE, env)).toEqual({ kind: "loginExpired" });
    expect(env.requests).toHaveLength(1);
  });

  test("403 is a rate limit, as Claude's own client reads it", async () => {
    const outcome = await attempt(CLAUDE, fetchEnv({ fixtures: replyWith(403) }));
    expect(outcome).toEqual({ kind: "rateLimited", retryAfterSeconds: null });
  });

  test("429 with Retry-After seconds carries them", async () => {
    const outcome = await attempt(CLAUDE, fetchEnv({ fixtures: fixtureCase("claude-429") }));
    expect(outcome).toEqual({ kind: "rateLimited", retryAfterSeconds: 120 });
  });

  test("429 with a Retry-After date carries the seconds until it", async () => {
    const fixtures = replyWith(429, { "retry-after": "Mon, 16 Nov 2026 06:01:30 GMT" });
    expect(await attempt(CLAUDE, fetchEnv({ fixtures }))).toEqual({ kind: "rateLimited", retryAfterSeconds: 90 });
  });

  test.each([["0", 0], [" 120 ", 120], ["86400", 86400]])("429 with Retry-After %p carries %p seconds", async (value, seconds) => {
    const outcome = await attempt(CLAUDE, fetchEnv({ fixtures: replyWith(429, { "retry-after": value }) }));
    expect(outcome).toEqual({ kind: "rateLimited", retryAfterSeconds: seconds });
  });

  test("429 with a Retry-After date that has passed carries zero seconds", async () => {
    const fixtures = replyWith(429, { "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT" });
    expect(await attempt(CLAUDE, fetchEnv({ fixtures }))).toEqual({ kind: "rateLimited", retryAfterSeconds: 0 });
  });

  test("429 with no Retry-After has no retry time", async () => {
    const outcome = await attempt(CLAUDE, fetchEnv({ fixtures: replyWith(429) }));
    expect(outcome).toEqual({ kind: "rateLimited", retryAfterSeconds: null });
  });

  test.each([
    ["a while"],
    [""],
    ["-5"],
    ["1.5"],
    ["1e3"],
    ["+120"],
    ["120s"],
    ["soon 1"],
    ["SECRET-BODY-5"],
    ["99999999999999999999"],
    ["9".repeat(400)],
    ["2026-11-16T06:01:30Z"],
    ["Mon, 16 Nov 2026 06:01:30 +0000"],
    ["Mon, 16 Nov 2026 06:01:30"],
    ["16 Nov 2026 06:01:30 GMT"],
    ["Monday, 16-Nov-26 06:01:30 GMT"],
    ["Mon, 16 Nov 2026 06:01:30 GMT and then some"],
  ])("429 with Retry-After %p has no retry time, so the back-off doubles", async (value) => {
    const outcome = await attempt(CLAUDE, fetchEnv({ fixtures: replyWith(429, { "retry-after": value }) }));
    expect(outcome).toEqual({ kind: "rateLimited", retryAfterSeconds: null });
  });

  test.each([[500], [503]])("%p is a provider having trouble", async (status) => {
    const outcome = await attempt(CLAUDE, fetchEnv({ fixtures: replyWith(status) }));
    expect(outcome).toMatchObject({ kind: "unreachable", cause: "server" });
  });

  test.each([[404], [418], [302]])("%p is unreadable", async (status) => {
    const outcome = await attempt(CLAUDE, fetchEnv({ fixtures: replyWith(status) }));
    expect(outcome.kind).toBe("unreadable");
  });

  test("a 200 whose body is not JSON is unreadable, and the body is not quoted", async () => {
    const fixtures = replyWith(200, {}, "<html>gateway text from the reply</html>");
    const outcome = await attempt(CLAUDE, fetchEnv({ fixtures }));
    expect(outcome.kind).toBe("unreadable");
    expect(JSON.stringify(outcome)).not.toContain("gateway text");
  });

  test("a 200 with a changed shape is unreadable", async () => {
    const fixtures = replyWith(200, {}, { five_hour: { utilization: "66" } });
    expect((await attempt(CLAUDE, fetchEnv({ fixtures }))).kind).toBe("unreadable");
  });

  test("no answer by the deadline is a timeout", async () => {
    const env = fetchEnv({ fixtures: fixtureCase("claude-hang"), deadline: deadlineFromNow(60) });
    expect(await attempt(CLAUDE, env)).toMatchObject({ kind: "unreachable", cause: "timeout" });
  });

  test("a case with no recorded reply is unreachable and never falls through to the network", async () => {
    const env = fetchEnv({ fixtures: caseWith({ login: LIVE_LOGIN }) });
    expect(await attempt(CLAUDE, env)).toMatchObject({ kind: "unreachable", cause: "network" });
    expect(env.requests).toMatchObject([{ via: "fixture" }]);
  });
});

describe("the stored login", () => {
  test("an expired login makes no request", async () => {
    const env = fetchEnv({ fixtures: fixtureCase("claude-expired") });
    expect(await attempt(CLAUDE, env)).toEqual({ kind: "loginExpired" });
    expect(env.requests).toEqual([]);
  });

  test("a case with no login file is signed out and makes no request", async () => {
    const env = fetchEnv({ fixtures: caseWith({ reply: { status: 200, headers: {}, body: {} } }) });
    expect(await attempt(CLAUDE, env)).toEqual({ kind: "signedOut" });
    expect(env.requests).toEqual([]);
  });

  test("a login file caught mid-rewrite is unreachable for now", async () => {
    const env = fetchEnv({ fixtures: caseWith({ login: '{"claudeAiOauth": {"accessTok' }) });
    expect(await attempt(CLAUDE, env)).toMatchObject({ kind: "unreachable", cause: "loginFile" });
    expect(env.requests).toEqual([]);
  });

  test("in fixture mode the login comes from the case's home, never from the real home", async () => {
    const realHome = tempDir();
    writeFileUnder(realHome, CLAUDE_LOGIN_PATH, LIVE_LOGIN);
    const env = fetchEnv({ home: realHome, fixtures: caseWith({ reply: { status: 200, headers: {}, body: {} } }) });
    expect(await attempt(CLAUDE, env)).toEqual({ kind: "signedOut" });
  });

  test("outside fixture mode the login comes from the home", async () => {
    const home = tempDir();
    const expired = { claudeAiOauth: { accessToken: "fixture-access-token", expiresAt: T0 - 1 } };
    writeFileUnder(home, CLAUDE_LOGIN_PATH, expired);
    const env = fetchEnv({ home, fixtures: null });
    expect(await attempt(CLAUDE, env)).toEqual({ kind: "loginExpired" });
    expect(await attempt(CLAUDE, fetchEnv({ home: tempDir(), fixtures: null }))).toEqual({ kind: "signedOut" });
    expect(env.requests).toEqual([]);
  });
});

describe("what the adapter sends", () => {
  interface Sent {
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly options: GetOptions | undefined;
  }

  async function runAgainst(body: unknown) {
    const asked: string[] = [];
    const sent: Sent[] = [];
    const ctx: FetchContext = {
      now: T0,
      readLogin: async (pathUnderHome) => {
        asked.push(pathUnderHome);
        return { kind: "json", value: LIVE_LOGIN };
      },
      get: async (url, headers, options) => {
        sent.push({ url, headers, options });
        return { kind: "json", body };
      },
    };
    return { result: await fetchClaude(ctx), asked, sent };
  }

  test("is one GET to the usage endpoint with the access token in a header", async () => {
    const { result, asked, sent } = await runAgainst({ five_hour: { utilization: 1, resets_at: RESET } });
    expect(result.kind).toBe("windows");
    expect(asked).toEqual([CLAUDE_LOGIN_PATH]);
    expect(sent).toEqual([
      {
        url: "https://api.anthropic.com/api/oauth/usage",
        headers: { Authorization: "Bearer fixture-access-token", "anthropic-beta": "oauth-2025-04-20" },
        options: { alsoRateLimited: [403] },
      },
    ]);
  });

  test("never includes the refresh token", async () => {
    const { sent } = await runAgainst({ five_hour: { utilization: 1, resets_at: RESET } });
    expect(JSON.stringify(sent)).not.toContain("fixture-refresh-token");
  });
});
