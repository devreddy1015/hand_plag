// Collects the licence of every bundled @fontsource font into
// public/font-licenses.txt, which ships with the app. The SIL OFL and
// Apache 2.0 both ask for the licence to travel with the fonts.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const dir = join(root, 'node_modules', '@fontsource');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const used = Object.keys(pkg.dependencies).filter((d) => d.startsWith('@fontsource/'));

const sections = used.sort().map((name) => {
  const base = join(dir, name.split('/')[1]);
  const meta = JSON.parse(readFileSync(join(base, 'metadata.json'), 'utf8'));
  const license = readFileSync(join(base, 'LICENSE'), 'utf8').trim();
  const rule = '='.repeat(72);
  const attribution = meta.license?.attribution ? `${meta.license.attribution}\n` : '';
  return `${rule}\n${meta.family} (${meta.license?.type ?? 'see below'})\n${attribution}${rule}\n\n${license}\n`;
});

mkdirSync(join(root, 'public'), { recursive: true });
writeFileSync(
  join(root, 'public', 'font-licenses.txt'),
  `Fonts bundled with Handscript\n\nThese fonts are distributed under their own licences, reproduced below.\n\n${sections.join('\n')}`,
);
console.log(`font-licenses.txt: ${used.length} fonts`);

