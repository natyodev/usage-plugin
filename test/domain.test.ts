import { describe, expect, test } from "bun:test";
import {
  DEFAULT_THRESHOLDS,
  formatCountdown,
  instant,
  isGlyph,
  isInstant,
  isPercent,
  isRecord,
  levelOf,
  parseInstant,
  tightestWindow,
  shownLabel,
} from "../src/domain.ts";
import { percent, T0 as NOW, window } from "./support.ts";

describe("tightestWindow", () => {
  test("returns the window with the highest percent used", () => {
    const tightest = tightestWindow({ windows: [window("5 hour", 66), window("7 day", 12)] });
    expect(tightest.label).toBe("5 hour");
  });

  test("finds the highest percent wherever it sits in the reading", () => {
    const tightest = tightestWindow({ windows: [window("5 hour", 12), window("7 day", 66)] });
    expect(tightest.label).toBe("7 day");
  });

  test("returns the earliest window on a tie", () => {
    const tightest = tightestWindow({ windows: [window("5 hour", 40), window("7 day", 40), window("month", 40)] });
    expect(tightest.label).toBe("5 hour");
  });

  test("returns a window at 0 when every window is at 0", () => {
    const tightest = tightestWindow({ windows: [window("5 hour", 0), window("7 day", 0)] });
    expect(tightest).toMatchObject({ label: "5 hour", usedPercent: 0 });
  });

  test("returns the window at 100 over a lower one", () => {
    const tightest = tightestWindow({ windows: [window("5 hour", 99.5), window("7 day", 100)] });
    expect(tightest).toMatchObject({ label: "7 day", usedPercent: 100 });
  });

  test("returns the only window of a single-window reading", () => {
    expect(tightestWindow({ windows: [window("week", 3)] }).label).toBe("week");
  });
});

describe("levelOf", () => {
  test.each([
    [0, "ok"],
    [74.9, "ok"],
    [75, "warning"],
    [89.9, "warning"],
    [90, "critical"],
    [100, "critical"],
    [104, "critical"],
  ] as const)("%p percent is %p at the default thresholds", (used, level) => {
    expect(levelOf(percent(used), DEFAULT_THRESHOLDS)).toBe(level);
  });

  test("follows the thresholds it is given", () => {
    const thresholds = { warning: percent(50), critical: percent(60) };
    expect(levelOf(percent(55), thresholds)).toBe("warning");
    expect(levelOf(percent(60), thresholds)).toBe("critical");
  });
});

describe("formatCountdown", () => {
  const inSeconds = (seconds: number) => instant(NOW + seconds * 1000);

  test.each([
    [23 * 60, "23m"],
    [46 * 60 + 59, "46m"],
    [2 * 3600 + 14 * 60, "2h 14m"],
    [2 * 3600, "2h 0m"],
    [3 * 86400 + 6 * 3600 + 59 * 60, "3d 6h"],
    [86400, "1d 0h"],
    [59, "<1m"],
    [1, "<1m"],
  ] as const)("%p seconds ahead reads %p", (seconds, text) => {
    expect(formatCountdown(inSeconds(seconds), NOW)).toBe(text);
  });

  test("reads now once the reset time has passed", () => {
    expect(formatCountdown(NOW, NOW)).toBe("now");
    expect(formatCountdown(inSeconds(-300), NOW)).toBe("now");
  });
});

describe("guards", () => {
  test("isPercent accepts finite numbers from 0 up and does not cap at 100", () => {
    expect(isPercent(0)).toBe(true);
    expect(isPercent(66.5)).toBe(true);
    expect(isPercent(104)).toBe(true);
  });

  test.each([[null], [undefined], [""], ["66"], [Number.NaN], [Number.POSITIVE_INFINITY], [-1], [{}]])(
    "isPercent rejects %p and never coerces it",
    (value) => {
      expect(isPercent(value)).toBe(false);
    },
  );

  test("isGlyph accepts only whole code points in the private use area from U+E900", () => {
    expect(isGlyph(0xe900)).toBe(true);
    expect(isGlyph(0xf8ff)).toBe(true);
    expect(isGlyph(0xe8ff)).toBe(false);
    expect(isGlyph(0xf900)).toBe(false);
    expect(isGlyph(0xe900 + 0.5)).toBe(false);
  });

  test("isInstant accepts only times a Date can hold", () => {
    expect(isInstant(0)).toBe(true);
    expect(isInstant(NOW)).toBe(true);
    expect(isInstant(Number.NaN)).toBe(false);
    expect(isInstant(8.64e15 + 1)).toBe(false);
    expect(isInstant("2026-11-16T06:00:00Z")).toBe(false);
  });

  test("isRecord accepts only objects that are not arrays", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ five_hour: null })).toBe(true);
    for (const value of [null, undefined, [], "{}", 5]) expect(isRecord(value)).toBe(false);
  });

  test("instant refuses a number that is not a time", () => {
    expect(() => instant(Number.NaN)).toThrow(RangeError);
  });

  test("parseInstant reads Claude's microsecond times with an offset", () => {
    expect(parseInstant("2026-11-16T06:30:00.046620+00:00")).toBe(instant(Date.UTC(2026, 10, 16, 6, 30, 0, 46)));
  });

  test("parseInstant reads Grok's nine fractional digits", () => {
    expect(parseInstant("2026-11-23T00:00:00.123456789Z")).toBe(instant(Date.UTC(2026, 10, 23, 0, 0, 0, 123)));
  });

  test.each([
    ["2026-11-16T06:30:00Z"],
    ["2026-11-16T06:30:00.0Z"],
    ["2026-11-16T06:30:00.000Z"],
    ["2026-11-16T06:30:00+00:00"],
    ["2026-11-16T01:30:00-05:00"],
    ["2026-11-16T12:00:00+05:30"],
  ])("parseInstant reads %p as the same instant", (iso) => {
    expect(parseInstant(iso)).toBe(instant(Date.UTC(2026, 10, 16, 6, 30, 0)));
  });

  test.each([
    [null],
    [undefined],
    [1794810600046],
    ["soon"],
    [""],
    ["-5"],
    ["1.5"],
    ["soon 1"],
    ["SECRET-BODY-5"],
    ["1794810600046"],
    ["2026-11-16"],
    ["2026-11-16T06:30:00"],
    ["2026-11-16T06:30Z"],
    ["2026-11-16 06:30:00Z"],
    ["2026-11-16T06:30:00+0000"],
    ["2026-11-16T06:30:00.Z"],
    ["2026-13-16T06:30:00Z"],
    ["2026-11-16T25:30:00Z"],
    ["+275760-09-13T00:00:00.000Z"],
    ["Mon, 16 Nov 2026 06:30:00 GMT"],
    [" 2026-11-16T06:30:00Z"],
    ["2026-11-16T06:30:00Z\n"],
  ])("parseInstant returns null for %p", (value) => {
    expect(parseInstant(value)).toBeNull();
  });
});

describe("shownLabel", () => {
  test.each([
    ["Session", 300, "5-hour"],
    ["5h", undefined, "5-hour"],
    ["5 hour", 300, "5-hour"],
    ["7 day", 10080, "Weekly"],
    ["Weekly", undefined, "Weekly"],
    ["Weekly Fable", 10080, "Weekly · Fable"],
    ["Weekly · Fable", 10080, "Weekly · Fable"],
    ["Weekly · Fable", undefined, "Weekly · Fable"],
    ["7 day - Opus", undefined, "Weekly · Opus"],
    ["5h: Sonnet", undefined, "5-hour · Sonnet"],
    ["Weekly (Fable)", 10080, "Weekly · Fable"],
    ["Weekly ·", 10080, "Weekly"],
    ["Opus", 10080, "Weekly · Opus"],
    ["Credits", undefined, "Credits"],
    ["Weekend", undefined, "Weekend"],
  ] as const)("names %p over %p minutes %p", (label, minutes, shown) => {
    expect(shownLabel({ label, ...(minutes === undefined ? {} : { minutes }) })).toBe(shown);
  });
});
