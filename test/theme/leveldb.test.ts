import { describe, expect, test } from "bun:test";
import { Damaged, readLocalStorage, snappy } from "../../src/theme/leveldb.ts";
import type { LevelFile } from "../../src/theme/leveldb.ts";
import { log, snappyCompress, storageKey, T3_ORIGIN, table } from "./leveldb-writer.ts";

const KEYS = ["t3code:theme", "t3code:theme-appearance-mode", "t3code:theme-halves:v1"];

function read(...files: LevelFile[]): ReadonlyMap<string, string> {
  return readLocalStorage(files, T3_ORIGIN, KEYS);
}

function text(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("latin1");
}

describe("snappy", () => {
  test("decodes a literal followed by a copy with a two-byte offset", () => {
    expect(text(snappy(Uint8Array.from([0x10, 0x0c, 0x61, 0x62, 0x63, 0x64, 0x2e, 0x04, 0x00])))).toBe("abcdabcdabcdabcd");
  });

  test("decodes a copy with a one-byte offset, and one that overlaps its own output", () => {
    expect(text(snappy(Uint8Array.from([0x0a, 0x0c, 0x61, 0x62, 0x63, 0x64, 0x09, 0x04])))).toBe("abcdabcdab");
    expect(text(snappy(Uint8Array.from([0x0a, 0x00, 0x61, 0x15, 0x01])))).toBe("aaaaaaaaaa");
  });

  test("decodes a literal longer than 60 bytes, whose length follows the tag", () => {
    const long = "x".repeat(10) + "0123456789".repeat(7);
    expect(text(snappy(Uint8Array.from([long.length, 60 << 2, long.length - 1, ...Buffer.from(long)])))).toBe(long);
  });

  test("throws Damaged for a copy from before the start, or output shorter than stated", () => {
    expect(() => snappy(Uint8Array.from([0x08, 0x00, 0x61, 0x15, 0x02]))).toThrow(Damaged);
    expect(() => snappy(Uint8Array.from([0x05, 0x00, 0x61]))).toThrow(Damaged);
  });

  test("round-trips what the test writer compresses", () => {
    const json = JSON.stringify([{ id: "a", colors: { canvas: "oklch(0.2 0.01 150)", surface: "oklch(0.2 0.01 150)" } }]);
    const bytes = Uint8Array.from(Buffer.from(json.repeat(20)));
    const compressed = snappyCompress(bytes);
    expect(compressed.length).toBeLessThan(bytes.length / 4);
    expect(snappy(compressed)).toEqual(bytes);
  });
});

describe("readLocalStorage", () => {
  test("reads values from a snappy-compressed table", () => {
    const ldb = table(
      [
        { key: storageKey("t3code:theme"), sequence: 3, value: "grove" },
        { key: storageKey("t3code:theme-halves:v1"), sequence: 4, value: '{"light":"grove","dark":"grove"}' },
      ],
      { compress: true },
    );
    expect(read({ name: "000005.ldb", bytes: ldb })).toEqual(
      new Map([
        ["t3code:theme", "grove"],
        ["t3code:theme-halves:v1", '{"light":"grove","dark":"grove"}'],
      ]),
    );
  });

  test("a value only in the write-ahead log is read, and a newer log write beats an older table", () => {
    const ldb = table([{ key: storageKey("t3code:theme"), sequence: 3, value: "grove" }], { compress: true });
    const wal = log([
      { sequence: 10, puts: [{ key: storageKey("t3code:theme"), value: "ocean" }] },
      { sequence: 11, puts: [{ key: storageKey("t3code:theme-appearance-mode"), value: "dark" }] },
    ]);
    expect(read({ name: "000005.ldb", bytes: ldb }, { name: "000007.log", bytes: wal })).toEqual(
      new Map([
        ["t3code:theme", "ocean"],
        ["t3code:theme-appearance-mode", "dark"],
      ]),
    );
  });

  test("a deleted key is gone, and the highest sequence wins whatever the file order", () => {
    const ldb = table([{ key: storageKey("t3code:theme"), sequence: 20, value: "iris" }], { compress: false });
    const wal = log([
      { sequence: 5, puts: [{ key: storageKey("t3code:theme"), value: "ember" }] },
      { sequence: 30, puts: [{ key: storageKey("t3code:theme-appearance-mode"), value: "light" }] },
      { sequence: 31, puts: [{ key: storageKey("t3code:theme-appearance-mode"), value: null }] },
    ]);
    expect(read({ name: "000007.log", bytes: wal }, { name: "000005.ldb", bytes: ldb })).toEqual(new Map([["t3code:theme", "iris"]]));
  });

  test("a later record in one batch beats an earlier one", () => {
    const wal = log([
      {
        sequence: 1,
        puts: [
          { key: storageKey("t3code:theme"), value: "ember" },
          { key: storageKey("t3code:theme"), value: "ocean" },
        ],
      },
    ]);
    expect(read({ name: "000003.log", bytes: wal }).get("t3code:theme")).toBe("ocean");
  });

  test("a UTF-16 value, a batch that spans log blocks, and Latin-1 bytes above 0x7f all read back", () => {
    const custom = JSON.stringify([{ id: "my-theme", label: "Mein Thema ü", note: "x".repeat(40_000) }]);
    const wal = log([
      { sequence: 1, puts: [{ key: storageKey("t3code:theme-halves:v1"), value: custom }] },
      { sequence: 2, puts: [{ key: storageKey("t3code:theme"), value: "Grüne ✓" }] },
    ]);
    expect(wal.length).toBeGreaterThan(32 * 1024);
    const storage = read({ name: "000003.log", bytes: wal });
    expect(storage.get("t3code:theme-halves:v1")).toBe(custom);
    expect(storage.get("t3code:theme")).toBe("Grüne ✓");
  });

  test("keys of other origins and keys not asked for are never returned", () => {
    const wal = log([
      {
        sequence: 1,
        puts: [
          { key: storageKey("t3code:theme", "https://example.com"), value: "ember" },
          { key: storageKey("t3code:drafts"), value: "private" },
        ],
      },
    ]);
    expect(read({ name: "000003.log", bytes: wal })).toEqual(new Map());
  });

  test("a table with a flipped byte throws Damaged", () => {
    const ldb = table([{ key: storageKey("t3code:theme"), sequence: 3, value: "grove" }], { compress: true });
    ldb[10] = (ldb[10] as number) ^ 0xff;
    expect(() => read({ name: "000005.ldb", bytes: ldb })).toThrow(Damaged);
    expect(() => read({ name: "000005.ldb", bytes: ldb.subarray(0, 40) })).toThrow(Damaged);
  });

  test("a log cut short mid-record keeps every whole record before the cut", () => {
    const wal = log([
      { sequence: 1, puts: [{ key: storageKey("t3code:theme"), value: "ember" }] },
      { sequence: 2, puts: [{ key: storageKey("t3code:theme"), value: "ocean" }] },
    ]);
    expect(read({ name: "000003.log", bytes: wal.subarray(0, wal.length - 3) }).get("t3code:theme")).toBe("ember");
  });

  test("files that are neither tables nor logs are ignored", () => {
    expect(read({ name: "CURRENT", bytes: Uint8Array.from(Buffer.from("MANIFEST-000001\n")) })).toEqual(new Map());
  });
});
