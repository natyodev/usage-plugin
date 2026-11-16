import { describe, expect, test } from "bun:test";
import { moduleDebug, moduleLine } from "../../src/render/module.ts";
import type { ModuleRequest, WaybarOutput } from "../../src/render/module.ts";
import { adapters } from "../../src/providers/index.ts";
import { t3ProfileFrom } from "../../src/theme/profile.ts";
import type { T3Profile } from "../../src/theme/profile.ts";
import { CLAUDE, fixtureCase, GROK, testRun, writeFileUnder } from "../support.ts";
import type { TestRun } from "../support.ts";

const INLINE: ModuleRequest = { only: null, layout: "inline" };
const GROVE_DARK = { accent: "#69d69a", warning: "#fe9a00", critical: "#ff454d" };

function profile(name: string): T3Profile {
  return t3ProfileFrom({ USAGE_PLUGIN_T3_PROFILE: fixtureCase(name) });
}

function runWith(fixtures: string, config = "{}"): TestRun {
  const run = testRun({ fixtures: fixtureCase(fixtures) });
  writeFileUnder(run.home, ".config/usage-plugin/config.jsonc", config);
  return run;
}

async function line(run: TestRun, t3: T3Profile | null): Promise<WaybarOutput> {
  return JSON.parse(await moduleLine(INLINE, run, adapters, t3));
}

function logo(glyph: number, color?: string): string {
  const paint = color === undefined ? "" : ` foreground='${color}'`;
  return `<span font_family='usage-plugin-icons' size='x-large'${paint}>${String.fromCodePoint(glyph)}</span>`;
}

describe("the module under theme t3", () => {
  test("paints each logo in the theme's accent and leaves an ok percent in the bar's own colour", async () => {
    expect((await line(runWith("claude-ok"), profile("t3-theme-grove-dark"))).text).toBe(`${logo(CLAUDE.glyph, GROVE_DARK.accent)} 34%`);
  });

  test("colours the percent with the theme's warning and critical colours at those levels", async () => {
    expect((await line(runWith("claude-80"), profile("t3-theme-grove-dark"))).text).toBe(
      `${logo(CLAUDE.glyph, GROVE_DARK.accent)} <span foreground='${GROVE_DARK.warning}'>20%</span>`,
    );
    expect((await line(runWith("claude-95"), profile("t3-theme-grove-dark"))).text).toBe(
      `${logo(CLAUDE.glyph, GROVE_DARK.accent)} <span foreground='${GROVE_DARK.critical}'>5%</span>`,
    );
  });

  test("a colors entry wins over the theme for its logo only", async () => {
    const output = await line(runWith("grok-ok", '{ "colors": { "claude": "#D97757" } }'), profile("t3-theme-grove-dark"));
    expect(output.text).toContain(logo(CLAUDE.glyph, "#D97757"));
    expect(output.text).toContain(logo(GROK.glyph, GROVE_DARK.accent));
  });

  test("follows another theme on the next run", async () => {
    const run = runWith("claude-ok");
    expect((await line(run, profile("t3-theme-grove-dark"))).text).toContain("#69d69a");
    expect((await line(run, profile("t3-theme-iris-dark"))).text).toContain("#9d7df2");
  });

  test("falls back to today's output when T3's theme cannot be read", async () => {
    const today = await line(runWith("claude-80"), null);
    expect(await line(runWith("claude-80"), profile("t3-theme-corrupt"))).toEqual(today);
    expect(await line(runWith("claude-80"), profile("t3-theme-unknown-version"))).toEqual(today);
  });
});

describe("theme waybar and none", () => {
  for (const mode of ["waybar", "none"]) {
    test(`${mode} keeps the module's output exactly as it is without T3, even when T3 can be read`, async () => {
      for (const fixtures of ["claude-ok", "claude-80", "claude-95", "grok-ok"]) {
        const today = await line(runWith(fixtures), null);
        const themed = await line(runWith(fixtures, `{ "theme": "${mode}" }`), profile("t3-theme-grove-dark"));
        expect(themed).toEqual(today);
        expect(themed.text).not.toContain("foreground");
      }
    });
  }
});

describe("barColors false", () => {
  test("leaves every logo and percent in the bar's own colour, whatever the theme or colors say", async () => {
    for (const fixtures of ["claude-ok", "claude-80", "claude-95", "grok-ok"]) {
      const plain = await line(
        runWith(fixtures, '{ "barColors": false, "colors": { "claude": "#D97757" } }'),
        profile("t3-theme-grove-dark"),
      );
      expect(plain.text).not.toContain("foreground");
    }
  });

  test("keeps the level classes, so the bar's CSS can still tell warning from ok", async () => {
    const plain = await line(runWith("claude-95", '{ "barColors": false }'), profile("t3-theme-grove-dark"));
    expect(plain.class).toContain("critical");
  });
});

describe("debug.log", () => {
  test("says why the module fell back, naming the version, once per change", async () => {
    const run = runWith("claude-ok");
    await line(run, profile("t3-theme-unknown-version"));
    await line(run, profile("t3-theme-unknown-version"));
    expect(run.events.filter((event) => event.event === "theme")).toEqual([
      { event: "theme", theme: "Waybar colours, because T3 Code 0.2.0 has no pinned palette" },
    ]);
  });
});

describe("module --debug", () => {
  test("names the theme it painted with, or why it fell back", () => {
    expect(moduleDebug(INLINE, runWith("claude-ok"), profile("t3-theme-grove-dark"))).toContain(
      `theme        T3 Code grove dark, palettes of 0.1.9 (${fixtureCase("t3-theme-grove-dark")}/app.asar)`,
    );
    expect(moduleDebug(INLINE, runWith("claude-ok"), profile("t3-theme-unknown-version"))).toContain(
      "theme        Waybar colours, because T3 Code 0.2.0 has no pinned palette",
    );
    expect(moduleDebug(INLINE, runWith("claude-ok", '{ "theme": "none" }'), profile("t3-theme-grove-dark"))).toContain(
      "theme        none, the config sets theme to none",
    );
  });
});
