import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SETTINGS, loadConfig, parseConfig, policyOf } from "../src/config.ts";
import { DEFAULT_THRESHOLDS } from "../src/domain.ts";
import { makeFifo, percent, tempDir, writeFileUnder } from "./support.ts";

const IDS = ["claude", "grok", "codex"];
const CONFIG_UNDER_HOME = ".config/usage-plugin/config.jsonc";

const parse = (text: string) => parseConfig(text, IDS);
const lines = (...rows: readonly string[]) => rows.join("\n");

describe("loadConfig", () => {
  test("with no file gives the defaults and no problems", () => {
    const home = tempDir();
    expect(loadConfig(join(home, CONFIG_UNDER_HOME))).toEqual({ path: join(home, CONFIG_UNDER_HOME), settings: DEFAULT_SETTINGS, problems: [] });
  });

  test("reads the file under the home", () => {
    const home = tempDir();
    writeFileUnder(home, CONFIG_UNDER_HOME, '{ "notifications": false }');
    expect(loadConfig(join(home, CONFIG_UNDER_HOME)).settings.notifications).toBe(false);
  });

  test("accepts every logo in the registry, with an adapter or reserved, and no other id", () => {
    const home = tempDir();
    writeFileUnder(home, CONFIG_UNDER_HOME, '{ "providers": { "grok": false, "codex": false, "openai": false } }');
    const { settings, problems } = loadConfig(join(home, CONFIG_UNDER_HOME));
    expect(settings.disabled).toEqual(new Set(["grok", "codex"]));
    expect(problems).toEqual([{ line: 1, message: expect.stringContaining("providers.openai names no provider") }]);
  });

  test("with a directory where the file should be gives the defaults and one problem with no line", () => {
    const home = tempDir();
    mkdirSync(join(home, CONFIG_UNDER_HOME), { recursive: true });
    const config = loadConfig(join(home, CONFIG_UNDER_HOME));
    expect(config.settings).toEqual(DEFAULT_SETTINGS);
    expect(config.problems).toEqual([{ line: null, message: "the file is not a regular file. Using the defaults." }]);
  });

  test.each([
    ["a FIFO", (path: string) => makeFifo(path)],
    ["a link to /dev/zero", (path: string) => symlinkSync("/dev/zero", path)],
  ])("with %s where the file should be returns at once with the defaults", (_case, make) => {
    const home = tempDir();
    mkdirSync(join(home, ".config/usage-plugin"), { recursive: true });
    make(join(home, CONFIG_UNDER_HOME));
    const startedAt = performance.now();
    expect(loadConfig(join(home, CONFIG_UNDER_HOME)).problems).toEqual([{ line: null, message: "the file is not a regular file. Using the defaults." }]);
    expect(performance.now() - startedAt).toBeLessThan(100);
  });

  test("with a file over 64 KiB gives the defaults and says why", () => {
    const home = tempDir();
    writeFileUnder(home, CONFIG_UNDER_HOME, `{ "notifications": false, "x": "${"a".repeat(70_000)}" }`);
    expect(loadConfig(join(home, CONFIG_UNDER_HOME))).toMatchObject({
      settings: DEFAULT_SETTINGS,
      problems: [{ line: null, message: "the file is larger than 64 KiB. Using the defaults." }],
    });
  });

  test("follows a link to a regular file", () => {
    const home = tempDir();
    const target = join(tempDir(), "config.jsonc");
    writeFileSync(target, '{ "notifications": false }');
    mkdirSync(join(home, ".config/usage-plugin"), { recursive: true });
    symlinkSync(target, join(home, CONFIG_UNDER_HOME));
    expect(loadConfig(join(home, CONFIG_UNDER_HOME)).settings.notifications).toBe(false);
  });

  test("with a file it may not read gives the defaults and one problem with no line", () => {
    const home = tempDir();
    writeFileUnder(home, CONFIG_UNDER_HOME, '{ "notifications": false }');
    chmodSync(join(home, CONFIG_UNDER_HOME), 0o000);
    const config = loadConfig(join(home, CONFIG_UNDER_HOME));
    expect(config.settings).toEqual(DEFAULT_SETTINGS);
    expect(config.problems).toEqual([{ line: null, message: expect.stringContaining("EACCES") }]);
  });
});

describe("parseConfig", () => {
  test("reads a file with line comments, block comments and trailing commas like plain JSON", () => {
    const commented = lines(
      "// usage-plugin",
      "{",
      "  /* switched off",
      "     until it ships */",
      '  "providers": { "grok": false, }, // trailing comma',
      '  "colors": { "claude": "#D97757" },',
      '  "thresholds": { "warning": 70, "critical": 85, },',
      '  "pollIntervalSeconds": 120,',
      '  "notifications": false,',
      "}",
    );
    const plain = JSON.stringify({
      providers: { grok: false },
      colors: { claude: "#D97757" },
      thresholds: { warning: 70, critical: 85 },
      pollIntervalSeconds: 120,
      notifications: false,
    });
    expect(parse(commented)).toEqual(parse(plain));
    const { settings, problems } = parse(plain);
    expect(problems).toEqual([]);
    expect([...settings.disabled]).toEqual(["grok"]);
    expect<ReadonlyMap<string, string>>(settings.colors).toEqual(new Map([["claude", "#D97757"]]));
    expect(settings).toMatchObject({ thresholds: { warning: 70, critical: 85 }, pollIntervalSeconds: 120, notifications: false });
  });

  test("reports an invalid threshold with its line, and keeps the other settings", () => {
    const { settings, problems } = parse(
      lines("{", '  "notifications": false,', '  "thresholds": {', '    "warning": 150,', '    "critical": 95', "  }", "}"),
    );
    expect(problems).toEqual([{ line: 4, message: "thresholds.warning must be a number from 0 to 100. Using 75." }]);
    expect(settings.thresholds).toEqual({ warning: DEFAULT_THRESHOLDS.warning, critical: percent(95) });
    expect(settings.notifications).toBe(false);
  });

  test("keeps a valid critical when warning is invalid, and names only warning", () => {
    const { settings, problems } = parse(lines("{", '  "thresholds": {', '    "warning": "fifty",', '    "critical": 60', "  }", "}"));
    expect(settings.thresholds).toEqual({ warning: percent(60), critical: percent(60) });
    expect(problems).toEqual([{ line: 3, message: "thresholds.warning must be a number from 0 to 100. Using 60." }]);
  });

  test("keeps a valid warning when critical is invalid, and names only critical", () => {
    const { settings, problems } = parse(lines("{", '  "thresholds": { "warning": 95, "critical": true }', "}"));
    expect(settings.thresholds).toEqual({ warning: percent(95), critical: percent(95) });
    expect(problems).toEqual([{ line: 2, message: "thresholds.critical must be a number from 0 to 100. Using 95." }]);
  });

  test("with only a critical below the default warning moves warning down to it, with no problem", () => {
    const { settings, problems } = parse('{ "thresholds": { "critical": 60 } }');
    expect(settings.thresholds).toEqual({ warning: percent(60), critical: percent(60) });
    expect(problems).toEqual([]);
  });

  test("calls settings nested too deeply a syntax error, and ignores the file", () => {
    const { settings, problems } = parse(`{ "x": ${"[".repeat(200_000)}${"]".repeat(200_000)} }`);
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(problems).toEqual([{ line: 1, message: expect.stringContaining("nested more than") }]);
  });

  test("reports a warning above critical, and uses both defaults", () => {
    const { settings, problems } = parse(lines("{", '  "thresholds": { "warning": 95, "critical": 80 }', "}"));
    expect(settings.thresholds).toEqual(DEFAULT_THRESHOLDS);
    expect(problems).toEqual([{ line: 2, message: expect.stringContaining("Using 75 and 90") }]);
  });

  test("reports a syntax error with its line, and ignores the whole file", () => {
    const { settings, problems } = parse(lines("{", '  "notifications": false,', '  "pollIntervalSeconds": soon', "}"));
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(problems).toEqual([{ line: 3, message: expect.stringContaining("The whole file is ignored") }]);
  });

  test("calls text after the settings a syntax error", () => {
    const { settings, problems } = parse(lines('{ "notifications": false }', "x"));
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(problems).toEqual([{ line: 2, message: expect.stringContaining("text after the end") }]);
  });

  test("calls a name that appears twice a syntax error", () => {
    const { settings, problems } = parse(lines("{", '  "notifications": false,', '  "notifications": true', "}"));
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(problems).toEqual([{ line: 3, message: expect.stringContaining("appears twice") }]);
  });

  test("reports an unknown key with its line", () => {
    const { settings, problems } = parse(lines("{", '  "notifications": false,', '  "colours": {}', "}"));
    expect(settings.notifications).toBe(false);
    expect(problems).toEqual([{ line: 3, message: expect.stringContaining('"colours" is not a setting') }]);
  });

  test("colours the bar by default, and reports a barColors that is not true or false", () => {
    expect(parse("{}").settings.barColors).toBe(true);
    expect(parse('{ "barColors": false }').settings.barColors).toBe(false);
    const { settings, problems } = parse(lines("{", '  "barColors": "white"', "}"));
    expect(settings.barColors).toBe(true);
    expect(problems).toEqual([{ line: 2, message: expect.stringContaining("barColors must be true or false") }]);
  });

  test("reports a colour that is not hex, and that logo keeps the CSS colour", () => {
    const { settings, problems } = parse(lines("{", '  "colors": {', '    "claude": "orange",', '    "grok": "#fff"', "  }", "}"));
    expect<ReadonlyMap<string, string>>(settings.colors).toEqual(new Map([["grok", "#fff"]]));
    expect(problems).toEqual([{ line: 3, message: expect.stringContaining("colors.claude") }]);
  });

  test("reports a provider id that names no logo, and accepts a logo that has no adapter yet", () => {
    const { settings, problems } = parse(lines("{", '  "providers": {', '    "openai": false,', '    "codex": false', "  }", "}"));
    expect(settings.disabled).toEqual(new Set(["codex"]));
    expect(problems).toEqual([{ line: 3, message: "providers.openai names no provider. The providers are claude, grok, codex." }]);
  });

  test.each([[59], [30], [3601], [90.5]])("reports a poll interval of %p, and polls every 60 seconds", (seconds) => {
    const { settings, problems } = parse(`{ "pollIntervalSeconds": ${seconds} }`);
    expect(settings.pollIntervalSeconds).toBe(60);
    expect(problems).toEqual([{ line: 1, message: "pollIntervalSeconds must be a whole number from 60 to 3600. Using 60." }]);
  });

  test("calls a file that is not one object a problem, and ignores it", () => {
    expect(parse("[]")).toEqual({ settings: DEFAULT_SETTINGS, problems: [{ line: 1, message: expect.any(String) }] });
  });
});

describe("policyOf", () => {
  test("polls at the configured interval", () => {
    expect(policyOf({ ...DEFAULT_SETTINGS, pollIntervalSeconds: 300 }).pollIntervalSeconds).toBe(300);
  });
});
