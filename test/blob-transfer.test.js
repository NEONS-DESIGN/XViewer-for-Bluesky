/**
 * blob-transfer.js の受け渡し。postMessage は location.origin 宛てに 1 回、
 * 同じ id を upload-blob の要求に載せることを偽の window / document で確かめる。
 * 実際に MAIN ワールドが Blob を受け取れるかは実機で確認する。
 */

import test from 'node:test';
import assert from 'node:assert';

import {BRIDGE_PROTOCOL} from '../src/common/bridge-protocol.js';
import {uploadBlob} from '../src/content/blob-transfer.js';

const ORIGIN = 'https://bsky.app';

/**
 * 偽の window / document を globalThis に置く。要求を受けたら handler の返事を返す。
 * @param {Function} handler (detail) => 返事の Object
 * @returns {{posted: Array, restore: Function}}
 */
function installFakes(handler) {
	const posted = [];
	const listeners = new Map();
	const saved = {window: globalThis.window, document: globalThis.document};
	globalThis.window = {
		location: {origin: ORIGIN},
		postMessage: (message, targetOrigin) => posted.push({message, targetOrigin})
	};
	globalThis.document = {
		addEventListener: (type, fn) => listeners.set(type, fn),
		removeEventListener: (type) => listeners.delete(type),
		dispatchEvent: (event) => {
			const detail = JSON.parse(event.detail);
			const reply = handler(detail);
			const listener = listeners.get(BRIDGE_PROTOCOL.resultEvent);
			listener({detail: JSON.stringify({id: detail.id, ...reply})});
			return true;
		}
	};
	return {
		posted,
		restore: () => {
			globalThis.window = saved.window;
			globalThis.document = saved.document;
		}
	};
}

test('uploadBlob: location.origin 宛てに 1 回預け、同じ id で upload-blob を呼ぶ', async () => {
	const requests = [];
	const fakes = installFakes((detail) => {
		requests.push(detail);
		return {ok: true, blob: {$type: 'blob'}};
	});
	try {
		const blob = new Blob(['a'], {type: 'image/png'});
		const result = await uploadBlob(blob);
		assert.deepStrictEqual(result, {ok: true, blob: {$type: 'blob'}, reason: null});
		assert.strictEqual(fakes.posted.length, 1);
		assert.strictEqual(fakes.posted[0].targetOrigin, ORIGIN);
		assert.strictEqual(fakes.posted[0].message.type, BRIDGE_PROTOCOL.blobMessageType);
		assert.strictEqual(fakes.posted[0].message.blob, blob);
		assert.strictEqual(requests.length, 1);
		assert.strictEqual(requests[0].action, BRIDGE_PROTOCOL.actions.uploadBlob);
		assert.deepStrictEqual(requests[0].payload, {blobId: fakes.posted[0].message.id});
		assert.match(fakes.posted[0].message.id, new RegExp(BRIDGE_PROTOCOL.upload.blobIdPattern));
	} finally {
		fakes.restore();
	}
});

test('uploadBlob: 橋渡しが失敗を返したら理由をそのまま返す', async () => {
	const fakes = installFakes(() => ({ok: false, reason: 'blob-not-allowed'}));
	try {
		const result = await uploadBlob(new Blob(['a'], {type: 'image/png'}));
		assert.deepStrictEqual(result, {ok: false, blob: null, reason: 'blob-not-allowed'});
	} finally {
		fakes.restore();
	}
});
