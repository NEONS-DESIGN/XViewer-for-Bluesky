/**
 * post-actions.js の純関数の検査。
 * 橋渡しの呼び出し・実通信・DOM は対象外 (実機で確認する)。
 */

import test from 'node:test';
import assert from 'node:assert';

import {EXT_CONFIG} from '../src/common/config.js';
import {
	parseRecordUri,
	readViewerState,
	toggleActionState,
	mergeActionKind,
	isActionApplied,
	readThreadResults,
	PostActions
} from '../src/content/post-actions.js';

/** 反応数の初期値。テストごとに作り直す */
function makeCounts() {
	return {reply: 3, repost: 10, like: 100, quote: 2};
}

test('parseRecordUri: いいねのレコード URI を分解できる', () => {
	const parsed = parseRecordUri('at://did:plc:abc/app.bsky.feed.like/3kxyz');
	assert.deepStrictEqual(parsed, {
		did: 'did:plc:abc',
		collection: 'app.bsky.feed.like',
		rkey: '3kxyz'
	});
});

test('parseRecordUri: 投稿の URI もコレクションを問わず分解できる', () => {
	const parsed = parseRecordUri('at://did:plc:abc/app.bsky.feed.post/3aaa');
	assert.strictEqual(parsed.collection, 'app.bsky.feed.post');
	assert.strictEqual(parsed.rkey, '3aaa');
});

test('parseRecordUri: 形が違えば null', () => {
	assert.strictEqual(parseRecordUri('https://bsky.app/'), null);
	assert.strictEqual(parseRecordUri('at://did:plc:abc/app.bsky.feed.like'), null);
	assert.strictEqual(parseRecordUri(''), null);
	assert.strictEqual(parseRecordUri(null), null);
	assert.strictEqual(parseRecordUri(undefined), null);
});

test('readViewerState: いいね済み・リポスト済み・ブックマーク済みを読む', () => {
	const state = readViewerState({
		like: 'at://did:plc:me/app.bsky.feed.like/1',
		repost: 'at://did:plc:me/app.bsky.feed.repost/2',
		bookmarked: true
	}, makeCounts());
	assert.strictEqual(state.liked, true);
	assert.strictEqual(state.likeUri, 'at://did:plc:me/app.bsky.feed.like/1');
	assert.strictEqual(state.reposted, true);
	assert.strictEqual(state.repostUri, 'at://did:plc:me/app.bsky.feed.repost/2');
	assert.strictEqual(state.bookmarked, true);
	assert.deepStrictEqual(state.counts, makeCounts());
});

test('readViewerState: viewer が空なら全部 false', () => {
	const state = readViewerState({}, makeCounts());
	assert.strictEqual(state.liked, false);
	assert.strictEqual(state.likeUri, null);
	assert.strictEqual(state.reposted, false);
	assert.strictEqual(state.repostUri, null);
	assert.strictEqual(state.bookmarked, false);
});

test('readViewerState: viewer が無くても落ちない', () => {
	const state = readViewerState(null, makeCounts());
	assert.strictEqual(state.liked, false);
	assert.strictEqual(state.bookmarked, false);
	assert.deepStrictEqual(state.counts, makeCounts());
});

test('readViewerState: 壊れた値は無視する', () => {
	const state = readViewerState({like: 42, repost: {}, bookmarked: 'yes'}, makeCounts());
	assert.strictEqual(state.liked, false);
	assert.strictEqual(state.reposted, false);
	assert.strictEqual(state.bookmarked, false);
});

test('toggleActionState: いいねを付けると数が 1 増える', () => {
	const before = readViewerState({}, makeCounts());
	const after = toggleActionState(before, 'like');
	assert.strictEqual(after.liked, true);
	assert.strictEqual(after.counts.like, 101);
	// 付けた直後は URI がまだ分からない (createRecord の応答で埋める)
	assert.strictEqual(after.likeUri, null);
});

test('toggleActionState: いいねを外すと数が 1 減り URI が消える', () => {
	const before = readViewerState({like: 'at://did:plc:me/app.bsky.feed.like/1'}, makeCounts());
	const after = toggleActionState(before, 'like');
	assert.strictEqual(after.liked, false);
	assert.strictEqual(after.counts.like, 99);
	assert.strictEqual(after.likeUri, null);
});

test('toggleActionState: 元の状態を壊さない (巻き戻せる)', () => {
	const before = readViewerState({}, makeCounts());
	const after = toggleActionState(before, 'like');
	assert.strictEqual(before.liked, false);
	assert.strictEqual(before.counts.like, 100);
	assert.notStrictEqual(before.counts, after.counts);
});

test('toggleActionState: リポストも同じように動く', () => {
	const before = readViewerState({}, makeCounts());
	const after = toggleActionState(before, 'repost');
	assert.strictEqual(after.reposted, true);
	assert.strictEqual(after.counts.repost, 11);
	assert.strictEqual(after.counts.like, 100);
});

test('toggleActionState: ブックマークは数を持たない', () => {
	const before = readViewerState({}, makeCounts());
	const after = toggleActionState(before, 'bookmark');
	assert.strictEqual(after.bookmarked, true);
	assert.deepStrictEqual(after.counts, makeCounts());
});

test('toggleActionState: 数は 0 を下回らない', () => {
	const zero = readViewerState(
		{like: 'at://did:plc:me/app.bsky.feed.like/1'},
		{reply: 0, repost: 0, like: 0, quote: 0}
	);
	const after = toggleActionState(zero, 'like');
	assert.strictEqual(after.counts.like, 0);
});

test('toggleActionState: 知らない種別は状態を変えない', () => {
	const before = readViewerState({}, makeCounts());
	const after = toggleActionState(before, 'follow');
	assert.deepStrictEqual(after, before);
});

test('readViewerState: counts が null でも落ちず、すべて 0 になる', () => {
	const state = readViewerState({}, null);
	assert.strictEqual(state.counts.reply, 0);
	assert.strictEqual(state.counts.repost, 0);
	assert.strictEqual(state.counts.like, 0);
	assert.strictEqual(state.counts.quote, 0);
});

test('readViewerState: counts の一部のキーが欠けていても、欠けたものだけ 0 になる', () => {
	const state = readViewerState({}, {reply: 3, like: 100});
	assert.strictEqual(state.counts.reply, 3);
	assert.strictEqual(state.counts.repost, 0);
	assert.strictEqual(state.counts.like, 100);
	assert.strictEqual(state.counts.quote, 0);
});

test('toggleActionState: リポストを外すと数が 1 減る', () => {
	const before = readViewerState({repost: 'at://did:plc:me/app.bsky.feed.repost/2'}, makeCounts());
	const after = toggleActionState(before, 'repost');
	assert.strictEqual(after.reposted, false);
	assert.strictEqual(after.counts.repost, 9);
	assert.strictEqual(after.repostUri, null);
});

test('toggleActionState: ブックマークを外すと bookmarked が false になる', () => {
	const before = readViewerState({bookmarked: true}, makeCounts());
	const after = toggleActionState(before, 'bookmark');
	assert.strictEqual(after.bookmarked, false);
	assert.deepStrictEqual(after.counts, makeCounts());
});

test('mergeActionKind: like の結果だけを取り込み、開き直した側のブックマークの状態は保たれる', () => {
	// 開き直した側の状態 (書き戻し前の viewer から作られ、like は未反応のまま)
	const reopened = readViewerState({bookmarked: true}, makeCounts());
	// 飛行中だった like の結果 (URI まで埋まっている)
	const finished = toggleActionState(readViewerState(null, makeCounts()), 'like');
	finished.likeUri = 'at://did:plc:me/app.bsky.feed.like/1';
	const merged = mergeActionKind(reopened, 'like', finished);
	assert.strictEqual(merged.liked, true);
	assert.strictEqual(merged.likeUri, 'at://did:plc:me/app.bsky.feed.like/1');
	assert.strictEqual(merged.counts.like, 101);
	assert.strictEqual(merged.bookmarked, true);
	assert.strictEqual(merged.reposted, false);
	assert.strictEqual(merged.counts.repost, 10);
	// 元の状態は書き換えない
	assert.strictEqual(reopened.liked, false);
	assert.strictEqual(reopened.likeUri, null);
});

test('mergeActionKind: repost の結果だけを取り込み、like の URI には触れない', () => {
	const reopened = readViewerState({like: 'at://did:plc:me/app.bsky.feed.like/9'}, makeCounts());
	const finished = toggleActionState(readViewerState(null, makeCounts()), 'repost');
	finished.repostUri = 'at://did:plc:me/app.bsky.feed.repost/2';
	const merged = mergeActionKind(reopened, 'repost', finished);
	assert.strictEqual(merged.reposted, true);
	assert.strictEqual(merged.repostUri, 'at://did:plc:me/app.bsky.feed.repost/2');
	assert.strictEqual(merged.counts.repost, 11);
	assert.strictEqual(merged.liked, true);
	assert.strictEqual(merged.likeUri, 'at://did:plc:me/app.bsky.feed.like/9');
	assert.strictEqual(merged.counts.like, 100);
});

test('mergeActionKind: bookmark は bookmarked だけを取り込み、counts は元のまま', () => {
	const reopened = readViewerState(null, makeCounts());
	const finished = toggleActionState(readViewerState(null, {reply: 0, repost: 0, like: 0, quote: 0}), 'bookmark');
	const merged = mergeActionKind(reopened, 'bookmark', finished);
	assert.strictEqual(merged.bookmarked, true);
	assert.deepStrictEqual(merged.counts, makeCounts());
});

test('mergeActionKind: 知らない種別は元の状態と同じ中身を返す', () => {
	const state = readViewerState({bookmarked: true}, makeCounts());
	const merged = mergeActionKind(state, 'unknown', toggleActionState(state, 'like'));
	assert.deepStrictEqual(merged, state);
	assert.notStrictEqual(merged, state);
});

test('isActionApplied: 引き直した状態が意図どおりなら true、違えば false', () => {
	const wanted = toggleActionState(readViewerState(null, makeCounts()), 'like');
	const serverLiked = readViewerState({like: 'at://did:plc:me/app.bsky.feed.like/1'}, makeCounts());
	const serverNot = readViewerState(null, makeCounts());
	assert.strictEqual(isActionApplied(serverLiked, 'like', wanted), true);
	assert.strictEqual(isActionApplied(serverNot, 'like', wanted), false);
	const wantedBookmark = toggleActionState(readViewerState(null, makeCounts()), 'bookmark');
	assert.strictEqual(isActionApplied(readViewerState({bookmarked: true}, makeCounts()), 'bookmark', wantedBookmark), true);
	assert.strictEqual(isActionApplied(serverLiked, 'unknown', wanted), false);
});

const REPO = 'did:plc:me';
const COLL = 'app.bsky.feed.post';
const WRITES = [{rkey: 'a'}, {rkey: 'b'}];
function okJson(repo = REPO) {
	return {results: [
		{uri: 'at://' + repo + '/' + COLL + '/a', cid: 'c1'},
		{uri: 'at://' + repo + '/' + COLL + '/b', cid: 'c2'}
	]};
}

test('readThreadResults: 正しい応答は書いた順の {uri, cid} になる', () => {
	assert.deepStrictEqual(readThreadResults(okJson(), WRITES, REPO, COLL), [
		{uri: 'at://did:plc:me/app.bsky.feed.post/a', cid: 'c1'},
		{uri: 'at://did:plc:me/app.bsky.feed.post/b', cid: 'c2'}
	]);
});

test('readThreadResults: 件数違い・uri 違い・cid 無し・null は null', () => {
	assert.strictEqual(readThreadResults({results: okJson().results.slice(0, 1)}, WRITES, REPO, COLL), null);
	assert.strictEqual(readThreadResults(okJson('did:plc:other'), WRITES, REPO, COLL), null);
	const noCid = okJson();
	delete noCid.results[1].cid;
	assert.strictEqual(readThreadResults(noCid, WRITES, REPO, COLL), null);
	const emptyCid = okJson();
	emptyCid.results[0].cid = '';
	assert.strictEqual(readThreadResults(emptyCid, WRITES, REPO, COLL), null);
	assert.strictEqual(readThreadResults(null, WRITES, REPO, COLL), null);
	assert.strictEqual(readThreadResults({}, WRITES, REPO, COLL), null);
});

/** 橋渡しと DID の取得を差し替えた PostActions */
function makeActions(dids, replies) {
	const actions = new PostActions({
		nsid: {applyWrites: 'com.atproto.repo.applyWrites'},
		collections: {post: COLL},
		reasons: {repoNotSelf: 'repo-not-self'}
	});
	const calls = [];
	actions.getSessionDid = async () => dids.shift() || null;
	actions.call = async (nsid, options) => {
		calls.push({nsid, body: options.body, timeoutMs: options.timeoutMs});
		return replies.shift();
	};
	return {actions, calls};
}

test('createReplyThread: repo-not-self なら新しい DID で組み直して 1 回やり直す', async () => {
	const built = [];
	const {actions, calls} = makeActions(['did:plc:old', 'did:plc:new'], [
		{ok: false, json: null, reason: 'repo-not-self'},
		{ok: true, json: okJson('did:plc:new'), reason: null}
	]);
	const result = await actions.createReplyThread(async (did) => {
		built.push(did);
		return WRITES;
	});
	assert.deepStrictEqual(built, ['did:plc:old', 'did:plc:new']);
	assert.strictEqual(calls[0].body.repo, 'did:plc:old');
	assert.strictEqual(calls[1].body.repo, 'did:plc:new');
	assert.strictEqual(calls[1].nsid, 'com.atproto.repo.applyWrites');
	assert.strictEqual(result.ok, true);
	assert.strictEqual(result.results.length, 2);
});

test('createReplyThread: 2 回とも repo-not-self なら失敗で build は 2 回だけ', async () => {
	let count = 0;
	const {actions} = makeActions(['did:plc:a', 'did:plc:b'], [
		{ok: false, json: null, reason: 'repo-not-self'},
		{ok: false, json: null, reason: 'repo-not-self'}
	]);
	const result = await actions.createReplyThread(async () => {
		count += 1;
		return WRITES;
	});
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.reason, 'repo-not-self');
	assert.strictEqual(count, 2);
});

test('createReplyThread: 応答の uri が合わなければ thread-unconfirmed', async () => {
	const {actions} = makeActions([REPO], [{ok: true, json: okJson('did:plc:other'), reason: null}]);
	const result = await actions.createReplyThread(async () => WRITES);
	assert.deepStrictEqual(
		{ok: result.ok, reason: result.reason, writes: result.writes},
		{ok: false, reason: 'thread-unconfirmed', writes: WRITES}
	);
});

test('createReplyThread: DID が無ければ no-session、build が投げれば失敗を返す', async () => {
	const none = makeActions([], []);
	assert.strictEqual((await none.actions.createReplyThread(async () => WRITES)).reason, 'no-session');
	const bad = makeActions([REPO], []);
	const result = await bad.actions.createReplyThread(async () => {
		throw new Error('x');
	});
	assert.deepStrictEqual({ok: result.ok, reason: result.reason}, {ok: false, reason: 'build-failed'});
});

test('createReplyThread: applyWrites は長い待ち時間で呼び、待ちきれなければ thread-unconfirmed (書けているかもしれない)', async () => {
	const {actions, calls} = makeActions([REPO], [{ok: false, json: null, reason: 'timeout'}]);
	const result = await actions.createReplyThread(async () => WRITES);
	assert.strictEqual(calls.length, 1);
	assert.strictEqual(calls[0].timeoutMs, EXT_CONFIG.mediaGrid.bridge.threadTimeoutMs);
	assert.ok(EXT_CONFIG.mediaGrid.bridge.threadTimeoutMs > EXT_CONFIG.mediaGrid.bridge.timeoutMs);
	assert.deepStrictEqual(
		{ok: result.ok, reason: result.reason, writes: result.writes},
		{ok: false, reason: 'thread-unconfirmed', writes: WRITES}
	);
	// 待ちきれなかったのではない失敗はそのまま返す (送り直してよい)
	const other = makeActions([REPO], [{ok: false, json: null, reason: 'thread-not-allowed'}]);
	assert.strictEqual((await other.actions.createReplyThread(async () => WRITES)).reason, 'thread-not-allowed');
});

test('PostActions#call: timeoutMs を橋渡しの待ち時間に渡し、省けば既定の待ち時間のまま', async () => {
	const saved = globalThis.document;
	const requests = [];
	globalThis.document = {
		addEventListener: () => {},
		removeEventListener: () => {},
		dispatchEvent: (event) => {
			requests.push(JSON.parse(event.detail));
			return true;
		}
	};
	const actions = new PostActions({nsid: {}, collections: {}, reasons: {repoNotSelf: 'repo-not-self'}});
	try {
		const started = Date.now();
		const result = await actions.call('com.atproto.repo.applyWrites', {body: {repo: REPO}, timeoutMs: 5});
		assert.deepStrictEqual(result, {ok: false, json: null, reason: 'timeout', status: null});
		// 既定 (EXT_CONFIG.mediaGrid.bridge.timeoutMs) より十分短い時間で打ち切られた
		assert.ok(Date.now() - started < EXT_CONFIG.mediaGrid.bridge.timeoutMs / 2, '渡した待ち時間が効いていない');
		assert.strictEqual(requests.length, 1);
		assert.deepStrictEqual(requests[0].payload.body, {repo: REPO});
		assert.strictEqual('timeoutMs' in requests[0].payload, false);
	} finally {
		globalThis.document = saved;
	}
});
