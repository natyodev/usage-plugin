import { describe, expect, test } from "bun:test";
import { applyOutcome, DEFAULT_POLICY } from "../src/cache.ts";
import type { Entry } from "../src/cache.ts";
import { DIRECT } from "../src/domain.ts";
import type { Outcome, Reading } from "../src/domain.ts";
import { healthOf } from "../src/health.ts";
import type { Health } from "../src/health.ts";
import { CLAUDE, secondsAfter, T0, window } from "./support.ts";

const FIRST: Reading = { provider: CLAUDE.id, plan: "max", windows: [window("5 hour", 66, 1410)], takenAt: T0, via: DIRECT };
const LATER: Reading = { ...FIRST, windows: [window("5 hour", 70, 1410)], takenAt: secondsAfter(T0, 600) };

const reading = (read: Reading): Outcome => ({ kind: "reading", reading: read });
const LOGIN_EXPIRED: Outcome = { kind: "loginExpired" };
const NO_NETWORK: Outcome = { kind: "unreachable", cause: "network", detail: "could not connect" };
const TIMED_OUT: Outcome = { kind: "unreachable", cause: "timeout", detail: "no answer within the run's budget" };
const UNREADABLE: Outcome = { kind: "unreadable", detail: "five_hour.utilization is not a number" };

function entryAfter(...outcomes: readonly Outcome[]): Entry {
  let entry: Entry | undefined;
  outcomes.forEach((outcome, minute) => {
    entry = applyOutcome(entry, outcome, secondsAfter(T0, minute * 60), DEFAULT_POLICY);
  });
  if (entry === undefined) throw new Error("give at least one outcome");
  return entry;
}

function healthAfter(...outcomes: readonly Outcome[]): Health {
  return healthOf(entryAfter(...outcomes));
}

describe("health", () => {
  test("a reading is fresh", () => {
    expect(healthAfter(reading(FIRST))).toEqual({ kind: "fresh", reading: FIRST });
  });

  test("fresh turns stale on a 401, and keeps the reading", () => {
    expect(healthAfter(reading(FIRST), LOGIN_EXPIRED)).toEqual({
      kind: "stale",
      reading: FIRST,
      holdup: { kind: "loginExpired" },
    });
  });

  test("stale turns fresh on the next reading", () => {
    expect(healthAfter(reading(FIRST), LOGIN_EXPIRED, reading(LATER))).toEqual({ kind: "fresh", reading: LATER });
  });

  test.each([
    ["offline", NO_NETWORK, { kind: "unreachable", cause: "network" }],
    ["timed out", TIMED_OUT, { kind: "unreachable", cause: "timeout" }],
  ] as const)("fresh turns stale when %s", (_case, miss, holdup) => {
    expect(healthAfter(reading(FIRST), miss)).toEqual({ kind: "stale", reading: FIRST, holdup });
  });

  test.each([
    ["the provider answers 503", { kind: "unreachable", cause: "server", detail: "HTTP 503" }, "server"],
    ["the login file is busy", { kind: "unreachable", cause: "loginFile", detail: "login file is not valid JSON" }, "loginFile"],
  ] as const)("fresh turns stale when %s", (_case, miss, cause) => {
    expect(healthAfter(reading(FIRST), miss)).toEqual({ kind: "stale", reading: FIRST, holdup: { kind: "unreachable", cause } });
  });

  test("expired turns waiting when the next fetch finds no network", () => {
    expect(healthAfter(LOGIN_EXPIRED, NO_NETWORK)).toEqual({ kind: "waiting", holdup: { kind: "unreachable", cause: "network" } });
  });

  test("broken turns stale on an ordinary miss, showing the reading kept from before", () => {
    expect(healthAfter(reading(FIRST), UNREADABLE, NO_NETWORK)).toEqual({
      kind: "stale",
      reading: FIRST,
      holdup: { kind: "unreachable", cause: "network" },
    });
  });

  test("signed out turns fresh on the first reading after a login", () => {
    expect(healthAfter({ kind: "signedOut" }, reading(LATER))).toEqual({ kind: "fresh", reading: LATER });
  });

  test("fresh turns stale when rate limited, and says when the next try is", () => {
    const limited: Outcome = { kind: "rateLimited", retryAfterSeconds: 120 };
    expect(healthAfter(reading(FIRST), limited)).toEqual({
      kind: "stale",
      reading: FIRST,
      holdup: { kind: "rateLimited", retryAt: secondsAfter(T0, 60 + 120) },
    });
  });

  test("a first miss with no reading is waiting", () => {
    expect(healthAfter(NO_NETWORK)).toEqual({ kind: "waiting", holdup: { kind: "unreachable", cause: "network" } });
    expect(healthAfter(TIMED_OUT)).toEqual({ kind: "waiting", holdup: { kind: "unreachable", cause: "timeout" } });
  });

  test("a 401 with no reading kept is expired, not waiting", () => {
    expect(healthAfter(LOGIN_EXPIRED)).toEqual({ kind: "expired" });
    expect(healthAfter(NO_NETWORK, LOGIN_EXPIRED)).toEqual({ kind: "expired" });
  });

  test("expired turns fresh on the first reading after a login", () => {
    expect(healthAfter(LOGIN_EXPIRED, LOGIN_EXPIRED, reading(LATER))).toEqual({ kind: "fresh", reading: LATER });
  });

  test("waiting turns fresh on the first reading", () => {
    expect(healthAfter(NO_NETWORK, NO_NETWORK, reading(LATER))).toEqual({ kind: "fresh", reading: LATER });
  });

  test("an unreadable reply is broken, even with a reading kept from before", () => {
    const broken: Health = { kind: "broken", detail: "five_hour.utilization is not a number" };
    expect(healthAfter(UNREADABLE)).toEqual(broken);
    expect(entryAfter(reading(FIRST), UNREADABLE).reading).toEqual(FIRST);
    expect(healthAfter(reading(FIRST), UNREADABLE)).toEqual(broken);
  });

  test("broken turns fresh on the next reading", () => {
    expect(healthAfter(reading(FIRST), UNREADABLE, reading(LATER))).toEqual({ kind: "fresh", reading: LATER });
  });

  test("a missing login is signed out, and the reading is forgotten", () => {
    const signedOut = entryAfter(reading(FIRST), { kind: "signedOut" });
    expect(healthOf(signedOut)).toEqual({ kind: "signedOut" });
    expect(signedOut.reading).toBeNull();
  });

  test("a read entry past its due time is still fresh", () => {
    const overdue: Entry = { ...entryAfter(reading(FIRST)), dueAt: secondsAfter(T0, -3600) };
    expect(healthOf(overdue)).toEqual({ kind: "fresh", reading: FIRST });
  });
});
