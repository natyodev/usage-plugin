/**
 * Packs the npm packages from a finished `dist/` into <out dir>: `usage-plugin-linux-<arch>` with the
 * binary and the hover module, and `usage-plugin` with the CLI, the widget and the font.
 *
 * Every version comes from the root package.json, so a release bumps that one line.
 *
 * usage: bun scripts/pack-npm.ts <x64|arm64> <out dir>
 */
import { $ } from "bun";
import { closeSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

/** The ELF `e_machine` of each arch, so a binary built for the wrong one is caught before it ships. */
const MACHINES: Readonly<Record<string, number>> = { x64: 0x3e, arm64: 0xb7 };

const root = join(import.meta.dir, "..");
const [arch, outArg] = Bun.argv.slice(2);
const machine = MACHINES[arch ?? ""];
if (machine === undefined || outArg === undefined) {
  throw new Error("usage: bun scripts/pack-npm.ts <x64|arm64> <out dir>");
}
const out = resolve(outArg);
const { version } = (await Bun.file(join(root, "package.json")).json()) as { version: string };

function elfMachine(path: string): number {
  const header = Buffer.alloc(20);
  const fd = openSync(path, "r");
  readSync(fd, header, 0, 20, 0);
  closeSync(fd);
  if (header.toString("latin1", 0, 4) !== "\x7fELF") throw new Error(`${path} is not an ELF file`);
  return header.readUInt16LE(18);
}

for (const file of ["dist/usage-plugin", "dist/usage-plugin-cffi.so"]) {
  if (elfMachine(join(root, file)) !== machine) throw new Error(`${file} is not built for ${arch}`);
}

async function pack(manifestDir: string, files: readonly string[]): Promise<string> {
  const stage = mkdtempSync(join(tmpdir(), "usage-plugin-pack-"));
  try {
    cpSync(join(root, "npm", manifestDir), stage, { recursive: true });
    for (const file of files) copyFileSync(join(root, file), join(stage, basename(file)));
    const manifest = await Bun.file(join(stage, "package.json")).json();
    manifest.version = version;
    for (const name of Object.keys(manifest.optionalDependencies ?? {})) manifest.optionalDependencies[name] = version;
    await Bun.write(join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    mkdirSync(out, { recursive: true });
    const tarball = (await $`npm pack --silent --pack-destination ${out}`.cwd(stage).text()).trim();
    return join(out, tarball);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

console.log(await pack(`linux-${arch}`, ["dist/usage-plugin", "dist/usage-plugin-cffi.so", "LICENSE"]));
console.log(await pack("usage-plugin", ["dist/widget.js", "dist/usage-plugin-icons.ttf", "README.md", "LICENSE"]));
