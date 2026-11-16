import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DIRECT, instant } from "../../src/domain.ts";
import { fetchGrok, parseBilling, parseLogin } from "../../src/providers/grok.ts";
import { adapters, attempt } from "../../src/providers/index.ts";
import type { Adapter, FetchContext, GetOptions } from "../../src/providers/index.ts";
import { deadlineFromNow, fetchEnv, fixtureCase, percent, secondsAfter, T0, tempDir, writeFileUnder } from "../support.ts";

const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const LOGIN_PATH = ".grok/auth.json";
const RESET = "2026-11-19T01:21:11.919+00:00";
const RESET_AT = instant(Date.parse(RESET));

const GROK = registeredGrok();

function registeredGrok(): Adapter {
  const grok = adapters.find((adapter) => adapter.id === "grok");
  if (grok === undefined) throw new Error("no adapter is registered as grok");
  return grok;
}

const LOGIN = {
  "https://auth.x.ai::fixture-account": {
    key: "fixture-key",
    auth_mode: "oidc",
    refresh_token: "fixture-refresh-token",
    expires_at: "2100-01-01T00:00:00.000000000Z",
  },
};

function config(overrides: Record<string, unknown> = {}) {
  return {
    config: {
      currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-11-12T01:21:11.919+00:00", end: RESET },
      creditUsagePercent: 78.0,
      productUsage: [
        { product: "GrokBot", usagePercent: 44.0 },
        { product: "GrokBuild", usagePercent: 34.0 },
      ],
      ...overrides,
    },
  };
}

function recordedBody(fixture: string): unknown {
  return JSON.parse(readFileSync(join(fixtureCase(fixture), "grok.json"), "utf8")).body;
}

function caseWith(files: { readonly reply?: unknown; readonly login?: unknown }): string {
  const dir = tempDir();
  if (files.reply !== undefined) writeFileUnder(dir, "grok.json", files.reply);
  if (files.login !== undefined) writeFileUnder(dir, join("home", LOGIN_PATH), files.login);
  return dir;
}

test("Grok is registered with the glyph the prototype font maps and the command that renews its login", () => {
  expect(GROK).toMatchObject({ id: "grok", name: "Grok", loginCommand: "grok", glyph: 0xe901 });
});

describe("the grok-ok fixture", () => {
  test("becomes a reading with one weekly window and its product split, stamped by the core", async () => {
    expect(await attempt(GROK, fetchEnv({ fixtures: fixtureCase("grok-ok") }))).toEqual({
      kind: "reading",
      reading: {
        provider: GROK.id,
        plan: null,
        windows: [
          {
            label: "Weekly",
            usedPercent: percent(59),
            resetsAt: secondsAfter(T0, 232495),
            detail: [
              { label: "Chat", usedPercent: percent(44) },
              { label: "Build", usedPercent: percent(15) },
            ],
            minutes: 10080,
          },
        ],
        takenAt: T0,
        via: DIRECT,
      },
    });
  });

  test("costs exactly one request, to the credits format of the billing endpoint", async () => {
    const env = fetchEnv({ fixtures: fixtureCase("grok-ok") });
    await attempt(GROK, env);
    expect(env.requests).toEqual([
      { event: "request", provider: GROK.id, via: "fixture", method: "GET", url: BILLING_URL },
    ]);
  });
});

describe("parseBilling", () => {
  test("reads the window and ignores every key it does not know", () => {
    const parsed = parseBilling(
      config({ isUnifiedBillingUser: true, prepaidBalance: { val: 0 }, brandNew: { nested: [1] }, billingPeriodEnd: "x" }),
    );
    expect(parsed).toEqual({
      kind: "window",
      window: {
        label: "Weekly",
        usedPercent: percent(78),
        resetsAt: RESET_AT,
        detail: [
          { label: "Chat", usedPercent: percent(44) },
          { label: "Build", usedPercent: percent(34) },
        ],
        minutes: 10080,
      },
    });
  });

  test("reads the legacy shape as unreadable, never as 0 percent", () => {
    expect(parseBilling(recordedBody("grok-legacy-shape")).kind).toBe("unreadable");
    expect(parseBilling({ config: { creditUsagePercent: 0, monthlyLimit: { val: 0 }, history: [] } }).kind).toBe(
      "unreadable",
    );
  });

  test("reads 0 percent with a current period as a real 0", () => {
    expect(parseBilling(config({ creditUsagePercent: 0, productUsage: [] }))).toMatchObject({
      window: { usedPercent: 0, detail: [] },
    });
  });

  test("keeps a percent above 100", () => {
    expect(parseBilling(config({ creditUsagePercent: 104 }))).toMatchObject({ window: { usedPercent: 104 } });
  });

  test.each([["missing", undefined], ["null", null]])("reads a %s productUsage as no split", (_case, productUsage) => {
    expect(parseBilling(config({ productUsage }))).toMatchObject({ window: { detail: [] } });
  });

  test.each([["SomethingNew"], ["toString"], ["__proto__"]])("keeps the name of a product %p it has no label for", (product) => {
    expect(parseBilling(config({ productUsage: [{ product, usagePercent: 3 }] }))).toMatchObject({
      window: { detail: [{ label: product, usedPercent: 3 }] },
    });
  });

  test.each([
    ["a body that is not an object", "credits"],
    ["a body with no config", { creditUsagePercent: 50 }],
    ["a creditUsagePercent that is a string", config({ creditUsagePercent: "78" })],
    ["a negative creditUsagePercent", config({ creditUsagePercent: -1 })],
    ["a null creditUsagePercent", config({ creditUsagePercent: null })],
    ["no currentPeriod", config({ currentPeriod: undefined })],
    ["a period that is not weekly", config({ currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY", end: RESET } })],
    ["a period with no type", config({ currentPeriod: { end: RESET } })],
    ["a period type named like an object member", config({ currentPeriod: { type: "constructor", end: RESET } })],
    ["a period with no end", config({ currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" } })],
    ["a period end that is not a time", config({ currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "soon" } })],
    ["a productUsage that is not a list", config({ productUsage: { GrokBot: 44 } })],
    ["a product that is not an object", config({ productUsage: [44] })],
    ["a product with no name", config({ productUsage: [{ product: "", usagePercent: 4 }] })],
    ["a product percent that is a string", config({ productUsage: [{ product: "GrokBot", usagePercent: "44" }] })],
  ])("reads %s as unreadable, never as a default", (_case, body) => {
    expect(parseBilling(body).kind).toBe("unreadable");
  });

  test("names the unreadable field without quoting the reply", () => {
    const parsed = parseBilling(config({ creditUsagePercent: "value-from-the-reply" }));
    expect(parsed).toMatchObject({ kind: "unreadable", detail: expect.stringContaining("creditUsagePercent") });
    expect(JSON.stringify(parsed)).not.toContain("value-from-the-reply");
  });
});

describe("parseLogin", () => {
  test("reads the key of the single x.ai login and ignores other entries", () => {
    const auth = { ...LOGIN, "https://other.example::fixture-account": { key: "other-key" }, version: 2 };
    expect(parseLogin(auth, T0)).toEqual({ kind: "login", key: "fixture-key" });
  });

  test.each([
    ["an empty file", {}],
    ["a file with no x.ai entry", { "https://other.example::fixture-account": { key: "other-key" } }],
    ["an x.ai entry that is not an object", { "https://auth.x.ai::fixture-account": "fixture-key" }],
    ["an x.ai entry with no key", { "https://auth.x.ai::fixture-account": { refresh_token: "fixture-refresh-token" } }],
    ["an empty key", { "https://auth.x.ai::fixture-account": { key: "" } }],
    ["a key that is not a string", { "https://auth.x.ai::fixture-account": { key: 42 } }],
    ["a file that is not an object", "fixture-key"],
    ["null", null],
  ])("reads %s as signed out", (_case, auth) => {
    expect(parseLogin(auth, T0)).toEqual({ kind: "signedOut" });
  });

  test("reads two x.ai logins as unreadable, without quoting either", () => {
    const auth = { ...LOGIN, "https://auth.x.ai::second-account": { key: "second-key" } };
    const parsed = parseLogin(auth, T0);
    expect(parsed).toMatchObject({ kind: "unreadable" });
    expect(JSON.stringify(parsed)).not.toMatch(/fixture-key|second-key|account/);
  });

  test("reads a login at or past its own expiry time as expired", () => {
    const expiring = (expiresAt: string) => ({ "https://auth.x.ai::fixture-account": { key: "fixture-key", expires_at: expiresAt } });
    expect(parseLogin(expiring("2026-11-16T06:00:00.000000000Z"), T0)).toEqual({ kind: "loginExpired" });
    expect(parseLogin(expiring("2026-11-16T05:59:59.999999999Z"), T0)).toEqual({ kind: "loginExpired" });
    expect(parseLogin(expiring("2026-11-16T06:00:01.000000000Z"), T0).kind).toBe("login");
  });

  test.each([[undefined], [null], ["tomorrow"], [4102444800000]])("leaves a login with expires_at %p to the provider", (expiresAt) => {
    const auth = { "https://auth.x.ai::fixture-account": { key: "fixture-key", expires_at: expiresAt } };
    expect(parseLogin(auth, T0).kind).toBe("login");
  });
});

describe("what Grok's answer becomes", () => {
  test("401 is an expired login after one request, and nothing tries to renew it", async () => {
    const env = fetchEnv({ fixtures: fixtureCase("grok-401") });
    expect(await attempt(GROK, env)).toEqual({ kind: "loginExpired" });
    expect(env.requests).toEqual([
      { event: "request", provider: GROK.id, via: "fixture", method: "GET", url: BILLING_URL },
    ]);
  });

  test("the legacy shape is unreadable", async () => {
    const outcome = await attempt(GROK, fetchEnv({ fixtures: fixtureCase("grok-legacy-shape") }));
    expect(outcome).toMatchObject({ kind: "unreadable", detail: expect.stringContaining("creditUsagePercent") });
  });

  test("no answer by the deadline is a timeout", async () => {
    const env = fetchEnv({ fixtures: fixtureCase("grok-hang"), deadline: deadlineFromNow(60) });
    expect(await attempt(GROK, env)).toMatchObject({ kind: "unreachable", cause: "timeout" });
  });
});

describe("the stored login", () => {
  test("a case with no auth file is signed out and makes no request", async () => {
    const env = fetchEnv({ fixtures: caseWith({ reply: { status: 200, headers: {}, body: config() } }) });
    expect(await attempt(GROK, env)).toEqual({ kind: "signedOut" });
    expect(env.requests).toEqual([]);
  });

  test("an expired login makes no request", async () => {
    const expired = { "https://auth.x.ai::fixture-account": { key: "fixture-key", expires_at: "2026-11-16T05:00:00Z" } };
    const env = fetchEnv({ fixtures: caseWith({ reply: { status: 200, headers: {}, body: config() }, login: expired }) });
    expect(await attempt(GROK, env)).toEqual({ kind: "loginExpired" });
    expect(env.requests).toEqual([]);
  });

  test("an auth file caught mid-rewrite is unreachable for now", async () => {
    const env = fetchEnv({ fixtures: caseWith({ login: '{"https://auth.x.ai::fixture-account": {"ke' }) });
    expect(await attempt(GROK, env)).toMatchObject({ kind: "unreachable", cause: "loginFile" });
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
        return { kind: "json", value: LOGIN };
      },
      get: async (url, headers, options) => {
        sent.push({ url, headers, options });
        return { kind: "json", body };
      },
    };
    return { result: await fetchGrok(ctx), asked, sent };
  }

  test("is one GET to the billing endpoint with the key in a header", async () => {
    const { result, asked, sent } = await runAgainst(config());
    expect(result.kind).toBe("windows");
    expect(asked).toEqual([LOGIN_PATH]);
    expect(sent).toEqual([{ url: BILLING_URL, headers: { Authorization: "Bearer fixture-key" }, options: undefined }]);
  });

  test("never includes the refresh token", async () => {
    const { sent } = await runAgainst(config());
    expect(JSON.stringify(sent)).not.toContain("fixture-refresh-token");
  });
});
