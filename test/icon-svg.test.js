import test from 'node:test';
import assert from 'node:assert';
import {readFileSync} from 'node:fs';
import {ICON_BACKGROUND, buildIconSvg} from '../scripts/icon-svg.mjs';
import {ICON_SIZES} from '../scripts/static-files.mjs';

const TOKENS_PATH = new URL('../src/common/tokens.css', import.meta.url);

test('アイコンの地の色はポップアップの --accent と同じ', () => {
	const css = readFileSync(TOKENS_PATH, 'utf8');
	const root = css.slice(css.indexOf(':root {'));
	const accent = /--accent:\s*(#[0-9a-fA-F]{6})\s*;/.exec(root)?.[1];
	assert.ok(accent, 'tokens.css に --accent が無い');
	assert.strictEqual(ICON_BACKGROUND.toLowerCase(), accent.toLowerCase());
});

test('目地を描くのは 128 だけ', () => {
	assert.doesNotMatch(buildIconSvg(48), /data-role="gutter"/);
	assert.match(buildIconSvg(128), /data-role="gutter"/);
});

test('どの寸法でも SVG の寸法と地の色が入る', () => {
	for (const size of ICON_SIZES) {
		const svg = buildIconSvg(size);
		assert.match(svg, new RegExp(`width="${size}" height="${size}"`), String(size));
		assert.ok(svg.includes(ICON_BACKGROUND), String(size));
		assert.match(svg, /viewBox="0 0 128 128"/);
	}
});

test('目地の矩形は縦 2 本・横 2 本の 4 つ', () => {
	assert.strictEqual(buildIconSvg(128).match(/data-role="gutter"/g).length, 4);
});
