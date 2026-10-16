/**
 * 表示中のタブバーの選び方。
 * SPA で別のプロフィールへ移ると、前のプロフィール画面のタブバーが矩形 0 のまま
 * DOM に残る。描画されていない方を選ばないことを確かめる。
 */
import test from 'node:test';
import assert from 'node:assert';
import {EXT_CONFIG} from '../src/common/config.js';
import {isRenderedElement, pickTabBar} from '../src/content/page.js';
import {pickRenderedElement} from '../src/inject/page-bridge.js';

const FEED = EXT_CONFIG.selectors.feed;

/**
 * 矩形と「postsFeed を内包するか」だけを持つ偽の要素を作る。
 * @param {string} name 識別用の名前
 * @param {{width: number, height: number}} rect 矩形
 * @param {boolean} [hasFeed] postsFeed を内包するか
 * @returns {Object}
 */
function fakeElement(name, rect, hasFeed = false) {
	return {
		name,
		getBoundingClientRect: () => rect,
		querySelector: (selector) => (selector === FEED && hasFeed ? {} : null)
	};
}

const SHOWN = {width: 600, height: 47};
const HIDDEN = {width: 0, height: 0};

test('矩形の幅と高さがともに 0 より大きい要素だけを描画中とみなす', () => {
	assert.strictEqual(isRenderedElement(fakeElement('a', SHOWN)), true);
	assert.strictEqual(isRenderedElement(fakeElement('b', HIDDEN)), false);
	assert.strictEqual(isRenderedElement(fakeElement('c', {width: 600, height: 0})), false);
	assert.strictEqual(isRenderedElement(fakeElement('d', {width: 0, height: 47})), false);
});

test('読めない要素は描画中とみなさない', () => {
	assert.strictEqual(isRenderedElement(null), false);
	assert.strictEqual(isRenderedElement({}), false);
	assert.strictEqual(isRenderedElement({
		getBoundingClientRect: () => {
			throw new Error('detached');
		}
	}), false);
});

test('前のプロフィールのタブバーが先に並んでいても、描画中の内側を選ぶ', () => {
	// 実測の並び: 旧外側・旧内側 (矩形 0)、新外側・新内側
	const pagers = [
		fakeElement('旧外側', HIDDEN, true),
		fakeElement('旧内側', HIDDEN),
		fakeElement('新外側', {width: 1905, height: 19706}, true),
		fakeElement('新内側', SHOWN)
	];
	assert.strictEqual(pickTabBar(pagers, FEED).name, '新内側');
});

test('描画中の内側が無ければ描画中の外側で代える', () => {
	const pagers = [
		fakeElement('旧内側', HIDDEN),
		fakeElement('新外側', {width: 1905, height: 19706}, true)
	];
	assert.strictEqual(pickTabBar(pagers, FEED).name, '新外側');
});

test('どれも描画されていなければ null (描画を待たせる)', () => {
	const pagers = [
		fakeElement('旧外側', HIDDEN, true),
		fakeElement('旧内側', HIDDEN)
	];
	assert.strictEqual(pickTabBar(pagers, FEED), null);
	assert.strictEqual(pickTabBar([], FEED), null);
});

test('橋渡しは描画中の要素を選び、無ければ null を返す', () => {
	const shown = fakeElement('新', SHOWN);
	assert.strictEqual(pickRenderedElement([fakeElement('旧', HIDDEN), shown]), shown);
	assert.strictEqual(pickRenderedElement([fakeElement('旧', HIDDEN)]), null);
	assert.strictEqual(pickRenderedElement([]), null);
});
