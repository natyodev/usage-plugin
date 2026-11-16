import { describe, expect, test } from "bun:test";
import { applyOutcome, DEFAULT_POLICY } from "../src/cache.ts";
import type { Entry, ProviderState } from "../src/cache.ts";
import { DEFAULT_SETTINGS, isHexColor } from "../src/config.ts";
import type { Settings } from "../src/config.ts";
import { DIRECT } from "../src/domain.ts";
import type { Miss, Reading, Window, Windows } from "../src/domain.ts";
import { buildView } from "../widget/view.ts";
import type { CardView } from "../widget/view.ts";
import { CLAUDE, GROK, percent, secondsAfter, T0, window } from "./support.ts";

const CLAUDE_WINDOWS: Windows = [window("5 hour", 66, 1410), window("7 day", 12, 282600)];
const AT = secondsAfter(T0, 180);

function readingOf(provider = CLAUDE, windows: Windows = CLAUDE_WINDOWS, plan: string | null = "max"): Reading {
  return { provider: provider.id, plan, windows, takenAt: T0, via: DIRECT };
}

/** Due five minutes after it was taken, so it is still current at `AT`. */
function read(reading: Reading = readingOf(), takenAt = T0): Entry {
  return applyOutcome(undefined, { kind: "reading", reading }, takenAt, { ...DEFAULT_POLICY, pollIntervalSeconds: 300 });
}

function missed(miss: Miss, kept: Reading | null): Entry {
  const before = kept === null ? undefined : read(kept);
  return applyOutcome(before, miss, secondsAfter(T0, 60), DEFAULT_POLICY);
}

function viewOf(states: readonly ProviderState[], settings: Partial<Settings> = {}, problems: readonly string[] = []) {
  return buildView(states, { ...DEFAULT_SETTINGS, ...settings }, problems, AT);
}

function onlyCard(entry: Entry, settings: Partial<Settings> = {}): CardView {
  const { cards } = viewOf([{ provider: CLAUDE, entry }], settings);
  expect(cards).toHaveLength(1);
  return cards[0] as CardView;
}

describe("a fresh Claude reading at 66 and 12 percent used", () => {
  const card = onlyCard(read());

  test("heads the card with the tightest window's percent left, like the module", () => {
    expect(card).toMatchObject({
      id: "claude",
      name: "Claude",
      glyph: "\u{e900}",
      color: null,
      plan: "max",
      state: "fresh",
      headline: { text: "34%", level: "ok" },
      note: null,
    });
  });

  test("shows every window with its percent left, a bar filled to it, and its reset", () => {
    expect(card.rows).toEqual([
      { label: "5-hour", percent: "34% left", level: "ok", fraction: 0.34, resets: "resets in 20m", chips: [] },
      { label: "Weekly", percent: "88% left", level: "ok", fraction: 0.88, resets: "resets in 3d 6h", chips: [] },
    ]);
  });

  test("says how old the reading is", () => {
    expect(viewOf([{ provider: CLAUDE, entry: read() }]).updated).toBe("updated 3m ago");
  });
});

describe("a Grok reading split by product", () => {
  test("shows what each product used as a chip under its window, since a product has no limit of its own", () => {
    const weekly: Window = {
      ...window("Weekly", 59.4, 232495),
      detail: [
        { label: "Chat", usedPercent: percent(44) },
        { label: "Build", usedPercent: percent(15.2) },
      ],
    };
    const { cards } = viewOf([{ provider: GROK, entry: read(readingOf(GROK, [weekly], null)) }]);
    expect(cards[0]?.name).toBe("Grok");
    expect(cards[0]?.plan).toBeNull();
    expect(cards[0]?.rows[0]?.chips).toEqual(["Chat 44% used", "Build 15% used"]);
    expect(cards[0]?.rows[0]?.percent).toBe("41% left");
    expect(cards[0]?.headline).toEqual({ text: "41%", level: "ok" });
  });
});

describe("each health state", () => {
  const offline: Miss = { kind: "unreachable", cause: "network", detail: "could not connect" };

  test("stale keeps the reading, marks the headline with ~, and says why", () => {
    const card = onlyCard(missed(offline, readingOf()));
    expect(card).toMatchObject({
      state: "stale",
      plan: "max",
      headline: { text: "~34%", level: "ok" },
      note: "read 3m ago. no network",
    });
    expect(card.rows.map((row) => row.percent)).toEqual(["34% left", "88% left"]);
  });

  test("waiting shows a dash, no rows, and the holdup", () => {
    const card = onlyCard(missed({ kind: "rateLimited", retryAfterSeconds: 600 }, null));
    expect(card).toMatchObject({ state: "waiting", plan: null, headline: { text: "–", level: null }, rows: [] });
    expect(card.note).toBe("no reading yet. rate limited, next try in 8m");
  });

  test("expired shows a question mark and the login command", () => {
    const card = onlyCard(missed({ kind: "loginExpired" }, null));
    expect(card).toMatchObject({ state: "expired", headline: { text: "?", level: null }, rows: [] });
    expect(card.note).toBe("login expired, run `claude` to refresh login");
  });

  test("broken shows an exclamation mark and what could not be read, never the kept reading", () => {
    const card = onlyCard(missed({ kind: "unreadable", detail: "reply is not JSON" }, readingOf()));
    expect(card).toMatchObject({ state: "broken", headline: { text: "!", level: null }, rows: [] });
    expect(card.note).toBe("cannot read Claude's reply: reply is not JSON");
  });

  test("signed out, switched off, and never attempted providers are left out", () => {
    const view = viewOf(
      [
        { provider: CLAUDE, entry: missed({ kind: "signedOut" }, null) },
        { provider: GROK, entry: null },
      ],
      {},
    );
    expect(view).toEqual({ updated: null, notices: [], cards: [], empty: "No provider has a reading yet." });
    expect(viewOf([{ provider: CLAUDE, entry: read() }], { disabled: new Set(["claude"]) }).cards).toEqual([]);
  });
});

describe("the config", () => {
  test("moves the levels with its thresholds", () => {
    const card = onlyCard(read(), { thresholds: { warning: percent(10), critical: percent(60) } });
    expect(card.headline.level).toBe("critical");
    expect(card.rows.map((row) => row.level)).toEqual(["critical", "warning"]);
  });

  test("colours the logo", () => {
    const orange = "#D97757";
    if (!isHexColor(orange)) throw new Error("not a colour");
    expect(onlyCard(read(), { colors: new Map([["claude", orange]]) }).color).toBe(orange);
  });

  test("passes its problems through as notices, even with no card", () => {
    expect(viewOf([], {}, ["config.jsonc line 3: colors.claude must be a colour"]).notices).toEqual([
      "config.jsonc line 3: colors.claude must be a colour",
    ]);
  });
});

test("a window over 100 percent used has nothing left and an empty bar", () => {
  const card = onlyCard(read(readingOf(CLAUDE, [window("5 hour", 130, 60)])));
  expect(card.rows[0]).toMatchObject({ percent: "0% left", level: "critical", fraction: 0 });
});

test("the newest reading dates the view", () => {
  const older = { ...readingOf(GROK, [window("Weekly", 10)]), takenAt: secondsAfter(T0, -3600) };
  const view = viewOf([
    { provider: GROK, entry: read(older) },
    { provider: CLAUDE, entry: read() },
  ]);
  expect(view.updated).toBe("updated 3m ago");
});

test("text that looks like markup stays exactly as the provider sent it", () => {
  const tricky: Window = {
    ...window("<b>5h</b> & co", 50),
    detail: [{ label: "<span foreground='red'>Chat</span>", usedPercent: percent(5) }],
  };
  const card = onlyCard(read(readingOf(CLAUDE, [tricky], "<i>Max</i> & 'Pro'")));
  expect(card.plan).toBe("<i>Max</i> & 'Pro'");
  expect(card.rows[0]?.label).toBe("<b>5h</b> & co");
  expect(card.rows[0]?.chips).toEqual(["<span foreground='red'>Chat</span> 5% used"]);
});

describe("a reading that nothing has refreshed", () => {
  const settings = { pollIntervalSeconds: 60 };

  test("stays current until a whole poll interval past its due time", () => {
    const entry = applyOutcome(undefined, { kind: "reading", reading: readingOf() }, secondsAfter(T0, 60), DEFAULT_POLICY);
    expect(onlyCard(entry, settings)).toMatchObject({ state: "fresh", headline: { text: "34%" }, note: null });
  });

  test("past that is dimmed like a stale reading and says how old it is", () => {
    const entry = applyOutcome(undefined, { kind: "reading", reading: readingOf() }, T0, DEFAULT_POLICY);
    expect(onlyCard(entry, settings)).toMatchObject({
      state: "stale",
      headline: { text: "~34%", level: "ok" },
      note: "read 3m ago, nothing has read Claude since",
    });
  });
});

describe("a window whose reset time has passed", () => {
  test("waits for a new reading instead of saying it resets now", () => {
    const windows: Windows = [window("5 hour", 66, 120), window("7 day", 12, 282600)];
    const [passed, coming] = onlyCard(read(readingOf(CLAUDE, windows))).rows;
    expect(passed?.resets).toBe("reset, waiting for a new reading");
    expect(coming?.resets).toBe("resets in 3d 6h");
  });
});

describe("the source line", () => {
  test("says direct for the plugin's own reading, and nothing when the config fixes the source", () => {
    expect(onlyCard(read()).source).toBe("direct");
    expect(onlyCard(read(), { source: "direct" }).source).toBeNull();
  });
});
