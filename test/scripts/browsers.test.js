import { test } from 'node:test';
import assert from 'node:assert';
import { resolveTargets, BROWSER_TARGETS } from '../../scripts/browsers.mjs';

test('引数なしなら chrome と firefox を表の順で返す', () => {
	assert.deepStrictEqual(resolveTargets([]).map((t) => t.name), ['chrome', 'firefox']);
});

test('--target=firefox は firefox だけ', () => {
	assert.deepStrictEqual(resolveTargets(['--target=firefox']).map((t) => t.name), ['firefox']);
});

test('知らない引数は投げる', () => {
	assert.throws(() => resolveTargets(['--targets=chrome']), /知らない引数/);
});

test('知らない --target は投げる', () => {
	assert.throws(() => resolveTargets(['--target=safari']), /知らない --target/);
});

test('Firefox の manifest にだけ gecko の id が入る', () => {
	const base = { manifest_version: 3, name: 'x' };
	assert.strictEqual(BROWSER_TARGETS.firefox.buildManifest(base, '3.0.0').browser_specific_settings.gecko.id, 'bluesky-extension@neonsdesign.com');
	assert.strictEqual(BROWSER_TARGETS.chrome.buildManifest(base, '3.0.0').browser_specific_settings, undefined);
	assert.strictEqual(BROWSER_TARGETS.chrome.buildManifest(base, '3.0.0').minimum_chrome_version, '120');
});
