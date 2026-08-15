#!/usr/bin/env node
/**
 * Pin the unpacked extension's id, so an OAuth client can be registered against it.
 *
 * An unpacked extension's id is derived from the path it was loaded from, so it changes when the
 * folder moves and differs on every machine. A Chrome-extension OAuth client is registered against
 * one specific id (RELEASE §5.3). Putting a public key in the manifest's `key` field freezes the id
 * to that key instead of to the path.
 *
 * This replaces the two-tool dance RELEASE §5.4 used to prescribe — `chrome.exe --pack-extension`
 * to produce a key pair, then `openssl rsa -pubout -outform DER | openssl base64 -A` to extract the
 * public half. Both steps exist only to obtain an RSA key and its SPKI DER encoding, which Node does
 * natively; neither Chrome nor OpenSSL has to be installed, and there is no `.crx` to throw away.
 * The bytes are identical either way — Chrome's `key` field has always just been base64 SPKI DER.
 *
 * **Regenerating is destructive in a way that is not obvious.** A new key is a new id, and the
 * OAuth client already registered against the old one silently stops matching: Drive fails to
 * authorise with no indication that an *id* is the reason. So an existing `VM_MANIFEST_KEY` is
 * never overwritten without `--force`, and `--force` prints what it is about to invalidate.
 *
 * Writes two files and touches nothing else:
 *
 *   .env.local                      `VM_MANIFEST_KEY=…`, every other line left exactly as it was
 *   ~/.vaulta-mark/dev-unpacked.pem the private half — not needed to load unpacked, only to pack
 *                                   a .crx
 *
 * The private half is deliberately written **outside the repository**, not beside `.env.local`.
 * `.gitignore` covers `*.pem` and always did, but a gitignore entry is one `git add -f`, one
 * careless edit of that file, or one directory-wide backup away from putting a signing key into a
 * public history — and GitHub's push protection does not reliably flag PEM material. Keeping it in
 * a different directory removes the class of accident rather than guarding against it. Override the
 * directory with `VM_DEV_KEY_DIR` if the home directory is not where you want it.
 *
 * Usage:  node scripts/dev-key.mjs [--force]     (or: npm run dev-key)
 */

import { generateKeyPairSync, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = join(ROOT, '.env.local');
const KEY_DIR = process.env['VM_DEV_KEY_DIR'] || join(homedir(), '.vaulta-mark');
const PEM_FILE = join(KEY_DIR, 'dev-unpacked.pem');
const KEY_VAR = 'VM_MANIFEST_KEY';

/**
 * Chrome's extension id: the first 16 bytes of the SHA-256 of the SPKI DER, hex-encoded, with each
 * hex digit shifted from `0-9a-f` into `a-p`. It is not base16 and not base32 — the alphabet exists
 * because an id has to be a valid hostname component, and digits were undesirable at the front.
 */
function extensionId(derPublicKey) {
  const digest = createHash('sha256').update(derPublicKey).digest('hex').slice(0, 32);
  return [...digest].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

/**
 * Replace the value of one variable, leaving the rest of the file byte-for-byte alone.
 *
 * `.env.local` is hand-edited — it holds `VM_OAUTH_CLIENT_ID` and the comments explaining both
 * values — so rewriting the whole file from a template would destroy work. A commented-out
 * assignment is treated as absent and replaced in place, which is what the `.env.example` shape
 * produces after `cp`.
 */
function upsert(contents, name, value) {
  const assignment = `${name}=${value}`;
  const line = new RegExp(`^[ \\t]*#?[ \\t]*${name}=.*$`, 'm');
  if (line.test(contents)) return contents.replace(line, assignment);
  return `${contents.replace(/\n*$/, '')}\n${assignment}\n`;
}

function readExisting() {
  if (!existsSync(ENV_FILE)) return { contents: '', current: null };
  const contents = readFileSync(ENV_FILE, 'utf8');
  const match = /^[ \t]*VM_MANIFEST_KEY=(.+)$/m.exec(contents);
  return { contents, current: match?.[1]?.trim() || null };
}

function main() {
  const force = process.argv.includes('--force');
  const { contents, current } = readExisting();

  if (current && !force) {
    console.error(
      [
        `${KEY_VAR} is already set in .env.local, pinning this extension to id:`,
        ``,
        `    ${extensionId(Buffer.from(current, 'base64'))}`,
        ``,
        `Refusing to replace it. A new key means a new id, and the OAuth client registered`,
        `against the current one would stop matching — Drive would fail to authorise without`,
        `ever saying that the id is why.`,
        ``,
        `If that is genuinely what you want:  node scripts/dev-key.mjs --force`,
        `You will then need to update the Item ID on the OAuth client (RELEASE §5.3).`,
      ].join('\n'),
    );
    process.exit(1);
  }

  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const key = publicKey.toString('base64');
  const id = extensionId(publicKey);

  mkdirSync(KEY_DIR, { recursive: true });
  writeFileSync(PEM_FILE, privateKey);
  writeFileSync(ENV_FILE, upsert(contents, KEY_VAR, key));

  const lines = [``, `Extension id pinned:`, ``, `    ${id}`, ``];
  if (current) {
    lines.push(
      `Replaced the previous key. The OAuth client's Item ID must be changed to the above,`,
      `or Drive will not authorise.`,
      ``,
    );
  }
  lines.push(
    `Wrote  .env.local  ${KEY_VAR}`,
    `Wrote  ${PEM_FILE}`,
    `       the private half — kept outside the repository, only needed to pack a .crx`,
    ``,
    `The key reaches the manifest in DEVELOPMENT builds only, because the Store assigns the`,
    `real id and a disagreeing "key" breaks the upload:`,
    ``,
    `    npm run dev                        stable id, watch build`,
    `    npx vite build --mode development  stable id, one shot`,
    `    npm run build                      no key, by design`,
    ``,
    `Next, for Drive (RELEASE §5.1–5.3): create a Google Cloud project, enable the Drive API,`,
    `set the consent screen scope to drive.file and nothing wider, then create an OAuth client`,
    `of type "Chrome Extension" with the id above as its Item ID. Paste the client id into`,
    `.env.local as VM_OAUTH_CLIENT_ID. Settings → Sync shows the same id and steps on screen.`,
    ``,
  );
  console.log(lines.join('\n'));
}

main();
