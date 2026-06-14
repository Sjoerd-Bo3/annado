import esbuild from 'esbuild';
import builtins from 'builtin-modules';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// The shared UI lives at the repo root in src/. The plugin sources import it
// through the `@app/*` path alias (see tsconfig.json); mirror that here so
// esbuild can resolve those imports to the real files.
const repoSrc = resolve(here, '../../src');

const prod = process.argv[2] === 'production';

const banner = `/*
This file is bundled by esbuild from apps/obsidian/src/main.ts.
It is the Obsidian plugin entry point. Do not edit directly.
*/`;

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
  // Match the `@app/*` tsconfig path alias for the shared UI in repo src/.
  alias: { '@app': repoSrc },
  jsx: 'automatic',
  // PR 2 ships no styling: ignore CSS side-effect imports so they don't pull
  // raw text into the bundle. PR 4 introduces a scoped styles.css pipeline.
  loader: { '.css': 'empty' },
  define: { 'process.env.NODE_ENV': prod ? '"production"' : '"development"' },
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  minify: prod,
});

// manifest.json already lives next to the emitted main.js in this folder,
// which is exactly what Obsidian loads, so no copy step is needed.

if (prod) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
