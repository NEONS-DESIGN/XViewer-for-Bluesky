/**
 * panel-focus-guard.js。パネル内のキーを本体へ届かせるかの判定と、
 * リスナーの付け外しが対になっていることを確かめる。
 * 本体のフォーカストラップとの実際のやり取りは実機で確認する。
 */

import test from 'node:test';
import assert from 'node:assert';

import {shouldStopPanelKey, installPanelFocusGuard} from '../src/content/panel-focus-guard.js';

/** 判定の入力を作る */
function key(name, overrides) {
	return Object.assign({key: name, isTextField: true, hasDraft: false, confirming: false}, overrides);
}

test('shouldStopPanelKey: 入力欄では Escape 以外のキーをすべて止める', () => {
	for (const name of ['a', 'ArrowLeft', 'ArrowRight', 'Tab', 'Enter', ' ']) {
		assert.strictEqual(shouldStopPanelKey(key(name)), true, name);
	}
});

test('shouldStopPanelKey: 入力欄の Escape は書きかけか削除の聞き返し中だけ止める', () => {
	assert.strictEqual(shouldStopPanelKey(key('Escape')), false);
	assert.strictEqual(shouldStopPanelKey(key('Escape', {hasDraft: true})), true);
	assert.strictEqual(shouldStopPanelKey(key('Escape', {confirming: true})), true);
});

test('shouldStopPanelKey: 入力欄の外では画像送りを残し、聞き返し中か書きかけがあるときの Escape だけ止める', () => {
	const outside = {isTextField: false};
	assert.strictEqual(shouldStopPanelKey(key('ArrowRight', outside)), false);
	assert.strictEqual(shouldStopPanelKey(key('ArrowLeft', outside)), false);
	assert.strictEqual(shouldStopPanelKey(key('Escape', outside)), false);
	assert.strictEqual(shouldStopPanelKey(key('Escape', Object.assign({confirming: true}, outside))), true);
	// 書きかけを残したまま送信ボタンなどへ移っても、Escape で閉じて書きかけを失わせない
	assert.strictEqual(shouldStopPanelKey(key('Escape', Object.assign({hasDraft: true}, outside))), true);
	// 書きかけがあっても、入力欄の外の ← → は画像送りのまま
	assert.strictEqual(shouldStopPanelKey(key('ArrowRight', Object.assign({hasDraft: true}, outside))), false);
});

/** addEventListener / removeEventListener の呼び出しを記録する最小の偽物 */
function recorder() {
	return {
		added: [],
		removed: [],
		addEventListener(type, listener, options) {
			this.added.push([type, listener, options === true || !!(options && options.capture)]);
		},
		removeEventListener(type, listener, options) {
			this.removed.push([type, listener, options === true || !!(options && options.capture)]);
		},
		contains() {
			return false;
		}
	};
}

test('installPanelFocusGuard: 外す関数は付けたときと同じ 3 組で外す', () => {
	const panel = recorder();
	const win = recorder();
	const release = installPanelFocusGuard(panel, () => ({hasDraft: false, confirming: false}), win);
	assert.strictEqual(panel.added.length + win.added.length, 3);
	assert.deepStrictEqual(win.added.map((entry) => [entry[0], entry[2]]), [['focusout', true]]);
	release();
	assert.deepStrictEqual(panel.removed, panel.added);
	assert.deepStrictEqual(win.removed, win.added);
});

test('installPanelFocusGuard: パネルの focusin を本体へ届かせない', () => {
	const panel = recorder();
	installPanelFocusGuard(panel, () => ({hasDraft: false, confirming: false}), recorder());
	const focusin = panel.added.find((entry) => entry[0] === 'focusin')[1];
	let stopped = false;
	focusin({stopPropagation() {
		stopped = true;
	}});
	assert.strictEqual(stopped, true);
});

test('installPanelFocusGuard: パネルに関わる focusout だけを止める', () => {
	const inside = {};
	const panel = recorder();
	panel.contains = (node) => node === inside;
	const win = recorder();
	installPanelFocusGuard(panel, () => ({hasDraft: false, confirming: false}), win);
	const focusout = win.added[0][1];
	const fire = (target, relatedTarget) => {
		let stopped = false;
		focusout({target, relatedTarget, stopImmediatePropagation() {
			stopped = true;
		}});
		return stopped;
	};
	assert.strictEqual(fire({}, inside), true);
	assert.strictEqual(fire(inside, {}), true);
	assert.strictEqual(fire({}, {}), false);
	assert.strictEqual(fire({}, null), false);
});

test('installPanelFocusGuard: keydown は入力欄の状態を読んで判定する', () => {
	const panel = recorder();
	let state = {hasDraft: false, confirming: false};
	installPanelFocusGuard(panel, () => state, recorder());
	const keydown = panel.added.find((entry) => entry[0] === 'keydown')[1];
	const fire = (name, target) => {
		let stopped = false;
		keydown({key: name, target, stopPropagation() {
			stopped = true;
		}});
		return stopped;
	};
	const textarea = {tagName: 'TEXTAREA'};
	assert.strictEqual(fire('ArrowRight', textarea), true);
	assert.strictEqual(fire('Escape', textarea), false);
	state = {hasDraft: true, confirming: false};
	assert.strictEqual(fire('Escape', textarea), true);
	assert.strictEqual(fire('ArrowRight', {tagName: 'BUTTON'}), false);
});
