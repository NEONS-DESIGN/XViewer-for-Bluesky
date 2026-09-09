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
