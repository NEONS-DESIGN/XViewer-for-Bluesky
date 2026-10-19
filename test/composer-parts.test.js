/**
 * 返信の入力欄の小さな部品 (object URL・要求の枠・知らせの 1 行・鍵の付いた部品の並べ直し) を確かめる。
 */

import test from 'node:test';
import assert from 'node:assert';

import {FakeDocument} from './helpers/fake-dom.js';
import {createObjectUrl, revokeObjectUrl} from '../src/content/object-url.js';
import {createRequestSlot} from '../src/content/request-slot.js';
import {NoticeLine} from '../src/content/notice-line.js';
import {syncKeyedParts, forgetKeyedParts} from '../src/content/keyed-parts.js';
import {noticeCause} from '../src/content/reply-post.js';

test('createObjectUrl / revokeObjectUrl: 作れない値・空の URL でも例外を投げない', () => {
	assert.strictEqual(createObjectUrl(null), '');
	assert.strictEqual(createObjectUrl({not: 'a blob'}), '');
	const url = createObjectUrl(new Blob(['x']));
	assert.ok(url.startsWith('blob:'));
	revokeObjectUrl(url);
	revokeObjectUrl('');
	revokeObjectUrl(null);
});

test('createRequestSlot: 最後に始めた印だけが今のもので、差し替え・取り消しで前の signal を打ち切る', () => {
	const slot = createRequestSlot();
	assert.strictEqual(slot.isCurrent(null), false);
	const first = slot.begin();
	assert.strictEqual(slot.isCurrent(first), true);
	assert.strictEqual(first.signal.aborted, false);
	const second = slot.begin();
	assert.strictEqual(first.signal.aborted, true, '差し替えても前の要求を止めない');
	assert.strictEqual(slot.isCurrent(first), false);
	assert.strictEqual(slot.isCurrent(second), true);
	slot.cancel();
	assert.strictEqual(second.signal.aborted, true);
	assert.strictEqual(slot.isCurrent(second), false);
	// 取り消した後も使い続けられる
	const third = slot.begin();
	assert.strictEqual(slot.isCurrent(third), true);
	slot.cancel();
	slot.cancel();
});

test('NoticeLine: 1 つだけ出し、出し直すと前のものを消し、印が合うときだけ消す', () => {
	const doc = new FakeDocument();
	const host = doc.createElement('div');
	const line = new NoticeLine(host, {className: 'err', separator: ' / '});
	assert.strictEqual(line.show([]), null);
	assert.strictEqual(host.children.length, 0);
	const first = line.show(['a', 'b'], 'gif');
	assert.strictEqual(first.textContent, 'a / b');
	assert.strictEqual(first.getAttribute('role'), 'alert');
	assert.strictEqual(first.className, 'err');
	assert.strictEqual(line.meta, 'gif');
	const second = line.show(['c']);
	assert.strictEqual(first.parentNode, null);
	assert.deepStrictEqual(host.children, [second]);
	assert.strictEqual(line.meta, null);
	assert.strictEqual(line.clearIf((meta) => meta === 'gif'), false);
	assert.strictEqual(line.element, second);
	const prompt = doc.createElement('div');
	line.showElement(prompt, 'prompt');
	assert.deepStrictEqual(host.children, [prompt]);
	assert.strictEqual(line.clearIf((meta) => meta === 'prompt'), true);
	assert.strictEqual(line.element, null);
	assert.strictEqual(host.children.length, 0);
});

test('syncKeyedParts: 同じ鍵の部品は使い回し、鍵が変われば作り直し、並びを合わせる', () => {
	const doc = new FakeDocument();
	const container = doc.createElement('div');
	let builds = 0;
	const part = (key) => ({key, build: () => {
		builds += 1;
		const element = doc.createElement('p');
		element.textContent = key;
		return element;
	}});
	const [a, b] = syncKeyedParts(container, [part('a'), part('b')]);
	assert.strictEqual(builds, 2);
	const again = syncKeyedParts(container, [part('a'), part('b')]);
	assert.strictEqual(builds, 2, '同じ鍵で作り直した');
	assert.deepStrictEqual(again, [a, b]);
	const swapped = syncKeyedParts(container, [part('b'), part('c'), part('a')]);
	assert.strictEqual(builds, 3);
	assert.deepStrictEqual(container.children, swapped);
	assert.strictEqual(swapped[0], b);
	assert.strictEqual(swapped[2], a);
	syncKeyedParts(container, [part('c')]);
	assert.strictEqual(container.children.length, 1);
	assert.strictEqual(a.parentNode, null);
	// 外から子を外されていたら作り直す
	container.textContent = '';
	syncKeyedParts(container, [part('c')]);
	assert.strictEqual(builds, 4);
	forgetKeyedParts(container);
	syncKeyedParts(container, [part('c')]);
	assert.strictEqual(builds, 5);
	// 作れない部品は飛ばす
	assert.deepStrictEqual(syncKeyedParts(container, [{key: 'x', build: () => null}]), []);
	assert.strictEqual(container.children.length, 0);
});

test('noticeCause: すべてが同じ原因の排他の知らせのときだけ、その原因を返す', () => {
	assert.strictEqual(noticeCause([]), null);
	assert.strictEqual(noticeCause([{text: 'a', cause: 'gif'}]), 'gif');
	assert.strictEqual(noticeCause([{text: 'a', cause: 'gif'}, {text: 'b', cause: 'gif'}]), 'gif');
	assert.strictEqual(noticeCause([{text: 'a', cause: null}, {text: 'b', cause: 'video'}]), null);
	assert.strictEqual(noticeCause([{text: 'a', cause: 'images'}, {text: 'b', cause: null}]), null);
});
