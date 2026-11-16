import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { instant, isGlyph, isPercent } from "../src/domain.ts";
import type { Instant, Percent, ProviderId, Window } from "../src/domain.ts";
import type { DebugEvent, Run } from "../src/cache.ts";
import { adapters, deadlineIn } from "../src/providers/index.ts";
import type { Adapter, FetchEnv, FetchWindows, RequestEvent } from "../src/providers/index.ts";

export const T0 = instant(Date.UTC(2026, 10, 16, 6, 0, 0));

export function secondsAfter(from: Instant, seconds: number): Instant {
  return instant(from + seconds * 1000);
}

export function percent(value: number): Percent {
  if (!isPercent(value)) throw new RangeError(`not a percent: ${value}`);
  return value;
}

export function window(label: string, usedPercent: number, resetsInSeconds: number | null = null, minutes?: number): Window {
  return {
    label,
    usedPercent: percent(usedPercent),
    resetsAt: resetsInSeconds === null ? null : secondsAfter(T0, resetsInSeconds),
    detail: [],
    ...(minutes === undefined ? {} : { minutes }),
  };
}

export const CLAUDE = registered("claude");

export const GROK = registered("grok");

function registered(id: string): Adapter {
  const adapter = adapters.find((candidate) => candidate.id === id);
  if (adapter === undefined) throw new Error(`no adapter is registered as ${id}`);
  return adapter;
}

export function adapterNamed(id: string, glyph: number, fetch: FetchWindows): Adapter {
  if (!isIdOfATestProvider(id) || !isGlyph(glyph)) throw new Error(`not a provider id and a glyph: ${id}, ${glyph}`);
  return { id, glyph, name: id, loginCommand: id, t3Driver: null, fetch };
}

function isIdOfATestProvider(id: string): id is ProviderId {
  return /^[a-z][a-z0-9-]*$/.test(id) && adapters.every((adapter) => adapter.id !== id);
}

export function fixtureCase(name: string): string {
  return join(import.meta.dir, "fixtures", name);
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "usage-plugin-test-"));
}

export function makeFifo(path: string): void {
  const made = Bun.spawnSync(["mkfifo", path]);
  if (made.exitCode !== 0) throw new Error(`mkfifo ${path} exited ${made.exitCode}`);
}

export const LIVE_LOGIN = {
  claudeAiOauth: {
    accessToken: "fixture-access-token",
    refreshToken: "fixture-refresh-token",
    expiresAt: Date.UTC(2100, 0, 1),
    subscriptionType: "max",
  },
};

export const CLAUDE_LOGIN_PATH = ".claude/.credentials.json";

export function writeFileUnder(root: string, path: string, content: unknown): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, typeof content === "string" ? content : JSON.stringify(content));
}

export function caseWith(files: { readonly reply?: unknown; readonly login?: unknown }): string {
  const dir = tempDir();
  if (files.reply !== undefined) writeFileUnder(dir, "claude.json", files.reply);
  if (files.login !== undefined) writeFileUnder(dir, join("home", CLAUDE_LOGIN_PATH), files.login);
  return dir;
}

export interface TestEnv extends FetchEnv {
  readonly requests: RequestEvent[];
}

export function fetchEnv(overrides: Partial<Omit<FetchEnv, "log">> = {}): TestEnv {
  const requests: RequestEvent[] = [];
  return {
    home: join(tempDir(), "no-home"),
    fixtures: fixtureCase("claude-ok"),
    now: () => T0,
    deadline: deadlineFromNow(2000),
    ...overrides,
    log: (event) => requests.push(event),
    requests,
  };
}

export function deadlineFromNow(ms: number) {
  return deadlineIn(performance.now() + ms);
}

export interface TestRun extends Run {
  readonly events: DebugEvent[];
}

export function testRun(overrides: Partial<Omit<Run, "log">> = {}): TestRun {
  const events: DebugEvent[] = [];
  const home = overrides.home ?? join(tempDir(), "no-home");
  return {
    home,
    configPath: join(home, ".config", "usage-plugin", "config.jsonc"),
    fixtures: fixtureCase("claude-ok"),
    runtimeDir: join(tempDir(), "usage-plugin"),
    now: () => T0,
    deadline: deadlineFromNow(2000),
    ...overrides,
    log: (event) => events.push(event),
    events,
  };
}

export function requestsIn(events: readonly DebugEvent[]): DebugEvent[] {
  return events.filter((event) => event.event === "request");
}

export async function until(condition: () => boolean, what: string): Promise<void> {
  const giveUpAt = performance.now() + 2000;
  while (!condition()) {
    if (performance.now() > giveUpAt) throw new Error(`timed out waiting until ${what}`);
    await Bun.sleep(1);
  }
}
