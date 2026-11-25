// Bundles src/ into one self-contained index.html.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

import { build } from 'esbuild';

const sdkVersion = JSON.parse(
  readFileSync(new URL('./node_modules/@unicitylabs/state-transition-sdk/package.json', import.meta.url), 'utf8'),
).version;

const result = await build({
  bundle: true,
  entryPoints: ['src/main.js'],
  format: 'iife',
  legalComments: 'none',
  metafile: true,
  minify: true,
  platform: 'browser',
  target: ['chrome116', 'firefox124', 'safari17.4'],
  write: false,
});

/**
 * License notices of the npm packages whose code ends up in the bundle, as one
 * HTML comment: the MIT and ISC licenses require them in every copy.
 *
 * @returns {string}
 */
function thirdPartyNotices() {
  const packageDirs = new Set();
  for (const output of Object.values(result.metafile.outputs)) {
    for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
      const at = input.lastIndexOf('node_modules/');
      if (at < 0 || bytesInOutput === 0) {
        continue;
      }
      const [scopeOrName, name] = input.slice(at + 'node_modules/'.length).split('/');
      packageDirs.add(input.slice(0, at) + 'node_modules/' + (scopeOrName.startsWith('@') ? `${scopeOrName}/${name}` : scopeOrName));
    }
  }
  const sections = [...packageDirs].sort().map((dir) => {
    const pkg = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'));
    const licenseFile = readdirSync(dir).find((file) => /^(licen[cs]e|copying)(\.|$)/i.test(file));
    if (!licenseFile) {
      throw new Error(`${pkg.name} is bundled but has no license file to include`);
    }
    const text = readFileSync(`${dir}/${licenseFile}`, 'utf8').trim().replace(/--!?>/g, (end) => end.replace('>', ' >'));
    return `${pkg.name}@${pkg.version} (${pkg.license})\n\n${text}`;
  });
  return `<!--\nThird-party code bundled into this page:\n\n${sections.join('\n\n' + '='.repeat(72) + '\n\n')}\n-->\n`;
}

const code = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const template = readFileSync(new URL('./src/template.html', import.meta.url), 'utf8');
if (!template.includes('<!-- APP_SCRIPT -->')) {
  throw new Error('src/template.html has no <!-- APP_SCRIPT --> marker');
}
const html = template
  .replaceAll('__SDK_VERSION__', sdkVersion)
  .replace('<!-- APP_SCRIPT -->', () => `<script>\n${code}</script>\n${thirdPartyNotices()}`);
writeFileSync(new URL('./index.html', import.meta.url), html);
console.log(`index.html: ${(html.length / 1024).toFixed(0)} KiB (script ${(code.length / 1024).toFixed(0)} KiB, SDK ${sdkVersion})`);
