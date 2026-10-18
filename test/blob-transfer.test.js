/**
 * blob-transfer.js の受け渡し。postMessage は location.origin 宛てに 1 回、
 * 同じ id を upload-blob の要求に載せることを偽の window / document で確かめる。
 * 実際に MAIN ワールドが Blob を受け取れるかは実機で確認する。
 */

import test from 'node:test';
import assert from 'node:assert';

import {BRIDGE_PROTOCOL} from '../src/common/bridge-protocol.js';
import {EXT_CONFIG} from '../src/common/config.js';
import {callBridge} from '../src/content/bridge-client.js';
import {uploadBlob, uploadVideo, cancelVideoUpload} from '../src/content/blob-transfer.js';

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

/**
 * 返事をしない偽の document と、待ち時間を控えてすぐ発火する setTimeout を置く。
 * @returns {{delays: number[], restore: Function}}
 */
function installSilentFakes() {
	const delays = [];
	const saved = {
		window: globalThis.window,
		document: globalThis.document,
		setTimeout: globalThis.setTimeout
	};
	globalThis.window = {location: {origin: ORIGIN}, postMessage: () => {}};
	globalThis.document = {
		addEventListener: () => {},
		removeEventListener: () => {},
		dispatchEvent: () => true
	};
	globalThis.setTimeout = (fn, ms) => {
		delays.push(ms);
		fn();
		return 1;
	};
	return {
		delays,
		restore: () => {
			globalThis.window = saved.window;
			globalThis.document = saved.document;
			globalThis.setTimeout = saved.setTimeout;
		}
	};
}

test('uploadBlob: 応答を待つ上限に uploadTimeoutMs を使う (ほかの操作より長い)', async () => {
	const bridge = EXT_CONFIG.mediaGrid.bridge;
	assert.ok(bridge.uploadTimeoutMs > bridge.timeoutMs);
	const fakes = installSilentFakes();
	try {
		const result = await uploadBlob(new Blob(['a'], {type: 'image/png'}));
		assert.deepStrictEqual(fakes.delays, [bridge.uploadTimeoutMs]);
		assert.deepStrictEqual(result, {ok: false, blob: null, reason: 'timeout'});
	} finally {
		fakes.restore();
	}
});

test('callBridge: timeoutMs を渡さない・正の数でないときは既定の timeoutMs で待つ', async () => {
	const bridge = EXT_CONFIG.mediaGrid.bridge;
	const fakes = installSilentFakes();
	try {
		await callBridge(bridge.actions.getSession, {});
		await callBridge(bridge.actions.getSession, {}, {timeoutMs: 0});
		await callBridge(bridge.actions.getSession, {}, {timeoutMs: NaN});
		await callBridge(bridge.actions.getSession, {}, null);
		await callBridge(bridge.actions.getSession, {}, {timeoutMs: 1234});
		assert.deepStrictEqual(fakes.delays, [
			bridge.timeoutMs, bridge.timeoutMs, bridge.timeoutMs, bridge.timeoutMs, 1234
		]);
	} finally {
		fakes.restore();
	}
});

test('uploadVideo: 動画を postMessage で 1 回預け、同じ id を upload-video に載せる', async () => {
	const requests = [];
	const fakes = installFakes((detail) => {
		requests.push(detail);
		return {ok: true, blob: {$type: 'blob'}};
	});
	try {
		const blob = new Blob(['v'], {type: 'video/mp4'});
		const handle = uploadVideo(blob, () => {});
		const result = await handle.done;
		assert.deepStrictEqual(result, {ok: true, blob: {$type: 'blob'}, reason: null, message: null});
		assert.strictEqual(fakes.posted.length, 1);
		assert.strictEqual(fakes.posted[0].targetOrigin, ORIGIN);
		assert.strictEqual(fakes.posted[0].message.blob, blob);
		assert.strictEqual(handle.id, fakes.posted[0].message.id);
		assert.strictEqual(requests[0].action, BRIDGE_PROTOCOL.actions.uploadVideo);
		assert.deepStrictEqual(requests[0].payload, {blobId: handle.id});
	} finally {
		fakes.restore();
	}
});

test('uploadVideo: 失敗の理由とサーバの文言をそのまま返す', async () => {
	const fakes = installFakes(() => ({
		ok: false,
		reason: 'upload-forbidden',
		message: 'Confirm your email address to upload videos'
	}));
	try {
		const result = await uploadVideo(new Blob(['v'], {type: 'video/mp4'}), () => {}).done;
		assert.deepStrictEqual(result, {
			ok: false,
			blob: null,
			reason: 'upload-forbidden',
			message: 'Confirm your email address to upload videos'
		});
	} finally {
		fakes.restore();
	}
});

test('cancelVideoUpload: cancel-upload-video に同じ id を載せる', () => {
	const requests = [];
	const fakes = installFakes((detail) => {
		requests.push(detail);
		return {ok: true};
	});
	try {
		cancelVideoUpload('abc');
		assert.strictEqual(requests.length, 1);
		assert.strictEqual(requests[0].action, BRIDGE_PROTOCOL.actions.cancelUploadVideo);
		assert.deepStrictEqual(requests[0].payload, {blobId: 'abc'});
	} finally {
		fakes.restore();
	}
});

test('uploadVideo: 待ちを打ち切ったら、同じ id で cancel-upload-video を送る', async () => {
	const requests = [];
	const saved = {
		window: globalThis.window,
		document: globalThis.document,
		setTimeout: globalThis.setTimeout
	};
	globalThis.window = {location: {origin: ORIGIN}, postMessage: () => {}};
	globalThis.document = {
		addEventListener: () => {},
		removeEventListener: () => {},
		dispatchEvent: (event) => {
			requests.push(JSON.parse(event.detail));
			return true;
		}
	};
	// 返事をせず、待ちはすぐ打ち切る
	globalThis.setTimeout = (fn) => {
		fn();
		return 1;
	};
	try {
		const handle = uploadVideo(new Blob(['v'], {type: 'video/mp4'}), () => {});
		const result = await handle.done;
		assert.deepStrictEqual(result, {ok: false, blob: null, reason: 'timeout', message: null});
		assert.deepStrictEqual(requests.map((r) => r.action), [
			BRIDGE_PROTOCOL.actions.uploadVideo,
			BRIDGE_PROTOCOL.actions.cancelUploadVideo
		]);
		assert.deepStrictEqual(requests[1].payload, {blobId: handle.id});
	} finally {
		globalThis.window = saved.window;
		globalThis.document = saved.document;
		globalThis.setTimeout = saved.setTimeout;
	}
});

test('uploadVideo: 打ち切り以外の失敗では取り消しを送らない', async () => {
	const requests = [];
	const fakes = installFakes((detail) => {
		requests.push(detail);
		return {ok: false, reason: 'upload-failed'};
	});
	try {
		await uploadVideo(new Blob(['v'], {type: 'video/mp4'}), () => {}).done;
		assert.deepStrictEqual(requests.map((r) => r.action), [BRIDGE_PROTOCOL.actions.uploadVideo]);
	} finally {
		fakes.restore();
	}
});
