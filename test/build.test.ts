import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scripts } from "../package.json";
import { tempDir } from "./support.ts";

const ROOT = join(import.meta.dir, "..");
const SHIPPED_PATH = "dist/usage-plugin";
const BUILD_TIMEOUT_MS = 120_000;

describe("the binary that `bun run build:bin` compiles", () => {
  const binary = join(tempDir(), "usage-plugin");

  beforeAll(() => {
    const [bun, ...args] = scripts["build:bin"].replace(SHIPPED_PATH, binary).split(" ");
    if (bun !== "bun" || !args.includes(binary)) throw new Error(`the build script no longer compiles ${SHIPPED_PATH}`);

    const built = Bun.spawnSync([process.execPath, ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    if (built.exitCode !== 0) throw new Error(`the build exited ${built.exitCode}: ${built.stderr.toString()}`);
  }, BUILD_TIMEOUT_MS);

  afterAll(() => rmSync(binary, { force: true }));

  async function runFrom(cwd: string, args: readonly string[]) {
    const env = { HOME: join(tempDir(), "no-home"), XDG_RUNTIME_DIR: tempDir() };
    const proc = Bun.spawn([binary, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  function cwdThatTriesToConfigureIt(): string {
    const cwd = tempDir();
    writeFileSync(join(cwd, ".env"), "USAGE_PLUGIN_FIXTURES=/nowhere\n");
    writeFileSync(join(cwd, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
    writeFileSync(join(cwd, "preload.ts"), 'console.log("a line from the preload");\n');
    return cwd;
  }

  test("does not load a .env from the directory it is started in", async () => {
    const debug = await runFrom(cwdThatTriesToConfigureIt(), ["module", "--debug"]);
    expect(debug.stdout).toContain("fixtures     none");
    expect(debug.stdout).not.toContain("/nowhere");
  });

  test("does not run a preload from a bunfig.toml in the directory it is started in", async () => {
    const module = await runFrom(cwdThatTriesToConfigureIt(), ["module"]);
    expect(module).toMatchObject({ stderr: "", exitCode: 0 });
    expect(JSON.parse(module.stdout).class).toEqual(["waiting", "t3-closed"]);
  });
});
