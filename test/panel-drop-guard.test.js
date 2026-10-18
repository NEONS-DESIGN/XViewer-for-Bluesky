/**
 * panel-drop-guard.js。パネルの上でファイルのドラッグの既定の動作を止め、入力欄が
 * 受けたドラッグには触れず、外せばリスナーが残らないことを偽の DOM で確かめる。
 * ブラウザがファイルを開かないことそのものは実機で確認する。
 */

import test from 'node:test';
import assert from 'node:assert';

import {EXT_CONFIG} from '../src/common/config.js';
import {FakeDocument, FakeEvent} from './helpers/fake-dom.js';
import {isFileDrag, installPanelDropGuard} from '../src/content/panel-drop-guard.js';

const NO_DROP = EXT_CONFIG.lightboxReplies.compose.noDropEffect;

/**
 * ドラッグのイベントを作る。
 * @param {string} type 'dragover' / 'drop'
 * @param {Object|null} transfer dataTransfer
 * @returns {FakeEvent}
 */
function dragEvent(type, transfer) {
	const event = new FakeEvent(type);
	event.dataTransfer = transfer;
	return event;
}

/**
 * パネルと、その中の本文・入力欄を作る。
 * @returns {{panel: Object, text: Object, composer: Object}}
 */
function setup() {
	const doc = new FakeDocument();
	const panel = doc.createElement('aside');
	const text = doc.createElement('p');
	const composer = doc.createElement('div');
	panel.append(text, composer);
	doc.body.append(panel);
	return {panel, text, composer};
}

test('isFileDrag: types の Files か items の file があるときだけ真', () => {
	assert.strictEqual(isFileDrag({types: ['Files']}), true);
	assert.strictEqual(isFileDrag({types: ['text/plain'], items: [{kind: 'file'}]}), true);
	assert.strictEqual(isFileDrag({types: ['text/plain', 'text/uri-list'], items: [{kind: 'string'}]}), false);
	assert.strictEqual(isFileDrag({}), false);
	assert.strictEqual(isFileDrag(null), false);
	assert.strictEqual(isFileDrag({get types() {
		throw new Error('x');
	}}), false);
});

test('installPanelDropGuard: 入力欄の外に落としたファイルは既定の動作を止め、受けないことを見せる', () => {
	const {panel, text} = setup();
	installPanelDropGuard(panel, NO_DROP);
	const transfer = {types: ['Files'], dropEffect: 'copy'};
	const over = dragEvent('dragover', transfer);
	text.dispatchEvent(over);
	assert.strictEqual(over.defaultPrevented, true);
	assert.strictEqual(transfer.dropEffect, NO_DROP);
	const drop = dragEvent('drop', transfer);
	text.dispatchEvent(drop);
	assert.strictEqual(drop.defaultPrevented, true);
});

test('installPanelDropGuard: 文字のドラッグには触れない', () => {
	const {panel, text} = setup();
	installPanelDropGuard(panel, NO_DROP);
	const transfer = {types: ['text/plain'], dropEffect: 'copy'};
	const over = dragEvent('dragover', transfer);
	text.dispatchEvent(over);
	assert.strictEqual(over.defaultPrevented, false);
	assert.strictEqual(transfer.dropEffect, 'copy');
	const drop = dragEvent('drop', transfer);
	text.dispatchEvent(drop);
	assert.strictEqual(drop.defaultPrevented, false);
});

test('installPanelDropGuard: 入力欄が受けた dragover の dropEffect は書き換えない', () => {
	const {panel, composer} = setup();
	installPanelDropGuard(panel, NO_DROP);
	composer.addEventListener('dragover', (event) => {
		event.preventDefault();
		event.dataTransfer.dropEffect = 'copy';
	});
	const transfer = {types: ['Files'], dropEffect: 'move'};
	const over = dragEvent('dragover', transfer);
	composer.dispatchEvent(over);
	assert.strictEqual(over.defaultPrevented, true);
	assert.strictEqual(transfer.dropEffect, 'copy');
});

test('installPanelDropGuard: 外すとリスナーが残らず、2 回外しても例外にならない', () => {
	const {panel, text} = setup();
	const release = installPanelDropGuard(panel, NO_DROP);
	assert.strictEqual(panel.listeners.length, 2);
	release();
	release();
	assert.strictEqual(panel.listeners.length, 0);
	const over = dragEvent('dragover', {types: ['Files'], dropEffect: 'copy'});
	text.dispatchEvent(over);
	assert.strictEqual(over.defaultPrevented, false);
});
