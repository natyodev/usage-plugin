import { describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyOutcome } from "../src/cache.ts";
import type { Entry, Policy } from "../src/cache.ts";
import { DIRECT } from "../src/domain.ts";
import type { Instant, Reading, Window } from "../src/domain.ts";
import { alertsRaised, notifyArgv, sendAlert } from "../src/notify.ts";
import { CLAUDE, deadlineFromNow, percent, secondsAfter, T0, tempDir, window } from "./support.ts";

const ALERT_AT_90: Policy = { pollIntervalSeconds: 60, alertAt: percent(90) };
const FIVE_HOURS = 5 * 3600;

function readingOf(...windows: readonly Window[]): Reading {
  const [first, ...rest] = windows;
  if (first === undefined) throw new Error("give at least one window");
  return { provider: CLAUDE.id, plan: "max", windows: [first, ...rest], takenAt: T0, via: DIRECT };
}

function alertsAcross(readings: readonly Reading[], policy: Policy = ALERT_AT_90): readonly string[] {
  let entry: Entry | undefined;
  const raised: string[] = [];
  readings.forEach((reading, poll) => {
    const next = applyOutcome(entry, { kind: "reading", reading }, secondsAfter(T0, poll * 60), policy);
    raised.push(...alertsRaised(CLAUDE, entry, next).map(({ window: { label, usedPercent } }) => `${label} ${usedPercent}`));
    entry = next;
  });
  return raised;
}

const fiveHour = (used: number, resetsInSeconds: number | null = 1410) => readingOf(window("5 hour", used, resetsInSeconds));

describe("alerts", () => {
  test("crossing 90 twice in one window raises one alert", () => {
    expect(alertsAcross([fiveHour(80), fiveHour(91), fiveHour(85), fiveHour(92)])).toEqual(["5 hour 91"]);
  });

  test("a reset time that moves 60 s with every poll raises one alert across ten polls", () => {
    const polls = Array.from({ length: 10 }, (_, poll) => fiveHour(95, 1410 + poll * 60));
    expect(alertsAcross(polls)).toEqual(["5 hour 95"]);
  });

  test("a dip under critical and a climb back in the same period raises nothing new", () => {
    expect(alertsAcross([fiveHour(95, 1410), fiveHour(40, 1410 + 300), fiveHour(96, 1410 + 600)])).toEqual(["5 hour 95"]);
  });

  test("a reset more than an hour past the marked one is a new period, and raises again", () => {
    expect(alertsAcross([fiveHour(95, 1410), fiveHour(93, 1410 + FIVE_HOURS)])).toEqual(["5 hour 95", "5 hour 93"]);
    expect(alertsAcross([fiveHour(95, 1410), fiveHour(93, 1410 + 3601)])).toEqual(["5 hour 95", "5 hour 93"]);
    expect(alertsAcross([fiveHour(95, 1410), fiveHour(93, 1410 + 3600)])).toEqual(["5 hour 95"]);
  });

  test("a window with no reset time re-arms only after a reading under critical", () => {
    expect(alertsAcross([fiveHour(95, null), fiveHour(97, null), fiveHour(99, null)])).toEqual(["5 hour 95"]);
    expect(alertsAcross([fiveHour(95, null), fiveHour(50, null), fiveHour(92, null)])).toEqual(["5 hour 95", "5 hour 92"]);
  });

  test("89.6 percent alerts at critical 90, because the bar prints 90", () => {
    expect(alertsAcross([fiveHour(89.6)])).toEqual(["5 hour 89.6"]);
    expect(alertsAcross([fiveHour(89.4)])).toEqual([]);
  });

  test("a first reading already at 95 raises once", () => {
    expect(alertsAcross([fiveHour(95), fiveHour(95), fiveHour(95)])).toEqual(["5 hour 95"]);
  });

  test("each window alerts on its own", () => {
    const both = readingOf(window("5 hour", 95, 1410), window("7 day", 91, 282600));
    expect(alertsAcross([both, both])).toEqual(["5 hour 95", "7 day 91"]);
    expect(alertsAcross([fiveHour(95), both])).toEqual(["5 hour 95", "7 day 91"]);
  });

  test("a window that leaves the reading forgets its mark", () => {
    const weekOnly = readingOf(window("7 day", 10, 282600));
    expect(alertsAcross([fiveHour(95), weekOnly, fiveHour(95)])).toEqual(["5 hour 95", "5 hour 95"]);
  });

  test("follows the critical threshold it is given", () => {
    expect(alertsAcross([fiveHour(61)], { ...ALERT_AT_90, alertAt: percent(60) })).toEqual(["5 hour 61"]);
  });

  test("raises nothing with alerts off, and a miss raises nothing", () => {
    expect(alertsAcross([fiveHour(95)], { ...ALERT_AT_90, alertAt: null })).toEqual([]);
    const read = applyOutcome(undefined, { kind: "reading", reading: fiveHour(95) }, T0, ALERT_AT_90);
    const missed = applyOutcome(read, { kind: "rateLimited", retryAfterSeconds: null }, T0, ALERT_AT_90);
    expect(alertsRaised(CLAUDE, read, missed)).toEqual([]);
  });
});

describe("the Notify call", () => {
  const at = (seconds: number): Instant => secondsAfter(T0, seconds);

  test("quotes a label with a quote and brackets as one string, and escapes the body for markup", () => {
    const alert = { provider: CLAUDE, window: window("it's [1] <b>", 92, 1410) };
    expect(notifyArgv(alert, at(0)).slice(11)).toEqual([
      "'usage-plugin'",
      "uint32 0",
      "''",
      "'Claude: 8% left'",
      "'it\\'s [1] &lt;b&gt; window, resets in 23m'",
      "@as []",
      "{'urgency': <byte 1>, 'x-dunst-stack-tag': <'usage-plugin-claude-it\\'s [1] <b>'>}",
      "int32 -1",
    ]);
  });

  test("calls Notify on the session bus with a timeout", () => {
    expect(notifyArgv({ provider: CLAUDE, window: window("5 hour", 92) }, at(0)).slice(0, 11)).toEqual([
      "gdbus",
      "call",
      "--session",
      "--timeout",
      "2",
      "--dest",
      "org.freedesktop.Notifications",
      "--object-path",
      "/org/freedesktop/Notifications",
      "--method",
      "org.freedesktop.Notifications.Notify",
    ]);
  });

  test("leaves the reset out when the window has none, and says now once it has passed", () => {
    expect(notifyArgv({ provider: CLAUDE, window: window("5 hour", 92) }, at(0))[15]).toBe("'5 hour window'");
    expect(notifyArgv({ provider: CLAUDE, window: window("5 hour", 92, 60) }, at(61))[15]).toBe("'5 hour window, resets now'");
  });
});

describe("sendAlert", () => {
  const alert = { provider: CLAUDE, window: window("5 hour", 95, 1410) };
  const run = () => ({ now: () => T0, deadline: deadlineFromNow(2000) });

  test("under the test preload's dead session bus resolves not sent, and does not throw", async () => {
    expect(await sendAlert(alert, run())).toEqual({ sent: false, detail: expect.stringContaining("gdbus exited") });
  });

  test("hands gdbus the session bus from process.env, which the test preload points at a dead socket", async () => {
    const dir = tempDir();
    const record = join(dir, "bus");
    writeFileSync(join(dir, "gdbus"), `#!/bin/sh\nprintf '%s' "$DBUS_SESSION_BUS_ADDRESS" > '${record}'\n`);
    chmodSync(join(dir, "gdbus"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${dir}:${path}`;
    try {
      expect(await sendAlert(alert, run())).toEqual({ sent: true });
    } finally {
      process.env.PATH = path;
    }
    expect(readFileSync(record, "utf8")).toBe("unix:path=/nonexistent/usage-plugin-test-bus");
  });

  async function withGdbus<T>(script: string, body: () => Promise<T>): Promise<T> {
    const dir = tempDir();
    writeFileSync(join(dir, "gdbus"), `#!/bin/sh\n${script}\n`);
    chmodSync(join(dir, "gdbus"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${dir}:${path}`;
    try {
      return await body();
    } finally {
      process.env.PATH = path;
    }
  }

  test("names the exit code when gdbus fails and prints nothing", async () => {
    expect(await withGdbus("exit 3", () => sendAlert(alert, run()))).toEqual({ sent: false, detail: "gdbus exited 3" });
  });

  test("does not wait on stderr that a child of gdbus holds open", async () => {
    const startedAt = performance.now();
    const sent = await withGdbus("/bin/sleep 5 &\nexit 1", () => sendAlert(alert, run()));
    expect(sent).toEqual({ sent: false, detail: "gdbus exited 1" });
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  test("resolves not sent by the deadline when gdbus hangs", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "gdbus"), "#!/bin/sh\nexec sleep 5\n");
    chmodSync(join(dir, "gdbus"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${dir}:${path}`;
    const startedAt = performance.now();
    try {
      expect(await sendAlert(alert, { now: () => T0, deadline: deadlineFromNow(150) })).toEqual({
        sent: false,
        detail: "gdbus did not finish in time",
      });
    } finally {
      process.env.PATH = path;
    }
    expect(performance.now() - startedAt).toBeLessThan(1000);
  });
});
