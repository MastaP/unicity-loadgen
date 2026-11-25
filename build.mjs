// Bundles src/ into one self-contained index.html.
import { readFileSync, writeFileSync } from 'node:fs';

import { build } from 'esbuild';

const sdkVersion = JSON.parse(
  readFileSync(new URL('./node_modules/@unicitylabs/state-transition-sdk/package.json', import.meta.url), 'utf8'),
).version;

const result = await build({
  bundle: true,
  entryPoints: ['src/main.js'],
  format: 'iife',
  legalComments: 'none',
  minify: true,
  platform: 'browser',
  target: ['chrome116', 'firefox124', 'safari17.4'],
  write: false,
});

const code = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const template = readFileSync(new URL('./src/template.html', import.meta.url), 'utf8');
if (!template.includes('<!-- APP_SCRIPT -->')) {
  throw new Error('src/template.html has no <!-- APP_SCRIPT --> marker');
}
const html = template
  .replaceAll('__SDK_VERSION__', sdkVersion)
  .replace('<!-- APP_SCRIPT -->', () => `<script>\n${code}</script>`);
writeFileSync(new URL('./index.html', import.meta.url), html);
console.log(`index.html: ${(html.length / 1024).toFixed(0)} KiB (script ${(code.length / 1024).toFixed(0)} KiB, SDK ${sdkVersion})`);
