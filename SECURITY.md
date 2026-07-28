# Security Policy

VaultaMark stores people's bookmarks under a password they cannot recover. Security reports are taken
seriously and answered.

> **Current status:** the repository is **private** and there is no released version yet. This policy
> is in force from the first public release; until then the advisory form below is reachable only by
> accounts with access to the repository, and GitHub's private vulnerability reporting cannot be
> switched on at all while a repository is private. If you are reading this without repository
> access, nothing here is live yet.

---

## Reporting a vulnerability

**Report privately, through GitHub Security Advisories:**

👉 <https://github.com/zyndata/vaulta-mark/security/advisories/new>
(repository → **Security** → **Advisories** → **Report a vulnerability**)

**Please do not open a public issue, pull request, or discussion for a security problem.** Public
issue templates route security reports to the advisory form for this reason. A public report starts
the clock for every user of the extension before a fix exists.

If GitHub advisories are unavailable to you, say so in a public issue **without any technical
detail** — "I have a security report and cannot use the advisory form" — and a private channel will
be arranged.

### What to include

- What the issue is, and what an attacker gains.
- Reproduction steps, or a proof of concept.
- The affected version (extension version, or commit SHA if built from source), Chrome version, and
  operating system.
- Whether Drive sync was connected, and which sync tier was active.
- Whether you have disclosed this anywhere else, and any deadline you are working to.

**Never include real vault data, a real master password, or a real exported `.vmv` file.** Synthetic
reproductions only. If a report needs a vault to demonstrate, create a throwaway one.

### What to expect

| | Target |
| --- | --- |
| Acknowledgement | within **3 business days** |
| Initial assessment (severity, whether it is in scope) | within **10 business days** |
| Fix or a documented mitigation plan | within **90 days** of acknowledgement |
| Public disclosure | after a fix ships, or at **90 days**, whichever is first |

This is a **coordinated disclosure** policy on a **90-day** clock. If a fix will take longer, that
will be said plainly and a new date agreed — silence is not an answer you should have to accept. If a
vulnerability is being actively exploited, disclosure may be accelerated so users can protect
themselves.

Reporters are credited in the advisory and in `CHANGELOG.md` unless they ask not to be. There is no
bug-bounty programme and no payment; this is a personal, unfunded project.

## Supported versions

| Version | Supported |
| --- | --- |
| Latest release | ✅ Security fixes |
| Anything older | ❌ Upgrade first |
| `dev` branch | ⚠️ Reports welcome; it is a development branch and may be broken by design |

Only the latest released version is supported. Fixes ship as a new patch release on the Chrome Web
Store — the Store has **no rollback**, so "upgrade" is genuinely the only remedy. There is no
backporting to earlier versions.

## Scope

**In scope** — anything that breaks a claim the product makes:

- Recovering vault content (titles, URLs, folders, tags, notes, thumbnails) without the master
  password, from `storage.local`, `chrome.storage.sync`, a Drive file, or an exported `.vmv`.
- A vaulted URL reaching `chrome.bookmarks`, the omnibox, or address-bar autocomplete.
- A key or plaintext surviving `lock()`, or reachable from a content script or another extension.
- Any network request the extension makes that is not to the user's own Google Drive or Google OAuth,
  or any request at all while Drive sync is off.
- Weaknesses in the key hierarchy, KDF parameters, envelope format, or AAD binding
  ([docs/ARCHITECTURE.md §4](docs/ARCHITECTURE.md#4-cryptography)).
- The merge engine losing or silently overwriting user data.
- Plaintext, keys, or URLs appearing in logs or in the "copy diagnostics" output.
- Data-exfiltration or privilege-escalation paths through the manifest, CSP, or permission set.

**Out of scope** — these are documented design limits, not bugs
([docs/ARCHITECTURE.md §8](docs/ARCHITECTURE.md#8-threat-model)):

- A compromised operating system or user account, a keylogger, or physical access while the vault is
  unlocked.
- Another extension with `debugger` or devtools access to our pages.
- A weak master password. There is a 10-character floor and a strength meter; the rest is the user's.
- The plaintext vault header (KDF parameters, salt, wrapped DEK, revision counters). It must be
  readable to derive a key at all. It leaks the *existence* and approximate *size* of a vault, and
  nothing about its contents.
- Ciphertext length. Mitigated by 256-byte padding, not eliminated.
- The existence, name, and timestamps of the Drive file, and the fact that you sync at all.
- Best-effort memory wiping. JavaScript gives no guarantee that a key is gone from memory —
  `src/crypto/wipe.ts` zeroes buffers we hold, but engine-internal copies, garbage-collector timing,
  and OS swap are outside our reach. This is stated in the code and here, deliberately.
- Denial of service against the user's own browser, and vulnerabilities in Chrome itself (report
  those to Google).
- Reports produced solely by an automated scanner with no demonstrated impact.

## There is no password recovery. None.

This is worth stating in a security policy because it is a security property, not an oversight.

The master password is **never stored and never transmitted**. There is no recovery key, no escrow,
no reset link, no backdoor, no support path. **The maintainers cannot recover a vault** — not for
you, not for law enforcement, not for anyone. If the password is forgotten, the vault is permanently
unreadable.

Use the encrypted export as your backup, and keep the password somewhere you trust.

Any "recovery" offer you receive for VaultaMark is a scam by construction.

## Security properties in one paragraph

The master password is stretched with PBKDF2-HMAC-SHA256 (600,000 iterations, per-vault random salt)
into a key-encryption key, which unwraps a random 256-bit data-encryption key; per-purpose subkeys are
derived from it with HKDF-SHA256. Everything — titles, URLs, folder names, tags, notes, thumbnails —
is encrypted with AES-256-GCM using a 96-bit random IV and additional authenticated data that binds
each ciphertext to its schema version, purpose, and slot. There is no password verifier: a wrong
password fails the GCM tag check. Plaintext is compressed and padded to a 256-byte boundary before
encryption. The unlocked key lives in `chrome.storage.session` (memory-only, cleared when the browser
exits), never on disk. Full specification:
[docs/ARCHITECTURE.md §4](docs/ARCHITECTURE.md#4-cryptography).

## No warranty

VaultaMark is free software distributed under [GPL-3.0-only](LICENSE). As stated in sections 15 and
16 of that license:

> **THERE IS NO WARRANTY FOR THE PROGRAM, TO THE EXTENT PERMITTED BY APPLICABLE LAW.** EXCEPT WHEN
> OTHERWISE STATED IN WRITING THE COPYRIGHT HOLDERS AND/OR OTHER PARTIES PROVIDE THE PROGRAM "AS IS"
> WITHOUT WARRANTY OF ANY KIND, EITHER EXPRESSED OR IMPLIED, INCLUDING, BUT NOT LIMITED TO, THE
> IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE. THE ENTIRE RISK AS TO
> THE QUALITY AND PERFORMANCE OF THE PROGRAM IS WITH YOU. SHOULD THE PROGRAM PROVE DEFECTIVE, YOU
> ASSUME THE COST OF ALL NECESSARY SERVICING, REPAIR OR CORRECTION.
>
> **IN NO EVENT** UNLESS REQUIRED BY APPLICABLE LAW OR AGREED TO IN WRITING WILL ANY COPYRIGHT HOLDER,
> OR ANY OTHER PARTY WHO MODIFIES AND/OR CONVEYS THE PROGRAM AS PERMITTED ABOVE, **BE LIABLE TO YOU
> FOR DAMAGES**, INCLUDING ANY GENERAL, SPECIAL, INCIDENTAL OR CONSEQUENTIAL DAMAGES ARISING OUT OF
> THE USE OR INABILITY TO USE THE PROGRAM (INCLUDING BUT NOT LIMITED TO LOSS OF DATA OR DATA BEING
> RENDERED INACCURATE OR LOSSES SUSTAINED BY YOU OR THIRD PARTIES OR A FAILURE OF THE PROGRAM TO
> OPERATE WITH ANY OTHER PROGRAMS), EVEN IF SUCH HOLDER OR OTHER PARTY HAS BEEN ADVISED OF THE
> POSSIBILITY OF SUCH DAMAGES.

Plainly: this software is provided as-is, with no warranty of any kind. The cryptography is
documented, tested against known-answer vectors, and open to audit — but it has **not** had a formal
third-party security audit. You are responsible for your own backups. Nobody is liable for lost or
unreadable vault data.

## Verifying what you install

Every release is built from a tagged commit by a GitHub Actions workflow, and the zip's SHA-256 is
published in the GitHub Release notes. The invariant scanners that prove "no remote code" are in the
repository and run on every build. See [docs/RELEASE.md](docs/RELEASE.md).

**While the repository is private, you cannot verify any of that yourself** — building from source
and comparing hashes requires the source. Independent verification becomes possible only if and when
the repository is published; until then the claims in this document are claims, and the reasonable
posture toward an unpublished security tool is skepticism.
