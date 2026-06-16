import esbuild from 'esbuild';
import builtins from 'builtin-modules';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

import postcss from 'postcss';
import tailwindcss from '@tailwindcss/postcss';
import prefixSelector from 'postcss-prefix-selector';

const here = dirname(fileURLToPath(import.meta.url));
// The shared UI lives at the repo root in src/. The plugin sources import it
// through the `@app/*` path alias (see tsconfig.json); mirror that here so
// esbuild can resolve those imports to the real files.
const repoSrc = resolve(here, '../../src');
// The Rust→WASM core, emitted by `wasm-pack build packages/core --target web
// --out-dir pkg`. `pkg/` is git-ignored (generated); run that command (the
// `obsidian` CI job does) before building. We alias the package name to it so
// `core.ts` can `import … from 'annado-core'`.
const corePkg = resolve(here, '../../packages/core/pkg');

const prod = process.argv[2] === 'production';

const banner = `/*
This file is bundled by esbuild from apps/obsidian/src/main.ts.
It is the Obsidian plugin entry point. Do not edit directly.
*/`;

// ---------------------------------------------------------------------------
// CSS pipeline
//
// Obsidian loads a single `styles.css` next to `main.js`. We compile the
// scoped Tailwind stylesheet (apps/obsidian/src/styles.css) through PostCSS:
//
//   1. @tailwindcss/postcss        — expand Tailwind + scoped-preflight plugin.
//   2. postcss-prefix-selector     — confine every selector under `.annado-root`
//                                    so utilities can't leak into Obsidian and
//                                    Obsidian's theme can't easily override us.
//   3. inline the bundled font     — replace the woff2 placeholder with a
//                                    base64 data URI so styles.css is
//                                    self-contained (no external font asset).
// ---------------------------------------------------------------------------

const SCOPE = '.annado-root';
const cssEntry = resolve(here, 'src/styles.css');
const cssOut = resolve(here, 'styles.css');
const interWoff2 = resolve(
  here,
  'node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2',
);

/**
 * Decide how a generated selector should be scoped under `.annado-root`.
 * Returns the rewritten selector, or `undefined` to defer to the default
 * `<prefix> <selector>` behaviour of postcss-prefix-selector.
 */
function scopeSelector(selector) {
  const trimmed = selector.trim();

  // Already scoped by hand in styles.css — leave it untouched.
  if (trimmed.includes('annado-root')) return selector;

  // Document-level selectors emitted by Tailwind's theme/preflight. The
  // scoped-preflight plugin already moves most reset rules onto the container,
  // but `:root` / `:host` (theme tokens) and bare `html`/`body` must collapse
  // onto `.annado-root` itself rather than become `.annado-root :root`.
  if (/^(:root|:host|html|body)$/.test(trimmed)) return SCOPE;

  // The universal selector becomes `.annado-root *` (descendants only), which
  // prefix-selector produces by default — fall through.
  return undefined;
}

async function buildCss() {
  const [css, fontBuf] = await Promise.all([
    readFile(cssEntry, 'utf8'),
    readFile(interWoff2),
  ]);

  const result = await postcss([
    tailwindcss(),
    prefixSelector({
      prefix: SCOPE,
      // Don't touch @keyframes step selectors ("from"/"to"/"0%").
      includeFiles: undefined,
      transform(prefix, selector, prefixedSelector) {
        const scoped = scopeSelector(selector);
        return scoped !== undefined ? scoped : prefixedSelector;
      },
    }),
  ]).process(css, { from: cssEntry, to: cssOut });

  const fontDataUri = `data:font/woff2;base64,${fontBuf.toString('base64')}`;
  const finalCss = result.css.replace('__ANNADO_INTER_WOFF2__', fontDataUri);

  await writeFile(cssOut, finalCss);
  // eslint-disable-next-line no-console
  console.log(`[css] wrote ${cssOut} (${(finalCss.length / 1024).toFixed(1)} kB)`);
}

// Rebuild styles.css on every esbuild pass so a running `dev` watch keeps the
// stylesheet in sync. In a one-shot production build this fires exactly once.
const cssPlugin = {
  name: 'annado-css',
  setup(build) {
    build.onEnd(() => buildCss());
  },
};

const context = await esbuild.context({
  banner: { js: banner },
  entryPoints: [resolve(here, 'src/main.ts')],
  outfile: resolve(here, 'main.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  // Obsidian provides `obsidian` and `electron`; Node builtins are not
  // available in the (mobile) runtime and must never be bundled.
  external: ['obsidian', 'electron', '@codemirror/*', ...builtins],
  // Match the `@app/*` tsconfig path alias for the shared UI in repo src/, and
  // resolve the WASM core package by name to its generated `pkg/` folder.
  alias: { '@app': repoSrc, 'annado-core': corePkg },
  jsx: 'automatic',
  // The shared UI imports './App.css' for its side effect; we compile a scoped
  // styles.css out-of-band (buildCss) instead, so the JS bundle ignores CSS
  // imports. The `.wasm` is inlined as base64 (decoded + instantiated in
  // core.ts) so the engine ships inside main.js with no runtime fetch (mobile).
  loader: { '.css': 'empty', '.wasm': 'base64' },
  define: { 'process.env.NODE_ENV': prod ? '"production"' : '"development"' },
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  minify: prod,
  plugins: [cssPlugin],
});

// manifest.json already lives next to the emitted main.js in this folder,
// which is exactly what Obsidian loads, so no copy step is needed.

if (prod) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
