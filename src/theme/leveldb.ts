/**
 * Reads Chromium's localStorage out of the files of its LevelDB: sorted tables (`.ldb`, blocks
 * often snappy-compressed) and the write-ahead log (`.log`) that holds the newest writes. Pure:
 * bytes in, values out. Format: github.com/google/leveldb/blob/main/doc/{table_format,log_format}.md.
 */

export interface LevelFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** The bytes do not hold a readable table, such as after a flipped bit or a truncation. */
export class Damaged extends Error {}

/**
 * The given keys of one origin's localStorage, each at its write with the highest sequence number.
 * A deletion removes the key. No other key's value is decoded. Throws `Damaged` for a table that
 * fails its checksum. A log stops at its first bad record, which is how LevelDB recovers from a
 * write cut short.
 */
export function readLocalStorage(
  files: readonly LevelFile[],
  origin: string,
  keys: readonly string[],
): ReadonlyMap<string, string> {
  // Chromium writes a key that fits in Latin-1 behind a 1 byte, and T3's keys are plain ASCII.
  const wanted = keys.map((name) => ({ name, bytes: Uint8Array.from(Buffer.from(`_${origin}\u0000\u0001${name}`, "latin1")) }));
  const latest = new Map<string, { readonly sequence: number; readonly value: Uint8Array | null }>();
  const keep = (key: Uint8Array, sequence: number, value: Uint8Array | null) => {
    const name = wanted.find((candidate) => sameBytes(candidate.bytes, key))?.name;
    if (name === undefined) return;
    const seen = latest.get(name);
    if (seen === undefined || seen.sequence < sequence) latest.set(name, { sequence, value });
  };
  for (const file of files) {
    if (file.name.endsWith(".ldb")) tableRecords(file, keep);
    else if (file.name.endsWith(".log")) logRecords(file.bytes, keep);
  }
  const storage = new Map<string, string>();
  for (const [name, { value }] of latest) {
    const text = value === null ? null : decodeString(value);
    if (text !== null) storage.set(name, text);
  }
  return storage;
}

type Keep = (key: Uint8Array, sequence: number, value: Uint8Array | null) => void;

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

/** Chromium's localStorage strings: a 1 byte before Latin-1, a 0 byte before UTF-16LE. */
function decodeString(bytes: Uint8Array): string | null {
  const body = Buffer.from(bytes.buffer, bytes.byteOffset + 1, bytes.byteLength - 1);
  if (bytes[0] === 1) return body.toString("latin1");
  if (bytes[0] === 0 && body.length % 2 === 0) return body.toString("utf16le");
  return null;
}

class Reader {
  at = 0;
  constructor(
    readonly bytes: Uint8Array,
    private readonly what: string,
  ) {}

  get done(): boolean {
    return this.at >= this.bytes.length;
  }

  byte(): number {
    const value = this.bytes[this.at];
    if (value === undefined) throw new Damaged(`${this.what} ends early`);
    this.at += 1;
    return value;
  }

  take(length: number): Uint8Array {
    if (length < 0 || this.at + length > this.bytes.length) throw new Damaged(`${this.what} ends early`);
    const slice = this.bytes.subarray(this.at, this.at + length);
    this.at += length;
    return slice;
  }

  varint(): number {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const byte = this.byte();
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
    }
    throw new Damaged(`${this.what} has a number too long to read`);
  }
}

function u32(bytes: Uint8Array, at: number): number {
  if (at < 0 || at + 4 > bytes.length) throw new Damaged("a fixed-width number runs past its bytes");
  return ((bytes[at] as number) | ((bytes[at + 1] as number) << 8) | ((bytes[at + 2] as number) << 16) | ((bytes[at + 3] as number) << 24)) >>> 0;
}

const TABLE_MAGIC = [0x8b80fb57, 0xdb477524];
const FOOTER_BYTES = 48;
const BLOCK_TRAILER_BYTES = 5;

function tableRecords({ name, bytes }: LevelFile, keep: Keep): void {
  const end = bytes.length;
  if (end < FOOTER_BYTES || u32(bytes, end - 8) !== TABLE_MAGIC[0] || u32(bytes, end - 4) !== TABLE_MAGIC[1]) {
    throw new Damaged(`${name} is not a LevelDB table`);
  }
  const footer = new Reader(bytes.subarray(end - FOOTER_BYTES), `${name}'s footer`);
  footer.varint();
  footer.varint();
  const index = blockAt(bytes, footer.varint(), footer.varint(), name);
  blockEntries(index, name, (_, handle) => {
    const at = new Reader(handle, `${name}'s index`);
    blockEntries(blockAt(bytes, at.varint(), at.varint(), name), name, (key, value) => {
      const user = key.length - 8;
      if (user < 0) throw new Damaged(`${name} has a key without its sequence number`);
      const low = u32(key, user);
      // The tag is the sequence number shifted past one type byte: 1 for a value, 0 for a deletion.
      keep(key.subarray(0, user), u32(key, user + 4) * 2 ** 24 + (low >>> 8), (low & 0xff) === 1 ? value : null);
    });
  });
}

function blockAt(bytes: Uint8Array, offset: number, size: number, name: string): Uint8Array {
  if (offset + size + BLOCK_TRAILER_BYTES > bytes.length) throw new Damaged(`${name} points past its end`);
  const content = bytes.subarray(offset, offset + size + 1);
  if (u32(bytes, offset + size + 1) !== maskedCrc32c(content)) throw new Damaged(`${name} fails its checksum`);
  const compression = bytes[offset + size];
  if (compression === 0) return content.subarray(0, size);
  if (compression === 1) return snappy(content.subarray(0, size), name);
  throw new Damaged(`${name} uses compression ${compression}, which is not snappy`);
}

function blockEntries(block: Uint8Array, name: string, each: (key: Uint8Array, value: Uint8Array) => void): void {
  const restarts = u32(block, block.length - 4);
  const end = block.length - 4 - 4 * restarts;
  if (end < 0) throw new Damaged(`${name} has more restarts than bytes`);
  const reader = new Reader(block.subarray(0, end), `a block of ${name}`);
  let key = new Uint8Array(0);
  while (!reader.done) {
    const shared = reader.varint();
    const unshared = reader.varint();
    const valueLength = reader.varint();
    if (shared > key.length) throw new Damaged(`${name} shares more of a key than the last key has`);
    const next = new Uint8Array(shared + unshared);
    next.set(key.subarray(0, shared));
    next.set(reader.take(unshared), shared);
    key = next;
    each(key, reader.take(valueLength));
  }
}

export function snappy(compressed: Uint8Array, name = "a snappy block"): Uint8Array {
  const reader = new Reader(compressed, name);
  const length = reader.varint();
  const output = new Uint8Array(length);
  let written = 0;
  while (!reader.done) {
    const tag = reader.byte();
    if ((tag & 3) === 0) {
      let literal = tag >> 2;
      if (literal >= 60) {
        const bytes = literal - 59;
        literal = 0;
        for (let index = 0; index < bytes; index += 1) literal += reader.byte() * 2 ** (8 * index);
      }
      const chunk = reader.take(literal + 1);
      if (written + chunk.length > length) throw new Damaged(`${name} decompresses past its stated length`);
      output.set(chunk, written);
      written += chunk.length;
      continue;
    }
    let copy: number;
    let offset: number;
    if ((tag & 3) === 1) {
      copy = ((tag >> 2) & 7) + 4;
      offset = ((tag >> 5) << 8) | reader.byte();
    } else if ((tag & 3) === 2) {
      copy = (tag >> 2) + 1;
      offset = reader.byte() | (reader.byte() << 8);
    } else {
      copy = (tag >> 2) + 1;
      offset = u32(reader.take(4), 0);
    }
    if (offset === 0 || offset > written || written + copy > length) throw new Damaged(`${name} copies from outside its output`);
    for (let index = 0; index < copy; index += 1) output[written + index] = output[written + index - offset] as number;
    written += copy;
  }
  if (written !== length) throw new Damaged(`${name} decompresses short of its stated length`);
  return output;
}

const LOG_BLOCK_BYTES = 32 * 1024;
const LOG_HEADER_BYTES = 7;
const FULL = 1;
const FIRST = 2;
const MIDDLE = 3;
const LAST = 4;

function logRecords(bytes: Uint8Array, keep: Keep): void {
  for (const batch of logPayloads(bytes)) {
    try {
      batchRecords(batch, keep);
    } catch (error) {
      if (!(error instanceof Damaged)) throw error;
    }
  }
}

function logPayloads(bytes: Uint8Array): Uint8Array[] {
  const payloads: Uint8Array[] = [];
  let pending: Uint8Array[] | null = null;
  let at = 0;
  while (at + LOG_HEADER_BYTES <= bytes.length) {
    const left = LOG_BLOCK_BYTES - (at % LOG_BLOCK_BYTES);
    if (left < LOG_HEADER_BYTES) {
      at += left;
      continue;
    }
    const length = (bytes[at + 4] as number) | ((bytes[at + 5] as number) << 8);
    const type = bytes[at + 6] as number;
    const end = at + LOG_HEADER_BYTES + length;
    if (type === 0 && length === 0) {
      at += left;
      continue;
    }
    if (end > bytes.length || length > left - LOG_HEADER_BYTES) break;
    if (u32(bytes, at) !== maskedCrc32c(bytes.subarray(at + 6, end))) break;
    const fragment = bytes.subarray(at + LOG_HEADER_BYTES, end);
    at = end;
    if (type === FULL) payloads.push(fragment);
    else if (type === FIRST) pending = [fragment];
    else if (type === MIDDLE && pending !== null) pending.push(fragment);
    else if (type === LAST && pending !== null) {
      payloads.push(Buffer.concat([...pending, fragment]));
      pending = null;
    } else pending = null;
  }
  return payloads;
}

function batchRecords(batch: Uint8Array, keep: Keep): void {
  if (batch.length < 12) throw new Damaged("a log batch is too short for its header");
  const first = u32(batch, 0) + u32(batch, 4) * 2 ** 32;
  const count = u32(batch, 8);
  const reader = new Reader(batch.subarray(12), "a log batch");
  for (let index = 0; index < count; index += 1) {
    const tag = reader.byte();
    const key = reader.take(reader.varint());
    if (tag !== 0 && tag !== 1) throw new Damaged(`a log batch has a record of kind ${tag}`);
    keep(key, first + index, tag === 1 ? reader.take(reader.varint()) : null);
  }
}

const CRC32C_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let crc = index;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0x82f63b78 : crc >>> 1;
    table[index] = crc >>> 0;
  }
  return table;
})();

/** LevelDB stores CRC-32C rotated and offset, so a checksum of data that holds checksums stays strong. */
export function maskedCrc32c(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  const table = CRC32C_TABLE;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = (table[(crc ^ (bytes[index] as number)) & 0xff] as number) ^ (crc >>> 8);
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  return (((crc >>> 15) | (crc << 17)) + 0xa282ead8) >>> 0;
}
