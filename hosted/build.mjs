// Builds dist/aurumdesk.html: one self-contained page that runs on demo data
// with no server, for hosting as a static preview.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (...p) => path.join(ROOT, ...p);

// The app imports by server URL (/shared/x.js, /overlay.js); map those to files,
// swapping the server feed for the in-browser one.
const urlImports = {
  name: 'url-imports',
  setup(b) {
    b.onResolve({ filter: /^\// }, (args) => {
      if (args.kind === 'entry-point') return undefined;
      if (args.path === '/feed.js') return { path: at('hosted/feed.js') };
      if (args.path.startsWith('/shared/')) return { path: at(args.path) };
      return { path: at('public', args.path) };
    });
  },
};

const out = await build({
  entryPoints: [at('public/app.js')],
  bundle: true,
  format: 'iife',
  minify: true,
  write: false,
  plugins: [urlImports],
});
const js = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = fs.readFileSync(at('public/style.css'), 'utf8');
const html = fs.readFileSync(at('public/index.html'), 'utf8');
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'))
  .replace(/<script[^>]*><\/script>\s*/g, '')
  .replace('<main class="layout">', `<div class="preview-note">Preview on demo prices: candles, order flow and COT are generated, not real gold data. The auto-trader runs in paper mode in this browser. Run the server version for live XAU/USD.</div>\n  <main class="layout">`);
const fonts = html.match(/<link rel="stylesheet" href="https:\/\/fonts[^>]+>/)?.[0] || '';

const page = `<title>Aurum Pulse</title>
${fonts}
<style>
${css}
:root { color-scheme: dark; }
.preview-note { max-width: 1760px; margin: 12px auto 0; padding: 8px 24px; font-size: 12px; color: var(--gold-2); }
</style>
${body.trim()}
<script src="https://unpkg.com/lightweight-charts@4.2.3/dist/lightweight-charts.standalone.production.js"></script>
<script>${js}</script>
`;
fs.mkdirSync(at('dist'), { recursive: true });
fs.writeFileSync(at('dist/aurumdesk.html'), page);
console.log(`dist/aurumdesk.html ${(page.length / 1024).toFixed(0)} KB`);
