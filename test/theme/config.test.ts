import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS, parseConfig } from "../../src/config.ts";

const LOGOS = ["claude", "grok"];

describe("the theme setting", () => {
  test("follows T3 Code unless the config says otherwise", () => {
    expect(DEFAULT_SETTINGS.theme).toBe("t3");
    expect(parseConfig("{}", LOGOS).settings.theme).toBe("t3");
  });

  test("takes waybar and none", () => {
    expect(parseConfig('{ "theme": "waybar" }', LOGOS)).toEqual({ settings: { ...DEFAULT_SETTINGS, theme: "waybar" }, problems: [] });
    expect(parseConfig('{ "theme": "none" }', LOGOS).settings.theme).toBe("none");
  });

  test("names the choices and keeps following T3 for anything else", () => {
    for (const value of ['"grove"', '"T3"', "true", "null"]) {
      expect(parseConfig(`{\n  "theme": ${value}\n}`, LOGOS)).toEqual({
        settings: DEFAULT_SETTINGS,
        problems: [{ line: 2, message: "theme must be one of t3, waybar, none. Using t3." }],
      });
    }
  });
});
