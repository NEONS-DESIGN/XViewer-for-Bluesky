import test from 'node:test';
import assert from 'node:assert';
import {EXT_CONFIG} from '../src/common/config.js';
import {MediaStore, MediaFetcher} from '../src/content/media-source.js';

const config = EXT_CONFIG.mediaGrid;

const makeEntry = (key) => ({key, postId: key, type: 'image', thumbUrl: 'x', labels: []});

/** 指定のレスポンスを順に返す偽 fetch を作る */
const makeFetch = (responses) => {
	const calls = [];
	const options = [];
	const impl = async (url, init) => {
		calls.push(url);
		options.push(init);
		const next = responses.shift();
		if (!next) {
			throw new Error('呼びすぎです');
		}
		if (next.throws) {
			throw new Error('network');
		}
		return {
			ok: next.status === undefined || next.status === 200,
			status: next.status || 200,
			json: async () => next.body
		};
	};
	impl.calls = calls;
	impl.options = options;
	return impl;
};

/** 動画だけの投稿 (既定の動画除外で entries が 0 件になる) を並べたフィード */
const videoOnlyFeedBody = (rkeys, cursor) => ({
	feed: rkeys.map((rkey) => ({
		post: {
			uri: `at://did:plc:x/app.bsky.feed.post/${rkey}`,
			author: {did: 'did:plc:x', handle: 'x.test', labels: []},
			embed: {
				$type: 'app.bsky.embed.video#view',
				playlist: 'p', thumbnail: 't', alt: ''
			},
			labels: []
		}
	})),
	cursor
});

const feedBody = (entries, cursor) => ({
	feed: entries.map((rkey) => ({
		post: {
			uri: `at://did:plc:x/app.bsky.feed.post/${rkey}`,
			author: {did: 'did:plc:x', handle: 'x.test', labels: []},
			embed: {
				$type: 'app.bsky.embed.images#view',
				images: [{thumb: 't', fullsize: 'f', alt: ''}]
			},
			labels: []
		}
	})),
	cursor
});

test('MediaStore は key で重複排除し追加順を保つ', () => {
	const store = new MediaStore();
	assert.strictEqual(store.add(makeEntry('a')), true);
	assert.strictEqual(store.add(makeEntry('b')), true);
	assert.strictEqual(store.add(makeEntry('a')), false);
	assert.strictEqual(store.size, 2);
	assert.deepStrictEqual(store.getAll().map((e) => e.key), ['a', 'b']);
});

test('MediaStore のリスナ例外は他のリスナを止めない', () => {
	const store = new MediaStore();
	const seen = [];
	store.subscribe(() => { throw new Error('壊れたリスナ'); });
	store.subscribe((n) => seen.push(n));
	store.notify(3);
	assert.deepStrictEqual(seen, [3]);
});

test('MediaStore は 0 件では通知しない', () => {
	const store = new MediaStore();
	let called = 0;
	store.subscribe(() => { called += 1; });
	store.notify(0);
	assert.strictEqual(called, 0);
});

test('fetchNext は 1 ページ取り込み cursor を進める', async () => {
	const store = new MediaStore();
	const impl = makeFetch([{body: feedBody(['p1', 'p2'], 'cur1')}]);
	const fetcher = new MediaFetcher(store, config, impl);
	fetcher.setActor('alice.test');

	await fetcher.fetchNext();

	assert.strictEqual(store.size, 2);
	assert.strictEqual(fetcher.cursor, 'cur1');
	assert.strictEqual(fetcher.exhausted, false);
	assert.strictEqual(fetcher.pageCount, 1);
	assert.ok(impl.calls[0].includes('actor=alice.test'));
	assert.ok(impl.calls[0].includes('filter=posts_with_media'));
	assert.ok(impl.calls[0].includes('limit=100'));
	assert.ok(!impl.calls[0].includes('cursor='), '1 ページ目に cursor を付けない');
});

test('cursor が無ければ終端とみなす', async () => {
	const store = new MediaStore();
	const fetcher = new MediaFetcher(store, config, makeFetch([{body: feedBody(['p1'], null)}]));
	fetcher.setActor('alice.test');
	await fetcher.fetchNext();
	assert.strictEqual(fetcher.exhausted, true);
});

test('前回と同じ cursor が返ったら終端とみなす', async () => {
	const store = new MediaStore();
	const fetcher = new MediaFetcher(store, config, makeFetch([
		{body: feedBody(['p1'], 'same')},
		{body: feedBody(['p2'], 'same')}
	]));
	fetcher.setActor('alice.test');
	await fetcher.fetchNext();
	fetcher.lastRunAt = 0;                 // クールダウンを明示的に解除する
	await fetcher.fetchNext();
	assert.strictEqual(fetcher.exhausted, true);
});

test('クールダウン中は要求を出さない', async () => {
	const store = new MediaStore();
	const impl = makeFetch([{body: feedBody(['p1'], 'c1')}]);
	const fetcher = new MediaFetcher(store, config, impl);
	fetcher.setActor('alice.test');
	await fetcher.fetchNext();
	await fetcher.fetchNext();             // 1 秒経っていないので弾かれる
	assert.strictEqual(impl.calls.length, 1);
});

test('429 は 1 回で failed になる', async () => {
	const store = new MediaStore();
	const fetcher = new MediaFetcher(store, config, makeFetch([{status: 429, body: {}}]));
	fetcher.setActor('alice.test');
	await fetcher.fetchNext();
	assert.strictEqual(fetcher.failed, true);
});

test('連続 3 回の失敗で failed になる', async () => {
	const store = new MediaStore();
	const fetcher = new MediaFetcher(store, config, makeFetch([
		{throws: true}, {throws: true}, {throws: true}
	]));
	fetcher.setActor('alice.test');
	for (let i = 0; i < 3; i += 1) {
		fetcher.lastRunAt = 0;
		await fetcher.fetchNext();
	}
	assert.strictEqual(fetcher.failed, true);
});

test('canRetry は retryAfterMs 経過後に状態を戻して true を返す', async () => {
	const store = new MediaStore();
	const fetcher = new MediaFetcher(store, config, makeFetch([{status: 429, body: {}}]));
	fetcher.setActor('alice.test');
	await fetcher.fetchNext();
	assert.strictEqual(fetcher.canRetry(), false);
	fetcher.lastRunAt = Date.now() - config.api.retryAfterMs - 1;
	assert.strictEqual(fetcher.canRetry(), true);
	assert.strictEqual(fetcher.failed, false);
});

test('応答待ちの間に対象が変わったら、その応答を丸ごと捨てる', async () => {
	const store = new MediaStore();
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	const impl = async () => {
		await gate;
		return {ok: true, status: 200, json: async () => feedBody(['old1', 'old2'], 'oldcur')};
	};
	const fetcher = new MediaFetcher(store, config, impl);
	fetcher.setActor('alice.test');

	const pending = fetcher.fetchNext();
	fetcher.setActor('bob.test');          // 待っている間に対象が変わった
	release();
	await pending;

	assert.strictEqual(store.size, 0, '別人のデータを蓄積してはいけない');
	assert.strictEqual(fetcher.cursor, null, '別人のカーソルを引き継いではいけない');
	assert.strictEqual(fetcher.exhausted, false);
});

test('setActor で同じ actor を指定しても状態を壊さない', async () => {
	const store = new MediaStore();
	const fetcher = new MediaFetcher(store, config, makeFetch([{body: feedBody(['p1'], 'c1')}]));
	fetcher.setActor('alice.test');
	await fetcher.fetchNext();
	fetcher.setActor('alice.test');
	assert.strictEqual(fetcher.cursor, 'c1');
});

test('ok:false のレスポンス (読めないアカウント) は終端扱い', async () => {
	const store = new MediaStore();
	const fetcher = new MediaFetcher(store, config, makeFetch([{body: {}}]));
	fetcher.setActor('alice.test');
	await fetcher.fetchNext();
	assert.strictEqual(fetcher.exhausted, true);
});

test('旧世代の応答が新世代の進行中フェッチを邪魔しない', async () => {
	const store = new MediaStore();
	let releaseA;
	let releaseB;
	const gateA = new Promise((resolve) => { releaseA = resolve; });
	const gateB = new Promise((resolve) => { releaseB = resolve; });
	let callCount = 0;
	const impl = async () => {
		callCount += 1;
		const n = callCount;
		if (n === 1) {
			// actor A の応答を保留
			await gateA;
			return {ok: true, status: 200, json: async () => feedBody(['a1'], 'curA')};
		} else if (n === 2) {
			// actor B の応答を保留
			await gateB;
			return {ok: true, status: 200, json: async () => feedBody(['b1'], 'curB')};
		} else {
			throw new Error('呼びすぎです');
		}
	};
	const fetcher = new MediaFetcher(store, config, impl);

	// 1. actor A で fetchNext() を呼ぶ (応答を保留させる)
	fetcher.setActor('alice.test');
	const pendingA = fetcher.fetchNext();
	assert.strictEqual(fetcher.running, true, 'A の取得が進行中');

	// 2. setActor('B') で対象を変える
	fetcher.setActor('bob.test');
	assert.strictEqual(fetcher.running, false, 'reset() で running=false');

	// 3. actor B で fetchNext() を呼ぶ (これも応答を保留させる)
	const pendingB = fetcher.fetchNext();
	assert.strictEqual(fetcher.running, true, 'B の取得が進行中');

	// 4. ここで 1 の応答を解決させる
	releaseA();
	await pendingA;

	// 5. この時点で B の取得はまだ進行中であり、running が true のままであることを検証する
	assert.strictEqual(fetcher.running, true, 'A の finally が B の running を壊さない');

	// 6. さらにクールダウンを解除して fetchNext() を呼んでも、B に対する二重リクエストが飛ばないこと
	fetcher.lastRunAt = 0;
	const pendingC = fetcher.fetchNext();
	// 同時実行を許さないので、pending な fetchNext() は呼ばれないはず
	assert.strictEqual(fetcher.running, true, 'まだ running=true（新しいリクエストは出ない）');

	// B の応答を解決
	releaseB();
	await pendingB;
	await pendingC;

	assert.strictEqual(callCount, 2, 'A と B で計 2 回だけ呼ばれる（二重リクエストなし）');
	assert.strictEqual(store.size, 1, 'B の 1 件だけ蓄積');
});

test('動画だけのページは entries が 0 件でも終端にせず、cursor を進める', async () => {
	const store = new MediaStore();
	const impl = makeFetch([{body: videoOnlyFeedBody(['v1', 'v2'], 'cur1')}]);
	const fetcher = new MediaFetcher(store, config, impl);
	fetcher.setActor('alice.test');
	await fetcher.fetchNext();
	assert.strictEqual(store.size, 0);
	assert.strictEqual(fetcher.exhausted, false, '動画の除外で 0 件になっただけで終端ではない');
	assert.strictEqual(fetcher.cursor, 'cur1');
});

test('feed が空 (0 件) なら cursor があっても終端とみなす', async () => {
	const store = new MediaStore();
	const impl = makeFetch([{body: {feed: [], cursor: 'cur1'}}]);
	const fetcher = new MediaFetcher(store, config, impl);
	fetcher.setActor('alice.test');
	await fetcher.fetchNext();
	assert.strictEqual(fetcher.exhausted, true);
});

test('fetchNext は 1 回の fetch にタイムアウトの signal を渡す', async () => {
	const store = new MediaStore();
	const impl = makeFetch([{body: feedBody(['p1'], 'cur1')}]);
	const fetcher = new MediaFetcher(store, config, impl);
	fetcher.setActor('alice.test');
	await fetcher.fetchNext();
	assert.strictEqual(impl.options[0].credentials, 'omit');
	if (typeof AbortSignal.timeout === 'function') {
		assert.ok(impl.options[0].signal instanceof AbortSignal, 'signal が無い');
	}
});
