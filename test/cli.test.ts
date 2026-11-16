import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  cpSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { version } from "../package.json";
import { applyOutcome, DEFAULT_POLICY, encodeCacheFile } from "../src/cache.ts";
import { parseArgs } from "../src/cli.ts";
import { DIRECT, instant } from "../src/domain.ts";
import { CLAUDE, fixtureCase, makeFifo, tempDir, window, writeFileUnder } from "./support.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const LOGO = "<span font_family='usage-plugin-icons' size='x-large'></span>";
const HUNG_AFTER_MS = 3000;

function laneEnv(fixture: string, xdgRuntimeDir = tempDir()) {
  return {
    HOME: join(tempDir(), "no-home"),
    USAGE_PLUGIN_FIXTURES: fixtureCase(fixture),
    XDG_RUNTIME_DIR: xdgRuntimeDir,
    DBUS_SESSION_BUS_ADDRESS: deadSessionBus(),
  };
}

function deadSessionBus(): string {
  const address = process.env.DBUS_SESSION_BUS_ADDRESS;
  if (address === undefined || !address.includes("/nonexistent/")) {
    throw new Error("the test preload must point the session bus at a socket that does not exist");
  }
  return address;
}

async function cli(args: readonly string[], env: Readonly<Record<string, string>> = laneEnv("claude-ok")) {
  const startedAt = performance.now();
  const proc = Bun.spawn([process.execPath, CLI, ...args], { env, stdout: "pipe", stderr: "pipe", timeout: HUNG_AFTER_MS });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode, tookMs: performance.now() - startedAt };
}

function onlyLine(stdout: string) {
  expect(stdout.endsWith("\n")).toBe(true);
  const lines = stdout.trimEnd().split("\n");
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] ?? "");
}

describe("parseArgs", () => {
  test("--version", () => {
    expect(parseArgs(["--version"])).toEqual({ kind: "version" });
  });

  test("module defaults to every provider in the inline layout", () => {
    expect(parseArgs(["module"])).toEqual({ kind: "module", request: { only: null, layout: "inline" } });
  });

  test("module takes a provider and a layout in any order", () => {
    const request = { only: CLAUDE.id, layout: "stacked" } as const;
    expect(parseArgs(["module", "--provider", "claude", "--layout", "stacked"])).toEqual({ kind: "module", request });
    expect(parseArgs(["module", "--layout", "stacked", "--provider", "claude"])).toEqual({ kind: "module", request });
  });

  test("module --debug asks for the report", () => {
    expect(parseArgs(["module", "--debug", "--provider", "claude"])).toEqual({
      kind: "moduleDebug",
      request: { only: CLAUDE.id, layout: "inline" },
    });
  });

  test.each([
    [["module", "--provider", "nope"]],
    [["module", "--provider"]],
    [["module", "--layout", "diagonal"]],
    [["module", "--layout"]],
    [["module", "--frobnicate"]],
    [["module", "claude"]],
    [["module", "--provider=claude"]],
  ])("%j is a usage error that Waybar will read", (argv) => {
    expect(parseArgs(argv)).toMatchObject({ kind: "usageError", forWaybar: true });
  });

  test("an unknown provider is answered with the ids that exist", () => {
    expect(parseArgs(["module", "--provider", "nope"])).toMatchObject({ message: expect.stringContaining("claude") });
  });

  test.each([[[]], [["widget"]], [["--version", "extra"]], [["--help"]]])(
    "%j is a usage error for a person at a terminal",
    (argv) => {
      expect(parseArgs(argv)).toMatchObject({ kind: "usageError", forWaybar: false });
    },
  );
});

describe("usage-plugin", () => {
  test("--version prints the package version", async () => {
    expect(await cli(["--version"])).toMatchObject({ stdout: `${version}\n`, exitCode: 0 });
  });

  test("with no command prints usage to stderr and exits 2", async () => {
    const result = await cli([]);
    expect(result).toMatchObject({ stdout: "", exitCode: 2 });
    expect(result.stderr).toContain("usage-plugin module");
  });
});

describe("usage-plugin module", () => {
  test("prints one JSON line for claude-ok and exits 0", async () => {
    const result = await cli(["module"]);
    expect(result.exitCode).toBe(0);
    expect(onlyLine(result.stdout)).toEqual({
      text: `${LOGO} 34%`,
      tooltip: [
        "<b>Claude</b>",
        "<tt>5-hour ███░░░░░░░  34% left</tt>  resets in 23m",
        "<tt>Weekly █████████░  88% left</tt>  resets in 3d 6h",
        "direct",
      ].join("\n"),
      class: ["ok", "claude", "claude-ok"],
      percentage: 34,
    });
  });

  test("--layout stacked puts the logo above the percent", async () => {
    const result = await cli(["module", "--layout", "stacked"]);
    expect(onlyLine(result.stdout).text).toBe(`${LOGO}\n34%`);
  });

  test("--provider claude prints Claude alone", async () => {
    const result = await cli(["module", "--provider", "claude"]);
    expect(onlyLine(result.stdout)).toMatchObject({ text: `${LOGO} 34%`, class: ["ok", "claude", "claude-ok"] });
  });

  test.each([
    ["claude-80", "warning", 20],
    ["claude-95", "critical", 5],
  ])("%s carries class %s", async (fixture, level, percentage) => {
    const result = await cli(["module"], laneEnv(fixture));
    expect(onlyLine(result.stdout)).toMatchObject({ class: [level, "claude", `claude-${level}`], percentage });
  });

  test.each([[["module", "--frobnicate"]], [["module", "--provider", "nope"]]])(
    "%j still prints one JSON line and exits 0, so the bar shows the problem",
    async (argv) => {
      const result = await cli(argv);
      expect(result.exitCode).toBe(0);
      expect(onlyLine(result.stdout)).toMatchObject({ text: "⚠", class: ["broken"] });
      expect(result.stderr).not.toBe("");
    },
  );

  test("gives a provider that hangs its whole 750 ms budget, and still prints inside one second", async () => {
    const result = await cli(["module"], laneEnv("claude-hang"));
    expect(result.exitCode).toBe(0);
    expect(onlyLine(result.stdout)).toMatchObject({
      text: `<span fgalpha='50%'>${LOGO} –</span>`,
      tooltip: "<b>Claude</b>\nno reading yet. no answer in time",
      class: ["waiting", "claude", "claude-waiting"],
    });
    expect(result.tookMs).toBeGreaterThanOrEqual(750);
    expect(result.tookMs).toBeLessThan(1000);
  });

  test("three modules started together against an empty cache make exactly one request", async () => {
    const xdgRuntimeDir = tempDir();
    const env = laneEnv("claude-ok", xdgRuntimeDir);
    const results = await Promise.all([
      cli(["module"], env),
      cli(["module", "--provider", "claude"], env),
      cli(["module", "--provider", "claude", "--layout", "stacked"], env),
    ]);

    for (const result of results) expect(onlyLine(result.stdout)).toMatchObject({ percentage: 34 });
    const log = readFileSync(join(xdgRuntimeDir, "usage-plugin", "debug.log"), "utf8");
    expect(log.split("\n").filter((line) => line.includes(" request "))).toHaveLength(1);
  });

  test("a second run inside the poll interval reads the cache and logs nothing", async () => {
    const xdgRuntimeDir = tempDir();
    const env = laneEnv("claude-ok", xdgRuntimeDir);
    const first = await cli(["module"], env);
    const logPath = join(xdgRuntimeDir, "usage-plugin", "debug.log");
    const logAfterFirst = readFileSync(logPath, "utf8");

    const second = await cli(["module"], env);

    expect(onlyLine(second.stdout)).toMatchObject({ percentage: 34 });
    expect(onlyLine(second.stdout).text).toBe(onlyLine(first.stdout).text);
    expect(readFileSync(logPath, "utf8")).toBe(logAfterFirst);
  });
});

describe("usage-plugin module with a config file under HOME", () => {
  function envWithConfig(config: string) {
    const env = laneEnv("claude-ok");
    writeFileUnder(env.HOME, ".config/usage-plugin/config.jsonc", config);
    return env;
  }

  test("reads it", async () => {
    const result = await cli(["module"], envWithConfig('{ "thresholds": { "warning": 50 } }'));
    expect(onlyLine(result.stdout)).toMatchObject({ class: ["warning", "claude", "claude-warning"], percentage: 34 });
  });

  test("that is invalid still prints the percent on the defaults, and names the config line in the tooltip", async () => {
    const result = await cli(["module"], envWithConfig('{\n  "thresholds": { "critical": "lots" }\n}'));
    expect(result.exitCode).toBe(0);
    const line = onlyLine(result.stdout);
    expect(line).toMatchObject({
      text: `${LOGO} 34%`,
      class: ["ok", "config-problem", "claude", "claude-ok"],
      percentage: 34,
    });
    expect(line.tooltip).toStartWith("⚠ config.jsonc line 2: thresholds.critical must be a number from 0 to 100. Using 90.\n");
  });
});

describe("usage-plugin module at the critical threshold", () => {
  function fakeGdbus(then: (dir: string) => string = () => "") {
    const dir = tempDir();
    const calls = join(dir, "calls");
    writeFileSync(join(dir, "gdbus"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\n${then(dir)}`);
    chmodSync(join(dir, "gdbus"), 0o755);
    return {
      path: dir,
      dir,
      calls: () => (existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean) : []),
    };
  }

  function makeEveryProviderDue(xdgRuntimeDir: string) {
    const path = join(xdgRuntimeDir, "usage-plugin", "cache.json");
    const file = JSON.parse(readFileSync(path, "utf8"));
    for (const entry of Object.values(file.providers)) Object.assign(Object(entry), { dueAt: "2026-01-01T00:00:00.000Z" });
    writeFileSync(path, JSON.stringify(file));
  }

  async function threePolls(fixtures: string, config: string | null = null, gdbus = fakeGdbus()) {
    const xdgRuntimeDir = tempDir();
    const env = { ...laneEnv("claude-ok", xdgRuntimeDir), USAGE_PLUGIN_FIXTURES: fixtures, PATH: gdbus.path };
    if (config !== null) writeFileUnder(env.HOME, ".config/usage-plugin/config.jsonc", config);
    for (let poll = 0; poll < 3; poll += 1) {
      expect((await cli(["module"], env)).exitCode).toBe(0);
      makeEveryProviderDue(xdgRuntimeDir);
    }
    const log = readFileSync(join(xdgRuntimeDir, "usage-plugin", "debug.log"), "utf8").split("\n");
    return { calls: gdbus.calls(), log };
  }

  test.each([
    ["claude-95", "claude", "Claude: 5% left", "5 hour"],
    ["grok-92", "grok", "Grok: 8% left", "Weekly"],
  ])("%s across three polls runs gdbus exactly once", async (fixture, provider, summary, label) => {
    const { calls, log } = await threePolls(fixtureCase(fixture));
    expect(log.filter((line) => line.includes(` request provider=${provider} `))).toHaveLength(3);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(`'${summary}'`);
    expect(log.filter((line) => line.includes(" alert "))).toEqual([
      expect.stringContaining(`alert provider=${provider} window="${label}" sent=true`),
    ]);
  });

  test("with notifications off in the config never runs gdbus", async () => {
    const { calls, log } = await threePolls(fixtureCase("claude-95"), '{ "notifications": false }');
    expect(log.filter((line) => line.includes(" request provider=claude "))).toHaveLength(3);
    expect(calls).toEqual([]);
  });

  const alertLines = (log: readonly string[]) => log.filter((line) => line.includes(" alert "));

  test("still sends the alert when another provider hangs past the run's budget", async () => {
    const fixtures = tempDir();
    cpSync(fixtureCase("grok-hang"), fixtures, { recursive: true });
    cpSync(join(fixtureCase("claude-95"), "claude.json"), join(fixtures, "claude.json"));
    const { calls, log } = await threePolls(fixtures);
    expect(calls).toHaveLength(1);
    expect(alertLines(log)).toEqual([expect.stringContaining('alert provider=claude window="5 hour" sent=true')]);
  });

  test("tries a send that failed again on the next poll, and only then", async () => {
    const gdbus = fakeGdbus(
      (dir) => `[ -e '${dir}/failed' ] && exit 0\n: > '${dir}/failed'\necho 'no notification server' >&2\nexit 1\n`,
    );
    const { calls, log } = await threePolls(fixtureCase("claude-95"), null, gdbus);
    expect(calls).toHaveLength(2);
    expect(alertLines(log)).toEqual([
      expect.stringContaining('alert provider=claude window="5 hour" sent=false detail="gdbus exited 1: no notification server"'),
      expect.stringContaining('alert provider=claude window="5 hour" sent=true'),
    ]);
  });

  test("sends with the cache lock free, so no other module waits on the bus", async () => {
    const gdbus = fakeGdbus(
      (dir) => `/bin/flock -n "$XDG_RUNTIME_DIR/usage-plugin/cache.lock" /bin/true && echo free >> '${dir}/lock' || echo held >> '${dir}/lock'\n`,
    );
    await threePolls(fixtureCase("claude-95"), null, gdbus);
    expect(readFileSync(join(gdbus.dir, "lock"), "utf8")).toBe("free\n");
  });
});

describe("usage-plugin module with a runtime directory that is not private", () => {
  const linked = (path: string) => {
    const target = tempDir();
    symlinkSync(target, path);
    return target;
  };
  const openToEveryone = (path: string) => {
    mkdirSync(path);
    chmodSync(path, 0o777);
    return path;
  };

  test.each([
    ["a symlink", ["module"], linked],
    ["open to everyone", ["module"], openToEveryone],
    ["a symlink", ["module", "--debug"], linked],
  ])("that is %s: %j prints one line that names it, exits 0, and puts nothing in it", async (_case, argv, make) => {
    const xdgRuntimeDir = tempDir();
    const runtimeDir = join(xdgRuntimeDir, "usage-plugin");
    const contents = make(runtimeDir);

    const result = await cli(argv, laneEnv("claude-ok", xdgRuntimeDir));

    expect(result.exitCode).toBe(0);
    expect(onlyLine(result.stdout)).toMatchObject({ text: "⚠", tooltip: expect.stringContaining(runtimeDir) });
    expect(readdirSync(contents)).toEqual([]);
  });
});

describe("usage-plugin module beside a file it cannot trust", () => {
  function runtimeDirWithFifo(name: string) {
    const xdgRuntimeDir = tempDir();
    mkdirSync(join(xdgRuntimeDir, "usage-plugin"), { mode: 0o700 });
    const fifo = join(xdgRuntimeDir, "usage-plugin", name);
    makeFifo(fifo);
    return { xdgRuntimeDir, fifo };
  }

  test.each([["cache.json"], ["debug.log"]])("still prints its line in time when %s is a FIFO", async (name) => {
    const { xdgRuntimeDir } = runtimeDirWithFifo(name);

    const result = await cli(["module"], laneEnv("claude-ok", xdgRuntimeDir));

    expect(result.exitCode).toBe(0);
    expect(onlyLine(result.stdout)).toMatchObject({ percentage: 34 });
    expect(result.tookMs).toBeLessThan(1000);
  });

  test("does not show a reading that someone feeds it through a FIFO at cache.json", async () => {
    const { xdgRuntimeDir, fifo } = runtimeDirWithFifo("cache.json");
    const now = instant(Date.now());
    const reading = { provider: CLAUDE.id, plan: null, windows: [window("planted", 5)], takenAt: now, via: DIRECT } as const;
    const planted = applyOutcome(undefined, { kind: "reading", reading }, now, DEFAULT_POLICY);
    const feeder = openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK);
    writeSync(feeder, encodeCacheFile({ entries: new Map([[CLAUDE.id, planted]]), unknownProviders: new Map() }));

    const result = await cli(["module"], laneEnv("claude-ok", xdgRuntimeDir));
    closeSync(feeder);

    expect(result.exitCode).toBe(0);
    expect(onlyLine(result.stdout)).toMatchObject({ percentage: 34 });
  });
});

describe("usage-plugin module with USAGE_PLUGIN_FIXTURES set to nothing", () => {
  test.each([[["module"]], [["module", "--debug"]]])("%j says so and does not run live", async (argv) => {
    const result = await cli(argv, { ...laneEnv("claude-ok"), USAGE_PLUGIN_FIXTURES: "" });
    expect(result.exitCode).toBe(0);
    expect(onlyLine(result.stdout)).toMatchObject({
      text: "⚠",
      tooltip: expect.stringContaining("USAGE_PLUGIN_FIXTURES"),
    });
  });
});

describe("usage-plugin module with USAGE_PLUGIN_FIXTURES set to a path that does not exist", () => {
  test("shows broken with the path, exits 0, and does not run live", async () => {
    const missing = join(tempDir(), "claude-okk");
    const result = await cli(["module"], { ...laneEnv("claude-ok"), USAGE_PLUGIN_FIXTURES: missing });
    expect(result.exitCode).toBe(0);
    expect(onlyLine(result.stdout)).toMatchObject({
      text: "⚠",
      tooltip: expect.stringContaining(missing),
      class: ["broken"],
    });
  });
});

describe("usage-plugin module --debug with USAGE_PLUGIN_FIXTURES naming a file", () => {
  test("shows broken with the path instead of a report of no logins", async () => {
    const file = join(fixtureCase("claude-ok"), "claude.json");
    const result = await cli(["module", "--debug"], { ...laneEnv("claude-ok"), USAGE_PLUGIN_FIXTURES: file });
    expect(onlyLine(result.stdout)).toMatchObject({ text: "⚠", tooltip: expect.stringContaining(file), class: ["broken"] });
  });
});

describe("usage-plugin module --debug names the config file", () => {
  test("under XDG_CONFIG_HOME when it is set, and under HOME otherwise", async () => {
    const configHome = tempDir();
    const withXdg = await cli(["module", "--debug"], { ...laneEnv("claude-ok"), XDG_CONFIG_HOME: configHome });
    expect(withXdg.stdout).toContain(`config       ${configHome}/usage-plugin/config.jsonc\n`);
    const env = laneEnv("claude-ok");
    const withoutXdg = await cli(["module", "--debug"], env);
    expect(withoutXdg.stdout).toContain(`config       ${env.HOME}/.config/usage-plugin/config.jsonc\n`);
  });
});

describe("usage-plugin module --debug", () => {
  test("writes nothing on an empty runtime directory", async () => {
    const xdgRuntimeDir = tempDir();
    const result = await cli(["module", "--debug"], laneEnv("claude-ok", xdgRuntimeDir));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("never attempted");
    expect(readdirSync(xdgRuntimeDir)).toEqual([]);
  });

  test("writes nothing beside a cache that is due", async () => {
    const xdgRuntimeDir = tempDir();
    await cli(["module"], laneEnv("claude-429", xdgRuntimeDir));
    const dir = join(xdgRuntimeDir, "usage-plugin");
    const snapshot = () => readdirSync(dir).map((name) => [name, statSync(join(dir, name)).mtimeMs, statSync(join(dir, name)).size]);
    const before = snapshot();

    const result = await cli(["module", "--debug"], laneEnv("claude-ok", xdgRuntimeDir));

    expect(result.stdout).toMatch(/claude\s+missed \d+s ago \(rateLimited, 1 in a row\), no reading kept, due in \d+s/);
    expect(snapshot()).toEqual(before);
    expect(existsSync(join(dir, "cache.json"))).toBe(true);
  });
});
