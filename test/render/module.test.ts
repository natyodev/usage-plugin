import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyOutcome, DEFAULT_POLICY, journal, readOrFetch } from "../../src/cache.ts";
import type { Entry, ProviderState } from "../../src/cache.ts";
import { isHexColor } from "../../src/config.ts";
import type { HexColor } from "../../src/config.ts";
import { DEFAULT_THRESHOLDS, DIRECT } from "../../src/domain.ts";
import type { Miss, Reading, Windows } from "../../src/domain.ts";
import { moduleDebug, moduleLine, renderModule, renderProblem } from "../../src/render/module.ts";
import { isProviderId } from "../../src/providers/index.ts";
import type { FetchResult } from "../../src/providers/index.ts";
import type { Layout, ModuleRequest, RenderOptions, WaybarOutput } from "../../src/render/module.ts";
import {
  adapterNamed,
  caseWith,
  CLAUDE,
  deadlineFromNow,
  fixtureCase,
  LIVE_LOGIN,
  percent,
  requestsIn,
  secondsAfter,
  T0,
  tempDir,
  testRun,
  until,
  window,
  writeFileUnder,
} from "../support.ts";
import type { TestRun } from "../support.ts";

const LOGO = "<span font_family='usage-plugin-icons' size='x-large'></span>";
const WINDOWS: Windows = [window("5 hour", 66, 1410), window("7 day", 12, 282600)];
const RED_MARK = "<span foreground='#E5484D' weight='bold'>!</span>";
const INLINE: ModuleRequest = { only: null, layout: "inline" };
const NO_NETWORK: Miss = { kind: "unreachable", cause: "network", detail: "could not connect" };
const UNREADABLE: Miss = { kind: "unreadable", detail: "reply is not JSON" };

function dimmed(markup: string): string {
  return `<span fgalpha='50%'>${markup}</span>`;
}

function readingOf(windows: Windows = WINDOWS): Reading {
  return { provider: CLAUDE.id, plan: "max", windows, takenAt: T0, via: DIRECT };
}

function withReading(windows: Windows = WINDOWS): ProviderState {
  const entry = applyOutcome(undefined, { kind: "reading", reading: readingOf(windows) }, T0, DEFAULT_POLICY);
  return { provider: CLAUDE, entry };
}

function missed(miss: Miss, kept: Reading | null, missedAfterSeconds = 180): ProviderState {
  const before: Entry | undefined =
    kept === null ? undefined : applyOutcome(undefined, { kind: "reading", reading: kept }, T0, DEFAULT_POLICY);
  return { provider: CLAUDE, entry: applyOutcome(before, miss, secondsAfter(T0, missedAfterSeconds), DEFAULT_POLICY) };
}

function render(
  states: readonly ProviderState[],
  layout: Layout = "inline",
  atSeconds = 0,
  options: Partial<RenderOptions> = {},
): WaybarOutput {
  return renderModule(states, {
    layout,
    now: secondsAfter(T0, atSeconds),
    thresholds: DEFAULT_THRESHOLDS,
    colors: new Map(),
    notices: [],
    showVia: false,
    ...options,
  });
}

async function lineFor(fixtures: string, request: Parameters<typeof moduleLine>[0] = { only: null, layout: "inline" }) {
  const line = await moduleLine(request, testRun({ fixtures }));
  return { line, output: JSON.parse(line) };
}

describe("the line for claude-ok", () => {
  test("is the line U1 printed in percent left, with the source named after the windows", async () => {
    const { line } = await lineFor(fixtureCase("claude-ok"));
    expect(line).toBe(
      "{\"text\":\"<span font_family='usage-plugin-icons' size='x-large'></span> 34%\",\"tooltip\":\"<b>Claude</b>\\n<tt>5-hour ███░░░░░░░  34% left</tt>  resets in 23m\\n<tt>Weekly █████████░  88% left</tt>  resets in 3d 6h\\ndirect\",\"class\":[\"ok\",\"claude\",\"claude-ok\"],\"percentage\":34}",
    );
  });

  test("stays fresh past its due time, because only a process that lost the race for the lock sees it so", () => {
    expect(render([withReading()], "inline", 3600)).toMatchObject({ text: `${LOGO} 34%`, class: ["ok", "claude", "claude-ok"] });
  });

  test("is one line of JSON with the four fields Waybar reads", async () => {
    const { line, output } = await lineFor(fixtureCase("claude-ok"));
    expect(line).not.toContain("\n");
    expect(Object.keys(output)).toEqual(["text", "tooltip", "class", "percentage"]);
  });

  test("puts the logo beside the tightest percent in the inline layout", async () => {
    const { output } = await lineFor(fixtureCase("claude-ok"));
    expect(output.text).toBe(`${LOGO} 34%`);
  });

  test("puts the logo above the tightest percent in the stacked layout", async () => {
    const { output } = await lineFor(fixtureCase("claude-ok"), { only: null, layout: "stacked" });
    expect(output.text).toBe(`${LOGO}\n34%`);
  });

  test("carries no colour, so the user's CSS paints the logo and the percent", async () => {
    for (const layout of ["inline", "stacked"] as const) {
      const { output } = await lineFor(fixtureCase("claude-ok"), { only: null, layout });
      expect(`${output.text}${output.tooltip}`).not.toMatch(/colou?r|foreground|background|fgcolor|bgcolor/i);
    }
  });

  test("names the overall level, the provider, and the provider's own level as classes", async () => {
    const { output } = await lineFor(fixtureCase("claude-ok"));
    expect(output.class).toEqual(["ok", "claude", "claude-ok"]);
  });

  test("reports the tightest window's percent left as a number, the same one the text shows", async () => {
    const { output } = await lineFor(fixtureCase("claude-ok"));
    expect(output.percentage).toBe(34);
  });

  test("lists both windows in the tooltip, each with its percent left, a bar filled to it, and a reset countdown", async () => {
    const { output } = await lineFor(fixtureCase("claude-ok"));
    expect(output.tooltip.split("\n")).toEqual([
      "<b>Claude</b>",
      "<tt>5-hour ███░░░░░░░  34% left</tt>  resets in 23m",
      "<tt>Weekly █████████░  88% left</tt>  resets in 3d 6h",
      "direct",
    ]);
  });

  test("is the same for a split module that asks for Claude", async () => {
    const combined = await lineFor(fixtureCase("claude-ok"));
    const split = await lineFor(fixtureCase("claude-ok"), { only: CLAUDE.id, layout: "inline" });
    expect(split.line).toBe(combined.line);
  });
});

describe("levels", () => {
  test("80 percent used shows 20 left and is a warning", async () => {
    const { output } = await lineFor(fixtureCase("claude-80"));
    expect(output).toMatchObject({ text: `${LOGO} 20%`, class: ["warning", "claude", "claude-warning"], percentage: 20 });
  });

  test("95 percent used shows 5 left and is critical", async () => {
    const { output } = await lineFor(fixtureCase("claude-95"));
    expect(output).toMatchObject({ text: `${LOGO} 5%`, class: ["critical", "claude", "claude-critical"], percentage: 5 });
  });

  test.each([
    [89.5, "11%", "warning"],
    [89.6, "10%", "critical"],
    [74.5, "26%", "ok"],
    [74.6, "25%", "warning"],
  ])("a window at %p used prints %p left and is %p, so the level matches the number on the bar", (used, printed, level) => {
    const output = render([withReading([window("5 hour", used, 60)])]);
    expect(output).toMatchObject({ text: `${LOGO} ${printed}`, class: [level, "claude", `claude-${level}`] });
  });

  test("the level follows the tightest window, wherever it sits", () => {
    const output = render([withReading([window("5 hour", 3, 60), window("7 day", 91, 3600)])]);
    expect(output).toMatchObject({ text: `${LOGO} 9%`, class: ["critical", "claude", "claude-critical"], percentage: 9 });
  });

  test("a window past 100 percent used has nothing left, with an empty bar", () => {
    const output = render([withReading([window("5 hour", 104, 60)])]);
    expect(output).toMatchObject({ text: `${LOGO} 0%`, class: ["critical", "claude", "claude-critical"], percentage: 0 });
    expect(output.tooltip).toContain("░░░░░░░░░░   0% left");
  });

  test("follows the thresholds it is given", () => {
    const thresholds = { warning: percent(50), critical: percent(99) };
    const output = render([withReading()], "inline", 0, { thresholds });
    expect(output.class).toEqual(["warning", "claude", "claude-warning"]);
  });
});

describe("the tooltip", () => {
  test("draws a full bar for an unused window and leaves out the countdown of a window with no reset time", () => {
    const output = render([withReading([window("5 hour", 0)])]);
    expect(output.tooltip.split("\n")[1]).toBe("<tt>5-hour ██████████ 100% left</tt>");
  });

  test.each([
    [0.5, "██████████ 100% left"],
    [0.6, "█████████░  99% left"],
    [95, "█░░░░░░░░░   5% left"],
    [97, "█░░░░░░░░░   3% left"],
    [99.5, "█░░░░░░░░░   1% left"],
    [99.6, "░░░░░░░░░░   0% left"],
    [100, "░░░░░░░░░░   0% left"],
  ])("draws a window at %p percent used as %p, so the bar looks full only at 100 left and empty only at 0", (used, shown) => {
    const output = render([withReading([window("5 hour", used)])]);
    expect(output.tooltip.split("\n")[1]).toBe(`<tt>5-hour ${shown}</tt>`);
  });

  test("says a window resets now once its reset time has passed", () => {
    const output = render([withReading([window("5 hour", 50, 30)])], "inline", 31);
    expect(output.tooltip).toContain("resets now");
  });

  test("escapes text that came from a provider", () => {
    const output = render([withReading([window("<b>5 & hour</b>", 5, 60)])]);
    expect(output.tooltip).toContain("&lt;b&gt;5 &amp; hour&lt;/b&gt;");
    expect(output.tooltip).not.toContain("<b>5 ");
  });
});

describe("several providers", () => {
  const second: ProviderState = {
    provider: { ...CLAUDE, name: "Second", glyph: CLAUDE.glyph },
    entry: withReading([window("week", 92, 3600)]).entry,
  };

  test("sit side by side in the inline layout and below one another in the stacked one", () => {
    expect(render([withReading(), second], "inline").text).toBe(`${LOGO} 34%  ${LOGO} 8%`);
    expect(render([withReading(), second], "stacked").text).toBe(`${LOGO}\n34%\n<span size='5pt'> </span>\n${LOGO}\n8%`);
  });

  test("give the module the highest level and the lowest percent left, and each provider its own level", () => {
    const output = render([withReading(), second]);
    expect(output.class).toEqual(["critical", "claude", "claude", "claude-ok", "claude-critical"]);
    expect(output.percentage).toBe(8);
  });
});

describe("a module beside a second provider", () => {
  const OTHER = adapterNamed("other", 0xe901, async () => ({
    kind: "windows",
    plan: null,
    windows: [window("week", 92, 3600)],
  }));
  const OTHER_LOGO = LOGO.replace(String.fromCodePoint(CLAUDE.glyph), String.fromCodePoint(OTHER.glyph));

  async function output(only: ModuleRequest["only"]): Promise<WaybarOutput> {
    return JSON.parse(await moduleLine({ only, layout: "inline" }, testRun(), [CLAUDE, OTHER]));
  }

  test("shows both when it is combined", async () => {
    expect(await output(null)).toMatchObject({
      text: `${LOGO} 34%  ${OTHER_LOGO} 8%`,
      class: ["critical", "claude", "other", "claude-ok", "other-critical"],
      percentage: 8,
    });
  });

  test("shows only the provider a split module asks for", async () => {
    expect(await output(CLAUDE.id)).toEqual({
      text: `${LOGO} 34%`,
      tooltip: expect.not.stringContaining("other"),
      class: ["ok", "claude", "claude-ok"],
      percentage: 34,
    });
    expect(await output(OTHER.id)).toEqual({
      text: `${OTHER_LOGO} 8%`,
      tooltip: expect.not.stringContaining("Claude"),
      class: ["critical", "other", "other-critical"],
      percentage: 8,
    });
  });

  test("does not wait for a provider that a split module does not show", async () => {
    const runtimeDir = join(tempDir(), "usage-plugin");
    const answer = Promise.withResolvers<FetchResult>();
    const both = [CLAUDE, adapterNamed("slow", 0xe901, () => answer.promise)];
    const combined = { only: null, layout: "inline" } as const;
    let combinedDone = false;
    const fetching = moduleLine(combined, testRun({ runtimeDir, deadline: deadlineFromNow(4000) }), both).then(() => {
      combinedDone = true;
    });
    await until(() => existsSync(join(runtimeDir, "cache.json")), "Claude's reading is on disk");

    const startedAt = performance.now();
    const split = JSON.parse(await moduleLine({ only: CLAUDE.id, layout: "inline" }, testRun({ runtimeDir }), both));

    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(combinedDone).toBe(false);
    expect(split.text).toBe(`${LOGO} 34%`);
    answer.resolve({ kind: "signedOut" });
    await fetching;
  });
});

describe("a provider with nothing to show", () => {
  test.each([
    ["was never attempted", { provider: CLAUDE, entry: null }],
    ["is signed out", missed({ kind: "signedOut" }, readingOf())],
  ])("that %s is hidden, and an empty text hides the module", (_case, state) => {
    expect(render([state])).toEqual({ text: "", tooltip: "", class: [], percentage: 0 });
  });

  test("a signed out case with T3 closed prints one dimmed mark that says to open T3 Code", async () => {
    const { output } = await lineFor(caseWith({}));
    expect(output).toEqual({
      text: "<span fgalpha='50%'>–</span>",
      tooltip: "T3 Code isn&apos;t running. Open T3 Code, or set up a provider.",
      class: ["waiting", "t3-closed"],
      percentage: 0,
    });
  });
});

describe("a provider whose latest fetch was a miss", () => {
  test("is stale while it keeps its last percent: dimmed and marked, and the tooltip says how old it is and why", () => {
    const output = render([missed({ kind: "rateLimited", retryAfterSeconds: 120 }, readingOf())], "inline", 180);
    expect(output).toEqual({
      text: dimmed(`${LOGO} ~34%`),
      tooltip: [
        "<b>Claude</b>",
        "<tt>5-hour ███░░░░░░░  34% left</tt>  resets in 20m",
        "<tt>Weekly █████████░  88% left</tt>  resets in 3d 6h",
        "read 3m ago. rate limited, next try in 2m",
      ].join("\n"),
      class: ["ok", "stale", "claude", "claude-ok", "claude-stale"],
      percentage: 34,
    });
  });

  test("is stale in the stacked layout too, with the logo and the percent dimmed together", () => {
    expect(render([missed(NO_NETWORK, readingOf())], "stacked", 180).text).toBe(dimmed(`${LOGO}\n~34%`));
  });

  test("an expired login after a reading keeps the percent dimmed, with its age and the login hint, through the whole flow", async () => {
    const runtimeDir = join(tempDir(), "usage-plugin");
    await moduleLine(INLINE, testRun({ runtimeDir }));
    const expired = testRun({ runtimeDir, fixtures: fixtureCase("claude-expired"), now: () => secondsAfter(T0, 180) });

    const output = JSON.parse(await moduleLine(INLINE, expired));

    expect(output).toMatchObject({
      text: dimmed(`${LOGO} ~34%`),
      class: ["ok", "stale", "claude", "claude-ok", "claude-stale"],
      percentage: 34,
    });
    expect(output.tooltip.split("\n").at(-1)).toBe("read 3m ago. login expired, run `claude` to refresh login");
  });

  test.each([
    [{ kind: "rateLimited", retryAfterSeconds: null }, "rate limited, next try in 5m"],
    [{ kind: "unreachable", cause: "network", detail: "could not connect" }, "no network"],
    [{ kind: "unreachable", cause: "timeout", detail: "no answer" }, "no answer in time"],
    [{ kind: "unreachable", cause: "server", detail: "HTTP 503" }, "Claude is having trouble"],
    [{ kind: "unreachable", cause: "loginFile", detail: "not valid JSON" }, "login file busy"],
  ] as const)("with no reading yet is waiting: a dimmed dash with no level, and the tooltip says why: %j", (miss, why) => {
    const output = render([missed(miss, null)], "inline", 180);
    expect(output).toEqual({
      text: dimmed(`${LOGO} –`),
      tooltip: `<b>Claude</b>\nno reading yet. ${why}`,
      class: ["waiting", "claude", "claude-waiting"],
      percentage: 0,
    });
  });

  test("with no reading yet and no network is waiting through the whole flow, not broken", async () => {
    const { output } = await lineFor(fixtureCase("claude-offline"));
    expect(output).toEqual({
      text: dimmed(`${LOGO} –`),
      tooltip: "<b>Claude</b>\nno reading yet. no network",
      class: ["waiting", "claude", "claude-waiting"],
      percentage: 0,
    });
  });

  test("with a refused login and no reading kept is expired: a dimmed logo and a full-strength ?, through the whole flow", async () => {
    const { output } = await lineFor(fixtureCase("claude-expired"));
    expect(output).toEqual({
      text: `${dimmed(LOGO)} <b>?</b>`,
      tooltip: "<b>Claude</b>\nlogin expired, run `claude` to refresh login",
      class: ["expired", "claude", "claude-expired"],
      percentage: 0,
    });
  });

  test("is expired in the stacked layout with the logo alone dimmed", () => {
    expect(render([missed({ kind: "loginExpired" }, null)], "stacked").text).toBe(`${dimmed(LOGO)}\n<b>?</b>`);
  });

  test("with an unreadable reply is broken: a red mark and the reason, and not the kept reading", () => {
    const output = render([missed({ kind: "unreadable", detail: "five_hour.utilization is not a number" }, readingOf())]);
    expect(output).toEqual({
      text: `${LOGO} ${RED_MARK}`,
      tooltip: "<b>Claude</b>\ncannot read Claude&apos;s reply: five_hour.utilization is not a number",
      class: ["broken", "claude", "claude-broken"],
      percentage: 0,
    });
  });

  test("with a malformed reply is broken through the whole flow", async () => {
    const { output } = await lineFor(fixtureCase("claude-malformed"));
    expect(output).toEqual({
      text: `${LOGO} ${RED_MARK}`,
      tooltip: "<b>Claude</b>\ncannot read Claude&apos;s reply: five_hour.utilization is not a number",
      class: ["broken", "claude", "claude-broken"],
      percentage: 0,
    });
  });

  test("escapes the detail of a miss in the tooltip", () => {
    const output = render([missed({ kind: "unreadable", detail: "<html> & more" }, null)]);
    expect(output.tooltip).toContain("&lt;html&gt; &amp; more");
  });

  test("dims only itself beside a fresh provider", () => {
    const other = adapterNamed("other", 0xe901, async () => ({ kind: "signedOut" }));
    const otherLogo = LOGO.replace(String.fromCodePoint(CLAUDE.glyph), String.fromCodePoint(other.glyph));
    const otherReading: Reading = { ...readingOf([window("week", 40, 3600)]), provider: other.id };
    const fresh: ProviderState = {
      provider: other,
      entry: applyOutcome(undefined, { kind: "reading", reading: otherReading }, T0, DEFAULT_POLICY),
    };

    const output = render([missed(NO_NETWORK, readingOf()), fresh], "inline", 180);

    expect(output.text).toBe(`${dimmed(`${LOGO} ~34%`)}  ${otherLogo} 60%`);
    expect(output.class).toEqual(["ok", "stale", "claude", "other", "claude-ok", "claude-stale", "other-ok"]);
  });

  test("names every state it shows once, beside the highest level", () => {
    const states = [missed(NO_NETWORK, null), missed(UNREADABLE, null), withReading([window("5 hour", 80, 60)])];
    expect(render(states, "inline", 180).class).toEqual([
      "warning",
      "waiting",
      "broken",
      "claude",
      "claude",
      "claude",
      "claude-waiting",
      "claude-broken",
      "claude-warning",
    ]);
  });
});

describe("a config file", () => {
  const ORANGE_LOGO = LOGO.replace("size='x-large'", "size='x-large' foreground='#D97757'");

  function orange(): HexColor {
    const color = "#D97757";
    if (!isHexColor(color)) throw new Error(`${color} is not a colour`);
    return color;
  }

  function runWith(config: string, fixtures = fixtureCase("claude-ok")): TestRun {
    const run = testRun({ fixtures });
    writeFileUnder(run.home, ".config/usage-plugin/config.jsonc", config);
    return run;
  }

  async function lineWith(run: TestRun, request: ModuleRequest = INLINE): Promise<WaybarOutput> {
    return JSON.parse(await moduleLine(request, run));
  }

  test("puts a colour on the logo span and nowhere else", async () => {
    const output = await lineWith(runWith('{ "colors": { "claude": "#D97757" } }'));
    expect(output.text).toBe(`${ORANGE_LOGO} 34%`);
    expect(output.tooltip).not.toContain("foreground");
    expect(output.class).toEqual(["ok", "claude", "claude-ok"]);
  });

  test("shortens a long problem and shows at most five, then a count of the rest", async () => {
    const keys = Array.from({ length: 7 }, (_, n) => `"${String(n).repeat(5_000)}": 1`);
    const output = await lineWith(runWith(`{ ${keys.join(", ")} }`));
    const notices = output.tooltip.split("\n").filter((line) => line.startsWith("⚠ "));
    expect(notices).toHaveLength(6);
    expect(notices.slice(0, 5).every((notice) => notice.endsWith("…") && notice.length < 260)).toBe(true);
    expect(notices[5]).toBe("⚠ and 2 more config problems");
  });

  test("paints only the provider it names, with Grok shown beside Claude", async () => {
    const grokLogo = `<span font_family='usage-plugin-icons' size='x-large'>${String.fromCodePoint(0xe901)}</span>`;
    const output = await lineWith(runWith('{ "colors": { "claude": "#D97757" } }', fixtureCase("grok-ok")));
    expect(output.text).toBe(`${ORANGE_LOGO} 34%  ${grokLogo} 41%`);
  });

  test("dims a coloured logo when its provider is stale, and keeps its colour", () => {
    const output = render([missed(NO_NETWORK, readingOf())], "inline", 180, { colors: new Map([[CLAUDE.id, orange()]]) });
    expect(output.text).toBe(dimmed(`${ORANGE_LOGO} ~34%`));
  });

  test("with warning 50 and critical 60 calls 55 percent used, 45 left, a warning", async () => {
    const at55 = caseWith({
      login: LIVE_LOGIN,
      reply: { status: 200, body: { five_hour: { utilization: 55, resets_at: "@now+1410" } } },
    });
    const config = '{ "thresholds": { "warning": 50, "critical": 60 }, "colors": { "claude": "#D97757" } }';
    expect(await lineWith(runWith(config, at55))).toMatchObject({
      text: `${ORANGE_LOGO} 45%`,
      class: ["warning", "claude", "claude-warning"],
      percentage: 45,
    });
  });

  test("with a problem renders on the defaults, and the tooltip leads with the problem and its line", async () => {
    const config = ["{", '  "colors": { "claude": "#D97757" },', '  "thresholds": { "warning": "high" },', "}"].join("\n");
    const output = await lineWith(runWith(config));
    expect(output).toMatchObject({
      text: `${ORANGE_LOGO} 34%`,
      class: ["ok", "config-problem", "claude", "claude-ok"],
      percentage: 34,
    });
    expect(output.tooltip.split("\n").slice(0, 2)).toEqual([
      "⚠ config.jsonc line 3: thresholds.warning must be a number from 0 to 100. Using 75.",
      "<b>Claude</b>",
    ]);
  });

  test("with a problem and no provider to show turns the module broken, so a typo never hides it", async () => {
    const output = await lineWith(runWith('{\n  "colours": {}\n}', caseWith({})));
    expect(output).toEqual({
      text: "⚠",
      tooltip:
        "⚠ config.jsonc line 2: &quot;colours&quot; is not a setting. The settings are providers, colors, thresholds, pollIntervalSeconds, notifications, source, theme and barColors.\nT3 Code isn&apos;t running. Open T3 Code, or set up a provider.",
      class: ["waiting", "t3-closed", "broken", "config-problem"],
      percentage: 0,
    });
  });

  test("leaves a provider switched off out of the fetch, and a split module for it prints empty text at once", async () => {
    const run = runWith('{ "providers": { "claude": false } }');
    const startedAt = performance.now();
    const output = await lineWith(run, { only: CLAUDE.id, layout: "inline" });
    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(output).toEqual({ text: "", tooltip: "", class: [], percentage: 0 });
    expect(requestsIn(run.events)).toEqual([]);
  });

  test("follows the poll interval it sets", async () => {
    const run = runWith('{ "pollIntervalSeconds": 300 }');
    await moduleLine(INLINE, run);
    const later = testRun({ runtimeDir: run.runtimeDir, home: run.home, now: () => secondsAfter(T0, 299) });
    await moduleLine(INLINE, later);
    expect(requestsIn([...run.events, ...later.events])).toHaveLength(1);
  });
});

describe("Grok, from its recorded replies", () => {
  const GROK_LOGO = LOGO.replace(String.fromCodePoint(CLAUDE.glyph), String.fromCodePoint(0xe901));

  function grokAlone(): ModuleRequest {
    const id = "grok";
    if (!isProviderId(id)) throw new Error("grok has no adapter");
    return { only: id, layout: "inline" };
  }

  async function afterGrokOk(fixture: string, request: ModuleRequest, deadlineMs = 2000): Promise<WaybarOutput> {
    const runtimeDir = join(tempDir(), "usage-plugin");
    await moduleLine(INLINE, testRun({ runtimeDir, fixtures: fixtureCase("grok-ok") }));
    const later = testRun({
      runtimeDir,
      fixtures: fixtureCase(fixture),
      now: () => secondsAfter(T0, 180),
      deadline: deadlineFromNow(deadlineMs),
    });
    return JSON.parse(await moduleLine(request, later));
  }

  test("a 401 after a reading is stale, with the grok login hint", async () => {
    const output = await afterGrokOk("grok-401", grokAlone());
    expect(output).toMatchObject({
      text: dimmed(`${GROK_LOGO} ~41%`),
      class: ["ok", "stale", "grok", "grok-ok", "grok-stale"],
      percentage: 41,
    });
    expect(output.tooltip.split("\n").at(-1)).toBe("read 3m ago. login expired, run `grok` to refresh login");
  });

  test("a hang after a reading is stale, and says there was no answer in time", async () => {
    const output = await afterGrokOk("grok-hang", grokAlone(), 400);
    expect(output).toMatchObject({ text: dimmed(`${GROK_LOGO} ~41%`), class: ["ok", "stale", "grok", "grok-ok", "grok-stale"] });
    expect(output.tooltip.split("\n").at(-1)).toBe("read 3m ago. no answer in time");
  });

  test("a combined module with Claude fresh and Grok stale dims only Grok", async () => {
    const output = await afterGrokOk("grok-401", INLINE);
    expect(output).toMatchObject({
      text: `${LOGO} 34%  ${dimmed(`${GROK_LOGO} ~41%`)}`,
      class: ["ok", "stale", "claude", "grok", "claude-ok", "grok-ok", "grok-stale"],
      percentage: 34,
    });
  });
});

describe("renderProblem", () => {
  test("is a visible update that carries the message, escaped", () => {
    expect(renderProblem('unknown argument "<x>"')).toEqual({
      text: "⚠",
      tooltip: "unknown argument &quot;&lt;x&gt;&quot;",
      class: ["broken"],
      percentage: 0,
    });
  });
});

describe("moduleDebug", () => {
  function snapshot(dir: string) {
    return readdirSync(dir).map((name) => [name, statSync(join(dir, name)).mtimeMs, statSync(join(dir, name)).size]);
  }

  test("reports each provider's entry, the line the module would print, and the log's tail", async () => {
    const primed = testRun();
    await readOrFetch({ ...primed, log: journal(primed.runtimeDir) });
    const request = { only: null, layout: "inline" } as const;
    const expected = await moduleLine(request, testRun({ runtimeDir: primed.runtimeDir }));

    const report = moduleDebug(request, testRun({ runtimeDir: primed.runtimeDir }));

    expect(report).toContain(primed.runtimeDir);
    expect(report).toContain(join(fixtureCase("claude-ok"), "home"));
    expect(report).toMatch(/claude\s+read \d+s ago, due in \d+s/);
    expect(report).toContain(expected);
    expect(report).toMatch(/ request provider=claude via=fixture /);
  });

  test("writes nothing, fetches nothing, and logs nothing", async () => {
    const primed = testRun();
    await readOrFetch({ ...primed, log: journal(primed.runtimeDir) });
    const before = snapshot(primed.runtimeDir);

    const due = testRun({ runtimeDir: primed.runtimeDir, now: () => secondsAfter(T0, 3600) });
    moduleDebug({ only: null, layout: "inline" }, due);

    expect(snapshot(primed.runtimeDir)).toEqual(before);
    expect(due.events).toEqual([]);
  });

  test("names the config file and each of its problems", () => {
    const run = testRun();
    writeFileUnder(run.home, ".config/usage-plugin/config.jsonc", '{\n  "colours": {}\n}');
    const report = moduleDebug(INLINE, run);
    expect(report).toContain(`config       ${join(run.home, ".config", "usage-plugin", "config.jsonc")}\n`);
    expect(report).toContain('config.jsonc line 2: "colours" is not a setting.');
  });

  test("does not create a runtime directory that is not there", () => {
    const run = testRun({ runtimeDir: join(tempDir(), "never-created") });
    const report = moduleDebug({ only: null, layout: "inline" }, run);
    expect(report).toMatch(/claude\s+never attempted/);
    expect(existsSync(run.runtimeDir)).toBe(false);
  });

  test("reads a torn cache file as empty and leaves it as it is", () => {
    const run = testRun();
    mkdirSync(run.runtimeDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(run.runtimeDir, "cache.json"), '{"version":1,"provi');
    const report = moduleDebug({ only: CLAUDE.id, layout: "stacked" }, run);
    expect(report).toContain('{"text":"","tooltip":"","class":[],"percentage":0}');
    expect(readFileSync(join(run.runtimeDir, "cache.json"), "utf8")).toBe('{"version":1,"provi');
  });
});

test.each([["claude-ok"], ["claude-429"], ["claude-expired"]])(
  "a %s run leaves no token in the line, the cache, or the log",
  async (name) => {
    const run = testRun({ fixtures: fixtureCase(name) });
    const line = await moduleLine({ only: null, layout: "inline" }, { ...run, log: journal(run.runtimeDir) });
    const written = readdirSync(run.runtimeDir).map((file) => readFileSync(join(run.runtimeDir, file), "utf8"));
    expect(written.length).toBeGreaterThanOrEqual(2);
    expect([line, ...written].join("\n")).not.toMatch(/fixture-(access|refresh)-token/);
  },
);
