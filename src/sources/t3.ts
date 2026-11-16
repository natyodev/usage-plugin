import { t3TokenFile } from "../cache.ts";
import type { Run } from "../cache.ts";
import { closeSync, readFileSync } from "node:fs";
import { isPercent, isRecord, parseInstant } from "../domain.ts";
import type { Instant, NoT3, Percent, Window, Windows } from "../domain.ts";
import { deadlineIn, loginHome, readRecordedJson } from "../providers/index.ts";

/**
 * The oldest `serverVersion` whose reply this file reads. There is no ceiling: a newer T3 that
 * changed the protocol answers HTTP 426, which reads as unsupported, and a reply that changed shape
 * reads as unreadable, so `auto` falls back either way.
 */
export const OLDEST_T3 = "0.1.9";

const PROTOCOL = 2;
const TOKEN_TTL = "1h";
const REISSUE_BEFORE_EXPIRY_MS = 5 * 60_000;
const RENEW_BEFORE_EXPIRY_MS = 15 * 60_000;
const ISSUE_GIVEN_UP_AFTER_MS = 10_000;
const CLI_TIMEOUT_SECONDS = "5";
const MAX_PROVIDERS = 64;
const MAX_WINDOWS = 32;
const MAX_LABEL = 40;
const MAX_FRAME_CHARS = 4_000_000;

export type T3Limits =
  | { readonly kind: "windows"; readonly windows: Windows }
  | { readonly kind: "probeFailed" };

export type T3Read =
  | { readonly kind: "unusable"; readonly why: NoT3 }
  | { readonly kind: "answered"; readonly byDriver: ReadonlyMap<string, T3Limits> };

export interface T3Event {
  readonly event: "t3";
  readonly step: "server" | "token" | "getConfig" | "revoke";
  readonly via: "network" | "fixture";
  readonly result: string;
}

type T3Run = Pick<Run, "home" | "fixtures" | "runtimeDir" | "now" | "deadline"> & {
  readonly log: (event: T3Event) => void;
};

interface Server {
  readonly host: string;
  readonly port: number;
}

interface Token {
  readonly token: string;
  readonly sessionId: string;
  readonly expiresAt: Instant;
  readonly refusedUntilExpiry: boolean;
}

type Answer =
  | { readonly kind: "config"; readonly value: unknown }
  | { readonly kind: "refused" }
  | { readonly kind: "incompatible" }
  | { readonly kind: "failing"; readonly detail: string };

const LOOPBACK: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * Resolves by the run's deadline less `reserveMs`, which `auto` keeps for the provider's own
 * adapter when T3 hangs. Never rejects.
 */
export async function readT3(run: T3Run, reserveMs = 0): Promise<T3Read> {
  const deadline = deadlineIn(performance.now() + Math.max(0, run.deadline.remainingMs() - reserveMs));
  try {
    return await read({ ...run, deadline });
  } catch (error) {
    return failing(`T3 Code read threw ${error instanceof Error ? error.name : typeof error}`);
  }
}

async function read(run: T3Run): Promise<T3Read> {
  const via = run.fixtures === null ? "network" : "fixture";
  const found = await findServer(run);
  run.log({ event: "t3", step: "server", via, result: found.kind === "server" ? "running" : found.kind });
  if (found.kind === "closed") return unusable({ kind: "closed" });
  if (found.kind === "unsupported") return unusable({ kind: "unsupported", version: found.version });

  const stored = storedToken(run);
  if (stored?.refusedUntilExpiry) return failing(REFUSED);
  let token: Token | null = stored;
  let issued = false;
  for (;;) {
    if (token === null) {
      const fresh = await issueToken(run);
      run.log({ event: "t3", step: "token", via, result: fresh === "pending" ? "pending" : fresh === null ? "issue failed" : "issued" });
      if (fresh === "pending") return failing("T3 Code is issuing a token");
      if (fresh === null) return failing("T3 Code did not issue a token");
      token = fresh;
      issued = true;
    }
    const answer = await getConfig(run, found.server, token);
    run.log({ event: "t3", step: "getConfig", via, result: answer.kind });
    if (answer.kind === "refused" && !issued) {
      token = null;
      continue;
    }
    if (answer.kind === "refused") {
      writeToken(run, { ...token, refusedUntilExpiry: true });
      return failing(REFUSED);
    }
    if (answer.kind === "incompatible") return unusable({ kind: "unsupported", version: found.version });
    if (answer.kind === "failing") return failing(answer.detail);
    const byDriver = limitsByDriver(answer.value);
    return byDriver === null ? failing("T3 Code's config has no providers list") : { kind: "answered", byDriver };
  }
}

const REFUSED = "T3 Code refused a fresh token";

function unusable(why: NoT3): T3Read {
  return { kind: "unusable", why };
}

function failing(detail: string): T3Read {
  return unusable({ kind: "failing", detail });
}

type Found =
  | { readonly kind: "server"; readonly server: Server; readonly version: string }
  | { readonly kind: "closed" }
  | { readonly kind: "unsupported"; readonly version: string };

async function findServer(run: T3Run): Promise<Found> {
  const file = await readRecordedJson(`${loginHome(run)}/.t3/userdata/server-runtime.json`, run.now());
  if (file.kind !== "json" || !isRecord(file.value)) return { kind: "closed" };
  const { pid, host = "127.0.0.1", port, serverVersion } = file.value;
  if (!isWhole(pid) || !isWhole(port) || typeof host !== "string" || !isT3Process(run, pid)) return { kind: "closed" };
  if (!LOOPBACK.has(host)) return { kind: "closed" };
  const version = versionLabel(serverVersion);
  if (!isSupported(serverVersion)) return { kind: "unsupported", version };
  return { kind: "server", server: { host, port }, version };
}

function isWhole(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * A runtime file left by a killed T3 can name a pid since reused by another program, which would
 * then be sent the token, so the process must look like T3. Fixtures name pids of no real T3.
 */
function isT3Process(run: T3Run, pid: number): boolean {
  if (run.fixtures !== null) return isAlive(pid);
  try {
    const comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    return comm === "t3" || comm.includes("t3code") || cmdline.some((arg) => arg.includes("t3code"));
  } catch {
    return false;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]*)?$/;

export function isSupported(version: unknown): boolean {
  const parts = versionParts(version);
  return parts !== null && compare(parts, versionParts(OLDEST_T3) ?? []) >= 0;
}

function versionParts(version: unknown): readonly number[] | null {
  const match = typeof version === "string" ? VERSION.exec(version) : null;
  return match === null ? null : match.slice(1, 4).map(Number);
}

function compare(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function versionLabel(version: unknown): string {
  return typeof version === "string" && VERSION.test(version) && version.length <= 32 ? version : "unknown";
}

/** Starts the next token in the background while this one still works, so no poll waits for one. */
function storedToken(run: T3Run): Token | null {
  const collected = run.fixtures === null ? collectIssued(run) : null;
  if (collected !== null && collected !== "pending") return collected;
  const stored = parseToken(t3TokenFile.read(run.runtimeDir));
  const left = stored === null ? 0 : stored.expiresAt - run.now();
  if (left <= REISSUE_BEFORE_EXPIRY_MS) return null;
  if (run.fixtures === null && collected === null && left < RENEW_BEFORE_EXPIRY_MS) void startIssue(run);
  return stored;
}

/** Replacing a session revokes the one before it, in the background, so none outlives its use. */
function replaceToken(run: T3Run, next: Token): void {
  const previous = parseToken(t3TokenFile.read(run.runtimeDir));
  writeToken(run, next);
  if (previous === null || previous.sessionId === next.sessionId) return;
  run.log({ event: "t3", step: "revoke", via: run.fixtures === null ? "network" : "fixture", result: "started" });
  if (run.fixtures === null) runT3InBackground(run, ["auth", "session", "revoke", "--base-dir", `${run.home}/.t3`, previous.sessionId], "ignore");
}

function writeToken(run: T3Run, token: Token): void {
  t3TokenFile.replace(run.runtimeDir, JSON.stringify({ ...token, expiresAt: new Date(token.expiresAt).toISOString() }));
}

function parseToken(text: string | null): Token | null {
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const { token, sessionId, refusedUntilExpiry = false } = value;
  const expiresAt = parseInstant(value.expiresAt);
  if (typeof token !== "string" || token === "" || typeof sessionId !== "string" || expiresAt === null) return null;
  return { token, sessionId, expiresAt, refusedUntilExpiry: refusedUntilExpiry === true };
}

async function issueToken(run: T3Run): Promise<Token | "pending" | null> {
  if (run.fixtures !== null) return keep(run, parseToken(fixtureIssue(run)));
  const started = startIssue(run);
  if (started !== null) await Promise.race([started, untilAborted(run.deadline.signal)]);
  return collectIssued(run);
}

function keep(run: T3Run, token: Token | null): Token | null {
  if (token !== null) replaceToken(run, token);
  return token;
}

/**
 * Issuing takes about 0.35 s, half a run's budget, so `t3` writes into a pending file that outlives
 * this process, and the next run collects the token when this one could not wait.
 */
function startIssue(run: T3Run): Promise<number> | null {
  const fd = t3TokenFile.pending.create(run.runtimeDir);
  if (fd === null) return null;
  const args = ["auth", "session", "issue", "--base-dir", `${run.home}/.t3`];
  const scope = ["--scope", "orchestration:read", "--ttl", TOKEN_TTL, "--label", "usage-plugin", "--json"];
  try {
    return runT3InBackground(run, [...args, ...scope], fd);
  } finally {
    closeSync(fd);
  }
}

/** Outlives this process, and `timeout` ends a `t3` that hangs, so hung runs never pile up. */
function runT3InBackground(run: T3Run, args: readonly string[], stdout: number | "ignore"): Promise<number> | null {
  const t3 = Bun.which("t3", { PATH: process.env.PATH ?? "" }) ?? `${run.home}/.local/bin/t3`;
  const timeout = Bun.which("timeout", { PATH: process.env.PATH ?? "" }) ?? "/usr/bin/timeout";
  try {
    const child = Bun.spawn([timeout, CLI_TIMEOUT_SECONDS, t3, ...args], { stdin: "ignore", stdout, stderr: "ignore", env: process.env });
    child.unref();
    return child.exited;
  } catch {
    return null;
  }
}

function collectIssued(run: T3Run): Token | "pending" | null {
  const pending = t3TokenFile.pending.read(run.runtimeDir);
  if (pending === null) return null;
  const token = parseToken(pending.text);
  if (token === null && pending.ageMs < ISSUE_GIVEN_UP_AFTER_MS) return "pending";
  t3TokenFile.pending.drop(run.runtimeDir);
  return keep(run, token);
}

function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function fixtureIssue(run: T3Run): string {
  const previous = parseToken(t3TokenFile.read(run.runtimeDir));
  const serial = Number(previous?.sessionId.replace("fixture-session-", "")) || 0;
  return JSON.stringify({
    token: `fixture-t3-token-${serial + 1}`,
    sessionId: `fixture-session-${serial + 1}`,
    expiresAt: new Date(run.now() + 3600_000).toISOString(),
  });
}

async function getConfig(run: T3Run, server: Server, token: Token): Promise<Answer> {
  if (run.fixtures !== null) return recordedConfig(run, token);
  const url = `ws://${server.host}:${server.port}/ws?orchestrationProtocol=${PROTOCOL}`;
  return new Promise((resolve) => {
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token.token}` } });
    const settle = (answer: Answer) => {
      run.deadline.signal.removeEventListener("abort", onAbort);
      socket.close();
      resolve(answer);
    };
    const onAbort = () => settle(failingAnswer("T3 Code did not answer in time"));
    if (run.deadline.signal.aborted) return onAbort();
    run.deadline.signal.addEventListener("abort", onAbort, { once: true });
    socket.addEventListener("open", () =>
      socket.send(JSON.stringify({ _tag: "Request", id: "1", tag: "server.getConfig", payload: {}, headers: [] })),
    );
    socket.addEventListener("message", (message) => {
      if (typeof message.data === "string" && message.data.length > MAX_FRAME_CHARS) {
        return settle(failingAnswer("T3 Code sent a reply too large to read"));
      }
      const frame = typeof message.data === "string" ? parseFrame(message.data) : null;
      if (frame === "ping") socket.send(JSON.stringify({ _tag: "Pong" }));
      else if (frame !== null) settle(frame);
    });
    socket.addEventListener("error", (event) => settle(upgradeRefusal(event)));
    socket.addEventListener("close", () => settle(failingAnswer("T3 Code closed the connection")));
  });
}

/**
 * Bun reports a refused upgrade only in the error's message, as "Expected 101 status code: 401".
 * T3 answers 401 to a token that expired or was revoked.
 */
function upgradeRefusal(event: Event): Answer {
  const message = "message" in event && typeof event.message === "string" ? event.message : "";
  const status = /Expected 101 status code: (\d{3})/.exec(message)?.[1];
  if (status === "401") return { kind: "refused" };
  if (status === "426") return { kind: "incompatible" };
  if (status === undefined) return failingAnswer("could not connect to T3 Code");
  return failingAnswer(`T3 Code refused the connection with HTTP ${status}`);
}

function parseFrame(text: string): Answer | "ping" | null {
  let frame: unknown;
  try {
    frame = JSON.parse(text);
  } catch {
    return failingAnswer("T3 Code sent a frame that is not JSON");
  }
  if (!isRecord(frame)) return failingAnswer("T3 Code sent a frame that is not an object");
  if (frame._tag === "Ping") return "ping";
  if (frame._tag === "Defect") return failingAnswer("T3 Code ended the request with a defect");
  if (frame._tag !== "Exit" || frame.requestId !== "1") return null;
  const { exit } = frame;
  if (isRecord(exit) && exit._tag === "Success") return { kind: "config", value: exit.value };
  return failingAnswer(`T3 Code answered server.getConfig with ${failureTag(exit)}`);
}

function failureTag(exit: unknown): string {
  const cause = isRecord(exit) && Array.isArray(exit.cause) ? exit.cause[0] : null;
  const tag = isRecord(cause) && isRecord(cause.error) ? cause.error._tag : isRecord(cause) ? cause._tag : null;
  return typeof tag === "string" && /^[A-Za-z]{1,64}$/.test(tag) ? tag : "a failure";
}

async function recordedConfig(run: T3Run, token: Token): Promise<Answer> {
  const fixtures = run.fixtures ?? "";
  const file = await readRecordedJson(`${fixtures}/t3.json`, run.now());
  if (file.kind === "missing") return failingAnswer("no recorded T3 Code reply");
  const recorded = file.kind === "json" && isRecord(file.value) ? file.value : null;
  if (recorded === null) return failingAnswer("the recorded T3 Code reply is malformed");
  const { refuse = [], config } = recorded;
  if (Array.isArray(refuse) && refuse.includes(token.token)) return { kind: "refused" };
  return { kind: "config", value: config };
}

export function limitsByDriver(config: unknown): ReadonlyMap<string, T3Limits> | null {
  if (!isRecord(config) || !Array.isArray(config.providers)) return null;
  const byDriver = new Map<string, T3Limits>();
  for (const provider of config.providers.slice(0, MAX_PROVIDERS)) {
    if (!isRecord(provider) || typeof provider.driver !== "string" || byDriver.has(provider.driver)) continue;
    const limits = limitsOf(provider.usageLimits);
    if (limits !== null) byDriver.set(provider.driver, limits);
  }
  return byDriver;
}

function limitsOf(usageLimits: unknown): T3Limits | null {
  if (!isRecord(usageLimits)) return null;
  const { unavailable } = usageLimits;
  if (isRecord(unavailable) && unavailable.reason === "probeFailed") return { kind: "probeFailed" };
  if (unavailable !== undefined) return null;
  const [first, ...rest] = windowsOf(usageLimits.windows);
  return first === undefined ? null : { kind: "windows", windows: [first, ...rest] };
}

/** A window that does not read is dropped, as T3's own `ForwardCompatibleArray` drops it. */
function windowsOf(stored: unknown): Window[] {
  if (!Array.isArray(stored)) return [];
  const windows: Window[] = [];
  const labels = new Set<string>();
  for (const raw of stored.slice(0, MAX_WINDOWS)) {
    if (!isRecord(raw) || typeof raw.label !== "string" || raw.label.trim() === "") continue;
    const usedPercent: unknown = raw.usedPercent;
    const resetsAt = raw.resetsAt === undefined ? null : parseInstant(raw.resetsAt);
    if (!isPercent(usedPercent) || (raw.resetsAt !== undefined && resetsAt === null)) continue;
    const label = uniqueLabel(raw.label.trim().slice(0, MAX_LABEL), labels);
    labels.add(label);
    const minutes = raw.windowDurationMins;
    const length = typeof minutes === "number" && Number.isInteger(minutes) && minutes > 0 ? { minutes } : {};
    windows.push({ label, usedPercent: usedPercent as Percent, resetsAt, detail: [], ...length });
  }
  return windows;
}

function uniqueLabel(label: string, taken: ReadonlySet<string>): string {
  let candidate = label;
  for (let copy = 2; taken.has(candidate); copy += 1) candidate = `${label} ${copy}`;
  return candidate;
}

function failingAnswer(detail: string): Answer {
  return { kind: "failing", detail };
}
