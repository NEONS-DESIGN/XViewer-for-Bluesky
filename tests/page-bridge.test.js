/**
 * page-bridge.js の白名簿の検査。
 * **この検査が橋渡しの唯一の関門である。** ext:bridge-request は document 上の
 * CustomEvent で、bsky.app 上で動く誰でも撃てるため、ここが緩むと
 * 「本体のセッションで任意の XRPC を呼べる穴」になる。
 * React fiber の走査・実通信・DOM は対象外 (実機で確認する)。
 */

const test = require('node:test');
const assert = require('node:assert');

const {EXT_CONFIG} = require('../config.js');
const {EXT_BRIDGE, checkXrpcRequest} = require('../page-bridge.js');

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

test('checkXrpcRequest: 自分の repo へのいいねは通る', () => {
    const result = checkXrpcRequest({
        nsid: 'com.atproto.repo.createRecord',
        body: {repo: SELF_DID, collection: 'app.bsky.feed.like', record: {}}
    }, SELF_DID);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.rule.target, 'pds');
    assert.strictEqual(result.rule.method, 'POST');
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

test('白名簿の値が config.js と page-bridge.js で一致している', () => {
    const nsids = Object.values(EXT_CONFIG.postActions.nsid).sort();
    assert.deepStrictEqual(Object.keys(EXT_BRIDGE.xrpc).sort(), nsids);
    assert.deepStrictEqual(
        EXT_BRIDGE.recordCollections.slice().sort(),
        Object.values(EXT_CONFIG.postActions.collections).sort()
    );
    assert.deepStrictEqual(
        EXT_BRIDGE.composerModes.slice().sort(),
        Object.values(EXT_CONFIG.postActions.composerModes).sort()
    );
    assert.strictEqual(
        EXT_BRIDGE.actions.callXrpc,
        EXT_CONFIG.mediaGrid.bridge.actions.callXrpc
    );
    assert.strictEqual(
        EXT_BRIDGE.actions.openComposer,
        EXT_CONFIG.mediaGrid.bridge.actions.openComposer
    );
    assert.strictEqual(
        EXT_BRIDGE.actions.getSession,
        EXT_CONFIG.mediaGrid.bridge.actions.getSession
    );
});
