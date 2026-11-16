import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "..", "..", "src");
const PROVIDERS = join(SRC, "providers");

interface Import {
  readonly typeOnly: boolean;
  readonly names: string;
  readonly from: string;
}

function importsOf(source: string): Import[] {
  const statements = source.matchAll(/^\s*(?:import|export)\s+(type\s+)?([^"';]*?)\s*from\s*["']([^"']+)["']/gm);
  return [...statements].map(([, type, names = "", from = ""]) => ({ typeOnly: type !== undefined, names, from }));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".ts"))
    .map((path) => join(dir, path));
}

const adapterFiles = sourceFiles(PROVIDERS).filter((path) => path !== join(PROVIDERS, "index.ts"));

test("there is an adapter file to check", () => {
  expect(adapterFiles.map((path) => relative(PROVIDERS, path))).toContain("claude.ts");
});

test.each(adapterFiles.map((path) => [relative(SRC, path), path]))(
  "%s imports only the domain and types from the contract",
  (_name, path) => {
    const source = readFileSync(path, "utf8");
    for (const imported of importsOf(source)) {
      const allowed = imported.from === "../domain.ts" || (imported.from === "./index.ts" && imported.typeOnly);
      expect(allowed, `import ${imported.names} from "${imported.from}"`).toBe(true);
    }
    expect(source, "a side-effect, dynamic, or CommonJS import").not.toMatch(/\bimport\s*["'(]|\brequire\s*\(/);
  },
);

const REACHES_OUTSIDE =
  /(?<![.\w$])(?:fetch|self|globalThis|Bun|process|require|XMLHttpRequest|WebSocket)(?![\w$])|\bimport\s*(?:\(|\.\s*meta\b)/g;

function ioOfItsOwn(source: string): string[] {
  return source
    .split("\n")
    .flatMap((line, index) => [...line.matchAll(REACHES_OUTSIDE)].map(([found]) => `line ${index + 1}: ${found}`));
}

test.each(adapterFiles.map((path) => [relative(SRC, path), path]))(
  "%s does no I/O of its own",
  (_name, path) => {
    expect(ioOfItsOwn(readFileSync(path, "utf8"))).toEqual([]);
  },
);

describe("the check for I/O of an adapter's own", () => {
  test.each([
    ["a call to fetch", "const reply = await fetch(url, { headers });"],
    ["fetch.call", "const reply = await fetch.call(undefined, url);"],
    ["self.fetch", "const reply = await self.fetch(url);"],
    ["globalThis.fetch", "const reply = await globalThis.fetch(url);"],
    ["fetch looked up by name", 'const reply = await globalThis["fetch"](url);'],
    ["fetch kept as a value", "const http = fetch;\nconst reply = await http(url);"],
    [
      "fetch as a default parameter",
      "export async function fetchGrok(ctx: FetchContext, http: typeof fetch = fetch): Promise<FetchResult> {\n  return http(url);\n}",
    ],
    ["fetch taken out of an object", "const { fetch: http } = self;"],
    ["Bun.file", "const text = await Bun.file(path).text();"],
    ["Bun kept as a value", "const runtime = Bun;"],
    ["process.env", "const home = process.env.HOME;"],
    ["process kept as a value", "const { env } = process;"],
    ["require", 'const fs = require("node:fs");'],
    ["require kept as a value", "const load = require;"],
    ["a dynamic import", 'const fs = await import("node:fs");'],
    ["import.meta", 'const fs = import.meta.require("node:fs");'],
    ["a WebSocket", "const socket = new WebSocket(url);"],
    ["an XMLHttpRequest", "const request = new XMLHttpRequest();"],
  ])("flags %s", (_case, source) => {
    expect(ioOfItsOwn(source)).not.toEqual([]);
  });

  test.each([
    ["a request through the context", "const reply = await ctx.get(USAGE_URL, { Authorization: `Bearer ${token}` });"],
    ["the contract's type names", 'import type { FetchContext, FetchResult } from "./index.ts";'],
    ["an adapter's own name", "export async function fetchClaude(ctx: FetchContext): Promise<FetchResult> {"],
    ["a member that shares a name", "return adapter.fetch(ctx) ?? adapter?.process(ctx);"],
    ["a name that only contains one", "const fetched = refetch(selfService, processed, Bunch);"],
    ["a static import of the domain", 'import { isRecord } from "../domain.ts";'],
  ])("allows %s", (_case, source) => {
    expect(ioOfItsOwn(source)).toEqual([]);
  });
});

test("only the cache runs an adapter, so every fetch happens under its lock", () => {
  const importers = sourceFiles(SRC).filter((path) =>
    importsOf(readFileSync(path, "utf8")).some(
      (imported) => /providers\/index\.ts$|^\.\/index\.ts$/.test(imported.from) && /\battempt\b/.test(imported.names),
    ),
  );
  expect(importers.map((path) => relative(SRC, path)).filter((path) => path !== "cache.ts")).toEqual([]);
});
