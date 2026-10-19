import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseAtUri, parsePostAtUri, postRkey} from '../src/common/at-uri.js';
import {buildUrl, fetchJson, fetchOkJson, fetchBlob, fetchWithTimeout} from '../src/common/http.js';
import {RemoteCache} from '../src/common/remote-cache.js';
import {prefersReducedMotion, scrollBehavior} from '../src/common/motion.js';
import {loadSyncSettings, watchSyncSettings} from '../src/common/sync-settings.js';

const POST = 'at://did:plc:abc/app.bsky.feed.post/3kxyz';

test('parseAtUri は collection を問わず 3 つに分ける', () => {
	assert.deepEqual(parseAtUri('at://did:plc:abc/app.bsky.feed.like/3k1'), {
		did: 'did:plc:abc', collection: 'app.bsky.feed.like', rkey: '3k1'
	});
	assert.equal(parseAtUri('at://did:plc:abc/app.bsky.feed.post'), null);
	assert.equal(parseAtUri('https://bsky.app/'), null);
	assert.equal(parseAtUri(null), null);
});

test('parsePostAtUri は投稿だけを通す', () => {
	assert.deepEqual(parsePostAtUri(POST), {did: 'did:plc:abc', rkey: '3kxyz'});
	assert.equal(parsePostAtUri('at://did:plc:abc/app.bsky.feed.like/3k1'), null);
	assert.equal(postRkey(POST), '3kxyz');
	assert.equal(postRkey('x'), null);
});

test('buildUrl は undefined を落とし、配列は同じキーを繰り返す', () => {
	const url = buildUrl('https://example.com', '/xrpc/a', {uri: POST, depth: 1, skip: undefined, uris: ['a', 'b']});
	const parsed = new URL(url);
	assert.equal(parsed.searchParams.get('uri'), POST);
	assert.equal(parsed.searchParams.get('depth'), '1');
	assert.equal(parsed.searchParams.has('skip'), false);
	assert.deepEqual(parsed.searchParams.getAll('uris'), ['a', 'b']);
});

/**
 * globalThis.fetch を差し替えて fn を走らせる。
 * @param {Function} impl
 * @param {Function} fn
 */
async function withFetch(impl, fn) {
	const original = globalThis.fetch;
	globalThis.fetch = impl;
	try {
		await fn();
	} finally {
		globalThis.fetch = original;
	}
}

test('fetchJson は状態と中身を返し、読めない中身は null、通信の失敗は null', async () => {
	await withFetch(async () => new Response('{"a":1}', {status: 404}), async () => {
		assert.deepEqual(await fetchJson('https://x/', 1000), {status: 404, json: {a: 1}});
		assert.equal(await fetchOkJson('https://x/', 1000), null);
	});
	await withFetch(async () => new Response('not json', {status: 200}), async () => {
		assert.deepEqual(await fetchJson('https://x/', 1000), {status: 200, json: null});
	});
	await withFetch(async () => {
		throw new TypeError('network');
	}, async () => {
		assert.equal(await fetchJson('https://x/', 1000), null);
		assert.equal(await fetchBlob('https://x/', 1000), null);
	});
});

test('fetchWithTimeout は外の signal でも打ち切る', async () => {
	const controller = new AbortController();
	await withFetch((url, init) => new Promise((resolve, reject) => {
		init.signal.addEventListener('abort', () => reject(init.signal.reason));
	}), async () => {
		const pending = fetchWithTimeout('https://x/', 60000, {signal: controller.signal});
		controller.abort();
		await assert.rejects(pending);
	});
});

test('RemoteCache は飛行中を 1 本にまとめ、成功だけを覚える', async () => {
	const cache = new RemoteCache({limit: 2});
	let calls = 0;
	const load = async () => {
		calls += 1;
		return 'v';
	};
	const [a, b] = await Promise.all([cache.get('k', load), cache.get('k', load)]);
	assert.equal(a, 'v');
	assert.equal(b, 'v');
	assert.equal(calls, 1);
	assert.equal(await cache.get('k', load), 'v');
	assert.equal(calls, 1);

	let failures = 0;
	const fail = async () => {
		failures += 1;
		return null;
	};
	assert.equal(await cache.get('n', fail), null);
	assert.equal(await cache.get('n', fail), null);
	assert.equal(failures, 2);
	// 同期で投げる load も null になる
	assert.equal(await cache.get('t', () => {
		throw new Error('x');
	}), null);
});

test('RemoteCache は上限で古いものを捨て、期限切れは引き直し、clear 後の応答を覚えない', async () => {
	let now = 0;
	const cache = new RemoteCache({limit: 2, ttlMs: 100, now: () => now});
	cache.set('a', 1);
	cache.set('b', 2);
	cache.set('c', 3);
	assert.equal(cache.peek('a'), undefined);
	assert.equal(cache.peek('c'), 3);
	now = 200;
	assert.equal(cache.peek('c'), undefined);

	let resolveLoad;
	const pending = cache.get('d', () => new Promise((resolve) => {
		resolveLoad = resolve;
	}));
	await Promise.resolve();
	cache.clear();
	resolveLoad('late');
	assert.equal(await pending, 'late');
	assert.equal(cache.peek('d'), undefined);
});

test('prefersReducedMotion は読めなければ偽', () => {
	assert.equal(prefersReducedMotion({matchMedia: () => ({matches: true})}), true);
	assert.equal(prefersReducedMotion({matchMedia: () => {
		throw new Error('x');
	}}), false);
	assert.equal(prefersReducedMotion({}), false);
	assert.equal(scrollBehavior({matchMedia: () => ({matches: true})}), 'auto');
	assert.equal(scrollBehavior({matchMedia: () => ({matches: false})}), 'smooth');
});

test('loadSyncSettings と watchSyncSettings は既定値で埋め、変わったキーだけを渡す', async () => {
	const listeners = [];
	globalThis.chrome = {
		storage: {
			sync: {get: async () => ({a: false, c: 'x'})},
			onChanged: {
				addListener: (fn) => listeners.push(fn),
				removeListener: (fn) => listeners.splice(listeners.indexOf(fn), 1)
			}
		}
	};
	try {
		assert.deepEqual(await loadSyncSettings({a: true, b: 2}, 'テスト'), {a: false, b: 2});
		const seen = [];
		const stop = watchSyncSettings({a: true, b: 2}, (changed) => seen.push(changed), 'テスト');
		listeners[0]({a: {newValue: undefined}, z: {newValue: 1}}, 'sync');
		listeners[0]({z: {newValue: 1}}, 'sync');
		listeners[0]({b: {newValue: 5}}, 'local');
		assert.deepEqual(seen, [{a: true}]);
		stop();
		assert.equal(listeners.length, 0);
	} finally {
		delete globalThis.chrome;
	}
});
