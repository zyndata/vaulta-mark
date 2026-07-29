import { inflateRawSync } from 'node:zlib';

import { makeZip } from '../../../scripts/zip.mjs';

interface ParsedEntry {
  name: string;
  data: Buffer;
}

/** A deliberately independent reader: parse the central directory, not the local headers. */
function readZip(zip: Buffer): ParsedEntry[] {
  const eocdOffset = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocdOffset).toBeGreaterThan(-1);

  const count = zip.readUInt16LE(eocdOffset + 10);
  let cursor = zip.readUInt32LE(eocdOffset + 16);

  const entries: ParsedEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    expect(zip.readUInt32LE(cursor)).toBe(0x02014b50);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');

    expect(zip.readUInt32LE(localOffset)).toBe(0x04034b50);
    expect(zip.readUInt16LE(localOffset + 8)).toBe(8); // deflate
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const extraLength = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + extraLength;

    entries.push({
      name,
      data: inflateRawSync(zip.subarray(dataStart, dataStart + compressedSize)),
    });
    cursor += 46 + nameLength;
  }
  return entries;
}

const fixture = (): { name: string; data: Buffer }[] => [
  { name: 'manifest.json', data: Buffer.from('{"manifest_version":3}\n', 'utf8') },
  { name: 'assets/popup-a1b2.js', data: Buffer.from('console.info("x".repeat(64));', 'utf8') },
  { name: 'icons/icon16.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10]) },
];

describe('zip writer', () => {
  it('round-trips every entry, path and byte', () => {
    const parsed = readZip(makeZip(fixture()));
    expect(parsed.map((entry) => entry.name)).toEqual([
      'manifest.json',
      'assets/popup-a1b2.js',
      'icons/icon16.png',
    ]);
    for (const [index, entry] of parsed.entries()) {
      expect(entry.data.equals(fixture()[index]!.data)).toBe(true);
    }
  });

  it('uses forward slashes and no directory entries, as the Web Store expects', () => {
    const zip = makeZip(fixture());
    expect(zip.includes(Buffer.from('assets/popup-a1b2.js'))).toBe(true);
    expect(readZip(zip).some((entry) => entry.name.endsWith('/'))).toBe(false);
  });

  it('is byte-for-byte reproducible, so a published zip can be hash-compared', () => {
    expect(makeZip(fixture()).equals(makeZip(fixture()))).toBe(true);
  });

  it('handles an empty archive without corrupting the end record', () => {
    expect(readZip(makeZip([]))).toEqual([]);
  });
});
