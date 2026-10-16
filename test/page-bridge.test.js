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
import {EXT_BRIDGE, checkXrpcRequest, buildQuery} from '../src/inject/page-bridge.js';

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

test('checkXrpcRequest: 投稿の作成も collection で落ちる', () => {
	const result = checkXrpcRequest({
		nsid: 'com.atproto.repo.createRecord',
		body: {repo: SELF_DID, collection: 'app.bsky.feed.post', record: {}}
	}, SELF_DID);
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.reason, 'collection-not-allowed');
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
