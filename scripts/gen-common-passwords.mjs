/**
 * Regenerates the bundled common-password list.
 *
 *   node scripts/gen-common-passwords.mjs
 *
 * Two artefacts, both committed:
 *
 *   src/crypto/data/common-passwords.txt  — the list in the clear, one entry per line, sorted.
 *                                           This is what a human audits.
 *   src/crypto/data/common-passwords.ts   — the same list gzipped and base64url'd, which is what
 *                                           actually ships (ARCHITECTURE §4.6). ~4× smaller.
 *
 * The two cannot drift: `test/unit/crypto/password.test.ts` regenerates the list from this file,
 * compares it to the committed `.txt`, and decompresses the committed `.ts` back to the same bytes.
 *
 * **What this list is and is not.** It is a deliberately mechanical, offline-constructible list —
 * a curated core of passwords that top every published breach corpus, expanded by the handful of
 * suffixes people actually append. It is not a breach dump: shipping one would mean vendoring
 * someone else's data of unclear provenance into a GPL package, for a strength *hint*. Entries are
 * stored lowercase because the lookup lowercases and de-leets its input first, which covers
 * `Password1`, `P@ssw0rd1` and friends without four times the bytes.
 */

import { gzipSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TXT_PATH = join(REPO_ROOT, 'src', 'crypto', 'data', 'common-passwords.txt');
const TS_PATH = join(REPO_ROOT, 'src', 'crypto', 'data', 'common-passwords.ts');

/** Alphabetic stems that get the suffix expansion below. */
// prettier-ignore
const STEMS = [
  // people
  'aaron', 'abigail', 'adam', 'aiden', 'alex', 'alexis', 'alice', 'amanda', 'amber', 'amelia',
  'andrea', 'andrew', 'angela', 'anthony', 'ashley', 'austin', 'ava', 'barbara', 'ben', 'brandon',
  'brian', 'brittany', 'caroline', 'charlie', 'charlotte', 'chelsea', 'chris', 'connor', 'courtney',
  'craig', 'daniel', 'danielle', 'david', 'dean', 'destiny', 'dylan', 'elizabeth', 'emily', 'emma',
  'eric', 'ethan', 'george', 'grace', 'hannah', 'harper', 'harry', 'heather', 'helen', 'isabella',
  'jack', 'jacob', 'james', 'jasmine', 'jason', 'jennifer', 'jessica', 'john', 'jordan', 'joseph',
  'joshua', 'justin', 'katie', 'kayla', 'kevin', 'kimberly', 'kyle', 'laura', 'lauren', 'liam',
  'logan', 'lucas', 'luke', 'maria', 'mark', 'martin', 'mason', 'matthew', 'megan', 'melissa',
  'michael', 'michelle', 'morgan', 'natalie', 'nathan', 'nicole', 'noah', 'oliver', 'olivia',
  'patrick', 'paul', 'peter', 'rachel', 'rebecca', 'richard', 'robert', 'ryan', 'samantha', 'sarah',
  'scott', 'sean', 'simon', 'sophie', 'stephanie', 'steven', 'susan', 'sydney', 'taylor', 'thomas',
  'tyler', 'victoria', 'william',
  // words people reach for
  'access', 'admin', 'angel', 'apple', 'arsenal', 'autumn', 'baby', 'bacon', 'banana', 'barcelona',
  'baseball', 'basketball', 'batman', 'bear', 'beer', 'birthday', 'boss', 'boston', 'brooklyn',
  'bubbles', 'buddy', 'bulldog', 'butterfly', 'camaro', 'candy', 'captain', 'castle', 'cheese',
  'cherry', 'chicago', 'chicken', 'chocolate', 'coffee', 'computer', 'cookie', 'corvette', 'cowboy',
  'cricket', 'crystal', 'dakota', 'dance', 'diamond', 'dolphin', 'donald', 'dragon', 'dream',
  'eagle', 'england', 'falcon', 'family', 'ferrari', 'flower', 'football', 'forest', 'forever',
  'freedom', 'friday', 'friend', 'garden', 'ginger', 'golden', 'google', 'guitar', 'hammer',
  'happy', 'harley', 'heaven', 'hello', 'hockey', 'honey', 'hunter', 'iloveyou', 'internet',
  'iphone', 'jesus', 'jupiter', 'killer', 'kitten', 'ladybug', 'lemon', 'letmein',
  'liberty', 'lightning', 'lion', 'liverpool', 'london', 'love', 'lucky', 'madrid', 'magic',
  'mango', 'manchester', 'marine', 'mario', 'master', 'matrix', 'maverick', 'melody', 'mercedes',
  'midnight', 'minecraft', 'money', 'monkey', 'monday', 'moon', 'morning', 'mother', 'mountain',
  'mustang', 'music', 'ninja', 'nintendo', 'ocean', 'orange', 'panther', 'paradise', 'password',
  'peanut', 'pepper', 'phoenix', 'piano', 'pikachu', 'pirate', 'pizza', 'pokemon', 'porsche',
  'princess', 'purple', 'rabbit', 'rainbow', 'ranger', 'river', 'rocket', 'sailor', 'samsung',
  'samurai', 'scooter', 'secret', 'shadow', 'silver', 'sister', 'skittles', 'snake', 'soccer',
  'soldier', 'sonic', 'spider', 'spiderman', 'spring', 'starwars', 'storm', 'sugar', 'summer',
  'sunday', 'sunflower', 'sunshine', 'superman', 'tennis', 'thunder', 'tiger', 'tigger', 'toyota',
  'turtle', 'unicorn', 'vampire', 'victory', 'viking', 'warrior', 'welcome', 'whatever', 'whisky',
  'windows', 'winter', 'wizard', 'wolf', 'yamaha', 'yankees', 'yellow', 'zombie',
];

/** Suffixes that turn a stem into the form people actually type at a password field. */
const SUFFIXES = ['', '1', '12', '123', '1234', '!', '2024'];

/** Entries that are not a stem-plus-suffix: keyboard walks, digit runs, set phrases, leet forms. */
// prettier-ignore
const LITERALS = [
  '000000', '00000000', '01234567', '012345678', '0123456789', '10203040', '11111',
  '111111', '11111111', '112233', '121212', '123123', '1234', '12345', '123456', '1234567',
  '12345678', '123456789', '1234567890', '123456a', '123abc', '123qwe', '131313', '1q2w3e',
  '1q2w3e4r', '1q2w3e4r5t', '1qaz2wsx', '1qazxsw2', '2000', '2001', '2020', '2021', '2022', '2023',
  '2024', '2025', '222222', '232323', '252525', '333333', '369369', '444444', '456789', '555555',
  '654321', '666666', '696969', '7777777', '777777', '789456', '888888', '987654321', '999999',
  'aaaaaa', 'abc123', 'abcd1234', 'abcdef', 'abcdefg', 'adminadmin', 'asdasd', 'asdf', 'asdfgh',
  'asdfghjk', 'asdfghjkl', 'azerty', 'azertyuiop', 'changeme', 'default', 'dragon123', 'flowerpot',
  'football1', 'fuckyou', 'guest', 'iloveu', 'letmein1', 'letmein123', 'login', 'lovely',
  'lovers', 'mypassword', 'newpassword', 'nopassword', 'p@55w0rd', 'p@ssw0rd', 'p@ssword',
  'pa55w0rd', 'pass', 'pass123', 'pass1234', 'passw0rd', 'password!', 'password01', 'password1!',
  'passwort', 'poiuyt', 'poiuytrewq', 'qazwsx', 'qazwsxedc', 'qwaszx', 'qwe123', 'qwer1234',
  'qwerty', 'qwerty1', 'qwerty12', 'qwerty123', 'qwerty1234', 'qwertyui', 'qwertyuiop', 'root',
  'rootroot', 'secret1', 'sunshine1', 'superuser', 'temp', 'temp123', 'test', 'test123',
  'test1234', 'testing', 'testtest', 'trustno1', 'user', 'user123', 'welcome1', 'welcome123',
  'whatever1', 'zaq12wsx', 'zxcasd', 'zxcvbn', 'zxcvbnm', 'zzzzzz',
];

/** Build the list: deterministic, deduplicated, sorted, lowercase. */
export function buildList() {
  const entries = new Set();
  for (const stem of STEMS) {
    for (const suffix of SUFFIXES) entries.add(stem + suffix);
  }
  for (const literal of LITERALS) entries.add(literal);
  return [...entries]
    .map((entry) => entry.toLowerCase())
    .filter((entry) => /^[\x20-\x7e]+$/.test(entry))
    .sort();
}

/** The exact contents of the committed `.txt`: one entry per line, trailing newline, LF. */
export function renderTxt(list) {
  return list.join('\n') + '\n';
}

/** The exact contents of the committed `.ts`. */
export function renderTs(list) {
  const gz = gzipSync(Buffer.from(renderTxt(list), 'utf8'), { level: 9 });
  const base64url = gz
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const wrapped = (base64url.match(/.{1,96}/g) ?? []).map((line) => `  '${line}' +`);
  wrapped[wrapped.length - 1] = wrapped.at(-1).replace(/ \+$/, ';');
  return `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Run \`node scripts/gen-common-passwords.mjs\` to regenerate this from
 * \`src/crypto/data/common-passwords.txt\`, which is the human-readable source of truth.
 *
 * The list ships gzipped and base64url-encoded (ARCHITECTURE §4.6): it is inert data, decompressed
 * lazily by \`src/crypto/password.ts\` the first time a password is scored, and never fetched.
 */

/** Number of entries in the list. */
export const COMMON_PASSWORD_COUNT = ${list.length};

/** gzip of the newline-separated list, base64url, unpadded. */
export const COMMON_PASSWORDS_GZ =
${wrapped.join('\n')}
`;
}

function main() {
  const list = buildList();
  writeFileSync(TXT_PATH, renderTxt(list), 'utf8');
  writeFileSync(TS_PATH, renderTs(list), 'utf8');
  const shipped = Buffer.byteLength(readFileSync(TS_PATH, 'utf8'), 'utf8');
  process.stdout.write(`${list.length} entries → ${TXT_PATH}\n${shipped} bytes → ${TS_PATH}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
