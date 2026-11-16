/**
 * Owns the runtime directory and its three files:
 *
 *   cache.json   what is known about every provider. Replaced whole, by rename, only under the lock.
 *   cache.lock   the flock target. Never renamed, because a lock on a replaced inode protects nothing.
 *   debug.log    appended line by line, by any process, without the lock.
 *
 * Readers never lock. `cache.json` only changes by rename, so a reader sees the old file or the
 * new one, whole. A process that dies holding the lock loses it to the kernel.
 */

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { DIRECT, instant, isPercent, isRecord, noT3Text, parseInstant } from "./domain.ts";
import type { Instant, Miss, NoT3, Outcome, Percent, Provider, ProviderId, Reading, Via, Window, WindowDetail } from "./domain.ts";
import { alertsRaised, markAlerts, NO_MARKS } from "./notify.ts";
import type { Alert, AlertMarks, Sent } from "./notify.ts";
import { attempt, adapters as registered } from "./providers/index.ts";
import type { Adapter, FetchEnv, RequestEvent } from "./providers/index.ts";
import type { T3Event } from "./sources/t3.ts";

export interface Run extends FetchEnv {
  readonly runtimeDir: string;
  readonly configPath: string;
  readonly log: (event: DebugEvent) => void;
}

export type DebugEvent =
  | RequestEvent
  | T3Event
  | { readonly event: "lock"; readonly acquired: boolean; readonly waitedMs: number }
  | {
      readonly event: "outcome";
      readonly provider: ProviderId;
      readonly outcome: Outcome["kind"];
      readonly detail: string | null;
      readonly tookMs: number;
      readonly dueAt: Instant;
    }
  | { readonly event: "skipped"; readonly provider: ProviderId; readonly remainingMs: number }
  | ({ readonly event: "alert"; readonly provider: ProviderId; readonly window: string } & Sent)
  | { readonly event: "cacheReset"; readonly reason: string }
  /** A theme read afresh, as `describeTheme` words it. */
  | { readonly event: "theme"; readonly theme: string };

type RuntimeDir = string & { readonly __brand: "RuntimeDir" };

type RuntimeFile = "cache.json" | "cache.lock" | "debug.log" | "t3-token" | "t3-token.pending";

export function isPrivateDirectory(fromLstat: Pick<Stats, "isDirectory" | "uid" | "mode">, uid: number | undefined): boolean {
  return fromLstat.isDirectory() && fromLstat.uid === uid && (fromLstat.mode & 0o077) === 0;
}

function runtimeDirAt(path: string): RuntimeDir | null {
  const found = lstatSync(path, { throwIfNoEntry: false });
  if (found === undefined) return null;
  if (isRuntimeDir(path, found)) return path;
  throw new Error(
    `the runtime directory ${path} is not used, because it is not private. ` +
      "Make it a real directory that you own with mode 0700, or set XDG_RUNTIME_DIR to one",
  );
}

function isRuntimeDir(path: string, found: Stats): path is RuntimeDir {
  return isPrivateDirectory(found, process.getuid?.());
}

function runtimeDirCreatedAt(path: string): RuntimeDir {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const created = runtimeDirAt(path);
  if (created === null) throw new Error(`the runtime directory ${path} could not be created`);
  return created;
}

const { O_APPEND, O_CREAT, O_EXCL, O_NOFOLLOW, O_NONBLOCK, O_RDONLY, O_RDWR, O_WRONLY } = constants;
const NOT_A_REGULAR_FILE: ReadonlySet<unknown> = new Set(["ENOENT", "ELOOP", "ENXIO", "EISDIR"]);

/** `O_NONBLOCK`, because a FIFO at that name would block the open until its other end opens. */
function openRegularFile(dir: RuntimeDir, name: RuntimeFile, flags: number): number | null {
  let fd: number;
  try {
    fd = openSync(`${dir}/${name}`, flags | O_NOFOLLOW | O_NONBLOCK, 0o600);
  } catch (error) {
    if (error instanceof Error && "code" in error && NOT_A_REGULAR_FILE.has(error.code)) return null;
    throw error;
  }
  if (fstatSync(fd).isFile()) return fd;
  closeSync(fd);
  return null;
}

function readRegularFile(dir: RuntimeDir | null, name: RuntimeFile): string | null {
  const fd = dir === null ? null : openRegularFile(dir, name, O_RDONLY);
  if (fd === null) return null;
  try {
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

export const t3TokenFile = {
  read: (runtimeDir: string): string | null => readRegularFile(runtimeDirAt(runtimeDir), "t3-token"),
  replace: (runtimeDir: string, text: string): void => replaceFile(runtimeDirCreatedAt(runtimeDir), "t3-token", text),
  /** Where `t3 auth session issue` writes, so the token outlives a run that ends first. */
  pending: {
    read: (runtimeDir: string): { readonly text: string; readonly ageMs: number } | null => {
      const dir = runtimeDirAt(runtimeDir);
      const text = readRegularFile(dir, "t3-token.pending");
      const found = dir === null ? undefined : lstatSync(`${dir}/t3-token.pending`, { throwIfNoEntry: false });
      return text === null || found === undefined ? null : { text, ageMs: Date.now() - found.mtimeMs };
    },
    /** Null while an issue is under way. Anything but a regular file of ours there is removed. */
    create: (runtimeDir: string): number | null => {
      const dir = runtimeDirCreatedAt(runtimeDir);
      const path = `${dir}/t3-token.pending`;
      const found = lstatSync(path, { throwIfNoEntry: false });
      if (found !== undefined && found.isFile() && found.uid === process.getuid?.()) return null;
      if (found !== undefined) rmSync(path, { recursive: true, force: true });
      try {
        return openRegularFile(dir, "t3-token.pending", O_WRONLY | O_CREAT | O_EXCL);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EEXIST") return null;
        throw error;
      }
    },
    drop: (runtimeDir: string): void => unlinkSync(`${runtimeDir}/t3-token.pending`),
  },
};

function replaceFile(dir: RuntimeDir, name: RuntimeFile, text: string): void {
  const temp = `${dir}/${name}.${process.pid}.tmp`;
  writeFileSync(temp, text, { flag: "wx", mode: 0o600 });
  renameSync(temp, `${dir}/${name}`);
}

export function journal(runtimeDir: string): (event: DebugEvent) => void {
  return (event) => appendIfPossible(runtimeDir, `${new Date().toISOString()} pid=${process.pid} ${describe(event)}\n`);
}

function appendIfPossible(runtimeDir: string, line: string): void {
  try {
    const fd = openRegularFile(runtimeDirCreatedAt(runtimeDir), "debug.log", O_WRONLY | O_APPEND | O_CREAT);
    if (fd === null) return;
    try {
      writeSync(fd, line);
    } finally {
      closeSync(fd);
    }
  } catch {}
}

export function journalTail(runtimeDir: string, lines: number): readonly string[] {
  const text = readRegularFile(runtimeDirAt(runtimeDir), "debug.log") ?? "";
  return text.split("\n").filter(Boolean).slice(-lines);
}

function describe(event: DebugEvent): string {
  switch (event.event) {
    case "request":
      return `request provider=${event.provider} via=${event.via} method=${event.method} url=${event.url}`;
    case "lock":
      return `lock acquired=${event.acquired} waitedMs=${event.waitedMs}`;
    case "outcome": {
      const detail = event.detail === null ? "" : ` detail=${JSON.stringify(event.detail)}`;
      return `outcome provider=${event.provider} outcome=${event.outcome} tookMs=${event.tookMs} dueAt=${iso(event.dueAt)}${detail}`;
    }
    case "skipped":
      return `skipped provider=${event.provider} remainingMs=${event.remainingMs}`;
    case "alert": {
      const detail = event.sent ? "" : ` detail=${JSON.stringify(event.detail)}`;
      return `alert provider=${event.provider} window=${JSON.stringify(event.window)} sent=${event.sent}${detail}`;
    }
    case "cacheReset":
      return `cacheReset reason=${JSON.stringify(event.reason)}`;
    case "t3":
      return `t3 step=${event.step} via=${event.via} result=${JSON.stringify(event.result)}`;
    case "theme":
      return `theme ${JSON.stringify(event.theme)}`;
  }
}

/**
 * An entry may carry members this version does not know, such as a later version's state.
 * `decodeCacheFile` keeps them and `applyOutcome` carries them forward, so an older binary does
 * not erase them during an upgrade. U1 carries `alerts` this way.
 */
export type Entry = {
  readonly dueAt: Instant;
  readonly alerts: AlertMarks;
} & (
  | { readonly status: "read"; readonly reading: Reading }
  | {
      readonly status: "missed";
      readonly reading: Reading | null;
      readonly miss: Miss;
      readonly missedAt: Instant;
      readonly streak: number;
    }
);

const OWNED_MEMBERS: ReadonlySet<string> = new Set(["status", "reading", "miss", "missedAt", "streak", "dueAt", "alerts"]);

function carriedMembers(entry: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entry).filter(([key]) => !OWNED_MEMBERS.has(key)));
}

export interface CacheFile {
  readonly entries: ReadonlyMap<ProviderId, Entry>;
  readonly unknownProviders: ReadonlyMap<string, unknown>;
}

export function decodeCacheFile(text: string | null, adapters: readonly Pick<Adapter, "id">[] = registered): CacheFile {
  return decode(text, adapters).file;
}

interface Decoded {
  readonly file: CacheFile;
  readonly resetReason: string | null;
}

function decode(text: string | null, adapters: readonly Pick<Adapter, "id">[]): Decoded {
  const empty = (resetReason: string | null): Decoded => ({
    file: { entries: new Map(), unknownProviders: new Map() },
    resetReason,
  });
  if (text === null) return empty(null);

  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return empty("not JSON");
  }
  if (!isRecord(root) || root.version !== 1 || !isRecord(root.providers)) return empty("not a version 1 cache");

  const entries = new Map<ProviderId, Entry>();
  const unknownProviders = new Map<string, unknown>();
  for (const [key, stored] of Object.entries(root.providers)) {
    const id = adapters.find((adapter) => adapter.id === key)?.id;
    if (id === undefined) {
      unknownProviders.set(key, stored);
      continue;
    }
    const entry = decodeEntry(id, stored);
    if (entry !== null) entries.set(id, entry);
  }
  return { file: { entries, unknownProviders }, resetReason: null };
}

function decodeEntry(id: ProviderId, stored: unknown): Entry | null {
  if (!isRecord(stored)) return null;
  const dueAt = parseInstant(stored.dueAt);
  if (dueAt === null) return null;
  const alerts = decodeMarks(stored.alerts);

  if (stored.status === "read") {
    const reading = decodeReading(id, stored.reading);
    return reading === null ? null : { ...carriedMembers(stored), status: "read", reading, dueAt, alerts };
  }
  if (stored.status === "missed") {
    const reading = stored.reading === null ? null : decodeReading(id, stored.reading);
    const miss = decodeMiss(stored.miss);
    const missedAt = parseInstant(stored.missedAt);
    const { streak } = stored;
    if (stored.reading !== null && reading === null) return null;
    if (miss === null || missedAt === null) return null;
    if (typeof streak !== "number" || !Number.isInteger(streak) || streak < 1) return null;
    return { ...carriedMembers(stored), status: "missed", reading, miss, missedAt, streak, dueAt, alerts };
  }
  return null;
}

function decodeMarks(stored: unknown): AlertMarks {
  if (!isRecord(stored)) return NO_MARKS;
  const marks = new Map<string, Instant | null>();
  for (const [label, at] of Object.entries(stored)) {
    const resetsAt = at === null ? null : parseInstant(at);
    if (at !== null && resetsAt === null) return NO_MARKS;
    marks.set(label, resetsAt);
  }
  return marks;
}

function decodeReading(id: ProviderId, stored: unknown): Reading | null {
  if (!isRecord(stored) || stored.provider !== id) return null;
  const { plan, windows } = stored;
  const takenAt = parseInstant(stored.takenAt);
  const via = decodeVia(stored.via);
  if (takenAt === null || via === null || (plan !== null && typeof plan !== "string")) return null;

  const [first, ...rest] = decodeEach(windows, decodeWindow) ?? [];
  return first === undefined ? null : { provider: id, plan, windows: [first, ...rest], takenAt, via };
}

function decodeVia(stored: unknown): Via | null {
  if (stored === undefined) return DIRECT;
  if (!isRecord(stored)) return null;
  if (stored.kind === "t3") return { kind: "t3" };
  const { unsupportedT3 } = stored;
  if (stored.kind !== "direct" || (unsupportedT3 !== null && typeof unsupportedT3 !== "string")) return null;
  return { kind: "direct", unsupportedT3 };
}

function decodeWindow(stored: unknown): Window | null {
  if (!isRecord(stored)) return null;
  const { label, usedPercent } = stored;
  const resetsAt = stored.resetsAt === null ? null : parseInstant(stored.resetsAt);
  const detail = decodeEach(stored.detail, decodeDetail);
  if (typeof label !== "string" || !isPercent(usedPercent) || detail === null) return null;
  if (stored.resetsAt !== null && resetsAt === null) return null;
  const { minutes } = stored;
  const length = typeof minutes === "number" && Number.isInteger(minutes) && minutes > 0 ? { minutes } : {};
  return { label, usedPercent, resetsAt, detail, ...length };
}

function decodeDetail(stored: unknown): WindowDetail | null {
  if (!isRecord(stored)) return null;
  const { label, usedPercent } = stored;
  return typeof label === "string" && isPercent(usedPercent) ? { label, usedPercent } : null;
}

function decodeEach<T>(stored: unknown, decodeItem: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(stored)) return null;
  const items: T[] = [];
  for (const raw of stored) {
    const item = decodeItem(raw);
    if (item === null) return null;
    items.push(item);
  }
  return items;
}

function decodeMiss(stored: unknown): Miss | null {
  if (!isRecord(stored)) return null;
  const { kind, retryAfterSeconds, cause, detail } = stored;
  switch (kind) {
    case "signedOut":
    case "loginExpired":
    case "probeFailed":
      return { kind };
    case "rateLimited":
      return retryAfterSeconds === null || typeof retryAfterSeconds === "number" ? { kind, retryAfterSeconds } : null;
    case "unreachable":
      if (cause !== "network" && cause !== "timeout" && cause !== "server" && cause !== "loginFile") return null;
      return typeof detail === "string" ? { kind, cause, detail } : null;
    case "unreadable":
      return typeof detail === "string" ? { kind, detail } : null;
    case "noT3": {
      const why = decodeNoT3(stored.why);
      return why === null ? null : { kind, why };
    }
    default:
      return null;
  }
}

function decodeNoT3(stored: unknown): NoT3 | null {
  if (!isRecord(stored)) return null;
  const { kind, version, detail } = stored;
  if (kind === "closed") return { kind };
  if (kind === "unsupported" && typeof version === "string") return { kind, version };
  if (kind === "failing" && typeof detail === "string") return { kind, detail };
  return null;
}

export function encodeCacheFile(file: CacheFile): string {
  const known = [...file.entries].map(([id, entry]): [string, unknown] => [id, encodeEntry(entry)]);
  const providers = Object.fromEntries([...file.unknownProviders, ...known]);
  return `${JSON.stringify({ version: 1, providers }, null, 2)}\n`;
}

function encodeEntry(entry: Entry): Record<string, unknown> {
  const reading = entry.reading === null ? null : encodeReading(entry.reading);
  const owned =
    entry.status === "read"
      ? { status: entry.status, reading, dueAt: iso(entry.dueAt) }
      : {
          status: entry.status,
          reading,
          miss: entry.miss,
          missedAt: iso(entry.missedAt),
          streak: entry.streak,
          dueAt: iso(entry.dueAt),
        };
  const alerts = Object.fromEntries([...entry.alerts].map(([label, at]) => [label, at === null ? null : iso(at)]));
  return { ...owned, alerts, ...carriedMembers(entry) };
}

function encodeReading(reading: Reading): Record<string, unknown> {
  return {
    provider: reading.provider,
    plan: reading.plan,
    windows: reading.windows.map((window) => ({
      ...window,
      resetsAt: window.resetsAt === null ? null : iso(window.resetsAt),
    })),
    takenAt: iso(reading.takenAt),
    via: reading.via,
  };
}

function iso(at: Instant): string {
  return new Date(at).toISOString();
}

export interface Policy {
  readonly pollIntervalSeconds: number;
  /** A window at or above this alerts once per period. Null when alerts are off. */
  readonly alertAt: Percent | null;
}

export const DEFAULT_POLICY: Policy = { pollIntervalSeconds: 60, alertAt: null };

const LONGEST_WAIT_SECONDS = 3600;
const RATE_LIMIT_BACKOFF_SECONDS = 300;
const UNREACHABLE_CAP_SECONDS = 300;
const UNREADABLE_CAP_SECONDS = 900;

export function isDue(entry: Entry | undefined, now: Instant, policy: Pick<Policy, "pollIntervalSeconds">): boolean {
  return entry === undefined || now >= entry.dueAt || clockWentBack(entry.dueAt, now, policy);
}

function clockWentBack(dueAt: Instant, now: Instant, policy: Pick<Policy, "pollIntervalSeconds">): boolean {
  return dueAt - now > Math.max(LONGEST_WAIT_SECONDS, policy.pollIntervalSeconds) * 1000;
}

export function applyOutcome(previous: Entry | undefined, outcome: Outcome, now: Instant, policy: Policy): Entry {
  const carried = previous === undefined ? {} : carriedMembers(previous);
  const after = (seconds: number) => instant(now + seconds * 1000);
  const alerts = previous?.alerts ?? NO_MARKS;

  if (outcome.kind === "reading") {
    return {
      ...carried,
      status: "read",
      reading: outcome.reading,
      dueAt: after(policy.pollIntervalSeconds),
      alerts: policy.alertAt === null ? alerts : markAlerts(alerts, outcome.reading, policy.alertAt),
    };
  }
  const continues = previous?.status === "missed" && streakGroup(previous.miss) === streakGroup(outcome);
  const streak = continues ? previous.streak + 1 : 1;
  return {
    ...carried,
    status: "missed",
    reading: outcome.kind === "signedOut" ? null : (previous?.reading ?? null),
    miss: outcome,
    missedAt: now,
    streak,
    dueAt: after(secondsUntilNextAttempt(outcome, streak, policy)),
    alerts,
  };
}

function streakGroup(miss: Miss): string {
  switch (miss.kind) {
    case "rateLimited":
    case "unreadable":
      return "answered";
    case "unreachable":
      return miss.cause === "server" || miss.cause === "timeout" ? "answered" : `unreachable/${miss.cause}`;
    case "signedOut":
    case "loginExpired":
    case "noT3":
    case "probeFailed":
      return miss.kind;
  }
}

export function secondsUntilNextAttempt(miss: Miss, streak: number, policy: Pick<Policy, "pollIntervalSeconds">): number {
  const poll = policy.pollIntervalSeconds;
  const atLeastPoll = (seconds: number, cap: number) => Math.max(poll, Math.min(cap, seconds));
  const doubling = (base: number, cap: number) => atLeastPoll(base * 2 ** (streak - 1), cap);

  switch (miss.kind) {
    case "signedOut":
    case "loginExpired":
    case "noT3":
    case "probeFailed":
      return poll;
    case "rateLimited":
      return miss.retryAfterSeconds === null
        ? doubling(RATE_LIMIT_BACKOFF_SECONDS, LONGEST_WAIT_SECONDS)
        : atLeastPoll(miss.retryAfterSeconds, LONGEST_WAIT_SECONDS);
    case "unreachable":
      return doubling(poll, UNREACHABLE_CAP_SECONDS);
    case "unreadable":
      return doubling(poll, UNREADABLE_CAP_SECONDS);
  }
}

export interface ProviderState {
  readonly provider: Provider;
  readonly entry: Entry | null;
}

export interface FetchOptions {
  /**
   * Every provider the cache keeps up to date. Defaults to the whole registry. This is never the
   * subset one module shows, because the lock holder fetches for every surface. A holder that
   * fetched only its own providers would starve the processes waiting for another.
   */
  readonly adapters?: readonly Adapter[];
  readonly policy?: Policy;
  /**
   * The providers this caller will show. Defaults to every adapter. A caller that finds the lock
   * held waits only while one of these has no entry.
   */
  readonly shown?: readonly ProviderId[];
}

const MIN_BUDGET_TO_FETCH_MS = 250;
const LOCK_POLL_MS = 15;
const LOG_MAX_BYTES = 256 * 1024;

export interface Fetched {
  readonly states: readonly ProviderState[];
  /**
   * The alerts this call's commits raised, already recorded and not yet sent. Empty for every
   * caller but the lock holder, so across processes each alert is raised once at most.
   */
  readonly raised: readonly Alert[];
}

/**
 * Returns what is known about every provider, fetching first when something is due. Resolves by
 * `run.deadline`, whatever a provider does.
 *
 * Across any number of processes, each provider is fetched at most once per due time, because a
 * fetch only happens under the lock after a second look at the file.
 */
export async function readOrFetch(run: Run, options: FetchOptions = {}): Promise<Fetched> {
  const all = options.adapters ?? registered;
  const policy = options.policy ?? DEFAULT_POLICY;
  const shown = options.shown ?? all.map((adapter) => adapter.id);
  const dueIn = (file: CacheFile) => all.filter((adapter) => isDue(file.entries.get(adapter.id), run.now(), policy));

  const first = load(runtimeDirAt(run.runtimeDir), all).file;
  if (dueIn(first).length === 0) return { states: states(all, first), raised: [] };

  const dir = runtimeDirCreatedAt(run.runtimeDir);
  const lock = await acquireLock(run, dir, () => {
    const { entries } = load(dir, all).file;
    return shown.every((id) => entries.has(id));
  });
  if (lock === null) return { states: states(all, load(dir, all).file), raised: [] };

  try {
    const second = load(dir, all);
    if (second.resetReason !== null) run.log({ event: "cacheReset", reason: second.resetReason });
    let file = second.file;
    const raised: Alert[] = [];

    let due = dueIn(file);
    const remainingMs = Math.round(run.deadline.remainingMs());
    if (remainingMs < MIN_BUDGET_TO_FETCH_MS) {
      for (const adapter of due) run.log({ event: "skipped", provider: adapter.id, remainingMs });
      due = [];
    }

    await Promise.all(
      due.map(async (adapter) => {
        const startedAt = performance.now();
        const outcome = await attempt(adapter, run);
        const previous = file.entries.get(adapter.id);
        const entry = applyOutcome(previous, outcome, run.now(), policy);
        file = lock.commit(file, adapter.id, entry);
        raised.push(...alertsRaised(adapter, previous, entry));
        run.log({
          event: "outcome",
          provider: adapter.id,
          outcome: outcome.kind,
          detail: detailOf(outcome),
          tookMs: Math.round(performance.now() - startedAt),
          dueAt: entry.dueAt,
        });
      }),
    );
    return { states: states(all, file), raised };
  } finally {
    lock.release();
  }
}

/**
 * Takes back the marks of alerts that did not go out, so the next due poll raises them again. A
 * mark is taken back only while it still holds the reset time it was raised with.
 */
export async function forgetAlerts(run: Run, unsent: readonly Alert[]): Promise<void> {
  const dir = unsent.length === 0 ? null : runtimeDirAt(run.runtimeDir);
  if (dir === null) return;
  const lock = await acquireLock(run, dir, () => false);
  if (lock === null) return;
  try {
    let file = load(dir, unsent.map((alert) => alert.provider)).file;
    for (const { provider, window } of unsent) {
      const entry = file.entries.get(provider.id);
      if (entry === undefined || entry.alerts.get(window.label) !== window.resetsAt) continue;
      const alerts = new Map(entry.alerts);
      alerts.delete(window.label);
      file = lock.commit(file, provider.id, { ...entry, alerts });
    }
  } finally {
    lock.release();
  }
}

export function readCache(
  run: Pick<Run, "runtimeDir">,
  adapters: readonly Adapter[] = registered,
): readonly ProviderState[] {
  return states(adapters, load(runtimeDirAt(run.runtimeDir), adapters).file);
}

function detailOf(outcome: Outcome): string | null {
  switch (outcome.kind) {
    case "unreachable":
      return `${outcome.cause}: ${outcome.detail}`;
    case "unreadable":
      return outcome.detail;
    case "rateLimited":
      return outcome.retryAfterSeconds === null ? null : `retry after ${outcome.retryAfterSeconds}s`;
    case "noT3":
      return noT3Text(outcome.why);
    case "probeFailed":
      return "T3 Code could not check usage";
    case "reading":
    case "signedOut":
    case "loginExpired":
      return null;
  }
}

function load(dir: RuntimeDir | null, adapters: readonly Pick<Adapter, "id">[]): Decoded {
  return decode(readRegularFile(dir, "cache.json"), adapters);
}

function states(adapters: readonly Adapter[], file: CacheFile): readonly ProviderState[] {
  return adapters.map((provider) => ({ provider, entry: file.entries.get(provider.id) ?? null }));
}

function commit(dir: RuntimeDir, file: CacheFile, id: ProviderId, entry: Entry): CacheFile {
  const next: CacheFile = { ...file, entries: new Map(file.entries).set(id, entry) };
  replaceFile(dir, "cache.json", encodeCacheFile(next));
  return next;
}

function tidy(dir: RuntimeDir): void {
  for (const name of readdirSync(dir)) {
    if (/^(?:cache\.json|t3-token)\..*\.tmp$/.test(name)) unlinkSync(`${dir}/${name}`);
  }
  const log = `${dir}/debug.log`;
  const found = lstatSync(log, { throwIfNoEntry: false });
  if (found?.isFile() && found.size > LOG_MAX_BYTES) renameSync(log, `${log}.1`);
}

interface Lock {
  commit(file: CacheFile, id: ProviderId, entry: Entry): CacheFile;
  release(): void;
}

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

async function acquireLock(run: Run, dir: RuntimeDir, canGoWithout: () => boolean): Promise<Lock | null> {
  const libc = await loadFlock();

  // Each open is its own file description, so two callers in one process exclude each other too.
  const fd = openRegularFile(dir, "cache.lock", O_RDWR | O_CREAT);
  if (fd === null) throw new Error(`${dir}/cache.lock is not a regular file, so the cache cannot be locked`);
  const startedAt = performance.now();
  const waitedMs = () => Math.round(performance.now() - startedAt);

  // Non-blocking with a poll, because a blocking flock stops the JS thread and has no timeout.
  for (;;) {
    if (libc.symbols.flock(fd, LOCK_EX | LOCK_NB) === 0) {
      run.log({ event: "lock", acquired: true, waitedMs: waitedMs() });
      tidy(dir);
      return {
        commit: (file, id, entry) => commit(dir, file, id, entry),
        release: () => {
          libc.symbols.flock(fd, LOCK_UN);
          closeSync(fd);
        },
      };
    }
    if (canGoWithout() || run.deadline.remainingMs() <= LOCK_POLL_MS) {
      closeSync(fd);
      run.log({ event: "lock", acquired: false, waitedMs: waitedMs() });
      return null;
    }
    await Bun.sleep(LOCK_POLL_MS);
  }
}

async function loadFlock() {
  const { dlopen, FFIType } = await import("bun:ffi");
  return dlopen("libc.so.6", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
}
