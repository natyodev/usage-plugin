#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `usage: usage-plugin install | usage-plugin uninstall | usage-plugin <command>

  install     put usage-plugin in ~/.local and print the Waybar block to paste
  uninstall   remove what install put there, keeping your config
  <command>   anything else runs the installed binary, as in: usage-plugin module --debug`;

const EXAMPLES_URL = "https://github.com/natyodev/usage-plugin/tree/main/examples";

const home = process.env.HOME || homedir();
const data = process.env.XDG_DATA_HOME || join(home, ".local/share");
const share = join(data, "usage-plugin");
const exe = join(share, "usage-plugin");
const cffi = join(share, "usage-plugin-cffi.so");
const font = join(data, "fonts", "usage-plugin-icons.ttf");
const binDir = join(home, ".local/bin");
const link = join(binDir, "usage-plugin");
const config = join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "usage-plugin/config.jsonc");

const say = (line = "") => process.stdout.write(`${line}\n`);
const warn = (line) => process.stderr.write(`warning: ${line}\n`);
const fail = (line) => {
  process.stderr.write(`error: ${line}\n`);
  process.exit(1);
};

/** The files install copies, from a repo's `dist/` (what install.sh passes) or from the npm packages. */
function fromBuild(dist) {
  return {
    binary: join(dist, "usage-plugin"),
    cffi: join(dist, "usage-plugin-cffi.so"),
    widget: join(dist, "widget.js"),
    font: join(dist, "usage-plugin-icons.ttf"),
    examples: join(dirname(dist), "examples"),
  };
}

function fromPackages() {
  const platform = `usage-plugin-${process.platform}-${process.arch}`;
  let dir;
  try {
    dir = dirname(createRequire(import.meta.url).resolve(`${platform}/package.json`));
  } catch {
    fail(
      `${platform} is not installed. usage-plugin ships prebuilt for Linux on x64 and arm64. ` +
        "Elsewhere, clone https://github.com/natyodev/usage-plugin and run ./install.sh",
    );
  }
  const pkg = dirname(dirname(fileURLToPath(import.meta.url)));
  return {
    binary: join(dir, "usage-plugin"),
    cffi: join(dir, "usage-plugin-cffi.so"),
    widget: join(pkg, "widget.js"),
    font: join(pkg, "usage-plugin-icons.ttf"),
    examples: EXAMPLES_URL,
  };
}

function sameContent(a, b) {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

/** Copies through a temporary name, so a running binary is replaced rather than overwritten. */
function place(from, to, mode) {
  if (sameContent(from, to)) return false;
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, `${to}.new`);
  chmodSync(`${to}.new`, mode);
  renameSync(`${to}.new`, to);
  return true;
}

function remove(path) {
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function linkTarget(path) {
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
}

function onPath(name) {
  return (process.env.PATH ?? "").split(delimiter).filter(Boolean).some((dir) => {
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function refreshFonts() {
  if (!onPath("fc-cache")) {
    warn(`fc-cache is missing, so the logo font may not show until fontconfig rescans ${dirname(font)}`);
    return;
  }
  const run = spawnSync("fc-cache", ["-f", dirname(font)], { stdio: "ignore" });
  if (run.status !== 0) warn(`fc-cache failed. Run fc-cache -f ${dirname(font)}`);
}

function hasLayerShell() {
  const cache = spawnSync("ldconfig", ["-p"], { encoding: "utf8" });
  if (cache.status === 0 && /libgtk4-layer-shell\.so\.0/.test(cache.stdout)) return true;
  return ["/usr/lib", "/usr/lib64", "/usr/lib/x86_64-linux-gnu", "/usr/lib/aarch64-linux-gnu", "/usr/local/lib"].some(
    (dir) => existsSync(join(dir, "libgtk4-layer-shell.so.0")),
  );
}

function configuredSource() {
  let text;
  try {
    text = readFileSync(config, "utf8");
  } catch {
    return "auto";
  }
  const uncommented = text.replace(/\/\/.*$/gm, "");
  return uncommented.match(/"source"\s*:\s*"([a-z0-9]*)"/)?.[1] || "auto";
}

function readingsLine() {
  const source = configuredSource();
  const t3 = onPath("t3") || existsSync(join(home, ".local/bin/t3")) || existsSync(join(home, ".t3/userdata"));
  const logins = [
    [".claude/.credentials.json", "claude"],
    [".grok/auth.json", "grok"],
  ]
    .filter(([file]) => existsSync(join(home, file)))
    .map(([, name]) => name)
    .join(" ");
  const none = "none found yet, run claude or grok to sign in";
  if (source === "auto" && t3) {
    say(`Readings: from T3 Code (source auto). While T3 Code is closed, providers fall back to CLI logins: ${logins || "none found"}.`);
  } else if (source === "auto") {
    say(`Readings: from CLI logins (source auto, no T3 Code found): ${logins || none}.`);
  } else if (source === "t3" && t3) {
    say("Readings: from T3 Code only (source t3). Open T3 Code to see them.");
  } else if (source === "t3") {
    warn("source is t3 but no T3 Code was found, so the module will wait for it");
  } else if (source === "direct") {
    say(`Readings: from CLI logins only (source direct): ${logins || none}.`);
  } else {
    warn(`source "${source}" in ${config} is not auto, t3 or direct, so the module uses auto`);
  }
}

const hoverSnippet = () => `
Hover opens the widget, a click pins it. Use "stacked" on a vertical bar, "inline" on a horizontal one:

  "cffi/usage": {
    "module_path": "${cffi}",
    "exec": "${link}",
    "layout": "stacked",
    "interval": 30,
    "tooltip": false
  },

Style it in your Waybar style.css:

  #cffi-usage { min-width: 42px; margin: 3px 7px; padding: 7px 0; }`;

const clickSnippet = () => `
A click opens the widget. Use "--layout stacked" on a vertical bar, "--layout inline" on a horizontal one:

  "custom/usage": {
    "exec": "${link} module --layout stacked",
    "return-type": "json",
    "interval": 30,
    "justify": "center",
    "tooltip": true,
    "on-click": "${link} widget --toggle"
  },

Style it in your Waybar style.css:

  #custom-usage { min-width: 42px; margin: 3px 7px; padding: 7px 0; }`;

function install(build) {
  for (const file of [build.binary, build.widget, build.font]) {
    if (!existsSync(file)) fail(`${file} is missing`);
  }
  const hover = existsSync(build.cffi);
  const copies = [
    [build.binary, exe, 0o755],
    [build.widget, join(share, "widget.js"), 0o644],
    ...(hover ? [[build.cffi, cffi, 0o755]] : []),
  ];
  const binChanged = copies.map(([from, to, mode]) => place(from, to, mode)).some(Boolean);
  if (!hover) {
    warn(
      "the hover module was not built: it needs gcc, pkg-config and the gtk3 and json-glib headers. The click-only module below works without it.",
    );
  }
  if (linkTarget(link) !== exe) {
    mkdirSync(binDir, { recursive: true });
    remove(link);
    symlinkSync(exe, link);
  }
  const fontChanged = place(build.font, font, 0o644);
  if (fontChanged) refreshFonts();

  const probe = spawnSync(exe, ["--version"], { encoding: "utf8" });
  if (probe.status !== 0) fail(`${exe} does not run: ${(probe.stderr || probe.error?.message || "").trim()}`);
  const version = probe.stdout.trim();
  if (binChanged || fontChanged) say(`Installed usage-plugin ${version} to ${share}`);
  else say(`usage-plugin ${version} is already installed in ${share}`);

  if (!onPath("gjs")) warn("gjs is missing, so the module cannot open the widget. Install gjs and gtk4. The module works without it.");
  if (!hasLayerShell()) {
    warn("gtk4-layer-shell is missing, so the widget cannot open beside the bar. Install gtk4-layer-shell. The module works without it.");
  }

  say();
  readingsLine();
  say();
  say("Add one block to your Waybar config, put its name in a modules list, and reload Waybar with:");
  say("  pkill -SIGUSR2 waybar");
  say(hover ? hoverSnippet() : clickSnippet());
  say();
  say(`More examples: ${build.examples}`);
}

function uninstall() {
  const removed = [];
  if (linkTarget(link) === exe && remove(link)) removed.push(link);
  for (const file of [exe, join(share, "widget.js"), cffi]) if (remove(file)) removed.push(file);
  try {
    rmdirSync(share);
  } catch {}
  if (remove(font)) {
    removed.push(font);
    refreshFonts();
  }
  if (removed.length === 0) say("usage-plugin is not installed, so there was nothing to remove.");
  for (const file of removed) say(`Removed ${file}`);
  say(`Your config in ${dirname(config)} is kept. Remove the module from your Waybar config and reload Waybar.`);
}

function runInstalled(args) {
  let binary = exe;
  if (!existsSync(binary)) {
    const platform = `usage-plugin-${process.platform}-${process.arch}`;
    try {
      binary = join(dirname(createRequire(import.meta.url).resolve(`${platform}/package.json`)), "usage-plugin");
    } catch {
      fail("usage-plugin is not installed. Run: npx usage-plugin install");
    }
  }
  const run = spawnSync(binary, args, { stdio: "inherit" });
  if (run.error) fail(`${binary} did not start: ${run.error.message}`);
  if (run.signal) process.kill(process.pid, run.signal);
  process.exit(run.status ?? 1);
}

const [command, ...rest] = process.argv.slice(2);
if (command === "install" && rest.length === 0) install(fromPackages());
else if (command === "install" && rest.length === 2 && rest[0] === "--from") install(fromBuild(resolve(rest[1])));
else if (command === "uninstall" && rest.length === 0) uninstall();
else if (command === "--help") say(USAGE);
else if (command === undefined || command === "install" || command === "uninstall") fail(`bad arguments\n${USAGE}`);
else runInstalled([command, ...rest]);
