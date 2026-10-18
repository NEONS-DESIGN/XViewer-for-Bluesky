/**
 * page-bridge.js の白名簿の検査。
 * **この検査が橋渡しの唯一の関門である。** ext:bridge-request は document 上の
 * CustomEvent で、bsky.app 上で動く誰でも撃てるため、ここが緩むと
 * 「本体のセッションで任意の XRPC を呼べる穴」になる。
 * React fiber の走査・実通信・DOM は対象外 (実機で確認する)。
 */

import test from 'node:test';
import assert from 'node:assert';

import {EXT_CONFIG} from '../src/common/config.js';
import {BRIDGE_PROTOCOL} from '../src/common/bridge-protocol.js';
import {
	EXT_BRIDGE, checkXrpcRequest, checkPostRecord, isReplyPostResponse, buildQuery,
	waitForLightboxHistory
} from '../src/inject/page-bridge.js';

/** 検査に使う自分の DID */
const SELF_DID = 'did:plc:self0000000000000000000';

test('checkXrpcRequest: 白名簿の読み取りは通る', () => {
	const result = checkXrpcRequest(
		{nsid: 'app.bsky.feed.getPosts', params: {uris: ['at://x']}},
		SELF_DID
	);
	assert.strictEqual(result.ok, true);
	assert.strictEqual(result.rule.target, 'appview');
	assert.strictEqual(result.rule.method, 'GET');
});

test('checkXrpcRequest: 白名簿に無い NSID は落ちる', () => {
	const result = checkXrpcRequest({nsid: 'com.atproto.repo.putRecord'}, SELF_DID);
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.reason, 'nsid-not-allowed');
});

test('checkXrpcRequest: フォローの作成は NSID が通っても collection で落ちる', () => {
	const result = checkXrpcRequest({
		nsid: 'com.atproto.repo.createRecord',
		body: {repo: SELF_DID, collection: 'app.bsky.graph.follow', record: {}}
	}, SELF_DID);
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.reason, 'collection-not-allowed');
});

/** 返信の作成に使う、検査を通る形の record を作る */
function replyRecord(overrides) {
	return Object.assign({
		$type: 'app.bsky.feed.post',
		text: 'a',
		createdAt: '2026-10-18T00:00:00.000Z',
		reply: {
			root: {uri: 'at://did:plc:a/app.bsky.feed.post/1', cid: 'c1'},
			parent: {uri: 'at://did:plc:a/app.bsky.feed.post/2', cid: 'c2'}
		}
	}, overrides);
}

/** 投稿の作成を検査にかける */
function checkPostCreate(record, did) {
	return checkXrpcRequest({
		nsid: 'com.atproto.repo.createRecord',
		body: {repo: did === undefined ? SELF_DID : did, collection: 'app.bsky.feed.post', record}
	}, SELF_DID);
}

test('checkXrpcRequest: 返信でない投稿の作成は落ちる', () => {
	const result = checkPostCreate({
		$type: 'app.bsky.feed.post', text: 'a', createdAt: '2026-10-18T00:00:00.000Z'
	});
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.reason, 'post-not-reply');
});

test('checkXrpcRequest: 返信の作成は通り、record はそのまま写される', () => {
	const record = replyRecord({langs: ['ja'], facets: []});
	const result = checkPostCreate(record);
	assert.strictEqual(result.ok, true);
	assert.strictEqual(result.rule.target, 'pds');
	assert.deepStrictEqual(result.body.record, record);
	assert.strictEqual(result.needsReplyCheck, false);
});

test('checkXrpcRequest: embed を持つ投稿は落ちる', () => {
	const result = checkPostCreate(replyRecord({embed: {$type: 'app.bsky.embed.images'}}));
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.reason, 'post-record-not-allowed');
});

test('checkXrpcRequest: 本文が 3000 バイトを超える投稿は落ち、ちょうど 3000 バイトは通る', () => {
	const over = checkPostCreate(replyRecord({text: 'あ'.repeat(1001)}));
	assert.strictEqual(over.ok, false);
	assert.strictEqual(over.reason, 'post-record-not-allowed');
	assert.strictEqual(checkPostCreate(replyRecord({text: 'a'.repeat(3000)})).ok, true);
});

test('checkXrpcRequest: reply の形が崩れた投稿は落ちる', () => {
	const root = {uri: 'at://did:plc:a/app.bsky.feed.post/1', cid: 'c1'};
	const parent = {uri: 'at://did:plc:a/app.bsky.feed.post/2', cid: 'c2'};
	const broken = [
		{root, parent: {uri: 'https://bsky.app/profile/a/post/2', cid: 'c2'}},
		{root: {uri: root.uri, cid: 1}, parent},
		{root},
		{root, parent: {uri: 'at://did:plc:a/app.bsky.feed.like/2', cid: 'c2'}},
		'x'
	];
	for (const reply of broken) {
		const result = checkPostCreate(replyRecord({reply}));
		assert.strictEqual(result.ok, false, JSON.stringify(reply));
		assert.strictEqual(result.reason, 'post-not-reply');
	}
});

test('checkXrpcRequest: langs と facets の形が崩れた投稿は落ちる', () => {
	const cases = [
		{langs: ['ja', 'en', 'fr', 'de']},
		{langs: ['ja', 1]},
		{langs: 'ja'},
		{facets: {}},
		{text: 1},
		{createdAt: 1}
	];
	for (const overrides of cases) {
		const result = checkPostCreate(replyRecord(overrides));
		assert.strictEqual(result.ok, false, JSON.stringify(overrides));
		assert.strictEqual(result.reason, 'post-record-not-allowed');
	}
});

test('checkXrpcRequest: 他人の repo への返信の作成は落ちる', () => {
	const result = checkPostCreate(replyRecord(), 'did:plc:someoneelse');
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.reason, 'repo-not-self');
});

test('checkXrpcRequest: 投稿の削除は返信であるかの事前確認を求め、いいねの削除は求めない', () => {
	const post = checkXrpcRequest({
		nsid: 'com.atproto.repo.deleteRecord',
		body: {repo: SELF_DID, collection: 'app.bsky.feed.post', rkey: 'abc'}
	}, SELF_DID);
	assert.strictEqual(post.ok, true);
	assert.strictEqual(post.needsReplyCheck, true);
	const like = checkXrpcRequest({
		nsid: 'com.atproto.repo.deleteRecord',
		body: {repo: SELF_DID, collection: 'app.bsky.feed.like', rkey: 'abc'}
	}, SELF_DID);
	assert.strictEqual(like.ok, true);
	assert.strictEqual(like.needsReplyCheck, false);
});

test('checkXrpcRequest: getPostThread の読み取りは appview へ通る', () => {
	const result = checkXrpcRequest({
		nsid: 'app.bsky.feed.getPostThread',
		params: {uri: 'at://x', depth: 1, parentHeight: 0}
	}, SELF_DID);
	assert.strictEqual(result.ok, true);
	assert.strictEqual(result.rule.target, 'appview');
	assert.strictEqual(result.rule.method, 'GET');
});

test('checkPostRecord: 返信の record だけを通す', () => {
	assert.deepStrictEqual(checkPostRecord(replyRecord()), {ok: true});
	assert.strictEqual(checkPostRecord(null).ok, false);
	assert.strictEqual(checkPostRecord(replyRecord({reply: undefined})).reason, 'post-not-reply');
});

test('isReplyPostResponse: 指定の URI の投稿が返信であるときだけ真', () => {
	const uri = 'at://did:plc:self/app.bsky.feed.post/abc';
	const reply = {root: {uri: 'at://r', cid: 'r'}, parent: {uri: 'at://p', cid: 'p'}};
	assert.strictEqual(isReplyPostResponse({posts: [{uri, record: {reply}}]}, uri), true);
	assert.strictEqual(isReplyPostResponse({posts: [{uri, record: {text: 'x'}}]}, uri), false);
	assert.strictEqual(isReplyPostResponse({posts: []}, uri), false);
	assert.strictEqual(
		isReplyPostResponse({posts: [{uri: 'at://did:plc:self/app.bsky.feed.post/other', record: {reply}}]}, uri),
		false
	);
	assert.strictEqual(isReplyPostResponse(null, uri), false);
	assert.strictEqual(isReplyPostResponse({posts: [{uri, record: {reply: 'x'}}]}, uri), false);
});

test('checkXrpcRequest: 他人の repo への書き込みは落ちる', () => {
	const result = checkXrpcRequest({
		nsid: 'com.atproto.repo.createRecord',
		body: {repo: 'did:plc:someoneelse', collection: 'app.bsky.feed.like', record: {}}
	}, SELF_DID);
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.reason, 'repo-not-self');
});

test('checkXrpcRequest: 自分の repo へのいいねは通り、body は白名簿のキーだけに組み直される', () => {
	const record = {$type: 'app.bsky.feed.like', subject: {uri: 'at://x', cid: 'c'}};
	const result = checkXrpcRequest({
		nsid: 'com.atproto.repo.createRecord',
		body: {repo: SELF_DID, collection: 'app.bsky.feed.like', record, validate: false}
	}, SELF_DID);
	assert.strictEqual(result.ok, true);
	assert.strictEqual(result.rule.target, 'pds');
	assert.strictEqual(result.rule.method, 'POST');
	assert.deepStrictEqual(result.body, {repo: SELF_DID, collection: 'app.bsky.feed.like', record});
});

test('checkXrpcRequest: record.$type が collection と違えば落ちる ($type 無しも同じ)', () => {
	const mismatch = checkXrpcRequest({
		nsid: 'com.atproto.repo.createRecord',
		body: {repo: SELF_DID, collection: 'app.bsky.feed.like',
			record: {$type: 'app.bsky.feed.post', text: 'x'}}
	}, SELF_DID);
	assert.strictEqual(mismatch.ok, false);
	assert.strictEqual(mismatch.reason, 'record-type-mismatch');
	const untyped = checkXrpcRequest({
		nsid: 'com.atproto.repo.createRecord',
		body: {repo: SELF_DID, collection: 'app.bsky.feed.like', record: {}}
	}, SELF_DID);
	assert.strictEqual(untyped.ok, false);
	assert.strictEqual(untyped.reason, 'record-type-mismatch');
});

test('checkXrpcRequest: deleteRecord は rkey が文字列でなければ落ち、通れば rkey まで写す', () => {
	const missing = checkXrpcRequest({
		nsid: 'com.atproto.repo.deleteRecord',
		body: {repo: SELF_DID, collection: 'app.bsky.feed.like'}
	}, SELF_DID);
	assert.strictEqual(missing.ok, false);
	assert.strictEqual(missing.reason, 'invalid-rkey');
	const ok = checkXrpcRequest({
		nsid: 'com.atproto.repo.deleteRecord',
		body: {repo: SELF_DID, collection: 'app.bsky.feed.like', rkey: 'abc', swapRecord: 'x'}
	}, SELF_DID);
	assert.strictEqual(ok.ok, true);
	assert.deepStrictEqual(ok.body, {repo: SELF_DID, collection: 'app.bsky.feed.like', rkey: 'abc'});
});

test('checkXrpcRequest: ブックマークは body が白名簿のキーだけになり、GET は body を持たない', () => {
	const bookmark = checkXrpcRequest({
		nsid: 'app.bsky.bookmark.createBookmark',
		body: {uri: 'at://x', cid: 'c', extra: 1}
	}, SELF_DID);
	assert.strictEqual(bookmark.ok, true);
	assert.deepStrictEqual(bookmark.body, {uri: 'at://x', cid: 'c'});
	const get = checkXrpcRequest({nsid: 'app.bsky.feed.getPosts', params: {uris: []}}, SELF_DID);
	assert.strictEqual(get.ok, true);
	assert.strictEqual(get.body, null);
});

test('checkXrpcRequest: 自分のリポストの削除も通る', () => {
	const result = checkXrpcRequest({
		nsid: 'com.atproto.repo.deleteRecord',
		body: {repo: SELF_DID, collection: 'app.bsky.feed.repost', rkey: 'abc'}
	}, SELF_DID);
	assert.strictEqual(result.ok, true);
});

test('checkXrpcRequest: セッションが無いときの書き込みは落ちる', () => {
	const result = checkXrpcRequest({
		nsid: 'com.atproto.repo.createRecord',
		body: {repo: SELF_DID, collection: 'app.bsky.feed.like', record: {}}
	}, null);
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.reason, 'repo-not-self');
});

test('checkXrpcRequest: payload が壊れていても落ちない', () => {
	assert.strictEqual(checkXrpcRequest(null, SELF_DID).ok, false);
	assert.strictEqual(checkXrpcRequest({}, SELF_DID).ok, false);
	assert.strictEqual(
		checkXrpcRequest({nsid: 'com.atproto.repo.createRecord'}, SELF_DID).reason,
		'invalid-body'
	);
});

/**
 * 修正ラウンド 1 (レビュー C1) の回帰テスト。
 * hasOwnProperty はプロパティキーの ToString 変換で照合するため、nsid に
 * 配列 (入れ子含む) を渡すと白名簿には hit しつつ、旧実装の isRecordWrite
 * (=== の厳密比較) は false になり collection / repo の検査を丸ごと飛ばして
 * いた。型の門番 (typeof payload.nsid !== 'string') で塞いだことを確認する
 */
test('checkXrpcRequest: nsid が文字列でないものは通らない', () => {
	assert.strictEqual(checkXrpcRequest({
		nsid: ['com.atproto.repo.createRecord'],
		body: {repo: SELF_DID, collection: 'app.bsky.feed.post', record: {}}
	}, SELF_DID).ok, false);
	assert.strictEqual(checkXrpcRequest({
		nsid: [['com.atproto.repo.deleteRecord']],
		body: {repo: SELF_DID, collection: 'app.bsky.graph.follow', rkey: 'a'}
	}, SELF_DID).ok, false);
});

/**
 * 修正ラウンド 1 (レビュー I2) の回帰テスト。
 * isRecordWrite を文字列リテラル 2 個の直書きに戻すと、EXT_BRIDGE.xrpc に
 * recordWrite: true な NSID を新しく足しても検査が追随せず、collection /
 * repo の検査を受けずに通ってしまう。rule.recordWrite から導くことで、
 * 白名簿に無い NSID (テスト用に一時追加したもの) でも検査が効くことを確認する
 */
test('checkXrpcRequest: 白名簿に recordWrite な NSID を追加すると自動で collection 検査を受ける', () => {
	const fakeNsid = 'com.atproto.repo.testWrite';
	EXT_BRIDGE.xrpc[fakeNsid] = {target: 'pds', method: 'POST', recordWrite: true};
	try {
		const result = checkXrpcRequest({
			nsid: fakeNsid,
			body: {repo: SELF_DID, collection: 'app.bsky.graph.follow', record: {}}
		}, SELF_DID);
		assert.strictEqual(result.ok, false);
		assert.strictEqual(result.reason, 'collection-not-allowed');
	} finally {
		delete EXT_BRIDGE.xrpc[fakeNsid];
	}
});

/**
 * 橋渡しの名前・白名簿の値は common/bridge-protocol.js の BRIDGE_PROTOCOL に 1 つだけ書き、
 * config.js (content 側) と page-bridge.js (MAIN 側) の両方がそれを参照する。
 * どちらかがリテラルを書き直して二重持ちに戻ると、参照が別物になってここで落ちる
 */
test('橋渡しの値は config.js と page-bridge.js が同じ BRIDGE_PROTOCOL を参照している', () => {
	// content 側 (config.js) はオブジェクトをそのまま参照する
	assert.strictEqual(EXT_CONFIG.mediaGrid.bridge.actions, BRIDGE_PROTOCOL.actions);
	assert.strictEqual(EXT_CONFIG.mediaGrid.bridge.routes, BRIDGE_PROTOCOL.routes);
	assert.strictEqual(EXT_CONFIG.mediaGrid.bridge.requestEvent, BRIDGE_PROTOCOL.requestEvent);
	assert.strictEqual(EXT_CONFIG.mediaGrid.bridge.resultEvent, BRIDGE_PROTOCOL.resultEvent);
	assert.strictEqual(EXT_CONFIG.selectors.tabPrefix, BRIDGE_PROTOCOL.tabTestIdPrefix);
	assert.strictEqual(EXT_CONFIG.postActions.nsid, BRIDGE_PROTOCOL.nsid);
	assert.strictEqual(EXT_CONFIG.postActions.collections, BRIDGE_PROTOCOL.collections);
	assert.strictEqual(EXT_CONFIG.postActions.composerModes, BRIDGE_PROTOCOL.composerModes);
	assert.strictEqual(EXT_CONFIG.postActions.reasons, BRIDGE_PROTOCOL.reasons);
	// MAIN 側 (page-bridge.js) も同じオブジェクトを参照する
	assert.strictEqual(EXT_BRIDGE.actions, BRIDGE_PROTOCOL.actions);
	assert.strictEqual(EXT_BRIDGE.requestEvent, BRIDGE_PROTOCOL.requestEvent);
	assert.strictEqual(EXT_BRIDGE.resultEvent, BRIDGE_PROTOCOL.resultEvent);
	assert.strictEqual(EXT_BRIDGE.tabTestIdPrefix, BRIDGE_PROTOCOL.tabTestIdPrefix);
	// 検査に使う一覧は BRIDGE_PROTOCOL から作ったもの (値の並びも同じ)
	assert.deepStrictEqual(EXT_BRIDGE.routeNames, Object.values(BRIDGE_PROTOCOL.routes));
	assert.deepStrictEqual(EXT_BRIDGE.recordCollections, Object.values(BRIDGE_PROTOCOL.collections));
	assert.deepStrictEqual(EXT_BRIDGE.composerModes, Object.values(BRIDGE_PROTOCOL.composerModes));
	assert.deepStrictEqual(Object.keys(EXT_BRIDGE.xrpc).sort(), Object.values(BRIDGE_PROTOCOL.nsid).sort());
	// 呼び出し側が分岐に使う失敗理由も、検査が返す値と同じもの
	assert.strictEqual(
		checkXrpcRequest({
			nsid: BRIDGE_PROTOCOL.nsid.createRecord,
			body: {repo: 'did:plc:other', collection: BRIDGE_PROTOCOL.collections.like, record: {}}
		}, SELF_DID).reason,
		BRIDGE_PROTOCOL.reasons.repoNotSelf
	);
});

test('BRIDGE_PROTOCOL は入れ子まで凍結されている', () => {
	assert.ok(Object.isFrozen(BRIDGE_PROTOCOL));
	for (const value of Object.values(BRIDGE_PROTOCOL)) {
		if (value && typeof value === 'object') {
			assert.ok(Object.isFrozen(value));
		}
	}
});

test('buildQuery: 配列は同じ名前を繰り返し、null / undefined は落とす', () => {
	assert.strictEqual(
		buildQuery({uris: ['at://a', 'at://b'], cursor: null, limit: 1, skip: undefined}),
		'?uris=at%3A%2F%2Fa&uris=at%3A%2F%2Fb&limit=1'
	);
});

test('buildQuery: params が無い・オブジェクトでない・空なら空文字', () => {
	assert.strictEqual(buildQuery(undefined), '');
	assert.strictEqual(buildQuery('uris=a'), '');
	assert.strictEqual(buildQuery({}), '');
	assert.strictEqual(buildQuery({cursor: null}), '');
});

test('checkXrpcRequest: facets は形・範囲・種別・行き先が正しいものだけを通す', () => {
	const text = 'see https://e.com #tag @a.bsky.social';
	const link = {index: {byteStart: 4, byteEnd: 17}, features: [{$type: 'app.bsky.richtext.facet#link', uri: 'https://e.com'}]};
	const tag = {index: {byteStart: 18, byteEnd: 22}, features: [{$type: 'app.bsky.richtext.facet#tag', tag: 'tag'}]};
	const mention = {index: {byteStart: 23, byteEnd: 37}, features: [{$type: 'app.bsky.richtext.facet#mention', did: 'did:plc:a'}]};
	assert.strictEqual(checkPostCreate(replyRecord({text, facets: [link, tag, mention]})).ok, true);
	const bad = [
		[{index: {byteStart: 4, byteEnd: 17}, features: [{$type: 'app.bsky.richtext.facet#link', uri: 'javascript:alert(1)'}]}],
		[{index: {byteStart: 0, byteEnd: 999}, features: tag.features}],
		[{index: {byteStart: 5, byteEnd: 5}, features: tag.features}],
		[{index: {byteStart: -1, byteEnd: 3}, features: tag.features}],
		[{index: {byteStart: 0, byteEnd: 3}, features: [{$type: 'app.bsky.richtext.facet#unknown'}]}],
		[{index: {byteStart: 0, byteEnd: 3}, features: [{$type: 'app.bsky.richtext.facet#mention', did: 'plc:a'}]}],
		[{index: {byteStart: 0, byteEnd: 3}, features: []}],
		[{index: {byteStart: 0, byteEnd: 3}, features: [{$type: 'app.bsky.richtext.facet#tag', tag: ''}]}],
		['x'],
		Array.from({length: 51}, () => tag)
	];
	for (const facets of bad) {
		const result = checkPostCreate(replyRecord({text, facets}));
		assert.strictEqual(result.ok, false, JSON.stringify(facets).slice(0, 80));
		assert.strictEqual(result.reason, 'post-record-not-allowed');
	}
});

/** history と popstate だけを持つ偽の window */
function fakeWindow(state) {
	const listeners = new Set();
	return {
		history: {state},
		addEventListener(type, listener) {
			if (type === 'popstate') {
				listeners.add(listener);
			}
		},
		removeEventListener(type, listener) {
			if (type === 'popstate') {
				listeners.delete(listener);
			}
		},
		firePopstate() {
			for (const listener of Array.from(listeners)) {
				listener({});
			}
		},
		get listenerCount() {
			return listeners.size;
		}
	};
}

test('waitForLightboxHistory: ライトボックスの履歴が無ければ待たずに false', async () => {
	const win = fakeWindow({foo: 1});
	assert.strictEqual(await waitForLightboxHistory(win, false, 1000), false);
	assert.strictEqual(win.listenerCount, 0);
});

test('waitForLightboxHistory: 閉じる前に履歴があれば、本体の popstate (戻りの完了) を待つ', async () => {
	const win = fakeWindow({lightbox: true});
	let settled = false;
	const waiting = waitForLightboxHistory(win, true, 1000).then((value) => {
		settled = true;
		return value;
	});
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.strictEqual(settled, false);
	win.firePopstate();
	assert.strictEqual(await waiting, true);
	assert.strictEqual(win.listenerCount, 0);
});

test('waitForLightboxHistory: popstate が来なくても上限で諦めて false', async () => {
	const win = fakeWindow({lightbox: true});
	assert.strictEqual(await waitForLightboxHistory(win, true, 30), false);
	assert.strictEqual(win.listenerCount, 0);
});
