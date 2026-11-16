import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { version } from "../../package.json";
import { isPercent } from "../../src/domain.ts";
import { attempt } from "../../src/providers/index.ts";
import type { Adapter, FetchResult } from "../../src/providers/index.ts";
import { CLAUDE, deadlineFromNow, fetchEnv, T0 } from "../support.ts";

interface Seen {
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
}

const seen: Seen[] = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      seen.push({ path: pathname, headers: Object.fromEntries(request.headers) });
      if (pathname === "/ok") return Response.json({ used: 42 });
      if (pathname === "/limited") return new Response("slow down", { status: 429, headers: { "Retry-After": "7" } });
      if (pathname === "/redirect") return Response.redirect("/ok", 302);
      if (pathname === "/hang") await Bun.sleep(5000);
      return new Response("not found", { status: 404 });
    },
  });
});

afterAll(() => server.stop(true));

function asking(path: string, port = server.port): Adapter {
  return {
    ...CLAUDE,
    fetch: async (ctx): Promise<FetchResult> => {
      const reply = await ctx.get(`http://127.0.0.1:${port}${path}`, { Authorization: "Bearer fixture-access-token" });
      if (reply.kind !== "json") return reply;
      const body = reply.body;
      if (typeof body !== "object" || body === null || !("used" in body) || !isPercent(body.used)) {
        return { kind: "unreadable", detail: "used is not a number" };
      }
      return { kind: "windows", plan: null, windows: [{ label: "test", usedPercent: body.used, resetsAt: null, detail: [] }] };
    },
  };
}

function liveEnv(deadlineMs = 2000) {
  return fetchEnv({ fixtures: null, deadline: deadlineFromNow(deadlineMs) });
}

describe("a live request", () => {
  test("returns the JSON body and sends the adapter's headers with our user agent", async () => {
    seen.length = 0;
    const outcome = await attempt(asking("/ok"), liveEnv());
    expect(outcome).toMatchObject({ kind: "reading", reading: { takenAt: T0, windows: [{ usedPercent: 42 }] } });
    expect(seen).toMatchObject([
      { path: "/ok", headers: { authorization: "Bearer fixture-access-token", "user-agent": `usage-plugin/${version}` } },
    ]);
  });

  test("is logged with its URL and nothing from its headers", async () => {
    const env = liveEnv();
    await attempt(asking("/ok"), env);
    expect(env.requests).toEqual([
      { event: "request", provider: CLAUDE.id, via: "network", method: "GET", url: `http://127.0.0.1:${server.port}/ok` },
    ]);
    expect(JSON.stringify(env.requests)).not.toContain("fixture-access-token");
  });

  test("reads Retry-After from a 429", async () => {
    expect(await attempt(asking("/limited"), liveEnv())).toEqual({ kind: "rateLimited", retryAfterSeconds: 7 });
  });

  test("does not follow a redirect, so the token never reaches a second address", async () => {
    seen.length = 0;
    expect(await attempt(asking("/redirect"), liveEnv())).toEqual({ kind: "unreadable", detail: "HTTP 302" });
    expect(seen.map((request) => request.path)).toEqual(["/redirect"]);
  });

  test("to a closed port is unreachable for lack of a network", async () => {
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = closed.port;
    await closed.stop(true);
    expect(await attempt(asking("/ok", port), liveEnv())).toMatchObject({ kind: "unreachable", cause: "network" });
  });

  test("with no answer by the deadline is a timeout", async () => {
    expect(await attempt(asking("/hang"), liveEnv(80))).toMatchObject({ kind: "unreachable", cause: "timeout" });
  });
});

describe("an adapter that misbehaves", () => {
  test("by throwing is unreadable, and its message is not kept", async () => {
    const throwing: Adapter = {
      ...CLAUDE,
      fetch: async () => {
        throw new TypeError("text quoted from the reply");
      },
    };
    const outcome = await attempt(throwing, liveEnv());
    expect(outcome).toMatchObject({ kind: "unreadable", detail: expect.stringContaining("TypeError") });
    expect(JSON.stringify(outcome)).not.toContain("text quoted from the reply");
  });

  test("by throwing before it returns a promise is unreadable too", async () => {
    const throwing: Adapter = {
      ...CLAUDE,
      fetch: () => {
        throw new RangeError("thrown synchronously");
      },
    };
    expect((await attempt(throwing, liveEnv())).kind).toBe("unreadable");
  });

  test("by never settling still ends at the deadline", async () => {
    const stuck: Adapter = { ...CLAUDE, fetch: () => new Promise(() => {}) };
    expect(await attempt(stuck, liveEnv(60))).toMatchObject({ kind: "unreachable", cause: "timeout" });
  });

  test("by asking for a login outside the home is unreadable", async () => {
    const escaping: Adapter = {
      ...CLAUDE,
      fetch: async (ctx) => {
        const file = await ctx.readLogin("../outside.json");
        return file.kind === "json" ? { kind: "unreadable", detail: "read a file outside the home" } : file;
      },
    };
    const outcome = await attempt(escaping, liveEnv());
    expect(outcome).toMatchObject({ kind: "unreadable", detail: expect.not.stringContaining("outside the home") });
  });
});
