import { version } from "../../package.json";
import { DIRECT, instant, isGlyph, isRecord } from "../domain.ts";
import type { Glyph, Instant, Miss, Outcome, Provider, ProviderId, Via, Windows } from "../domain.ts";
import { fetchClaude } from "./claude.ts";
import { fetchGrok } from "./grok.ts";

interface ReservedRow {
  readonly glyph: number;
}

interface NamedRow extends ReservedRow {
  readonly name: string;
  readonly loginCommand: string | null;
  readonly t3Driver: string | null;
}

interface AdapterRow extends NamedRow {
  readonly fetch: FetchWindows;
}

type Row = ReservedRow | NamedRow | AdapterRow;

type Table = Readonly<Record<string, Row>>;

/**
 * Adding a provider is one SVG in assets/logos/ and one row here, plus an adapter file when the
 * plugin reads it directly and not only through T3 Code.
 *
 * The key is the provider id: the CSS class, the `--provider` value, the cache key, and the base
 * name of the logo and of the fixture reply. Row order is the order providers show in the module.
 *
 * Rows are append only, and a glyph is never renumbered or reused. E900 to E903 are
 * taken because an earlier prototype font already maps them.
 */
const table: Table = {
  claude: { glyph: 0xe900, name: "Claude", loginCommand: "claude", t3Driver: "claudeAgent", fetch: fetchClaude },
  grok: { glyph: 0xe901, name: "Grok", loginCommand: "grok", t3Driver: "grok", fetch: fetchGrok },
  codex: { glyph: 0xe902, name: "Codex", loginCommand: null, t3Driver: "codex" },
  gemini: { glyph: 0xe903 },
  cursor: { glyph: 0xe904, name: "Cursor", loginCommand: null, t3Driver: "cursor" },
  antigravity: { glyph: 0xe905, name: "Antigravity", loginCommand: null, t3Driver: "antigravity" },
  muse: { glyph: 0xe906, name: "Muse", loginCommand: null, t3Driver: "muse" },
};

export interface Listed extends Provider {
  readonly fetch: FetchWindows | null;
  /** The `driver` T3 Code reports this provider under, or null when T3 does not read it. */
  readonly t3Driver: string | null;
}

export interface Adapter extends Listed {
  readonly fetch: FetchWindows;
}

export interface Logo {
  readonly id: string;
  readonly glyph: Glyph;
  readonly hasAdapter: boolean;
}

export const logos: readonly Logo[] = listLogos(table);

export const providers: readonly Listed[] = assemble(table);

export const adapters: readonly Adapter[] = providers.flatMap(({ fetch, ...provider }) =>
  fetch === null ? [] : [{ ...provider, fetch }],
);

export function isProviderId(id: string): id is ProviderId {
  return isNamed(Object.hasOwn(table, id) ? table[id] : undefined);
}

function isNamed(row: Row | undefined): row is NamedRow | AdapterRow {
  return row !== undefined && "name" in row;
}

function hasAdapter(row: Row | undefined): row is AdapterRow {
  return row !== undefined && "fetch" in row;
}

function listLogos(rows: Table): readonly Logo[] {
  const taken = new Set<number>();
  return Object.entries(rows).map(([id, row]) => {
    const { glyph } = row;
    if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error(`provider id "${id}" must be lower case and safe as a CSS class`);
    if (!isGlyph(glyph)) throw new Error(`glyph of "${id}" is outside the private use area from U+E900`);
    if (taken.has(glyph)) throw new Error(`glyph of "${id}" is already taken`);
    taken.add(glyph);
    return { id, glyph, hasAdapter: hasAdapter(row) };
  });
}

function assemble(rows: Table): readonly Listed[] {
  return logos.flatMap(({ id, glyph }) => {
    const row = rows[id];
    if (!isNamed(row) || !isProviderId(id)) return [];
    const { name, loginCommand, t3Driver } = row;
    return [{ id, glyph, name, loginCommand, t3Driver, fetch: hasAdapter(row) ? row.fetch : null }];
  });
}

/**
 * One fetch for one provider: its windows, or the reason there are none.
 *
 * Rules for the author of an adapter:
 * - Do all I/O through `ctx`. Import nothing but `../domain.ts` and types from this file.
 * - Return a `Miss` you received from `ctx` unchanged.
 * - Parse the login and the reply with guards. A value you cannot read is `unreadable`, never a
 *   default. A missing login is `signedOut`. A login past its own expiry time is `loginExpired`,
 *   returned before any request.
 * - Put the token in a header, never in the URL. URLs are logged. Headers are not.
 * - There is no deadline to honour and no status code to map. `attempt` and `ctx.get` do both.
 */
export type FetchWindows = (ctx: FetchContext) => Promise<FetchResult>;

export type FetchResult =
  | { readonly kind: "windows"; readonly windows: Windows; readonly plan: string | null; readonly via?: Via }
  | Miss;

export interface FetchContext {
  /** The time of this fetch. Compare a login's expiry against it. */
  readonly now: Instant;

  /**
   * Reads and JSON-parses the provider's login file, read-only. `pathUnderHome` is
   * relative to the user's home, such as ".claude/.credentials.json".
   *
   *   file missing        -> signedOut
   *   file not valid JSON -> unreachable, cause "loginFile". The provider's CLI rewrites it.
   */
  readLogin(pathUnderHome: string): Promise<LoginFile>;

  /**
   * One GET for a JSON document.
   *
   *   2xx with a JSON body              -> the body
   *   2xx with any other body           -> unreadable
   *   401                               -> loginExpired
   *   429, and any `alsoRateLimited`    -> rateLimited, with Retry-After when it parses
   *   5xx                               -> unreachable, cause "server"
   *   any other status                  -> unreadable
   *   no connection                     -> unreachable, cause "network"
   *   the run's deadline passes         -> unreachable, cause "timeout"
   */
  get(url: string, headers: Readonly<Record<string, string>>, options?: GetOptions): Promise<Reply>;
}

export interface GetOptions {
  /** Extra statuses this endpoint uses to say "slow down". */
  readonly alsoRateLimited?: readonly number[];
}

export type LoginFile =
  | { readonly kind: "json"; readonly value: unknown }
  | Extract<Miss, { kind: "signedOut" | "unreachable" }>;

export type Reply =
  | { readonly kind: "json"; readonly body: unknown }
  | Extract<Miss, { kind: "loginExpired" | "rateLimited" | "unreachable" | "unreadable" }>;

export interface Deadline {
  remainingMs(): number;
  readonly signal: AbortSignal;
}

/** `budgetMs` counts from process start, which is where `performance.now()` starts. */
export function deadlineIn(budgetMs: number): Deadline {
  const remainingMs = () => Math.max(0, budgetMs - performance.now());
  return { remainingMs, signal: AbortSignal.timeout(Math.ceil(remainingMs())) };
}

export interface RequestEvent {
  readonly event: "request";
  readonly provider: ProviderId;
  readonly via: "network" | "fixture";
  readonly method: "GET";
  readonly url: string;
}

export interface FetchEnv {
  readonly home: string;
  readonly fixtures: string | null;
  readonly now: () => Instant;
  readonly deadline: Deadline;
  readonly log: (event: RequestEvent) => void;
}

export function loginHome(env: Pick<FetchEnv, "home" | "fixtures">): string {
  return env.fixtures === null ? env.home : `${env.fixtures}/home`;
}

/** Runs one adapter once. Resolves by the deadline and never rejects. */
export async function attempt(adapter: Adapter, env: FetchEnv): Promise<Outcome> {
  const ctx = contextFor(adapter.id, env);
  const result = await Promise.race([
    Promise.resolve()
      .then(() => adapter.fetch(ctx))
      .catch((error: unknown) => unreadable(`adapter threw ${error instanceof Error ? error.name : typeof error}`)),
    untilAborted(env.deadline.signal).then(() => unreachable("timeout", NO_ANSWER)),
  ]);
  if (result.kind !== "windows") return result;
  return {
    kind: "reading",
    reading: {
      provider: adapter.id,
      plan: result.plan,
      windows: result.windows,
      takenAt: env.now(),
      via: result.via ?? DIRECT,
    },
  };
}

const NO_ANSWER = "no answer within the run's budget";

function contextFor(provider: ProviderId, env: FetchEnv): FetchContext {
  const { fixtures } = env;
  return {
    now: env.now(),
    readLogin: (pathUnderHome) => readLoginFile(loginHome(env), pathUnderHome),
    get: (url, headers, options = {}) =>
      fixtures === null
        ? getLive(provider, env, url, headers, options)
        : getRecorded(provider, env, fixtures, url, options),
  };
}

async function readLoginFile(home: string, pathUnderHome: string): Promise<LoginFile> {
  if (pathUnderHome.startsWith("/") || pathUnderHome.split("/").includes("..")) {
    throw new Error("a login path must stay under the home");
  }
  const file = await readText(`${home}/${pathUnderHome}`);
  if (file.kind === "missing") return { kind: "signedOut" };
  if (file.kind === "unavailable") return unreachable("loginFile", "login file could not be read");
  const parsed = parseJson(file.text);
  return parsed === null ? unreachable("loginFile", "login file is not valid JSON") : { kind: "json", value: parsed.value };
}

async function getLive(
  provider: ProviderId,
  env: FetchEnv,
  url: string,
  headers: Readonly<Record<string, string>>,
  options: GetOptions,
): Promise<Reply> {
  env.log({ event: "request", provider, via: "network", method: "GET", url });
  // Of the reply's headers only Retry-After is read. The others carry organisation ids.
  const answer = await fetch(url, {
    method: "GET",
    headers: { ...headers, "User-Agent": `usage-plugin/${version}` },
    signal: env.deadline.signal,
    redirect: "manual",
  })
    .then(async (response) => ({
      status: response.status,
      retryAfter: response.headers.get("retry-after"),
      body: await response.text(),
    }))
    .catch(() => null);
  if (answer !== null) return interpret(answer.status, answer.retryAfter, answer.body, options, env.now());
  return env.deadline.signal.aborted ? unreachable("timeout", NO_ANSWER) : unreachable("network", "could not connect");
}

async function getRecorded(
  provider: ProviderId,
  env: FetchEnv,
  fixtures: string,
  url: string,
  options: GetOptions,
): Promise<Reply> {
  env.log({ event: "request", provider, via: "fixture", method: "GET", url });
  const file = await readText(`${fixtures}/${provider}.json`);
  if (file.kind === "missing") return unreachable("network", `no recorded reply for ${provider}`);
  const recorded = file.kind === "text" ? parseRecordedReply(parseJson(file.text)?.value) : null;
  if (recorded === null) return unreadable(`the recorded reply for ${provider} is malformed`);

  if (recorded.delayMs > 0 && (await wait(recorded.delayMs, env.deadline.signal)) === "aborted") {
    return unreachable("timeout", NO_ANSWER);
  }
  const now = env.now();
  const body =
    typeof recorded.body === "string"
      ? recorded.body
      : JSON.stringify(recorded.body, (_key, value: unknown) => resolveRelativeTime(value, now));
  return interpret(recorded.status, recorded.retryAfter, body, options, now);
}

interface RecordedReply {
  readonly status: number;
  readonly retryAfter: string | null;
  readonly body: unknown;
  readonly delayMs: number;
}

function parseRecordedReply(value: unknown): RecordedReply | null {
  if (!isRecord(value) || !("body" in value)) return null;
  const { status, headers = {}, body, delayMs = 0 } = value;
  if (typeof status !== "number" || !Number.isInteger(status)) return null;
  if (typeof delayMs !== "number" || !(delayMs >= 0)) return null;
  if (!isRecord(headers)) return null;
  const retryAfter = headers["retry-after"] ?? null;
  if (retryAfter !== null && typeof retryAfter !== "string") return null;
  return { status, retryAfter, body, delayMs };
}

const RELATIVE_TIME = /^@now([+-]\d+)$/;

function resolveRelativeTime(value: unknown, now: Instant): unknown {
  if (typeof value !== "string") return value;
  const seconds = RELATIVE_TIME.exec(value)?.[1];
  return seconds === undefined ? value : new Date(instant(now + Number(seconds) * 1000)).toISOString();
}

function interpret(status: number, retryAfter: string | null, body: string, options: GetOptions, now: Instant): Reply {
  if (status >= 200 && status < 300) {
    const parsed = parseJson(body);
    return parsed === null ? unreadable("reply is not JSON") : { kind: "json", body: parsed.value };
  }
  if (status === 401) return { kind: "loginExpired" };
  if (status === 429 || options.alsoRateLimited?.includes(status)) {
    return { kind: "rateLimited", retryAfterSeconds: retryAfterSeconds(retryAfter, now) };
  }
  if (status >= 500 && status < 600) return unreachable("server", `HTTP ${status}`);
  return unreadable(`HTTP ${status}`);
}

const IMF_FIXDATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Retry-After is a count of seconds or a date such as "Sun, 06 Nov 1994 08:49:37 GMT" (RFC 9110).
 * The shape is checked first, because `Date.parse` alone reads "-5" and "1.5" as dates in 2001.
 */
function retryAfterSeconds(header: string | null, now: Instant): number | null {
  if (header === null) return null;
  const value = header.trim();
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? seconds : null;
  }
  if (!IMF_FIXDATE.test(value)) return null;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, Math.ceil((date - now) / 1000));
}

/** A recorded JSON file with every "@now+N" string turned into the time N seconds from `now`. */
export async function readRecordedJson(
  path: string,
  now: Instant,
): Promise<{ readonly kind: "json"; readonly value: unknown } | { readonly kind: "missing" | "malformed" }> {
  const file = await readText(path);
  if (file.kind === "missing") return { kind: "missing" };
  const parsed = file.kind === "text" ? parseJson(file.text) : null;
  if (parsed === null) return { kind: "malformed" };
  return { kind: "json", value: JSON.parse(JSON.stringify(parsed.value, (_key, value: unknown) => resolveRelativeTime(value, now))) };
}

type FileText =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "missing" }
  | { readonly kind: "unavailable" };

async function readText(path: string): Promise<FileText> {
  try {
    return { kind: "text", text: await Bun.file(path).text() };
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    return { kind: missing ? "missing" : "unavailable" };
  }
}

function parseJson(text: string): { readonly value: unknown } | null {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return null;
  }
}

function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function wait(ms: number, signal: AbortSignal): Promise<"elapsed" | "aborted"> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve("aborted");
    const onAbort = () => {
      clearTimeout(timer);
      resolve("aborted");
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve("elapsed");
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function unreachable(
  cause: Extract<Miss, { kind: "unreachable" }>["cause"],
  detail: string,
): Extract<Miss, { kind: "unreachable" }> {
  return { kind: "unreachable", cause, detail };
}

function unreadable(detail: string): Extract<Miss, { kind: "unreadable" }> {
  return { kind: "unreadable", detail };
}
