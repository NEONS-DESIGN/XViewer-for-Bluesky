import { test } from 'node:test';
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import { CONTENT_ENTRY_POINTS, INJECT_ENTRY_POINTS, POPUP_ENTRY_POINTS, outputNamesOf } from '../../scripts/entry-points.mjs';
import { staticFilesFor } from '../../scripts/static-files.mjs';

/** 出力先。置き場所の違いは相対パスの突き合わせに影響しないので適当な名前でよい。 */
const OUT_DIR = 'out';

/**
 * manifest が参照するファイル (出力先からの相対パス) を集める。
 * @param {object} manifest src/manifest.json の中身
 * @returns {string[]} 参照されているパス
 */
function referencedPaths(manifest) {
	const paths = [];
	for (const script of manifest.content_scripts ?? []) {
		paths.push(...(script.js ?? []), ...(script.css ?? []));
	}
	if (manifest.action?.default_popup) {
		paths.push(manifest.action.default_popup);
	}
	paths.push(...Object.values(manifest.icons ?? {}));
	paths.push(...Object.values(manifest.action?.default_icon ?? {}));
	return paths;
}

test('manifest が参照するファイルはすべてビルドが出力する', async () => {
	const manifest = JSON.parse(await readFile('src/manifest.json', 'utf8'));
	const produced = new Set([
		...outputNamesOf(CONTENT_ENTRY_POINTS),
		...outputNamesOf(INJECT_ENTRY_POINTS),
		...outputNamesOf(POPUP_ENTRY_POINTS),
		...staticFilesFor(OUT_DIR).map(([, to]) => to.slice(OUT_DIR.length + 1)),
	]);
	const referenced = referencedPaths(manifest);
	assert.ok(referenced.length > 0, 'manifest から参照を 1 件も読めない');
	for (const path of referenced) {
		assert.ok(produced.has(path), `${path} をビルドは出力しない`);
	}
});
