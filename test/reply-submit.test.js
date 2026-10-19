/**
 * reply-submit.js の送信の手順。アップロード → 世代の確認 → 組み立て → 送信 → 世代の確認の順と、
 * 失敗・世代の変化・確かめられなかった送信の扱いを、偽の段で確かめる。
 */

import test from 'node:test';
import assert from 'node:assert';

import {runSubmit, runThreadSubmit, THREAD_UNCONFIRMED} from '../src/content/reply-submit.js';

/**
 * 画像の並びを作る。
 * @param {number} count
 * @returns {Array<{blob: Blob}>}
 */
function images(count) {
	return Array.from({length: count}, (unused, i) => ({blob: new Blob([String(i)])}));
}

/**
 * 呼ばれた順を控える偽のアップロード。n 枚目 (1 始まり) を failAt にすると失敗を返す。
 * @param {Array<string>} log
 * @param {number} [failAt]
 */
function fakeUpload(log, failAt = 0) {
	let count = 0;
	return async () => {
		count += 1;
		log.push(`upload${count}`);
		return count === failAt
			? {ok: false, blob: null, reason: 'blob-not-allowed'}
			: {ok: true, blob: {ref: count}, reason: null};
	};
}

test('runSubmit: 画像を順に送り、組み立てた record を作成して onPosted に (結果, record, blobs) を渡す', async () => {
	const log = [];
	const progress = [];
	let posted = null;
	const status = await runSubmit({
		images: images(2),
		upload: fakeUpload(log),
		onProgress: (current, total) => progress.push([current, total]),
		isCurrent: () => true,
		buildRecord: async (blobs) => ({text: 'a', blobs}),
		createReply: async (record) => {
			log.push('create');
			return {ok: true, uri: 'at://x', cid: 'bafy', reason: null, record};
		},
		onPosted: (...args) => { posted = args; },
		onFailed: () => assert.fail('失敗にしてはいけない')
	});
	assert.strictEqual(status, 'posted');
	assert.deepStrictEqual(log, ['upload1', 'upload2', 'create']);
	assert.deepStrictEqual(progress, [[1, 2], [2, 2]]);
	assert.strictEqual(posted.length, 3);
	assert.strictEqual(posted[0].uri, 'at://x');
	assert.deepStrictEqual(posted[1], {text: 'a', blobs: [{ref: 1}, {ref: 2}]});
	assert.deepStrictEqual(posted[2], [{ref: 1}, {ref: 2}]);
});

test('runSubmit: アップロードの失敗は upload で知らせ、作成を呼ばない', async () => {
	const log = [];
	const failed = [];
	const status = await runSubmit({
		images: images(3),
		upload: fakeUpload(log, 2),
		onProgress: () => {},
		isCurrent: () => true,
		buildRecord: async () => assert.fail('組み立ててはいけない'),
		createReply: async () => assert.fail('作成してはいけない'),
		onPosted: () => assert.fail('投稿済みにしてはいけない'),
		onFailed: (kind, reason) => failed.push([kind, reason])
	});
	assert.strictEqual(status, 'upload-failed');
	assert.deepStrictEqual(log, ['upload1', 'upload2']);
	assert.deepStrictEqual(failed, [['upload', 'blob-not-allowed']]);
});

test('runSubmit: 作成の失敗・例外は post で知らせ、世代が変わっていれば何も知らせない', async () => {
	const base = {
		images: [],
		upload: async () => assert.fail('画像は無い'),
		onProgress: () => {},
		buildRecord: async () => ({text: 'a'}),
		onPosted: () => assert.fail('投稿済みにしてはいけない')
	};
	const failed = [];
	const onFailed = (kind, reason) => failed.push([kind, reason]);
	assert.strictEqual(await runSubmit({
		...base, isCurrent: () => true, onFailed,
		createReply: async () => ({ok: false, uri: null, cid: null, reason: 'http-error'})
	}), 'post-failed');
	assert.strictEqual(await runSubmit({
		...base, isCurrent: () => true, onFailed,
		createReply: async () => { throw new Error('boom'); }
	}), 'post-failed');
	assert.deepStrictEqual(failed, [['post', 'http-error'], ['post', 'post-exception']]);

	let current = true;
	assert.strictEqual(await runSubmit({
		...base, isCurrent: () => current, onFailed: () => assert.fail('知らせてはいけない'),
		createReply: async () => {
			current = false;
			throw new Error('boom');
		}
	}), 'stale');
});

test('runThreadSubmit: 進み具合は全投稿を通した番号で、onPosted には送った writes の value を渡す', async () => {
	const log = [];
	const progress = [];
	let posted = null;
	const status = await runThreadSubmit({
		posts: [
			{images: images(1), buildRecord: async (blobs) => ({n: 0, blobs}), onUploadFailed: () => assert.fail()},
			{images: images(2), buildRecord: async (blobs) => ({n: 1, blobs}), onUploadFailed: () => assert.fail()}
		],
		upload: fakeUpload(log),
		onProgress: (current, total) => progress.push([current, total]),
		isCurrent: () => true,
		send: async (records) => {
			log.push(`send${records.length}`);
			return {
				ok: true,
				results: [{uri: 'at://a', cid: 'a'}, {uri: 'at://b', cid: 'b'}],
				writes: records.map((value) => ({value: {...value, chained: true}})),
				reason: null
			};
		},
		onPosted: (...args) => { posted = args; },
		onFailed: () => assert.fail('失敗にしてはいけない')
	});
	assert.strictEqual(status, 'posted');
	assert.deepStrictEqual(log, ['upload1', 'upload2', 'upload3', 'send2']);
	assert.deepStrictEqual(progress, [[1, 3], [2, 3], [3, 3]]);
	assert.deepStrictEqual(posted[1].map((record) => record.chained), [true, true]);
	assert.deepStrictEqual(posted[2], [[{ref: 1}], [{ref: 2}, {ref: 3}]]);
});

test('runThreadSubmit: アップロードの失敗はその投稿だけに知らせ、確かめられなかった送信は unconfirmed で知らせる', async () => {
	const uploadFailed = [];
	const status = await runThreadSubmit({
		posts: [
			{images: images(1), buildRecord: async () => ({}), onUploadFailed: (reason) => uploadFailed.push(['first', reason])},
			{images: images(1), buildRecord: async () => ({}), onUploadFailed: (reason) => uploadFailed.push(['second', reason])}
		],
		upload: fakeUpload([], 2),
		onProgress: () => {},
		isCurrent: () => true,
		send: async () => assert.fail('送ってはいけない'),
		onPosted: () => assert.fail(),
		onFailed: () => assert.fail('入れ物の失敗にしてはいけない')
	});
	assert.strictEqual(status, 'upload-failed');
	assert.deepStrictEqual(uploadFailed, [['second', 'blob-not-allowed']]);

	const failed = [];
	const unconfirmed = await runThreadSubmit({
		posts: [{images: [], buildRecord: async () => ({}), onUploadFailed: () => assert.fail()}],
		upload: async () => assert.fail(),
		onProgress: () => {},
		isCurrent: () => true,
		send: async () => ({ok: false, results: null, writes: [], reason: THREAD_UNCONFIRMED}),
		onPosted: () => assert.fail(),
		onFailed: (kind, reason) => failed.push([kind, reason])
	});
	assert.strictEqual(unconfirmed, 'unconfirmed');
	assert.deepStrictEqual(failed, [['unconfirmed', THREAD_UNCONFIRMED]]);
	assert.strictEqual(THREAD_UNCONFIRMED, 'thread-unconfirmed');
});

test('runThreadSubmit: 組み立ての途中で世代が変わったら、残りを組み立てず送らない', async () => {
	let current = true;
	const built = [];
	const status = await runThreadSubmit({
		posts: [0, 1, 2].map((n) => ({
			images: [],
			buildRecord: async () => {
				built.push(n);
				if (n === 1) current = false;
				return {n};
			},
			onUploadFailed: () => assert.fail()
		})),
		upload: async () => assert.fail(),
		onProgress: () => {},
		isCurrent: () => current,
		send: async () => assert.fail('送ってはいけない'),
		onPosted: () => assert.fail(),
		onFailed: () => assert.fail()
	});
	assert.strictEqual(status, 'stale');
	assert.deepStrictEqual(built, [0, 1]);
});
