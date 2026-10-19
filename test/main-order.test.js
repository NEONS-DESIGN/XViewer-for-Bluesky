/**
 * content script の入口 (src/content/main.js) の起動順と、起動の失敗の扱いのテスト。
 * 起動順は旧 manifest の読み込み順 (debug.js → content.js → media-grid.js →
 * lightbox-panel.js → lightbox-guard.js) で各ファイルが自己起動していた順と同じにする。
 */
import test from 'node:test';
import assert from 'node:assert';
import {STARTUP_ORDER, start} from '../src/content/main.js';

test('起動順は旧 manifest の読み込み順と同じ', () => {
	assert.deepStrictEqual(STARTUP_ORDER, ['debug', 'page', 'mediaGrid', 'lightboxPanel', 'lightboxGuard']);
});

test('1 つの起動が投げても残りは起動する', (t) => {
	// 失敗の記録はコンソールへ出るので、テストの出力を汚さないよう黙らせる
	t.mock.method(console, 'error', () => {});
	const called = [];
	start([['a', () => { called.push('a'); throw new Error('x'); }], ['b', () => called.push('b')]]);
	assert.deepStrictEqual(called, ['a', 'b']);
});

test('起動の失敗は手順の名前を添えて console.error に残す', (t) => {
	const logged = t.mock.method(console, 'error', () => {});
	const error = new Error('x');
	start([['a', () => { throw error; }]]);
	assert.strictEqual(logged.mock.callCount(), 1);
	assert.deepStrictEqual(logged.mock.calls[0].arguments, ['[XViewer] 起動に失敗しました', 'a', error]);
});

test('手順が返した Promise の拒否も手順の名前を添えて残し、残りは待たずに起動する', async (t) => {
	const logged = t.mock.method(console, 'error', () => {});
	const error = new Error('async');
	const called = [];
	start([['a', async () => { called.push('a'); throw error; }], ['b', () => called.push('b')]]);
	assert.deepStrictEqual(called, ['a', 'b']);
	await new Promise((resolve) => setImmediate(resolve));
	assert.strictEqual(logged.mock.callCount(), 1);
	assert.deepStrictEqual(logged.mock.calls[0].arguments, ['[XViewer] 起動に失敗しました', 'a', error]);
});
