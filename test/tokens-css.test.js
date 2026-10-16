import test from 'node:test';
import assert from 'node:assert';
import {readFileSync} from 'node:fs';
import {readBlock, assertLightBlocksMatch} from './helpers/css-blocks.js';

const TOKENS_PATH = new URL('../src/common/tokens.css', import.meta.url);

test('tokens.css: ライトの宣言 2 か所 (data-theme と prefers-color-scheme) が同じ中身', () => {
	assertLightBlocksMatch(readFileSync(TOKENS_PATH, 'utf8'), ":root[data-theme='light']");
});

test('tokens.css: 必須トークンがダークの :root に揃っている', () => {
	const dark = readBlock(readFileSync(TOKENS_PATH, 'utf8'), ':root');
	for (const name of ['--bg', '--surface', '--fg', '--muted', '--border', '--divider',
		'--control-bg', '--control-border', '--control-hover', '--hover', '--accent',
		'--on-accent', '--danger', '--focus-ring', '--scrollbar-track', '--scrollbar-thumb']) {
		assert.ok(dark && name in dark, `${name} が無い`);
	}
	assert.strictEqual(dark['--accent'], '#006aff');
});
