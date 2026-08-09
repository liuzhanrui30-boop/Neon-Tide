import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const outputDirectory = path.resolve(process.argv[2] ?? 'dist-unminified');
const html = await readFile(path.join(outputDirectory, 'index.html'), 'utf8');
const source = html.match(/<script[^>]+type="module"[^>]+src="([^"]+)"/)?.[1];
assert.ok(source?.startsWith('./assets/'), 'production entry must retain relative subpath-safe asset URLs');
const entryPath = path.join(outputDirectory, source.replace(/^\.\//, ''));
const entryBytes = (await stat(entryPath)).size;
assert.ok(entryBytes < 500_000, `unminified main entry must be <500kB, received ${entryBytes} bytes`);

const assets = await readdir(path.join(outputDirectory, 'assets'));
for (const chunk of ['chapter-data-city', 'chapter-star-forge', 'chapter-void-cathedral', 'runtime-legacy', 'gameplay-core']) {
  assert.ok(assets.some((file) => file.startsWith(`${chunk}-`) && file.endsWith('.js')), `missing build chunk: ${chunk}`);
}
console.log(JSON.stringify({ outputDirectory, entry: path.basename(entryPath), entryBytes, assets: assets.filter((file) => file.endsWith('.js')).sort() }));
