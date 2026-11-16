/**
 * Reads single files out of an Electron `app.asar` without unpacking it. The archive is a Chromium
 * pickle holding a JSON header, then the files back to back: github.com/electron/asar.
 */

import { closeSync, openSync, readSync } from "node:fs";
import { isRecord } from "../domain.ts";

interface Asar {
  readonly path: string;
  readonly header: AsarDirectory;
  readonly dataStart: number;
}

interface AsarDirectory {
  readonly files: Readonly<Record<string, AsarDirectory | AsarFile>>;
}

interface AsarFile {
  readonly size: number;
  /** A string, because it can pass 2^32. */
  readonly offset: string;
  readonly unpacked?: boolean;
}

export class NotAnAsar extends Error {}

const MAX_HEADER_BYTES = 64 * 1024 * 1024;

export function openAsar(path: string): Asar {
  const fd = openSync(path, "r");
  try {
    const prefix = readAt(fd, 0, 16);
    const view = new DataView(prefix.buffer, prefix.byteOffset, 16);
    const headerBytes = view.getUint32(12, true);
    if (view.getUint32(0, true) !== 4 || headerBytes > MAX_HEADER_BYTES) throw new NotAnAsar(`${path} is not an asar archive`);
    let header: unknown;
    try {
      header = JSON.parse(Buffer.from(readAt(fd, 16, headerBytes)).toString("utf8"));
    } catch {
      throw new NotAnAsar(`${path} has a header that is not JSON`);
    }
    if (!isDirectory(header)) throw new NotAnAsar(`${path} has a header without files`);
    return { path, header, dataStart: 8 + view.getUint32(4, true) };
  } finally {
    closeSync(fd);
  }
}

function isDirectory(node: unknown): node is AsarDirectory {
  return isRecord(node) && isRecord(node.files);
}

function isFile(node: unknown): node is AsarFile {
  return isRecord(node) && typeof node.size === "number" && typeof node.offset === "string";
}

/** Throws `NotAnAsar` when `inner` is missing, a directory, or unpacked beside the archive. */
export function readAsarFile(asar: Asar, inner: string): Uint8Array {
  let node: unknown = asar.header;
  for (const name of inner.split("/")) node = isDirectory(node) ? node.files[name] : undefined;
  if (!isFile(node) || node.unpacked === true) throw new NotAnAsar(`${asar.path} holds no packed file ${inner}`);
  const fd = openSync(asar.path, "r");
  try {
    return readAt(fd, asar.dataStart + Number(node.offset), node.size);
  } finally {
    closeSync(fd);
  }
}

/** Every packed file's path, depth first. */
export function asarPaths(directory: AsarDirectory, under = ""): string[] {
  return Object.entries(directory.files).flatMap(([name, node]) => {
    const path = under === "" ? name : `${under}/${name}`;
    return isDirectory(node) ? asarPaths(node, path) : [path];
  });
}

/** The `version` in the archive's root package.json, or null when it has none. */
export function asarVersion(asar: Asar): string | null {
  const manifest: unknown = JSON.parse(Buffer.from(readAsarFile(asar, "package.json")).toString("utf8"));
  return isRecord(manifest) && typeof manifest.version === "string" ? manifest.version : null;
}

function readAt(fd: number, position: number, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const read = readSync(fd, bytes, 0, length, position);
  if (read !== length) throw new NotAnAsar(`an asar archive ends ${length - read} bytes early`);
  return bytes;
}
