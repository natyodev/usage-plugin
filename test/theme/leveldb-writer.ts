/**
 * Writes the LevelDB files Chromium keeps localStorage in, for tests and the fixture profiles.
 * Deterministic, so a regenerated fixture is byte-identical to the committed one.
 */

import { maskedCrc32c } from "../../src/theme/leveldb.ts";

export interface Put {
  readonly key: string;
  /** Null writes a deletion. */
  readonly value: string | null;
}

export const T3_ORIGIN = "t3code://app";

/** Chromium's key for one localStorage item, as Latin-1 text. */
export function storageKey(key: string, origin = T3_ORIGIN): string {
  return `_${origin}\u0000\u0001${key}`;
}

/** Latin-1 behind a 1 byte when every character fits, else UTF-16LE behind a 0 byte, as Chromium stores it. */
export function storageValue(text: string): Uint8Array {
  if ([...text].every((char) => char.charCodeAt(0) < 256)) return bytesOf([1], Buffer.from(text, "latin1"));
  return bytesOf([0], Buffer.from(text, "utf16le"));
}

function latin1(text: string): Uint8Array {
  return Uint8Array.from(Buffer.from(text, "latin1"));
}

function bytesOf(...parts: readonly ArrayLike<number>[]): Uint8Array {
  return Uint8Array.from(parts.flatMap((part) => Array.from(part)));
}

function varint(value: number): number[] {
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  bytes.push(rest);
  return bytes;
}

function u32(value: number): number[] {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
  return [...bytes];
}

function u64(value: bigint): number[] {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return [...bytes];
}

export function snappyCompress(input: Uint8Array): Uint8Array {
  const out: number[] = varint(input.length);
  const seen = new Map<number, number>();
  let literalStart = 0;
  let at = 0;
  const flushLiteral = (end: number) => {
    let start = literalStart;
    while (start < end) {
      const length = Math.min(end - start, 256);
      out.push(...(length <= 60 ? [(length - 1) << 2] : [60 << 2, length - 1]), ...input.subarray(start, start + length));
      start += length;
    }
  };
  while (at + 4 <= input.length) {
    const word = ((input[at] as number) << 24) | ((input[at + 1] as number) << 16) | ((input[at + 2] as number) << 8) | (input[at + 3] as number);
    const candidate = seen.get(word);
    seen.set(word, at);
    if (candidate === undefined || at - candidate > 0xffff) {
      at += 1;
      continue;
    }
    let length = 4;
    while (at + length < input.length && input[candidate + length] === input[at + length] && length < 64) length += 1;
    flushLiteral(at);
    const offset = at - candidate;
    if (length <= 11 && offset < 2048) out.push(((offset >> 8) << 5) | ((length - 4) << 2) | 1, offset & 0xff);
    else out.push(((length - 1) << 2) | 2, offset & 0xff, offset >> 8);
    at += length;
    literalStart = at;
  }
  flushLiteral(input.length);
  return Uint8Array.from(out);
}

export interface TableEntry extends Put {
  readonly sequence: number;
}

const RESTART_INTERVAL = 4;

function block(entries: readonly { readonly key: Uint8Array; readonly value: Uint8Array }[]): Uint8Array {
  const out: number[] = [];
  const restarts: number[] = [];
  let last: Uint8Array = new Uint8Array(0);
  entries.forEach(({ key, value }, index) => {
    let shared = 0;
    if (index % RESTART_INTERVAL === 0) restarts.push(out.length);
    else while (shared < Math.min(last.length, key.length) && last[shared] === key[shared]) shared += 1;
    out.push(...varint(shared), ...varint(key.length - shared), ...varint(value.length), ...key.subarray(shared), ...value);
    last = key;
  });
  if (restarts.length === 0) restarts.push(0);
  return bytesOf(out, ...restarts.map(u32), u32(restarts.length));
}

/** One `.ldb` table. Entries are sorted as LevelDB sorts them: key ascending, newest first. */
export function table(entries: readonly TableEntry[], { compress }: { readonly compress: boolean }): Uint8Array {
  const sorted = [...entries].sort((a, b) => (a.key === b.key ? b.sequence - a.sequence : a.key < b.key ? -1 : 1));
  const internal = sorted.map(({ key, sequence, value }) => ({
    key: bytesOf(latin1(key), u64((BigInt(sequence) << 8n) | (value === null ? 0n : 1n))),
    value: value === null ? new Uint8Array(0) : storageValue(value),
  }));
  const file: number[] = [];
  const append = (content: Uint8Array, squeeze: boolean) => {
    const stored = squeeze ? snappyCompress(content) : content;
    const typed = bytesOf(stored, [squeeze ? 1 : 0]);
    const handle = { offset: file.length, size: stored.length };
    file.push(...typed, ...u32(maskedCrc32c(typed)));
    return handle;
  };
  const halves = [internal.slice(0, Math.ceil(internal.length / 2)), internal.slice(Math.ceil(internal.length / 2))];
  const index = halves
    .filter((half) => half.length > 0)
    .map((half) => {
      const { offset, size } = append(block(half), compress);
      return { key: (half.at(-1) as { key: Uint8Array }).key, value: Uint8Array.from([...varint(offset), ...varint(size)]) };
    });
  const meta = append(block([]), false);
  const top = append(block(index), false);
  const handles = [...varint(meta.offset), ...varint(meta.size), ...varint(top.offset), ...varint(top.size)];
  file.push(...handles, ...new Array(40 - handles.length).fill(0), ...u64(0xdb4775248b80fb57n));
  return Uint8Array.from(file);
}

export interface Batch {
  readonly sequence: number;
  readonly puts: readonly Put[];
}

const LOG_BLOCK = 32 * 1024;

/** One `.log` write-ahead log. A batch longer than what is left of a block is split across blocks. */
export function log(batches: readonly Batch[]): Uint8Array {
  const file: number[] = [];
  for (const { sequence, puts } of batches) {
    const payload = bytesOf(
      u64(BigInt(sequence)),
      u32(puts.length),
      ...puts.map(({ key, value }) => {
        const keyBytes = latin1(key);
        if (value === null) return bytesOf([0], varint(keyBytes.length), keyBytes);
        const valueBytes = storageValue(value);
        return bytesOf([1], varint(keyBytes.length), keyBytes, varint(valueBytes.length), valueBytes);
      }),
    );
    let at = 0;
    do {
      const left = LOG_BLOCK - (file.length % LOG_BLOCK);
      if (left < 7) {
        file.push(...new Array(left).fill(0));
        continue;
      }
      const length = Math.min(payload.length - at, left - 7);
      const first = at === 0;
      const last = at + length === payload.length;
      const type = first && last ? 1 : first ? 2 : last ? 4 : 3;
      const typed = bytesOf([type], payload.subarray(at, at + length));
      file.push(...u32(maskedCrc32c(typed)), length & 0xff, length >> 8, ...typed);
      at += length;
    } while (at < payload.length);
  }
  return Uint8Array.from(file);
}
