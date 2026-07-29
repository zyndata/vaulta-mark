#!/usr/bin/env node
/**
 * Packages `dist/` into `release/vaulta-mark-<version>.zip` for the Chrome Web Store.
 *
 * Written by hand rather than pulled from npm for two reasons: this is the artifact users are
 * told they can rebuild and hash-compare against the published one (README "Install"), so it
 * has to be byte-for-byte deterministic — fixed timestamps, sorted entries, no extra fields —
 * and a zip writer is small enough that owning it beats trusting one.
 *
 * Source maps are excluded: they are a CI debugging artifact, not part of the package.
 *
 * Usage: node scripts/zip.mjs
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, join, relative, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const distDir = resolve(repoRoot, 'dist');
const releaseDir = resolve(repoRoot, 'release');

/** Fixed MS-DOS timestamp (1980-01-01 00:00:00) so the same input always hashes the same. */
const DOS_DATE = 0x0021;
const DOS_TIME = 0x0000;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/** @param {Buffer} buf */
function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  /** @type {string[]} */
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else files.push(full);
  }
  return files;
}

/**
 * Build a zip archive from entries that are already in the order they should appear.
 * Pure — this is what the unit tests drive.
 *
 * @param {{ name: string, data: Buffer }[]} entries
 * @returns {Buffer}
 */
export function makeZip(entries) {
  /** @type {Buffer[]} */
  const chunks = [];
  /** @type {Buffer[]} */
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.data, { level: 9 });
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length

    chunks.push(local, name, compressed);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4); // version made by
    header.writeUInt16LE(20, 6); // version needed
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30); // extra
    header.writeUInt16LE(0, 32); // comment
    header.writeUInt16LE(0, 34); // disk
    header.writeUInt16LE(0, 36); // internal attrs
    // External attributes: regular file, mode 0644. `>>> 0` because the shift overflows into a
    // negative 32-bit signed integer, which Buffer refuses to write.
    header.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);

    central.push(header, name);
    offset += local.length + name.length + compressed.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, end]);
}

async function main() {
  /** @type {{ version: string }} */
  const pkg = JSON.parse(await readFile(resolve(repoRoot, 'package.json'), 'utf8'));

  let files;
  try {
    files = await walk(distDir);
  } catch {
    console.error('✗ dist/ not found — run `npm run build` first.');
    process.exitCode = 1;
    return;
  }

  const entries = [];
  for (const file of files.sort()) {
    if (extname(file) === '.map') continue;
    entries.push({
      name: relative(distDir, file).split(/[\\/]/).join('/'),
      data: await readFile(file),
    });
  }

  if (!entries.some((entry) => entry.name === 'manifest.json')) {
    console.error('✗ dist/manifest.json is missing — that is not a loadable extension.');
    process.exitCode = 1;
    return;
  }

  const zip = makeZip(entries);
  const target = resolve(releaseDir, `vaulta-mark-${pkg.version}.zip`);
  await mkdir(releaseDir, { recursive: true });
  await writeFile(target, zip);

  const sha256 = createHash('sha256').update(zip).digest('hex');
  console.log(`✓ ${relative(repoRoot, target)}  ${entries.length} files, ${zip.length} bytes`);
  console.log(`  sha256  ${sha256}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
