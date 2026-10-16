import test from 'node:test';
import assert from 'node:assert';
import {EXT_CONFIG} from '../src/common/config.js';
import {shouldBlur} from '../src/content/media-source.js';

const config = EXT_CONFIG.mediaGrid;

test('ぼかし対象ラベルが付いていれば true', () => {
	assert.strictEqual(shouldBlur({labels: ['porn']}, config), true);
	assert.strictEqual(shouldBlur({labels: ['graphic-media']}, config), true);
	assert.strictEqual(shouldBlur({labels: ['other', 'nudity']}, config), true);
});

test('対象外のラベルだけなら false', () => {
	assert.strictEqual(shouldBlur({labels: []}, config), false);
	assert.strictEqual(shouldBlur({labels: ['spam', '!warn']}, config), false);
});

test('labels が無い・壊れていても例外を投げず false', () => {
	assert.strictEqual(shouldBlur({}, config), false);
	assert.strictEqual(shouldBlur({labels: null}, config), false);
	assert.strictEqual(shouldBlur(null, config), false);
});
