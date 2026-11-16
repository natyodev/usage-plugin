/**
 * Builds the T3 Code fixture profiles in `test/fixtures/t3-theme-*`, each usable as
 * `USAGE_PLUGIN_T3_PROFILE=<dir>`. They hold only theme keys, written here, never copied from
 * a real profile.
 *
 *   bun test/theme/fixtures.ts
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { log, storageKey, table } from "./leveldb-writer.ts";
import type { Batch, TableEntry } from "./leveldb-writer.ts";

export interface FixtureProfile {
  readonly name: string;
  /** Older writes, in a snappy-compressed table. */
  readonly table: readonly TableEntry[];
  /** Newer writes, in the write-ahead log. */
  readonly log: readonly Batch[];
  readonly version: string;
  readonly userdata?: Readonly<Record<string, unknown>>;
  readonly corrupt?: boolean;
}

const HALVES = "t3code:theme-halves:v1";
const MODE = "t3code:theme-appearance-mode";
const THEME = "t3code:theme";
const CUSTOM = "t3code:themes:v1";

const put = (key: string, value: string | null) => ({ key: storageKey(key), value });
const groveHalves = (dark: string) => JSON.stringify({ light: "grove", dark });

const GROVE_DARK = {
  table: [{ ...put(HALVES, groveHalves("grove")), sequence: 2 }],
  log: [{ sequence: 5, puts: [put(MODE, "dark")] }],
};

export const FIXTURE_PROFILES: readonly FixtureProfile[] = [
  { name: "t3-theme-grove-dark", ...GROVE_DARK, version: "0.1.9" },
  {
    name: "t3-theme-ocean-dark",
    table: [{ ...put(THEME, "ember"), sequence: 1 }],
    log: [{ sequence: 3, puts: [put(THEME, "ocean"), put(MODE, "dark")] }],
    version: "0.1.9",
  },
  {
    name: "t3-theme-ember-light",
    table: [
      { ...put(THEME, "ember"), sequence: 1 },
      { ...put(MODE, "light"), sequence: 2 },
    ],
    log: [],
    version: "0.1.9",
  },
  {
    name: "t3-theme-iris-dark",
    ...GROVE_DARK,
    log: [...GROVE_DARK.log, { sequence: 7, puts: [put(HALVES, groveHalves("iris"))] }],
    version: "0.1.9",
  },
  {
    name: "t3-theme-custom",
    table: [{ ...put(MODE, "dark"), sequence: 1 }],
    log: [
      {
        sequence: 4,
        puts: [
          put(
            CUSTOM,
            JSON.stringify([
              {
                id: "harbour-night",
                label: "Harbour Night",
                appearance: "dark",
                colors: { canvas: "oklch(0.22 0.035 235)", surface: "oklch(0.27 0.04 235)", accent: "oklch(0.78 0.14 75)", text: "oklch(0.96 0.01 235)" },
              },
            ]),
          ),
          put(THEME, "harbour-night"),
        ],
      },
    ],
    version: "0.1.9",
    userdata: { "client-settings.json": { appearanceContrast: 115, glassOpacity: 70 } },
  },
  {
    name: "t3-theme-custom-file",
    table: [{ ...put(THEME, "sunset"), sequence: 1 }],
    log: [{ sequence: 2, puts: [put(MODE, "light")] }],
    version: "0.1.9",
    userdata: { "themes/sunset.json": { name: "Sunset", appearance: "light", canvas: "#fff4e6", accent: "#c2410c" } },
  },
  { name: "t3-theme-unknown-version", ...GROVE_DARK, version: "0.2.0" },
  { name: "t3-theme-corrupt", ...GROVE_DARK, version: "0.1.9", corrupt: true },
];

export function fakeAsar(version: string): Uint8Array {
  const manifest = Buffer.from(`${JSON.stringify({ name: "t3code", version })}\n`);
  const header = Buffer.from(JSON.stringify({ files: { "package.json": { size: manifest.length, offset: "0" } } }));
  const padded = Math.ceil(header.length / 4) * 4;
  const prefix = Buffer.alloc(16 + padded);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(8 + padded, 4);
  prefix.writeUInt32LE(4 + padded, 8);
  prefix.writeUInt32LE(header.length, 12);
  header.copy(prefix, 16);
  return Buffer.concat([prefix, manifest]);
}

export function profileFiles(profile: FixtureProfile): ReadonlyMap<string, Uint8Array | string> {
  const ldb = table(profile.table, { compress: true });
  if (profile.corrupt === true) ldb[12] = (ldb[12] as number) ^ 0x5a;
  return new Map<string, Uint8Array | string>([
    ["app.asar", fakeAsar(profile.version)],
    ["leveldb/CURRENT", "MANIFEST-000001\n"],
    ["leveldb/MANIFEST-000001", ""],
    ["leveldb/000005.ldb", ldb],
    ["leveldb/000007.log", log(profile.log)],
    ...Object.entries(profile.userdata ?? {}).map(([path, json]): [string, string] => [`userdata/${path}`, `${JSON.stringify(json, null, 2)}\n`]),
  ]);
}

export function writeProfile(root: string, profile: FixtureProfile): string {
  const dir = join(root, profile.name);
  rmSync(dir, { recursive: true, force: true });
  for (const [path, content] of profileFiles(profile)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..", "fixtures");
  for (const profile of FIXTURE_PROFILES) console.log(`wrote ${writeProfile(root, profile)}`);
}
