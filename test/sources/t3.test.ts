import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyOutcome, DEFAULT_POLICY, encodeCacheFile, readOrFetch } from "../../src/cache.ts";
import type { ProviderState } from "../../src/cache.ts";
import { DIRECT, instant } from "../../src/domain.ts";
import type { ProviderId } from "../../src/domain.ts";
import { providers } from "../../src/providers/index.ts";
import { moduleLine } from "../../src/render/module.ts";
import { sourcedProviders } from "../../src/sources/index.ts";
import { isSupported, limitsByDriver, readT3 } from "../../src/sources/t3.ts";
import type { T3Event } from "../../src/sources/t3.ts";
import { deadlineFromNow, fixtureCase, requestsIn, T0, T3_DRIVERS, tempDir, testRun, window, writeFileUnder } from "../support.ts";
import type { TestRun } from "../support.ts";

const CLAUDE = "claude" as ProviderId;

function runFor(fixture: string, config: string | null = null, overrides: Parameters<typeof testRun>[0] = {}): TestRun {
  const run = testRun({ fixtures: fixtureCase(fixture), ...overrides });
  if (config !== null) writeFileUnder(run.home, ".config/usage-plugin/config.jsonc", config);
  return run;
}

const SOURCE = (source: string) => `{ "source": "${source}" }`;

const CLOSED_PLACEHOLDER = {
  text: "<span fgalpha='50%'>–</span>",
  tooltip: "T3 Code isn&apos;t running. Open T3 Code, or set up a provider.",
  class: ["waiting", "t3-closed"],
  percentage: 0,
};

async function line(run: TestRun) {
  return JSON.parse(await moduleLine({ only: null, layout: "inline" }, run));
}

function t3Events(run: TestRun): T3Event[] {
  return run.events.filter((event): event is T3Event => event.event === "t3");
}

function steps(run: TestRun): string[] {
  return t3Events(run).map((event) => `${event.step} ${event.result}`);
}

async function states(run: TestRun, source: "auto" | "t3" | "direct"): Promise<ReadonlyMap<string, ProviderState>> {
  const { states: all } = await readOrFetch(run, { adapters: sourcedProviders(source, run) });
  return new Map(all.map((state) => [state.provider.id, state]));
}

describe("a full T3 Code reply", () => {
  test("becomes a reading for every provider T3 reports, each window with its label, percent and reset", async () => {
    const run = runFor("t3-ok");
    const read = await states(run, "t3");
    const claude = read.get("claude")?.entry;
    expect(claude?.status).toBe("read");
    if (claude?.status !== "read") return;
    expect(claude.reading.via).toEqual({ kind: "t3" });
    expect(claude.reading.windows).toEqual([
      window("Session", 46, 1410, 300),
      window("Weekly", 34, 282600, 10080),
      window("Weekly Fable", 26, 282600, 10080),
    ]);
    expect([...read].filter(([, state]) => state.entry?.status === "read").map(([id]) => id)).toEqual([
      "claude",
      "grok",
      "codex",
    ]);
  });

  test("ignores a driver the registry does not know", async () => {
    const read = await readT3(runFor("t3-ok"));
    expect(read.kind).toBe("answered");
    if (read.kind === "answered") expect([...read.byDriver.keys()]).toEqual(["claudeAgent", "grok", "codex", "someday-driver"]);
    const ids = providers.map((provider) => provider.t3Driver);
    expect(ids).not.toContain("someday-driver");
  });

  test("shows every driver T3 Code ships with its own logo, and still ignores one the registry does not know", async () => {
    const dir = join(tempDir(), "t3-every-driver");
    cpSync(fixtureCase("t3-ok"), dir, { recursive: true });
    const usageLimits = { windows: [{ label: "Weekly", usedPercent: 10, resetsAt: "@now+3600" }] };
    const reported = [...T3_DRIVERS, "someday-driver"].map((driver) => ({ instanceId: driver, driver, usageLimits }));
    writeFileSync(join(dir, "t3.json"), JSON.stringify({ config: { providers: reported } }));
    const output = await line(testRun({ fixtures: dir }));
    for (const driver of T3_DRIVERS) {
      const provider = providers.find((candidate) => candidate.t3Driver === driver);
      expect(output.class, driver).toContain(provider?.id);
      expect(output.text, driver).toContain(String.fromCodePoint(provider?.glyph ?? 0));
    }
    expect(output.class.filter((name: string) => providers.some((provider) => provider.id === name))).toHaveLength(T3_DRIVERS.length);
  });

  test("never fetches a provider that has neither a T3 driver nor an adapter", () => {
    const ids = sourcedProviders("auto", runFor("t3-ok")).map((adapter): string => adapter.id);
    expect(ids).toContain("claude");
    expect(ids).not.toContain("openai");
  });

  test("is read once per run, however many providers are due", async () => {
    const run = runFor("t3-ok");
    await states(run, "auto");
    expect(steps(run).filter((step) => step.startsWith("getConfig"))).toEqual(["getConfig config"]);
  });

  test("shows each provider's logo and percent left, and the tooltip says via T3 Code", async () => {
    const output = await line(runFor("t3-ok"));
    expect(output.class).toEqual(["ok", "claude", "grok", "codex", "claude-ok", "grok-ok", "codex-ok"]);
    expect(output.text).toContain(" 54%");
    expect(output.text).toContain(" 99%");
    expect(output.text).toContain(" 60%");
    expect(output.tooltip.split("\n").filter((row: string) => row === "via T3 Code")).toHaveLength(3);
  });
});

describe("a reply with more than anyone needs", () => {
  test("keeps 32 windows of 64 providers and stays fast, even with 10,000 windows and repeated labels", () => {
    const windows = Array.from({ length: 10_000 }, (_, index) => ({ label: index % 2 ? "Dup" : `W${index}`, usedPercent: 5 }));
    const providers = Array.from({ length: 1000 }, (_, index) => ({ driver: `d${index}`, usageLimits: { windows } }));
    const startedAt = performance.now();
    const byDriver = limitsByDriver({ providers: [{ driver: "claudeAgent", usageLimits: { windows } }, ...providers] });
    expect(performance.now() - startedAt).toBeLessThan(100);
    expect(byDriver?.size).toBe(64);
    const claude = byDriver?.get("claudeAgent");
    expect(claude?.kind === "windows" && claude.windows.length).toBe(32);
    expect(claude?.kind === "windows" && claude.windows[3]?.label).toBe("Dup 2");
  });

  test("cuts a long label, so the tooltip stays small", () => {
    const byDriver = limitsByDriver({ providers: [{ driver: "grok", usageLimits: { windows: [{ label: "x".repeat(5000), usedPercent: 1 }] } }] });
    const grok = byDriver?.get("grok");
    expect(grok?.kind === "windows" && grok.windows[0]?.label.length).toBe(40);
  });
});

describe("unavailable limits", () => {
  test("probeFailed shows the provider broken with the reason, and the others still render", async () => {
    const output = await line(runFor("t3-probe-failed"));
    expect(output.class).toContain("claude-broken");
    expect(output.class).toContain("grok-ok");
    expect(output.tooltip).toContain("<b>Claude</b>\nT3 Code could not check Claude&apos;s usage");
    expect(output.tooltip).not.toContain("reply");
  });

  test("unsupported falls back to the own adapter under auto", async () => {
    const run = runFor("t3-unsupported-claude");
    const claude = (await states(run, "auto")).get("claude")?.entry;
    expect(claude?.status === "read" && claude.reading.via).toEqual({ kind: "direct", unsupportedT3: null });
    expect(requestsIn(run.events).map((event): unknown => event.event === "request" && event.provider)).toEqual(["claude"]);
  });

  test("unsupported hides the provider under t3", async () => {
    const run = runFor("t3-unsupported-claude");
    const claude = (await states(run, "t3")).get("claude")?.entry;
    expect(claude?.status === "missed" && claude.miss).toEqual({ kind: "signedOut" });
    expect(requestsIn(run.events)).toEqual([]);
  });
});

describe("a T3 Code that is not running", () => {
  test("auto reads Claude from its own adapter, and the tooltip says direct", async () => {
    const output = await line(runFor("t3-closed"));
    expect(output.class).toEqual(["ok", "claude", "claude-ok"]);
    expect(output.tooltip.split("\n")).toContain("direct");
    expect(steps(runFor("t3-closed"))).toEqual([]);
  });

  test("never issues a token or opens a connection", async () => {
    const run = runFor("t3-closed");
    await line(run);
    expect(steps(run)).toEqual(["server closed"]);
  });

  test("hides a provider whose kept reading was read directly, so a lost login never says open T3 Code", async () => {
    const run = runFor("t3-closed-no-login");
    const direct = applyOutcome(
      undefined,
      { kind: "reading", reading: { provider: CLAUDE, plan: null, windows: [window("5 hour", 63)], takenAt: T0, via: DIRECT } },
      T0,
      DEFAULT_POLICY,
    );
    writeFileUnder(run.runtimeDir, "cache.json", encodeCacheFile({ entries: new Map([[CLAUDE, direct]]), unknownProviders: new Map() }));
    chmodSync(run.runtimeDir, 0o700);
    expect(await line({ ...run, now: () => instant(T0 + 120_000) })).toEqual(CLOSED_PLACEHOLDER);
  });

  test("a T3 that runs but cannot answer shows one dimmed mark that says why, rather than a row of dashes", async () => {
    const dir = join(tempDir(), "t3-silent");
    cpSync(fixtureCase("t3-ok"), dir, { recursive: true });
    rmSync(join(dir, "t3.json"));
    const run = testRun({ fixtures: dir });
    expect(await line(run)).toEqual({ ...CLOSED_PLACEHOLDER, tooltip: "no recorded T3 Code reply.", class: ["waiting", "t3-failing"] });
    expect(steps(run)).toEqual(["server running", "token issued", "getConfig failing"]);
  });

  test("on a cold start with no login shows one dimmed mark that says to open T3 Code, never broken", async () => {
    expect(await line(runFor("t3-closed-no-login"))).toEqual(CLOSED_PLACEHOLDER);
    expect(await line(runFor("t3-closed-no-login", SOURCE("t3")))).toEqual(CLOSED_PLACEHOLDER);
  });

  test("names an unsupported version in the cold-start mark", async () => {
    const output = await line(runFor("t3-version", SOURCE("t3")));
    expect(output.tooltip).toBe("T3 Code 0.1.8 is not supported. Update T3 Code, or set up a provider.");
    expect(output.class).toEqual(["waiting", "t3-unsupported"]);
  });

  test("stays hidden under direct with nothing signed in", async () => {
    expect(await line(runFor("t3-closed-no-login", SOURCE("direct")))).toEqual({ text: "", tooltip: "", class: [], percentage: 0 });
  });

  test("keeps the reading T3 brought earlier, dimmed, with the hint open T3 Code", async () => {
    const run = runFor("t3-closed-no-login");
    const earlier = applyOutcome(
      undefined,
      {
        kind: "reading",
        reading: {
          provider: CLAUDE,
          plan: null,
          windows: [window("Session", 46)],
          takenAt: instant(T0 - 600_000),
          via: { kind: "t3" },
        },
      },
      instant(T0 - 600_000),
      DEFAULT_POLICY,
    );
    writeFileUnder(run.runtimeDir, "cache.json", encodeCacheFile({ entries: new Map([[CLAUDE, earlier]]), unknownProviders: new Map() }));
    chmodSync(run.runtimeDir, 0o700);
    const output = await line(run);
    expect(output.class).toEqual(["ok", "stale", "claude", "claude-ok", "claude-stale"]);
    expect(output.text).toContain("~54%");
    expect(output.tooltip).toContain("read 10m ago. open T3 Code");
    expect(output.class).not.toContain("broken");
  });
});

describe("the T3 Code version", () => {
  test("is supported from 0.1.9 on", () => {
    for (const version of ["0.1.9", "0.1.12", "0.1.9-beta.1", "0.2.0", "1.0.0"]) expect(isSupported(version)).toBe(true);
    for (const version of ["0.1.8", "0.0.20", "", "0.1", "latest", null, 9]) expect(isSupported(version)).toBe(false);
  });

  test("older than 0.1.9 falls back as if T3 were closed, and the tooltip names the version", async () => {
    const run = runFor("t3-version");
    const output = await line(run);
    expect(output.class).toEqual(["ok", "claude", "claude-ok"]);
    expect(output.tooltip).toContain("direct, T3 Code 0.1.8 is not supported");
    expect(steps(run)).toEqual(["server unsupported"]);
  });

  test("older than 0.1.9 under t3 keeps an earlier reading and says why", async () => {
    const run = runFor("t3-version");
    const claude = (await states(run, "t3")).get("claude")?.entry;
    expect(claude?.status === "missed" && claude.miss).toEqual({ kind: "noT3", why: { kind: "unsupported", version: "0.1.8" } });
  });
});

describe("the token", () => {
  test("is issued once and reused by the next run", async () => {
    const first = runFor("t3-ok");
    await states(first, "t3");
    const second = runFor("t3-ok", null, { runtimeDir: first.runtimeDir, now: () => instant(T0 + 120_000) });
    await states(second, "t3");
    expect(steps(first)).toEqual(["server running", "token issued", "getConfig config"]);
    expect(steps(second)).toEqual(["server running", "getConfig config"]);
  });

  test("refused by T3 after earlier use is issued again exactly once, and the reading renders", async () => {
    const earlier = runFor("t3-ok");
    await states(earlier, "t3");
    const run = runFor("t3-refuse", null, { runtimeDir: earlier.runtimeDir, now: () => instant(T0 + 120_000) });
    const output = await line(run);
    expect(steps(run)).toEqual(["server running", "getConfig refused", "revoke started", "token issued", "getConfig config"]);
    expect(output.class).toContain("claude-ok");
    expect(JSON.parse(readFileSync(join(run.runtimeDir, "t3-token"), "utf8")).token).toBe("fixture-t3-token-2");
  });

  test("refused when fresh is not issued again until it expires, so a T3 that rejects every token gets two an hour", async () => {
    const first = runFor("t3-refuse");
    const claude = (await states(first, "t3")).get("claude")?.entry;
    expect(steps(first)).toEqual(["server running", "token issued", "getConfig refused"]);
    expect(claude?.status === "missed" && claude.miss).toEqual({ kind: "noT3", why: { kind: "failing", detail: "T3 Code refused a fresh token" } });

    const later = runFor("t3-refuse", null, { runtimeDir: first.runtimeDir, now: () => instant(T0 + 30 * 60_000) });
    await readT3(later);
    expect(steps(later)).toEqual(["server running"]);

    const expired = runFor("t3-refuse", null, { runtimeDir: first.runtimeDir, now: () => instant(T0 + 56 * 60_000) });
    await readT3(expired);
    expect(steps(expired)).toEqual(["server running", "revoke started", "token issued", "getConfig config"]);
  });

  test("within five minutes of expiry is replaced before use", async () => {
    const first = runFor("t3-ok");
    await states(first, "t3");
    const late = runFor("t3-ok", null, { runtimeDir: first.runtimeDir, now: () => instant(T0 + 56 * 60_000) });
    await states(late, "t3");
    expect(steps(late)).toEqual(["server running", "revoke started", "token issued", "getConfig config"]);
  });

  test("lives only in the runtime dir at 0600, and never in the cache or the debug log", async () => {
    const run = runFor("t3-refuse");
    const { journal } = await import("../../src/cache.ts");
    await moduleLine({ only: null, layout: "inline" }, { ...run, log: journal(run.runtimeDir) });
    expect(statSync(join(run.runtimeDir, "t3-token")).mode & 0o777).toBe(0o600);
    for (const file of ["cache.json", "debug.log"]) {
      expect(readFileSync(join(run.runtimeDir, file), "utf8")).not.toContain("fixture-t3-token");
    }
  });
});

describe("the source setting", () => {
  test("direct never contacts T3 and leaves out providers only T3 reads", async () => {
    const run = runFor("t3-ok", SOURCE("direct"));
    const output = await line(run);
    expect(steps(run)).toEqual([]);
    expect(output.class).not.toContain("codex");
    expect(output.tooltip).not.toContain("direct");
    expect(output.tooltip).not.toContain("via T3 Code");
  });

  test("t3 never calls an adapter, even with T3 closed and logins present", async () => {
    const run = runFor("t3-closed", SOURCE("t3"));
    const output = await line(run);
    expect(requestsIn(run.events)).toEqual([]);
    expect(output).toEqual(CLOSED_PLACEHOLDER);
  });

  test("auto prefers T3 over a login that is also present", async () => {
    const dir = join(tempDir(), "t3-and-login");
    cpSync(fixtureCase("t3-ok"), dir, { recursive: true });
    cpSync(fixtureCase("claude-ok"), dir, { recursive: true });
    const run = testRun({ fixtures: dir });
    const claude = (await states(run, "auto")).get("claude")?.entry;
    expect(claude?.status === "read" && claude.reading.via).toEqual({ kind: "t3" });
    expect(requestsIn(run.events)).toEqual([]);
  });

  test("a misspelt source is reported and auto is used", async () => {
    const output = await line(runFor("t3-ok", SOURCE("T3")));
    expect(output.tooltip).toContain('source must be &quot;auto&quot;, &quot;t3&quot; or &quot;direct&quot;. Using &quot;auto&quot;.');
    expect(output.tooltip).toContain("via T3 Code");
  });
});

describe("the live connection", () => {
  const servers: { stop(): void }[] = [];
  const realPath = process.env.PATH;
  const t3Server = Bun.spawn(["bash", "-c", "exec -a t3code sleep 600"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  afterEach(() => {
    for (const server of servers.splice(0)) server.stop();
    process.env.PATH = realPath;
  });
  afterAll(() => t3Server.kill());

  function fakeT3(accepts: (token: string | null) => boolean) {
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request, upgrade) {
        const token = request.headers.get("authorization")?.replace("Bearer ", "") ?? null;
        const url = new URL(request.url);
        seen.push(`${url.pathname}${url.search} ${token}`);
        if (accepts(token) && upgrade.upgrade(request)) return;
        return new Response('{"reason":"invalid_credential"}', { status: 401 });
      },
      websocket: {
        message(socket, text) {
          const { id } = JSON.parse(String(text));
          socket.send(JSON.stringify({ _tag: "Ping" }));
          const recorded = readFileSync(join(fixtureCase("t3-ok"), "t3.json"), "utf8").replace(
            /"@now\+(\d+)"/g,
            (_match, seconds: string) => JSON.stringify(new Date(Date.now() + Number(seconds) * 1000).toISOString()),
          );
          const { config } = JSON.parse(recorded);
          socket.send(JSON.stringify({ _tag: "Exit", requestId: id, exit: { _tag: "Success", value: config } }));
        },
      },
    });
    servers.push(server);
    return { port: server.port ?? 0, seen };
  }

  function liveRun(port: number) {
    const run = testRun({ fixtures: null, now: () => instant(Date.now()) });
    writeFileUnder(run.home, ".t3/userdata/server-runtime.json", {
      version: 1,
      pid: t3Server.pid,
      host: "127.0.0.1",
      port,
      serverVersion: "0.1.9",
    });
    return run;
  }

  function issuing(token: string, delaySeconds = 0) {
    const bin = tempDir();
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    writeFileSync(
      join(bin, "t3"),
      `#!/bin/sh\necho "$@" >> "${bin}/calls"\n[ "$3" = issue ] || exit 0\nsleep ${delaySeconds}\necho "{\\"sessionId\\":\\"s-$(date +%s%N)\\",\\"token\\":\\"${token}\\",\\"expiresAt\\":\\"${expiresAt}\\"}"\n`,
    );
    writeFileSync(join(bin, "timeout"), `#!/bin/sh\necho "$1" >> "${bin}/timeouts"\nexec ${Bun.which("timeout")} "$@"\n`);
    chmodSync(join(bin, "t3"), 0o755);
    chmodSync(join(bin, "timeout"), 0o755);
    process.env.PATH = `${bin}:${realPath}`;
    const lines = (name: string) => readFileSync(join(bin, name), "utf8").trim().split("\n");
    return Object.assign(() => lines("calls").filter((call) => call.includes(" issue ")), {
      revokes: () => (existsSync(join(bin, "calls")) ? lines("calls").filter((call) => call.includes(" revoke ")) : []),
      timeouts: () => lines("timeouts"),
    });
  }

  test("sends one getConfig with the bearer token on protocol 2 and reads the reply", async () => {
    const { port, seen } = fakeT3((token) => token === "live-1");
    const calls = issuing("live-1");
    const run = liveRun(port);
    const read = await readT3(run);
    expect(read.kind === "answered" && [...read.byDriver.keys()]).toContain("claudeAgent");
    expect(seen).toEqual(["/ws?orchestrationProtocol=2 live-1"]);
    expect(calls()).toEqual([
      `auth session issue --base-dir ${run.home}/.t3 --scope orchestration:read --ttl 1h --label usage-plugin --json`,
    ]);
  });

  test("a 401 on the upgrade issues one new token and tries again", async () => {
    const { port, seen } = fakeT3((token) => token === "live-new");
    const run = liveRun(port);
    writeFileUnder(
      run.runtimeDir,
      "t3-token",
      JSON.stringify({ token: "live-revoked", sessionId: "old", expiresAt: new Date(Date.now() + 3600_000).toISOString() }),
    );
    chmodSync(run.runtimeDir, 0o700);
    const calls = issuing("live-new");
    const read = await readT3(run);
    expect(read.kind).toBe("answered");
    expect(seen.map((row) => row.split(" ")[1])).toEqual(["live-revoked", "live-new"]);
    expect(calls()).toHaveLength(1);
  });

  test("a 426 on the upgrade reads as an unsupported version", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("{}", { status: 426 }) });
    servers.push(server);
    issuing("live-1");
    expect(await readT3(liveRun(server.port ?? 0))).toEqual({ kind: "unusable", why: { kind: "unsupported", version: "0.1.9" } });
  });

  test("a server that is not on loopback is never sent the token", async () => {
    const run = liveRun(1);
    writeFileUnder(run.home, ".t3/userdata/server-runtime.json", { version: 1, pid: t3Server.pid, host: "192.0.2.7", port: 3773, serverVersion: "0.1.9" });
    const calls = issuing("live-1");
    expect(await readT3(run)).toEqual({ kind: "unusable", why: { kind: "closed" } });
    expect(() => calls()).toThrow();
  });

  test("a hung T3 under auto leaves the own adapter its share of the budget", async () => {
    const hung = Bun.serve({ port: 0, fetch: (request, upgrade) => (upgrade.upgrade(request) ? undefined : new Response("", { status: 500 })), websocket: { message() {} } });
    servers.push(hung);
    issuing("live-1");
    const run = { ...liveRun(hung.port ?? 0), deadline: deadlineFromNow(1000) };
    const startedAt = performance.now();
    const read = await readT3(run, 300);
    expect(read).toEqual({ kind: "unusable", why: { kind: "failing", detail: "T3 Code did not answer in time" } });
    expect(run.deadline.remainingMs()).toBeGreaterThan(200);
    expect(performance.now() - startedAt).toBeLessThan(900);
  });

  test("a token that takes longer than the run is collected by the next run, without a second issue", async () => {
    const { port, seen } = fakeT3((token) => token === "live-slow");
    const calls = issuing("live-slow", 0.6);
    const first = { ...liveRun(port), deadline: deadlineFromNow(200) };
    expect(await readT3(first)).toEqual({ kind: "unusable", why: { kind: "failing", detail: "T3 Code is issuing a token" } });
    expect(statSync(join(first.runtimeDir, "t3-token.pending")).mode & 0o777).toBe(0o600);

    const meanwhile = { ...first, deadline: deadlineFromNow(200), events: [] };
    expect(await readT3(meanwhile)).toEqual({ kind: "unusable", why: { kind: "failing", detail: "T3 Code is issuing a token" } });

    await Bun.sleep(700);
    const next = { ...first, deadline: deadlineFromNow(1000) };
    expect((await readT3(next)).kind).toBe("answered");
    expect(calls()).toHaveLength(1);
    expect(seen.map((row) => row.split(" ")[1])).toEqual(["live-slow"]);
    expect(existsSync(join(first.runtimeDir, "t3-token.pending"))).toBe(false);
  });

  test("a token within fifteen minutes of expiry is still used while its successor is issued in the background", async () => {
    const { port, seen } = fakeT3((token) => token === "live-old" || token === "live-next");
    const run = liveRun(port);
    writeFileUnder(
      run.runtimeDir,
      "t3-token",
      JSON.stringify({ token: "live-old", sessionId: "old", expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }),
    );
    chmodSync(run.runtimeDir, 0o700);
    const calls = issuing("live-next");
    expect((await readT3(run)).kind).toBe("answered");
    await Bun.sleep(300);
    expect((await readT3({ ...run, deadline: deadlineFromNow(1000) })).kind).toBe("answered");
    expect(seen.map((row) => row.split(" ")[1])).toEqual(["live-old", "live-next"]);
    expect(calls()).toHaveLength(1);
  });

  test("each renewal revokes the session it replaces: N issues, N - 1 revokes", async () => {
    const { port } = fakeT3(() => true);
    const calls = issuing("live-any");
    const run = liveRun(port);
    const issued: string[] = [];
    for (let renewal = 0; renewal < 4; renewal += 1) {
      const stored = existsSync(join(run.runtimeDir, "t3-token"))
        ? JSON.parse(readFileSync(join(run.runtimeDir, "t3-token"), "utf8"))
        : null;
      if (stored !== null) {
        writeFileSync(join(run.runtimeDir, "t3-token"), JSON.stringify({ ...stored, expiresAt: new Date(Date.now() + 60_000).toISOString() }));
      }
      expect((await readT3({ ...run, deadline: deadlineFromNow(1500) })).kind).toBe("answered");
      issued.push(JSON.parse(readFileSync(join(run.runtimeDir, "t3-token"), "utf8")).sessionId);
    }
    await Bun.sleep(300);
    expect(calls()).toHaveLength(4);
    expect(calls.revokes()).toEqual(issued.slice(0, 3).map((id) => `auth session revoke --base-dir ${run.home}/.t3 ${id}`));
    expect(calls.timeouts().every((seconds) => seconds === "5")).toBe(true);
  });

  test("a runtime file that names a process other than T3 is never sent the token", async () => {
    const { port, seen } = fakeT3(() => true);
    const calls = issuing("live-1");
    for (const pid of [1, process.pid]) {
      const run = liveRun(port);
      writeFileUnder(run.home, ".t3/userdata/server-runtime.json", { version: 1, pid, host: "127.0.0.1", port, serverVersion: "0.1.9" });
      expect(await readT3(run)).toEqual({ kind: "unusable", why: { kind: "closed" } });
    }
    expect(seen).toEqual([]);
    expect(() => calls()).toThrow();
  });

  test("a directory or a symlink planted at the pending file is replaced, and the token still arrives", async () => {
    const { port } = fakeT3(() => true);
    issuing("live-1");
    for (const plant of ["directory", "symlink"] as const) {
      const run = liveRun(port);
      writeFileUnder(run.runtimeDir, "elsewhere", "");
      chmodSync(run.runtimeDir, 0o700);
      const pending = join(run.runtimeDir, "t3-token.pending");
      if (plant === "directory") writeFileUnder(pending, "inside", "x");
      else symlinkSync(join(run.runtimeDir, "elsewhere"), pending);
      expect((await readT3({ ...run, deadline: deadlineFromNow(1500) })).kind).toBe("answered");
      expect(readFileSync(join(run.runtimeDir, "elsewhere"), "utf8")).toBe("");
    }
  });

  test("no server on the port is unreachable, not broken", async () => {
    const { port } = fakeT3(() => true);
    servers.splice(0).forEach((server) => server.stop());
    issuing("live-1");
    const read = await readT3(liveRun(port));
    expect(read).toEqual({ kind: "unusable", why: { kind: "failing", detail: "could not connect to T3 Code" } });
  });
});
