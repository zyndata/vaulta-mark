# Contributing to VaultaMark

Thanks for looking. VaultaMark is a security tool, so a few of the rules below are stricter than you
may be used to. They exist to keep the extension auditable and its threat model honest — not to make
contributing tedious.

> **VaultaMark has a single maintainer, and contributions are open**
> ([PLAN.md §2.5, D36](PLAN.md#25-project--process)). Two things follow, and it is fairer to say both
> up front than to let you discover them from a stale pull request.
>
> **Issues and Discussions are the cheap door.** A bug report, a question, or "is this supposed to
> work like that?" costs you five minutes and is genuinely useful. Start there.
>
> **A pull request is read on its merits, and review latency is one person's.** There is no roadmap
> soliciting work and no `good first issue` queue pretending otherwise. Small, focused changes —
> a bug with the test that catches it, a doc that has gone out of date — are the ones most likely to
> land quickly. **For anything larger, open an issue first**; the rules in this document are
> non-negotiable and it is better to find that out before you have written the code than after.
>
> This document was written in Phase 0, while the repository was still private, because rules like
> these are only worth anything if they were followed from the first commit rather than adopted at
> publication. That is why the history reads as though it always expected an audience.

Before anything else, please read:

- [PLAN.md](PLAN.md) — goals, decisions, the hard invariants, and the phased build order.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — normative specs for crypto, vault format, storage,
  and sync.
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — how we behave here.

**Security vulnerabilities do not go in issues or pull requests.** Report them privately: see
[SECURITY.md](SECURITY.md).

---

## Ground rules that are not negotiable

These are the [hard invariants](PLAN.md#4-hard-invariants). They are enforced in CI by
`npm run verify:invariants`, not by reviewer goodwill. A change that needs one of them relaxed is the
wrong change; open an issue and we will find another way.

1. **No remote code.** No `<script src="http…">`, no remote `import()`, no `eval`, no `new Function`,
   no CDN, no WASM. Everything executable ships inside the package.
2. **Strict CSP**, exactly `script-src 'self'; object-src 'self'; frame-ancestors 'none'`.
3. **No absolute URLs** outside `build/url-allowlist.json`.
4. **No network traffic** except the user's own Google Drive and Google OAuth, and only when they
   have enabled Drive sync. Browsing the vault makes zero requests. **No telemetry, no analytics, no
   error reporting — ever.**
5. **Vault items are never stored in `chrome.bookmarks`.** That is the entire point of the product.
6. **No plaintext vault content** in `storage.local`, `storage.sync`, or on Drive.
7. **Locked means locked.** After `lock()`, `chrome.storage.session` is empty and no module holds a
   key or a decrypted item.
8. **Permissions never grow silently.** `build/permissions.lock.json` and `CHANGELOG.md` change in
   the same commit as the manifest.

Two more, about code you write:

- **Never log** a password, key, URL, title, note, or tag — not even at debug level. The
  "copy diagnostics" feature is redacted by design.
- **Everything from a web page is hostile**: Open Graph metadata, image URLs, imported bookmark
  files. Validate before use.

## Runtime dependencies: zero, by default

VaultaMark ships with **no runtime npm dependencies**. WebCrypto, `CompressionStream`,
`OffscreenCanvas`, `crypto.randomUUID`, and `structuredClone` cover what the extension needs.

Every runtime dependency is supply-chain risk in a tool whose job is to hold secrets. If you believe
one is genuinely necessary, that is a discussion before it is a pull request:

1. Open an issue making the written case — what it does, why the platform cannot, how large it is,
   who maintains it, and its transitive dependency count.
2. Include a bundle-size measurement, before and after.
3. If accepted, it is recorded in `docs/ARCHITECTURE.md` §Dependencies in the same change.

**Dev dependencies are unrestricted** — they never reach a user's browser.

## Crypto and vault-format changes

**Do not open a pull request touching `src/crypto/**` or the vault format without a linked issue.**
Discuss it first. A crypto change that arrives as an unannounced diff will be closed with a request
to open the issue, regardless of merit.

When such a change is agreed:

- It is **spec-first**: `docs/ARCHITECTURE.md` is updated in the same change as the code.
- Format changes bump `SCHEMA_VERSION` and land with a migration **and** a fixture.
- Known-answer tests against committed vectors, not just round-trips.
- `src/crypto/` is the only place `crypto.subtle` may appear, and it imports nothing else from the
  project. ESLint enforces both.

## Branching and commits

**`dev` is where development happens. `main` is release-only** — it receives a `--no-ff` merge from
`dev` at release time and nothing else. Never commit to `main`.

Full model: [docs/RELEASE.md §1](docs/RELEASE.md#1-branching-model).

- Maintainer work lands as direct commits on `dev`, one per logical unit.
- Outside contributions arrive as pull requests **targeting `dev`**, where CI gates them.
- Short-lived `feat/*` branches are optional, for work risky enough to want a clean revert point.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add tag filter to the manager search box
fix: keep the autolock alarm armed across a service-worker restart
docs: correct the capacity math in ARCHITECTURE §5.3
test: add hostile-input table for imported bookmark files
chore: bump vitest
ci: run codeql weekly
```

`feat:` → **Added**, `fix:` → **Fixed**, `perf:`/`refactor:` → **Changed**, and `feat!:` or a
`BREAKING CHANGE:` footer forces a major version bump. Update `CHANGELOG.md` under `## [Unreleased]`
in the **same commit** as any user-visible change.

## Developer Certificate of Origin

Contributions are accepted under the [DCO 1.1](https://developercertificate.org/). By signing off you
state that you wrote the contribution, or otherwise have the right to submit it under GPL-3.0-only,
and that you understand the contribution and your sign-off are public.

Add a sign-off line to every commit:

```
Signed-off-by: Your Name <your.email@example.com>
```

`git commit -s` adds it for you. Use your real name and a real address; anonymous sign-offs are not
accepted. Contributions are licensed to the project under **GPL-3.0-only** — the same terms as the
rest of the code. There is no CLA and no copyright assignment.

## Running the project

**Requirements:** Node 24 LTS (the version in [`.nvmrc`](.nvmrc) — `nvm use` picks it up) and npm.
Nothing else.

```bash
npm ci                 # install dev dependencies from the lockfile

npm run dev            # watch build; load dist/ unpacked in chrome://extensions
npm run build          # production build → dist/

npm run test           # unit + integration (Vitest)
npm run test:watch     # Vitest in watch mode
npm run test:e2e       # Playwright, against a real Chromium with the extension loaded
npm run type-check     # tsc --noEmit
npm run lint           # ESLint
npm run format         # Prettier

npm run verify         # lint + type-check + test + build + invariant scan  ← the real gate
```

**Run `npm run verify` before every push.** CI runs on every push, but GitHub can only *require* a
status check on a pull request — so for direct pushes CI is the backstop, and your local run is the
gate. This is a deliberate trade, explained in
[docs/BRANCH_PROTECTION.md](docs/BRANCH_PROTECTION.md).

> The toolchain and these scripts land in **Phase 1**. Until then the repository holds documentation
> and governance files only, and there is nothing to install or run.

To load the extension: build, then `chrome://extensions` → enable Developer mode → **Load unpacked**
→ select `dist/`. To use "open in incognito" while developing, also enable **Allow in incognito** on
the extension's details page.

## Testing expectations

- **Vitest** for unit and integration tests; **Playwright** for E2E. `chrome.*` is mocked in
  `test/mocks/chrome.ts`.
- **Coverage gates:** 90 % lines / 85 % branches on `src/{crypto,vault,storage,sync}/**`, 70 %
  global. Thresholds ratchet up, never down.
- The merge engine gets table tests **and** property tests (no loss, idempotent, order-independent,
  convergent).
- Anything consuming page-derived data gets a **hostile input table**, not a happy-path test.
- A bug fix comes with the test that would have caught it.

## Style

- **Strict TypeScript**: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. No `any`
  without an adjacent comment justifying it.
- **Typed errors** from the project taxonomy — never a bare `Error` across a module boundary.
- Messages between contexts are a **discriminated union** in `src/shared/messages.ts`; no ad-hoc
  string message types.
- **No user-facing string outside `_locales/en/messages.json`.**
- Dependency direction is one-way and ESLint-enforced:
  `ui → shared → vault → crypto`, with `storage → sync → background` feeding in. `src/vault/` is
  pure: no I/O, no `chrome.*`.
- Comments explain **why**, not what. Prettier decides formatting; do not argue with it.

## Pull-request checklist

The [template](.github/PULL_REQUEST_TEMPLATE.md) asks you to confirm:

- which phase the work belongs to (or that it is outside the phase plan);
- tests added or updated, and `npm run verify` green locally;
- invariants unaffected, or re-verified if touched;
- permissions unchanged, or `build/permissions.lock.json` updated with a CHANGELOG entry;
- `CHANGELOG.md` updated under `## [Unreleased]`;
- docs updated — a change in behaviour without a change to the doc describing it is incomplete.

Keep pull requests focused. A diff that does one thing gets reviewed; a diff that does five things
gets postponed.
