import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  applyOutcome,
  decodeCacheFile,
  DEFAULT_POLICY,
  encodeCacheFile,
  forgetAlerts,
  isDue,
  isPrivateDirectory,
  journal,
  journalTail,
  readCache,
  readOrFetch,
  secondsUntilNextAttempt,
} from "../src/cache.ts";
import type { Entry, FetchOptions, Policy, Run } from "../src/cache.ts";
import { DIRECT } from "../src/domain.ts";
import type { Instant, Miss, Reading } from "../src/domain.ts";
import type { Adapter, FetchResult } from "../src/providers/index.ts";
import {
  adapterNamed,
  caseWith,
  CLAUDE,
  deadlineFromNow,
  fixtureCase,
  LIVE_LOGIN,
  makeFifo,
  percent,
  requestsIn,
  secondsAfter,
  T0,
  tempDir,
  testRun,
  until,
  window,
} from "./support.ts";

const READING: Reading = {
  provider: CLAUDE.id,
  plan: "max",
  windows: [window("5 hour", 66, 1410, 300), window("7 day", 12, 282600, 10080)],
  takenAt: T0,
  via: DIRECT,
};
const RATE_LIMITED: Miss = { kind: "rateLimited", retryAfterSeconds: null };
const NO_NETWORK: Miss = { kind: "unreachable", cause: "network", detail: "could not connect" };
const UNREADABLE: Miss = { kind: "unreadable", detail: "reply is not JSON" };

async function read(run: Run, options: FetchOptions = {}) {
  return (await readOrFetch(run, { adapters: [CLAUDE], ...options })).states;
}

function entryWithReading(at: Instant = T0): Entry {
  return applyOutcome(undefined, { kind: "reading", reading: { ...READING, takenAt: at } }, at, DEFAULT_POLICY);
}

function cacheText(entry: Entry): string {
  return encodeCacheFile({ entries: new Map([[CLAUDE.id, entry]]), unknownProviders: new Map() });
}

function runtimeDirWith(files: Readonly<Record<string, string>>): string {
  const runtimeDir = join(tempDir(), "usage-plugin");
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(runtimeDir, name), text);
  return runtimeDir;
}

function onDisk(runtimeDir: string) {
  return JSON.parse(readFileSync(join(runtimeDir, "cache.json"), "utf8"));
}

async function lockHolder(runtimeDir: string, now: () => Instant = () => T0) {
  const gate = Promise.withResolvers<FetchResult>();
  const gated: Adapter = { ...CLAUDE, fetch: () => gate.promise };
  const run = testRun({ runtimeDir, now, deadline: deadlineFromNow(4000) });
  let done = false;
  const finished = read(run, { adapters: [gated] }).then(() => {
    done = true;
  });
  await until(() => run.events.some((event) => event.event === "lock" && event.acquired), "the holder has the lock");
  return {
    isDone: () => done,
    finish: async () => {
      gate.resolve({ kind: "signedOut" });
      await finished;
    },
  };
}

describe("readOrFetch", () => {
  test("fills an empty cache with one fetch and says when the next is due", async () => {
    const run = testRun();
    const states = await read(run);
    expect(states).toEqual([
      { provider: CLAUDE, entry: { status: "read", reading: READING, dueAt: secondsAfter(T0, 60), alerts: new Map() } },
    ]);
    expect(requestsIn(run.events)).toHaveLength(1);
  });

  test("two concurrent callers produce exactly one fetch and the same reading", async () => {
    const runtimeDir = join(tempDir(), "usage-plugin");
    const first = testRun({ runtimeDir });
    const second = testRun({ runtimeDir });
    const [a, b] = await Promise.all([read(first), read(second)]);
    expect(requestsIn([...first.events, ...second.events])).toHaveLength(1);
    expect(a).toEqual(b);
    expect(a[0]?.entry).toMatchObject({ status: "read", reading: READING });
  });

  test("eight concurrent callers still produce exactly one fetch", async () => {
    const runtimeDir = join(tempDir(), "usage-plugin");
    const runs = Array.from({ length: 8 }, () => testRun({ runtimeDir }));
    const results = await Promise.all(runs.map((run) => read(run)));
    expect(requestsIn(runs.flatMap((run) => run.events))).toHaveLength(1);
    for (const states of results) expect(states[0]?.entry?.status).toBe("read");
  });

  test("reads a fresh cache with no fetch, no lock, and no log line", async () => {
    const runtimeDir = runtimeDirWith({ "cache.json": cacheText(entryWithReading()) });
    const run = testRun({ runtimeDir, now: () => secondsAfter(T0, 59) });
    const states = await read(run);
    expect(states[0]?.entry).toEqual(entryWithReading());
    expect(run.events).toEqual([]);
    expect(readdirSync(runtimeDir)).toEqual(["cache.json"]);
  });

  test("fetches again once the poll interval has passed", async () => {
    const runtimeDir = runtimeDirWith({ "cache.json": cacheText(entryWithReading()) });
    const run = testRun({ runtimeDir, now: () => secondsAfter(T0, 60) });
    const states = await read(run);
    expect(requestsIn(run.events)).toHaveLength(1);
    expect(states[0]?.entry).toMatchObject({ status: "read", reading: { takenAt: secondsAfter(T0, 60) } });
  });

  test("follows the poll interval it is given", async () => {
    const runtimeDir = runtimeDirWith({ "cache.json": cacheText(entryWithReading()) });
    const run = testRun({ runtimeDir, now: () => secondsAfter(T0, 60) });
    const states = await read(run, { policy: { ...DEFAULT_POLICY, pollIntervalSeconds: 300 } });
    expect(states[0]?.entry?.dueAt).toBe(secondsAfter(T0, 360));
  });

  test("a 429 stops fetches until Retry-After passes", async () => {
    const runtimeDir = join(tempDir(), "usage-plugin");
    const requestsAt = async (seconds: number) => {
      const run = testRun({ runtimeDir, fixtures: fixtureCase("claude-429"), now: () => secondsAfter(T0, seconds) });
      const states = await read(run);
      return { requests: requestsIn(run.events).length, entry: states[0]?.entry };
    };

    expect(await requestsAt(0)).toMatchObject({ requests: 1, entry: { status: "missed", streak: 1 } });
    expect(await requestsAt(60)).toMatchObject({ requests: 0, entry: { status: "missed", streak: 1 } });
    expect(await requestsAt(119)).toMatchObject({ requests: 0 });
    expect(await requestsAt(120)).toMatchObject({ requests: 1, entry: { status: "missed", streak: 2 } });
  });

  test("writes the back-off where a person can read it off the file", async () => {
    const run = testRun({ fixtures: fixtureCase("claude-429") });
    await read(run);
    expect(onDisk(run.runtimeDir)).toEqual({
      version: 1,
      providers: {
        claude: {
          status: "missed",
          reading: null,
          miss: { kind: "rateLimited", retryAfterSeconds: 120 },
          missedAt: "2026-11-16T06:00:00.000Z",
          streak: 1,
          dueAt: "2026-11-16T06:02:00.000Z",
          alerts: {},
        },
      },
    });
  });

  test("keeps the last reading through a miss", async () => {
    const runtimeDir = runtimeDirWith({ "cache.json": cacheText(entryWithReading()) });
    const run = testRun({ runtimeDir, fixtures: fixtureCase("claude-429"), now: () => secondsAfter(T0, 60) });
    const states = await read(run);
    expect(states[0]?.entry).toMatchObject({ status: "missed", reading: READING, missedAt: secondsAfter(T0, 60) });
  });

  test("drops the kept reading once the provider is signed out", async () => {
    const runtimeDir = runtimeDirWith({ "cache.json": cacheText(entryWithReading()) });
    const signedOut = caseWith({});
    const states = await read(testRun({ runtimeDir, fixtures: signedOut, now: () => secondsAfter(T0, 60) }));
    expect(states[0]?.entry).toMatchObject({ status: "missed", reading: null, miss: { kind: "signedOut" } });
  });

  test("records a provider that hangs as a timeout, by the deadline", async () => {
    const run = testRun({ fixtures: fixtureCase("claude-hang"), deadline: deadlineFromNow(400) });
    const states = await read(run);
    expect(states[0]?.entry).toMatchObject({
      status: "missed",
      miss: { kind: "unreachable", cause: "timeout" },
      dueAt: secondsAfter(T0, 60),
    });
  });

  test("starts no fetch when too little of the budget is left to give it a fair chance", async () => {
    const run = testRun({ deadline: deadlineFromNow(100) });
    const states = await read(run);
    expect(states).toEqual([{ provider: CLAUDE, entry: null }]);
    expect(requestsIn(run.events)).toEqual([]);
    expect(run.events).toContainEqual(expect.objectContaining({ event: "skipped", provider: CLAUDE.id }));
    expect(existsSync(join(run.runtimeDir, "cache.json"))).toBe(false);
  });

  test("fetches every adapter it is given and returns them in that order", async () => {
    const calls: string[] = [];
    const counting: Adapter = {
      ...CLAUDE,
      fetch: async () => {
        calls.push("fetch");
        return { kind: "windows", plan: null, windows: [window("only", 5)] };
      },
    };
    const states = await read(testRun(), { adapters: [counting] });
    expect(calls).toEqual(["fetch"]);
    expect(states).toMatchObject([{ provider: { id: CLAUDE.id }, entry: { reading: { windows: [{ label: "only" }] } } }]);
  });
});

describe("what a crash leaves behind", () => {
  const TORN = '{"version":1,"providers":{"claude":{"status":"read","rea';

  test("a leftover temp file does not change what a fresh cache reads", async () => {
    const runtimeDir = runtimeDirWith({ "cache.json": cacheText(entryWithReading()), "cache.json.4242.tmp": TORN });
    const states = await read(testRun({ runtimeDir }));
    expect(states[0]?.entry).toEqual(entryWithReading());
  });

  test("a leftover temp file is swept by the next fetch, and the cache stays whole", async () => {
    const runtimeDir = runtimeDirWith({ "cache.json": cacheText(entryWithReading()), "cache.json.4242.tmp": TORN });
    const states = await read(testRun({ runtimeDir, now: () => secondsAfter(T0, 60) }));
    expect(states[0]?.entry?.status).toBe("read");
    expect(readdirSync(runtimeDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(onDisk(runtimeDir).providers.claude.status).toBe("read");
  });

  test("a temp file with no cache beside it reads as an empty cache", async () => {
    const runtimeDir = runtimeDirWith({ "cache.json.4242.tmp": TORN });
    const run = testRun({ runtimeDir });
    const states = await read(run);
    expect(states[0]?.entry).toMatchObject({ status: "read", reading: READING });
    expect(requestsIn(run.events)).toHaveLength(1);
  });

  test("a torn cache file is fetched again and logged once", async () => {
    const runtimeDir = runtimeDirWith({ "cache.json": TORN });
    const run = testRun({ runtimeDir });
    const states = await read(run);
    expect(states[0]?.entry?.status).toBe("read");
    expect(run.events.filter((event) => event.event === "cacheReset")).toHaveLength(1);
    expect(onDisk(runtimeDir).version).toBe(1);
  });

  test("an oversized debug log is set aside by the next fetch", async () => {
    const runtimeDir = runtimeDirWith({ "debug.log": "x".repeat(300 * 1024) });
    await read({ ...testRun({ runtimeDir }), log: journal(runtimeDir) });
    expect(statSync(join(runtimeDir, "debug.log.1")).size).toBeGreaterThanOrEqual(300 * 1024);
    expect(statSync(join(runtimeDir, "debug.log")).size).toBeLessThan(4096);
  });
});

describe("a runtime directory that is not private", () => {
  const openTo = (mode: number) => (path: string) => {
    mkdirSync(path);
    chmodSync(path, mode);
    return path;
  };
  const linkedToAPrivateDirectory = (path: string) => {
    const target = tempDir();
    symlinkSync(target, path);
    return target;
  };

  test.each([
    ["is a symlink to a private directory", linkedToAPrivateDirectory],
    ["is open to everyone", openTo(0o777)],
    ["lets the group read it", openTo(0o750)],
    ["lets others pass through it", openTo(0o701)],
  ])("that %s is refused by name, and nothing is put in it", async (_case, make) => {
    const runtimeDir = join(tempDir(), "usage-plugin");
    const contents = make(runtimeDir);
    const run = testRun({ runtimeDir });

    await expect(read(run)).rejects.toThrow(runtimeDir);
    expect(() => readCache({ runtimeDir }, [CLAUDE])).toThrow(runtimeDir);
    expect(() => journalTail(runtimeDir, 5)).toThrow(runtimeDir);
    journal(runtimeDir)({ event: "lock", acquired: true, waitedMs: 0 });

    expect(requestsIn(run.events)).toEqual([]);
    expect(readdirSync(contents)).toEqual([]);
  });

  test("is any directory that belongs to another user, whatever its mode", () => {
    const ours = lstatSync(tempDir());
    expect(isPrivateDirectory(ours, ours.uid)).toBe(true);
    expect(isPrivateDirectory(ours, ours.uid + 1)).toBe(false);
    expect(isPrivateDirectory(ours, undefined)).toBe(false);
  });

  test("is created private when it is missing", async () => {
    const run = testRun();
    await read(run);
    expect(lstatSync(run.runtimeDir).mode & 0o777).toBe(0o700);
  });
});

describe("a file in the runtime directory that someone planted", () => {
  const ORIGINAL = "the owner's own notes\n";

  function victimFile(text = ORIGINAL): string {
    const victim = join(tempDir(), "victim.txt");
    writeFileSync(victim, text);
    return victim;
  }

  test("a symlink at the temp file's name is not written through", async () => {
    const runtimeDir = runtimeDirWith({});
    const victim = victimFile();
    const planting: Adapter = {
      ...CLAUDE,
      fetch: async () => {
        symlinkSync(victim, join(runtimeDir, `cache.json.${process.pid}.tmp`));
        return { kind: "windows", plan: null, windows: [window("only", 5)] };
      },
    };

    await expect(read(testRun({ runtimeDir }), { adapters: [planting] })).rejects.toThrow("cache.json");

    expect(readFileSync(victim, "utf8")).toBe(ORIGINAL);
    expect(existsSync(join(runtimeDir, "cache.json"))).toBe(false);
  });

  test("a symlink at debug.log is not appended through, and the fetch still lands", async () => {
    const runtimeDir = runtimeDirWith({});
    const victim = victimFile();
    symlinkSync(victim, join(runtimeDir, "debug.log"));

    const states = await read({ ...testRun({ runtimeDir }), log: journal(runtimeDir) });

    expect(readFileSync(victim, "utf8")).toBe(ORIGINAL);
    expect(states[0]?.entry).toMatchObject({ status: "read", reading: READING });
    expect(journalTail(runtimeDir, 5)).toEqual([]);
  });

  test("a symlink at cache.lock is not followed, and the run says so", async () => {
    const runtimeDir = runtimeDirWith({});
    const target = join(tempDir(), "never-created");
    symlinkSync(target, join(runtimeDir, "cache.lock"));
    const run = testRun({ runtimeDir });

    await expect(read(run)).rejects.toThrow("cache.lock");

    expect(existsSync(target)).toBe(false);
    expect(requestsIn(run.events)).toEqual([]);
  });

  test("a FIFO at cache.lock is not taken for the lock, and the run says so", async () => {
    const runtimeDir = runtimeDirWith({});
    makeFifo(join(runtimeDir, "cache.lock"));
    const run = testRun({ runtimeDir });

    await expect(read(run)).rejects.toThrow("cache.lock");

    expect(requestsIn(run.events)).toEqual([]);
  });

  test("a FIFO at debug.log with someone reading it is sent no log line", () => {
    const runtimeDir = runtimeDirWith({});
    makeFifo(join(runtimeDir, "debug.log"));
    const listener = openSync(join(runtimeDir, "debug.log"), constants.O_RDWR | constants.O_NONBLOCK);

    journal(runtimeDir)({ event: "lock", acquired: true, waitedMs: 0 });

    writeSync(listener, "nothing before this");
    const heard = Buffer.alloc(4096);
    expect(heard.toString("utf8", 0, readSync(listener, heard))).toBe("nothing before this");
    closeSync(listener);
  });

  test("a symlink at cache.json is not read through, and the next fetch replaces it", async () => {
    const planted = cacheText(
      applyOutcome(undefined, { kind: "reading", reading: { ...READING, windows: [window("planted", 5)] } }, T0, DEFAULT_POLICY),
    );
    const victim = victimFile(planted);
    const runtimeDir = runtimeDirWith({});
    symlinkSync(victim, join(runtimeDir, "cache.json"));
    const run = testRun({ runtimeDir });

    const states = await read(run);

    expect(states[0]?.entry).toMatchObject({ status: "read", reading: READING });
    expect(requestsIn(run.events)).toHaveLength(1);
    expect(readFileSync(victim, "utf8")).toBe(planted);
    expect(lstatSync(join(runtimeDir, "cache.json")).isFile()).toBe(true);
  });
});

const WELL_UNDER_RUN_BUDGET_MS = 500;

describe("a caller that finds the lock held", () => {

  test("returns at once with the reading it already has", async () => {
    const runtimeDir = runtimeDirWith({ "cache.json": cacheText(entryWithReading()) });
    const later = () => secondsAfter(T0, 60);
    const holder = await lockHolder(runtimeDir, later);

    const waiter = testRun({ runtimeDir, now: later });
    const startedAt = performance.now();
    const states = await read(waiter);

    expect(performance.now() - startedAt).toBeLessThan(WELL_UNDER_RUN_BUDGET_MS);
    expect(holder.isDone()).toBe(false);
    expect(states[0]?.entry).toEqual(entryWithReading());
    expect(requestsIn(waiter.events)).toEqual([]);
    await holder.finish();
  });

  test("with nothing to show returns as soon as an entry lands, while the lock is still held", async () => {
    const runtimeDir = join(tempDir(), "usage-plugin");
    const holder = await lockHolder(runtimeDir);

    const waiter = testRun({ runtimeDir });
    let waiterDone = false;
    const waiting = read(waiter).then((states) => {
      waiterDone = true;
      return states;
    });
    await Bun.sleep(60);
    expect(waiterDone).toBe(false);

    writeFileSync(join(runtimeDir, "landing"), cacheText(entryWithReading()));
    renameSync(join(runtimeDir, "landing"), join(runtimeDir, "cache.json"));
    const landedAt = performance.now();
    const states = await waiting;

    expect(performance.now() - landedAt).toBeLessThan(WELL_UNDER_RUN_BUDGET_MS);
    expect(holder.isDone()).toBe(false);
    expect(states[0]?.entry).toEqual(entryWithReading());
    expect(requestsIn(waiter.events)).toEqual([]);
    await holder.finish();
  });

  test("with nothing to show gives up at its deadline", async () => {
    const runtimeDir = join(tempDir(), "usage-plugin");
    const holder = await lockHolder(runtimeDir);

    const waiter = testRun({ runtimeDir, deadline: deadlineFromNow(120) });
    const states = await read(waiter);

    expect(holder.isDone()).toBe(false);
    expect(states).toEqual([{ provider: CLAUDE, entry: null }]);
    expect(waiter.events).toEqual([expect.objectContaining({ event: "lock", acquired: false })]);
    await holder.finish();
  });

  test("and shows none of the providers still missing does not wait", async () => {
    const runtimeDir = join(tempDir(), "usage-plugin");
    const holder = await lockHolder(runtimeDir);

    const startedAt = performance.now();
    const states = await read(testRun({ runtimeDir }), { shown: [] });

    expect(performance.now() - startedAt).toBeLessThan(WELL_UNDER_RUN_BUDGET_MS);
    expect(holder.isDone()).toBe(false);
    expect(states).toEqual([{ provider: CLAUDE, entry: null }]);
    await holder.finish();
  });
});

describe("two providers that are both due", () => {
  test("are each fetched once, side by side, and a caller that shows the one that landed does not wait for the other", async () => {
    const runtimeDir = join(tempDir(), "usage-plugin");
    const fetched: string[] = [];
    const answer = Promise.withResolvers<FetchResult>();
    const slow = adapterNamed("slow", 0xe901, () => {
      fetched.push("slow");
      return answer.promise;
    });
    const quick: Adapter = {
      ...CLAUDE,
      fetch: async () => {
        fetched.push("quick");
        return { kind: "windows", plan: null, windows: [window("quick", 5)] };
      },
    };
    const both = [slow, quick];

    let holderDone = false;
    const holding = readOrFetch(testRun({ runtimeDir, deadline: deadlineFromNow(4000) }), { adapters: both }).then(
      ({ states }) => {
        holderDone = true;
        return states;
      },
    );
    await until(() => existsSync(join(runtimeDir, "cache.json")), "the quick provider's reading is on disk");
    expect(Object.keys(onDisk(runtimeDir).providers)).toEqual([quick.id]);

    const startedAt = performance.now();
    const { states: seen } = await readOrFetch(testRun({ runtimeDir }), { adapters: both, shown: [quick.id] });

    expect(performance.now() - startedAt).toBeLessThan(WELL_UNDER_RUN_BUDGET_MS);
    expect(holderDone).toBe(false);
    expect(seen).toMatchObject([{ entry: null }, { entry: { reading: { windows: [{ label: "quick" }] } } }]);

    answer.resolve({ kind: "windows", plan: null, windows: [window("slow", 7)] });
    expect(await holding).toMatchObject([
      { provider: slow, entry: { status: "read", reading: { provider: slow.id, windows: [{ label: "slow" }] } } },
      { provider: quick, entry: { status: "read", reading: { provider: quick.id, windows: [{ label: "quick" }] } } },
    ]);
    expect(fetched.sort()).toEqual(["quick", "slow"]);
    expect(onDisk(runtimeDir).providers).toMatchObject({
      [slow.id]: { status: "read", reading: { windows: [{ label: "slow" }] } },
      [quick.id]: { status: "read", reading: { windows: [{ label: "quick" }] } },
    });
  });
});

describe("readCache", () => {
  test("returns what is known without fetching or writing", async () => {
    const runtimeDir = runtimeDirWith({ "cache.json": cacheText(entryWithReading()) });
    expect(readCache({ runtimeDir }, [CLAUDE])).toEqual([{ provider: CLAUDE, entry: entryWithReading() }]);
    expect(readdirSync(runtimeDir)).toEqual(["cache.json"]);
  });

  test("returns no entries for a runtime directory that does not exist, and does not create it", () => {
    const runtimeDir = join(tempDir(), "never-created");
    expect(readCache({ runtimeDir }, [CLAUDE])).toEqual([{ provider: CLAUDE, entry: null }]);
    expect(existsSync(runtimeDir)).toBe(false);
  });
});

describe("secondsUntilNextAttempt", () => {
  const waits = (miss: Miss, streaks: readonly number[], pollIntervalSeconds = 60) =>
    streaks.map((streak) => secondsUntilNextAttempt(miss, streak, { pollIntervalSeconds }));

  test("looks again after one poll interval when signed out or expired", () => {
    expect(waits({ kind: "signedOut" }, [1, 5])).toEqual([60, 60]);
    expect(waits({ kind: "loginExpired" }, [1, 5])).toEqual([60, 60]);
  });

  test("honours Retry-After between the poll interval and one hour", () => {
    const after = (retryAfterSeconds: number) => waits({ kind: "rateLimited", retryAfterSeconds }, [1])[0];
    expect(after(120)).toBe(120);
    expect(after(5)).toBe(60);
    expect(after(86400)).toBe(3600);
  });

  test("doubles from 300 seconds to one hour when a 429 names no time", () => {
    expect(waits(RATE_LIMITED, [1, 2, 3, 4, 5, 6, 60])).toEqual([300, 600, 1200, 2400, 3600, 3600, 3600]);
  });

  test("doubles from the poll interval to 5 minutes while unreachable", () => {
    expect(waits(NO_NETWORK, [1, 2, 3, 4, 5])).toEqual([60, 120, 240, 300, 300]);
  });

  test("doubles from the poll interval to 15 minutes while unreadable", () => {
    expect(waits(UNREADABLE, [1, 2, 3, 4, 5, 6])).toEqual([60, 120, 240, 480, 900, 900]);
  });

  test("never waits less than the poll interval", () => {
    expect(waits(NO_NETWORK, [1, 9], 600)).toEqual([600, 600]);
    expect(waits(RATE_LIMITED, [1], 900)).toEqual([900]);
  });
});

describe("applyOutcome", () => {
  test("counts misses in a row and starts over after a reading", () => {
    const first = applyOutcome(entryWithReading(), NO_NETWORK, T0, DEFAULT_POLICY);
    const second = applyOutcome(first, NO_NETWORK, T0, DEFAULT_POLICY);
    const recovered = applyOutcome(second, { kind: "reading", reading: READING }, T0, DEFAULT_POLICY);
    const again = applyOutcome(recovered, UNREADABLE, T0, DEFAULT_POLICY);
    expect([first, second, again]).toMatchObject([{ streak: 1 }, { streak: 2 }, { streak: 1 }]);
    expect(second).toMatchObject({ status: "missed", reading: READING, missedAt: T0, dueAt: secondsAfter(T0, 120) });
  });

  test("leaves nothing of a miss on the entry once a reading arrives", () => {
    const missed = applyOutcome(entryWithReading(), NO_NETWORK, T0, DEFAULT_POLICY);
    const recovered = applyOutcome(missed, { kind: "reading", reading: READING }, T0, DEFAULT_POLICY);
    expect(recovered).toEqual(entryWithReading());
  });

  test("carries members it does not own through a miss and a reading", () => {
    const fromALaterVersion = { until: "2027-01-01T00:00:00.000Z" };
    const text = JSON.stringify({
      version: 1,
      providers: { claude: { ...JSON.parse(cacheText(entryWithReading())).providers.claude, snoozed: fromALaterVersion } },
    });
    const stored = decodeCacheFile(text).entries.get(CLAUDE.id);
    const missed = applyOutcome(stored, RATE_LIMITED, T0, DEFAULT_POLICY);
    const recovered = applyOutcome(missed, { kind: "reading", reading: READING }, T0, DEFAULT_POLICY);
    for (const entry of [missed, recovered]) {
      expect(JSON.parse(cacheText(entry)).providers.claude.snoozed).toEqual(fromALaterVersion);
    }
  });
});

describe("the streak of misses", () => {
  const EXPIRED_LOGIN = { claudeAiOauth: { ...LIVE_LOGIN.claudeAiOauth, expiresAt: T0 - 1 } };
  const SLOW_DOWN = { status: 429, headers: {}, body: { type: "error" } };
  const SERVER_TROUBLE: Miss = { kind: "unreachable", cause: "server", detail: "HTTP 503" };
  const LOGIN_FILE_BUSY: Miss = { kind: "unreachable", cause: "loginFile", detail: "login file is not valid JSON" };

  function secondsWaitedAfter(misses: readonly Miss[]): number {
    let entry = entryWithReading();
    let now = T0;
    for (const miss of misses) {
      now = entry.dueAt;
      entry = applyOutcome(entry, miss, now, DEFAULT_POLICY);
    }
    return (entry.dueAt - now) / 1000;
  }

  test("keeps doubling a 429 that names no time when 503s come between", () => {
    expect(secondsWaitedAfter([RATE_LIMITED, SERVER_TROUBLE, RATE_LIMITED])).toBe(1200);
    expect(secondsWaitedAfter([RATE_LIMITED, SERVER_TROUBLE, RATE_LIMITED, SERVER_TROUBLE, RATE_LIMITED])).toBe(3600);
  });

  test("an hour without a network does not lengthen the 429 after it", () => {
    const anHourOffline = Array.from({ length: 14 }, () => NO_NETWORK);
    expect(secondsWaitedAfter(anHourOffline)).toBe(300);
    expect(secondsWaitedAfter([...anHourOffline, RATE_LIMITED])).toBe(300);
  });

  test("a login file caught mid-rewrite between two 429s does not lengthen the second", () => {
    expect(secondsWaitedAfter([RATE_LIMITED, LOGIN_FILE_BUSY, RATE_LIMITED])).toBe(300);
  });

  test("the first 429 after an expired login backs off 300 s, and expired logins still count in a row", async () => {
    const runtimeDir = join(tempDir(), "usage-plugin");
    const expired = caseWith({ login: EXPIRED_LOGIN, reply: SLOW_DOWN });
    const renewed = caseWith({ login: LIVE_LOGIN, reply: SLOW_DOWN });
    for (let poll = 0; poll < 5; poll += 1) {
      const run = testRun({ runtimeDir, fixtures: expired, now: () => secondsAfter(T0, poll * 60) });
      expect((await read(run))[0]?.entry).toMatchObject({ miss: { kind: "loginExpired" }, streak: poll + 1 });
    }

    const renewedAt = secondsAfter(T0, 300);
    const states = await read(testRun({ runtimeDir, fixtures: renewed, now: () => renewedAt }));

    expect(states[0]?.entry).toMatchObject({
      miss: { kind: "rateLimited", retryAfterSeconds: null },
      streak: 1,
      dueAt: secondsAfter(renewedAt, 300),
    });
  });
});

describe("isDue", () => {
  const entry = entryWithReading();

  test("a provider with no entry is due", () => {
    expect(isDue(undefined, T0, DEFAULT_POLICY)).toBe(true);
  });

  test("an entry is due from its due time on", () => {
    expect(isDue(entry, secondsAfter(T0, 59), DEFAULT_POLICY)).toBe(false);
    expect(isDue(entry, secondsAfter(T0, 60), DEFAULT_POLICY)).toBe(true);
  });

  test("a due time further out than any back-off is a clock set back, and is due", () => {
    expect(isDue(entry, secondsAfter(T0, -3600), DEFAULT_POLICY)).toBe(true);
    expect(isDue(entry, secondsAfter(T0, -3000), DEFAULT_POLICY)).toBe(false);
  });

  test("the longest back-off there is, a Retry-After past one hour, is not mistaken for a clock set back", () => {
    const limited = applyOutcome(undefined, { kind: "rateLimited", retryAfterSeconds: 86400 }, T0, DEFAULT_POLICY);
    expect(limited.dueAt).toBe(secondsAfter(T0, 3600));
    expect(isDue(limited, T0, DEFAULT_POLICY)).toBe(false);
    expect(isDue(limited, secondsAfter(T0, 3599), DEFAULT_POLICY)).toBe(false);
    expect(isDue(limited, secondsAfter(T0, 3600), DEFAULT_POLICY)).toBe(true);
  });

  test("a poll interval longer than an hour is not mistaken for a clock set back", () => {
    const policy = { ...DEFAULT_POLICY, pollIntervalSeconds: 7200 };
    const slow = applyOutcome(undefined, { kind: "reading", reading: READING }, T0, policy);
    expect(isDue(slow, secondsAfter(T0, 10), policy)).toBe(false);
  });
});

describe("the cache file", () => {
  test("round-trips an entry that was read and an entry that was missed", () => {
    for (const entry of [entryWithReading(), applyOutcome(entryWithReading(), UNREADABLE, secondsAfter(T0, 60), DEFAULT_POLICY)]) {
      expect(decodeCacheFile(cacheText(entry)).entries.get(CLAUDE.id)).toEqual(entry);
    }
  });

  test("round-trips the detail under a window", () => {
    const split = [
      { label: "chat", usedPercent: percent(30) },
      { label: "build", usedPercent: percent(10) },
    ];
    const reading: Reading = { ...READING, windows: [{ ...window("week", 40, 3600), detail: split }] };
    const entry = applyOutcome(undefined, { kind: "reading", reading }, T0, DEFAULT_POLICY);
    expect(decodeCacheFile(cacheText(entry)).entries.get(CLAUDE.id)).toEqual(entry);
  });

  test("writes every time as ISO 8601", () => {
    const stored = JSON.parse(cacheText(entryWithReading())).providers.claude;
    expect(stored.dueAt).toBe("2026-11-16T06:01:00.000Z");
    expect(stored.reading.takenAt).toBe("2026-11-16T06:00:00.000Z");
    expect(stored.reading.windows[0].resetsAt).toBe("2026-11-16T06:23:30.000Z");
  });

  test.each([
    ["no file", null],
    ["text that is not JSON", "{"],
    ["another version", JSON.stringify({ version: 2, providers: {} })],
    ["a JSON scalar", "7"],
  ])("reads %s as empty", (_case, text) => {
    expect(decodeCacheFile(text).entries.size).toBe(0);
  });

  const FROM_A_NEWER_BINARY = { status: "paused", until: "2027-01-01T00:00:00.000Z", windows: [{ label: "week" }] };

  test("keeps an entry under an id it has no adapter for, and writes it back unchanged", () => {
    const stored = JSON.parse(cacheText(entryWithReading())).providers.claude;
    const text = JSON.stringify({ version: 1, providers: { later: FROM_A_NEWER_BINARY, claude: stored } });
    const file = decodeCacheFile(text);
    expect([...file.entries.keys()]).toEqual([CLAUDE.id]);
    expect(JSON.parse(encodeCacheFile(file)).providers).toEqual({ later: FROM_A_NEWER_BINARY, claude: stored });
  });

  test("keeps an entry under an id that is also the name of a built-in member", () => {
    const text = '{"version":1,"providers":{"__proto__":{"status":"paused"},"toString":{"status":"paused"}}}';
    const written = encodeCacheFile(decodeCacheFile(text));
    expect(written).toContain('"__proto__": {\n      "status": "paused"');
    expect(written).toContain('"toString": {\n      "status": "paused"');
  });

  test("keeps an entry of a provider that is switched off, and reads it again once it is back on", () => {
    const text = cacheText(entryWithReading());
    const switchedOff = decodeCacheFile(text, []);
    expect(switchedOff.entries.size).toBe(0);
    expect(decodeCacheFile(encodeCacheFile(switchedOff)).entries.get(CLAUDE.id)).toEqual(entryWithReading());
  });

  test("a fetch writes back an entry it has no adapter for", async () => {
    const stored = JSON.parse(cacheText(entryWithReading())).providers.claude;
    const text = JSON.stringify({ version: 1, providers: { later: FROM_A_NEWER_BINARY, claude: stored } });
    const runtimeDir = runtimeDirWith({ "cache.json": text });

    const run = testRun({ runtimeDir, now: () => secondsAfter(T0, 60) });
    await read(run);

    expect(requestsIn(run.events)).toHaveLength(1);
    expect(onDisk(runtimeDir).providers.later).toEqual(FROM_A_NEWER_BINARY);
    expect(onDisk(runtimeDir).providers.claude.reading.takenAt).toBe("2026-11-16T06:01:00.000Z");
  });

  const damages: readonly (readonly [string, (entry: StoredEntry) => void])[] = [
    ["a percent that is a string", (entry) => entry.reading.windows.forEach((stored) => void (stored.usedPercent = "66"))],
    ["a reading with no windows", (entry) => void (entry.reading.windows = [])],
    ["a reading stamped with another provider", (entry) => void (entry.reading.provider = "grok")],
    ["a due time that is not a time", (entry) => void (entry.dueAt = "soon")],
    ["a status it does not know", (entry) => void (entry.status = "fresh")],
  ];

  test.each(damages)("drops an entry with %s", (_case, damage) => {
    const file = JSON.parse(cacheText(entryWithReading()));
    damage(file.providers.claude);
    expect(decodeCacheFile(JSON.stringify(file)).entries.size).toBe(0);
  });

  test("drops a missed entry whose miss it cannot read", () => {
    const file = JSON.parse(cacheText(applyOutcome(undefined, NO_NETWORK, T0, DEFAULT_POLICY)));
    file.providers.claude.miss = { kind: "onFire" };
    expect(decodeCacheFile(JSON.stringify(file)).entries.size).toBe(0);
  });
});

interface StoredEntry {
  status: string;
  dueAt: string;
  reading: { provider: string; windows: { usedPercent: unknown }[] };
}

describe("alert marks", () => {
  const ALERT_AT_90 = { ...DEFAULT_POLICY, alertAt: percent(90) };
  const AT_95: Reading = { ...READING, windows: [window("5 hour", 95, 1410), window("7 day", 12, 282600)] };
  const marked = (reading: Reading = AT_95) => applyOutcome(undefined, { kind: "reading", reading }, T0, ALERT_AT_90);
  const fetchWith = (run: Run, policy: Policy) => readOrFetch(run, { adapters: [CLAUDE], policy });

  test("round-trip through the cache file, as ISO times by window label", () => {
    const noReset: Reading = { ...READING, windows: [window("5 hour", 95)] };
    for (const entry of [marked(), marked(noReset)]) {
      expect(decodeCacheFile(cacheText(entry)).entries.get(CLAUDE.id)).toEqual(entry);
    }
    expect(JSON.parse(cacheText(marked())).providers.claude.alerts).toEqual({ "5 hour": "2026-11-16T06:23:30.000Z" });
    expect(JSON.parse(cacheText(marked(noReset))).providers.claude.alerts).toEqual({ "5 hour": null });
  });

  test.each([
    ["a string", "5 hour"],
    ["a list", ["5 hour"]],
    ["a mark that is not a time", { "5 hour": 90 }],
  ])("that are %s read as none, and the entry is kept", (_case, alerts) => {
    const file = JSON.parse(cacheText(marked()));
    file.providers.claude.alerts = alerts;
    expect(decodeCacheFile(JSON.stringify(file)).entries.get(CLAUDE.id)).toEqual({ ...marked(), alerts: new Map() });
  });

  test("read back after U1 rewrote the entry, because U1 keeps members it does not own", () => {
    const byU1 = {
      status: "missed",
      reading: JSON.parse(cacheText(marked())).providers.claude.reading,
      miss: { kind: "rateLimited", retryAfterSeconds: null },
      missedAt: "2026-11-16T06:01:00.000Z",
      streak: 1,
      dueAt: "2026-11-16T06:06:00.000Z",
      alerts: { "5 hour": "2026-11-16T06:23:30.000Z" },
    };
    const entry = decodeCacheFile(JSON.stringify({ version: 1, providers: { claude: byU1 } })).entries.get(CLAUDE.id);
    expect(entry?.alerts).toEqual(new Map([["5 hour", secondsAfter(T0, 1410)]]));
  });

  test("are kept through a miss, which raises nothing", async () => {
    const runtimeDir = runtimeDirWith({ "cache.json": cacheText(marked()) });
    const run = testRun({ runtimeDir, fixtures: fixtureCase("claude-429"), now: () => secondsAfter(T0, 60) });
    const { states, raised } = await fetchWith(run, ALERT_AT_90);
    expect(raised).toEqual([]);
    expect(states[0]?.entry?.alerts).toEqual(marked().alerts);
  });

  test("raise nothing with no alertAt", async () => {
    const { raised } = await fetchWith(testRun({ fixtures: fixtureCase("claude-95") }), DEFAULT_POLICY);
    expect(raised).toEqual([]);
  });

  test("are committed before readOrFetch returns the alert they raise", async () => {
    const run = testRun({ fixtures: fixtureCase("claude-95") });
    const { raised } = await fetchWith(run, ALERT_AT_90);
    expect(raised).toMatchObject([{ provider: { id: CLAUDE.id }, window: { label: "5 hour", usedPercent: 95 } }]);
    expect(onDisk(run.runtimeDir).providers.claude.alerts).toEqual({ "5 hour": "2026-11-16T06:23:30.000Z" });
  });

  test("that did not go out are taken back, and only while they hold the reset they were raised with", async () => {
    const runtimeDir = runtimeDirWith({ "cache.json": cacheText(marked()) });
    const [fiveHour] = AT_95.windows;
    const otherPeriod = { ...fiveHour, resetsAt: secondsAfter(T0, 99_999) };
    await forgetAlerts(testRun({ runtimeDir }), [{ provider: CLAUDE, window: otherPeriod }]);
    expect(onDisk(runtimeDir).providers.claude.alerts).toEqual({ "5 hour": "2026-11-16T06:23:30.000Z" });
    await forgetAlerts(testRun({ runtimeDir }), [{ provider: CLAUDE, window: fiveHour }]);
    expect(onDisk(runtimeDir).providers.claude.alerts).toEqual({});
  });

  test("raise an alert for the lock holder alone, across concurrent callers", async () => {
    const runtimeDir = join(tempDir(), "usage-plugin");
    const runs = Array.from({ length: 8 }, () => testRun({ runtimeDir, fixtures: fixtureCase("claude-95") }));
    const results = await Promise.all(runs.map((run) => fetchWith(run, ALERT_AT_90)));
    expect(results.flatMap(({ raised }) => raised)).toHaveLength(1);
    const holder = runs.findIndex((run) => run.events.some((event) => event.event === "lock" && event.acquired));
    expect(results[holder]?.raised).toHaveLength(1);
  });
});

describe("journal", () => {
  test("appends one line per event, with the time and the pid first", () => {
    const runtimeDir = join(tempDir(), "usage-plugin");
    const log = journal(runtimeDir);
    log({ event: "lock", acquired: true, waitedMs: 0 });
    log({ event: "request", provider: CLAUDE.id, via: "fixture", method: "GET", url: "https://example.test/usage" });
    log({
      event: "outcome",
      provider: CLAUDE.id,
      outcome: "unreadable",
      detail: "reply is not JSON",
      tookMs: 4,
      dueAt: secondsAfter(T0, 60),
    });
    const lines = readFileSync(join(runtimeDir, "debug.log"), "utf8").trimEnd().split("\n");
    expect(lines).toEqual([
      expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z pid=\d+ lock acquired=true waitedMs=0$/),
      expect.stringMatching(/ pid=\d+ request provider=claude via=fixture method=GET url=https:\/\/example\.test\/usage$/),
      expect.stringMatching(/ outcome provider=claude outcome=unreadable tookMs=4 dueAt=2026-11-16T06:01:00\.000Z detail="reply is not JSON"$/),
    ]);
  });

  test("says whether an alert went out, and why not", () => {
    const runtimeDir = join(tempDir(), "usage-plugin");
    const log = journal(runtimeDir);
    log({ event: "alert", provider: CLAUDE.id, window: "5 hour", sent: true });
    log({ event: "alert", provider: CLAUDE.id, window: "5 hour", sent: false, detail: "gdbus exited 1: no bus" });
    expect(journalTail(runtimeDir, 2)).toEqual([
      expect.stringMatching(/ alert provider=claude window="5 hour" sent=true$/),
      expect.stringMatching(/ alert provider=claude window="5 hour" sent=false detail="gdbus exited 1: no bus"$/),
    ]);
  });

  test("never throws when the log cannot be written", () => {
    const blocked = join(tempDir(), "a-file");
    writeFileSync(blocked, "");
    expect(() => journal(join(blocked, "usage-plugin"))({ event: "lock", acquired: true, waitedMs: 0 })).not.toThrow();
  });
});
