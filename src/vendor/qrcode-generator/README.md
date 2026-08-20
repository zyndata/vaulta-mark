# qrcode-generator — vendored

`qrcode.js` is **byte-identical** to `dist/qrcode.mjs` from the npm package below, with one change
that is not to its contents: the extension. It is `.js` rather than `.mjs` so that TypeScript picks
up the hand-written `qrcode.d.ts` beside it — under `moduleResolution: bundler` a `.mjs` specifier
looks for a `.d.mts`, and a second declaration filename spelling is one more thing to know.

| | |
| --- | --- |
| Package | `qrcode-generator` |
| Version | 2.0.4 |
| File | `dist/qrcode.mjs` |
| Author | Kazuhiko Arase |
| Licence | MIT (2009) |
| Upstream | `github.com/kazuhikoarase/qrcode-generator` |
| sha256 of `qrcode.js` | `ea91d7118a5395289170da848b7c6758b996163bfbccf312591ab65a4911b7c0` |
| sha256 of the tarball | `02e2e18a99a90b02dad940851f59b7c3c5fd1ab79cbdece8595cb06328878159` |

**Why it is here and not in `dependencies`:** D4 (zero runtime dependencies) is about what the
package installs and what a supply chain can reach into. Vendored source is neither — it is read
once, reviewed as a diff, and changes only when someone changes it in a commit. The reason it is
not *written* here instead is in `docs/ARCHITECTURE.md` §15.

**Why it is unminified:** so it can be read. A project whose auditability is an argument it makes in
public does not ship 12 KB of somebody else's minified output and call it reviewed.

## Re-vendoring

```sh
npm pack qrcode-generator@<version>
tar xzf qrcode-generator-<version>.tgz
cp package/dist/qrcode.mjs src/vendor/qrcode-generator/qrcode.js
```

Then diff, update the table above, re-read `qrcode.d.ts` against the new file, and run
`npm run verify` — `scripts/check-budgets.mjs` asserts the encoder is still in a chunk of its own
rather than in an entry, which is the property a change here is most likely to break silently.

**The copyright header at the top of `qrcode.js` stays.** MIT requires it, and the minifier strips
comments from `dist/`, so the notice that ships with the package is `public/THIRD-PARTY-NOTICES.txt`
— keep the two in step.
