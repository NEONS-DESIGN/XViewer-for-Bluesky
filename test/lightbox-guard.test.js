/**
 * lightbox-guard.js の計算・判定の検査。
 * DOM への目印の付け外し・リスナーの登録と撤去は対象外 (実機で確認する)。
 */

import test from 'node:test';
import assert from 'node:assert';

import {EXT_CONFIG} from '../src/common/config.js';
import {
	computeContainRect,
	shouldBlockLightboxClick,
	isInteractiveHit
} from '../src/content/lightbox-guard.js';
import {isLightboxDialog} from '../src/content/page.js';

/**
 * closest() の結果を受け取る側の検査に使う最小のダミー。
 * @param {Array<Object>} descendants contains() が true を返す相手
 */
function makeContainer(descendants) {
	const container = {};
	container.contains = (el) => el === container || descendants.includes(el);
	return container;
}

/**
 * 実測値 (2026-09-09、bsky.app)。
 * 原寸 3300x1968 の画像が 1208x661 の img に object-fit: contain で入る。
 * 描画されるのは (50,0) から 1108x661 で、左右に 50px ずつ余白ができる
 */
const MEASURED = {
	rect: {x: 0, y: 0, width: 1208, height: 661},
	natural: {width: 3300, height: 1968}
};

test('computeContainRect は実測の画像で描画矩形を返す', () => {
	const drawn = computeContainRect(MEASURED.rect, MEASURED.natural);
	assert.equal(Math.round(drawn.x), 50);
	assert.equal(Math.round(drawn.y), 0);
	assert.equal(Math.round(drawn.width), 1108);
	assert.equal(Math.round(drawn.height), 661);
});

test('computeContainRect は縦長の画像で左右に余白を作る', () => {
	const drawn = computeContainRect(
		{x: 0, y: 0, width: 1000, height: 500},
		{width: 100, height: 200}
	);
	assert.deepEqual(drawn, {x: 375, y: 0, width: 250, height: 500});
});

test('computeContainRect は横長の画像で上下に余白を作る', () => {
	const drawn = computeContainRect(
		{x: 0, y: 0, width: 1000, height: 500},
		{width: 400, height: 100}
	);
	assert.deepEqual(drawn, {x: 0, y: 125, width: 1000, height: 250});
});

test('computeContainRect は枠と同じ縦横比なら枠いっぱいに描く', () => {
	const drawn = computeContainRect(
		{x: 0, y: 0, width: 1000, height: 500},
		{width: 200, height: 100}
	);
	assert.deepEqual(drawn, {x: 0, y: 0, width: 1000, height: 500});
});

test('computeContainRect は要素の原点を足した座標を返す', () => {
	const drawn = computeContainRect(
		{x: 100, y: 40, width: 1000, height: 500},
		{width: 100, height: 200}
	);
	assert.deepEqual(drawn, {x: 475, y: 40, width: 250, height: 500});
});

test('computeContainRect は原寸が未確定なら null を返す', () => {
	assert.equal(computeContainRect(MEASURED.rect, {width: 0, height: 0}), null);
	assert.equal(computeContainRect(MEASURED.rect, null), null);
});

test('computeContainRect は要素の矩形が潰れていれば null を返す', () => {
	assert.equal(
		computeContainRect({x: 0, y: 0, width: 0, height: 0}, MEASURED.natural),
		null
	);
	assert.equal(computeContainRect(null, MEASURED.natural), null);
});

test('shouldBlockLightboxClick は描画矩形の内側で true を返す', () => {
	const drawn = computeContainRect(MEASURED.rect, MEASURED.natural);
	assert.equal(shouldBlockLightboxClick({x: 604, y: 331}, drawn, false), true);
});

test('shouldBlockLightboxClick は半透明の余白で false を返す', () => {
	const drawn = computeContainRect(MEASURED.rect, MEASURED.natural);
	// 左の余白 (実測で 0-50px)。ここは背景として閉じられるままにする
	assert.equal(shouldBlockLightboxClick({x: 25, y: 331}, drawn, false), false);
	// 下の ALT 文の帯 (画像は 661px までしか無い)
	assert.equal(shouldBlockLightboxClick({x: 604, y: 700}, drawn, false), false);
});

test('shouldBlockLightboxClick は押せる要素の上では false を返す', () => {
	const drawn = computeContainRect(MEASURED.rect, MEASURED.natural);
	// 左上の「画像オプション」ボタン (20,20)-(64,64) は描画矩形と重なる。
	// ここで true を返すとボタンが押せなくなる
	assert.equal(shouldBlockLightboxClick({x: 60, y: 40}, drawn, true), false);
});

test('shouldBlockLightboxClick は描画矩形が無ければ false を返す', () => {
	// 読み込み前で原寸が取れない間は、従来どおり閉じられる側に倒す
	assert.equal(shouldBlockLightboxClick({x: 604, y: 331}, null, false), false);
});

test('shouldBlockLightboxClick は描画矩形の縁を内側として扱う', () => {
	const drawn = computeContainRect(MEASURED.rect, MEASURED.natural);
	assert.equal(
		shouldBlockLightboxClick({x: drawn.x, y: drawn.y}, drawn, false),
		true
	);
	assert.equal(
		shouldBlockLightboxClick(
			{x: drawn.x + drawn.width, y: drawn.y + drawn.height}, drawn, false
		),
		true
	);
	assert.equal(
		shouldBlockLightboxClick({x: drawn.x - 0.1, y: drawn.y}, drawn, false),
		false
	);
});

test('isInteractiveHit は固定親の中の押せる要素で true を返す', () => {
	const button = {};
	const container = makeContainer([button]);
	assert.equal(isInteractiveHit(button, container), true);
});

test('isInteractiveHit は固定親そのものを押せる要素とみなさない', () => {
	// **固定親は実測で tabindex="0" を持つ** (2026-09-09)。closest() は必ず
	// ここにヒットするため、除外しないと全てのクリックが素通しになる
	const container = makeContainer([]);
	assert.equal(isInteractiveHit(container, container), false);
});

test('isInteractiveHit は固定親の外の要素を押せる要素とみなさない', () => {
	const outside = {};
	const container = makeContainer([]);
	assert.equal(isInteractiveHit(outside, container), false);
});

test('isInteractiveHit はヒットが無ければ false を返す', () => {
	assert.equal(isInteractiveHit(null, makeContainer([])), false);
	assert.equal(isInteractiveHit({}, null), false);
});

test('EXT_CONFIG.lightboxGuard は必要な設定を持つ', () => {
	const config = EXT_CONFIG.lightboxGuard;
	assert.equal(typeof config.storageKey, 'string');
	assert.equal(config.defaultEnabled, true);
	assert.equal(typeof config.markerAttr, 'string');
	assert.equal(typeof config.interactiveSelector, 'string');
	// 介入する相手はパネルと同じ要素でなければならない
	assert.equal(config.dialogSelector, EXT_CONFIG.lightboxPanel.dialogSelector);
});

/**
 * ダイアログの代わりになる最小の相手を作る。
 * querySelector だけ持てば isLightboxDialog は動く。
 * @param {boolean} hasComposer 投稿作成モーダルの目印を含むか
 * @returns {Object} ダイアログの代わり
 */
function makeDialog(hasComposer) {
	return {
		querySelector(selector) {
			return (hasComposer && selector === EXT_CONFIG.lightbox.composerSelector)
				? {}
				: null;
		}
	};
}

test('isLightboxDialog: 投稿作成モーダルを含まないダイアログはライトボックス', () => {
	assert.strictEqual(
		isLightboxDialog(makeDialog(false), EXT_CONFIG.lightbox),
		true
	);
});

test('isLightboxDialog: 投稿作成モーダルを含むダイアログはライトボックスではない', () => {
	assert.strictEqual(
		isLightboxDialog(makeDialog(true), EXT_CONFIG.lightbox),
		false
	);
});

test('isLightboxDialog: null を渡しても落ちず false を返す', () => {
	assert.strictEqual(isLightboxDialog(null, EXT_CONFIG.lightbox), false);
});

test('isLightboxDialog: querySelector が投げても false を返す', () => {
	const broken = {
		querySelector() {
			throw new Error('壊れた要素');
		}
	};
	assert.strictEqual(isLightboxDialog(broken, EXT_CONFIG.lightbox), false);
});
