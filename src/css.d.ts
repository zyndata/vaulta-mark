/**
 * `import './styles.css'` is a side-effect import that Vite resolves and TypeScript does not.
 *
 * TypeScript 5.9 accepts it silently. TypeScript 7 reports `TS2882` on each one — measured against
 * 7.0.2 on 2026-08-13, four errors, in `src/manager/manager.ts` and `src/popup/popup.ts` and
 * nothing else. This file is the whole fix, staged ahead of the bump so that taking it is a
 * same-day merge rather than a discovery.
 *
 * Deliberately **not** `"types": ["vite/client"]` in tsconfig, which would also declare this and a
 * great deal more. That list is scoped on purpose: `src/` ships to a browser, and `vite/client`
 * brings `import.meta.env` and Node-flavoured ambient types into a directory that must not reach
 * for either.
 *
 * The bump itself is still blocked elsewhere — `typescript-eslint` refuses to load under TS 7
 * (typescript-eslint#10940), which takes `npm run lint` and with it `npm run verify` down. Keep
 * Dependabot PR #15 parked until that ships.
 */
declare module '*.css';
