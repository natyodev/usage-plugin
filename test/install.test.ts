import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "./support.ts";

const ROOT = join(import.meta.dir, "..");
const SHIPPED = ["install.sh", "npm/usage-plugin/package.json", "npm/usage-plugin/bin/usage-plugin.js"];

function builtCheckout(withHoverModule: boolean): string {
  const repo = tempDir();
  for (const file of SHIPPED) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    copyFileSync(join(ROOT, file), join(repo, file));
  }
  mkdirSync(join(repo, "dist"));
  writeFileSync(join(repo, "dist", "usage-plugin"), "#!/bin/sh\necho 0.1.0\n");
  chmodSync(join(repo, "dist", "usage-plugin"), 0o755);
  writeFileSync(join(repo, "dist", "widget.js"), "// widget\n");
  writeFileSync(join(repo, "dist", "usage-plugin-icons.ttf"), "font");
  if (withHoverModule) writeFileSync(join(repo, "dist", "usage-plugin-cffi.so"), "module");
  return repo;
}

function install(repo: string, home: string, path = process.env.PATH ?? "") {
  const run = Bun.spawnSync(["/bin/sh", join(repo, "install.sh")], {
    env: { HOME: home, PATH: path },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

function snapshotWithMtimes(root: string, under = ""): string[] {
  return readdirSync(join(root, under)).flatMap((name) => {
    const path = join(under, name);
    const stats = lstatSync(join(root, path));
    if (stats.isDirectory()) return snapshotWithMtimes(root, path);
    const body = stats.isSymbolicLink() ? `-> ${readlinkSync(join(root, path))}` : readFileSync(join(root, path), "utf8");
    return [`${path} ${stats.mtimeMs} ${body}`];
  });
}

test("a second run changes no file and nothing goes under .config/waybar", () => {
  const repo = builtCheckout(true);
  const home = tempDir();

  const first = install(repo, home);
  expect(first.exitCode, first.stderr).toBe(0);
  const after = snapshotWithMtimes(home);
  const second = install(repo, home);
  expect(second.exitCode, second.stderr).toBe(0);

  expect(snapshotWithMtimes(home)).toEqual(after);
  expect(after.some((line) => line.startsWith(".config/waybar"))).toBe(false);
  expect(readlinkSync(join(home, ".local/bin/usage-plugin"))).toBe(join(home, ".local/share/usage-plugin/usage-plugin"));
  expect(second.stdout).toContain("already installed");
});

test("prints a hover module block with the installed paths", () => {
  const repo = builtCheckout(true);
  const home = tempDir();
  const { stdout } = install(repo, home);
  expect(stdout).toContain(`"module_path": "${home}/.local/share/usage-plugin/usage-plugin-cffi.so"`);
  expect(stdout).toContain(`"exec": "${home}/.local/bin/usage-plugin"`);
  expect(stdout).toContain("pkill -SIGUSR2 waybar");
});

test("falls back to a click module when the hover module was not built", () => {
  const repo = builtCheckout(false);
  const home = tempDir();
  const { exitCode, stdout, stderr } = install(repo, home);
  expect(exitCode).toBe(0);
  expect(stderr).toContain("the hover module was not built");
  expect(stdout).toContain(`"exec": "${home}/.local/bin/usage-plugin module --layout stacked"`);
  expect(stdout).toContain(`"on-click": "${home}/.local/bin/usage-plugin widget --toggle"`);
});

test("warns about a missing gjs and still installs the module", () => {
  const repo = builtCheckout(true);
  const home = tempDir();
  const bin = tempDir();
  for (const tool of ["sh", "find", "head", "dirname", "node"]) {
    const found = Bun.which(tool, { PATH: process.env.PATH ?? "" });
    if (found !== null) Bun.spawnSync(["ln", "-s", found, join(bin, tool)]);
  }
  const { exitCode, stderr } = install(repo, home, bin);
  expect(exitCode, stderr).toBe(0);
  expect(stderr).toContain("gjs is missing");
  expect(lstatSync(join(home, ".local/share/usage-plugin/usage-plugin")).isFile()).toBe(true);
});
