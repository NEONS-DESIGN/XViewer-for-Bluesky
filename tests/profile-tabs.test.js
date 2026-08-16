const test = require('node:test');
const assert = require('node:assert');
const {EXT_VIEWS, EXT_CONFIG} = require('../config.js');
const {buildTabList, findTabIndex} = require('../profile-tabs.js');

const build = (profile, context) => buildTabList(profile, context, EXT_CONFIG);
const names = (tabs) => tabs.map((t) => t.name);

test('他人のプロフィール (ログイン済み、付随情報なし)', () => {
    const tabs = build({did: 'did:plc:a', associated: {}}, {isMe: false, hasSession: true});
    assert.deepStrictEqual(names(tabs), ['posts', 'replies', 'media', 'videos']);
    assert.strictEqual(findTabIndex(tabs, EXT_VIEWS.MEDIA), 2);
    assert.strictEqual(findTabIndex(tabs, EXT_VIEWS.VIDEOS), 3);
    assert.strictEqual(findTabIndex(tabs, EXT_VIEWS.POSTS), 0);
});

test('未ログインでは replies が消えて index が前へずれる', () => {
    const tabs = build({did: 'did:plc:a', associated: {}}, {isMe: false, hasSession: false});
    assert.deepStrictEqual(names(tabs), ['posts', 'media', 'videos']);
    assert.strictEqual(findTabIndex(tabs, EXT_VIEWS.MEDIA), 1);
});

test('自分のプロフィールでは likes / feeds / starterPacks が増える', () => {
    const tabs = build({did: 'did:plc:me', associated: {}}, {isMe: true, hasSession: true});
    assert.deepStrictEqual(names(tabs),
        ['posts', 'replies', 'media', 'videos', 'likes', 'feeds', 'starterPacks', 'lists']);
    assert.strictEqual(findTabIndex(tabs, EXT_VIEWS.MEDIA), 2);
});

test('ラベラーアカウントには media / videos が存在しない', () => {
    const tabs = build(
        {did: 'did:plc:mod', associated: {labeler: true}},
        {isMe: false, hasSession: true}
    );
    assert.deepStrictEqual(names(tabs), ['labels', 'posts', 'replies']);
    assert.strictEqual(findTabIndex(tabs, EXT_VIEWS.MEDIA), -1);
});

test('ラベラーかつリスト持ちでは lists が先頭側に来る', () => {
    const tabs = build(
        {did: 'did:plc:mod', associated: {labeler: true, lists: 2, starterPacks: 0}},
        {isMe: false, hasSession: true}
    );
    assert.deepStrictEqual(names(tabs), ['labels', 'listsForLabeler', 'posts', 'replies']);
});

test('フィード保有アカウントでは feeds が増える', () => {
    const tabs = build(
        {did: 'did:plc:a', associated: {feedgens: 3}},
        {isMe: false, hasSession: true}
    );
    assert.deepStrictEqual(names(tabs), ['posts', 'replies', 'media', 'videos', 'feeds']);
    assert.strictEqual(findTabIndex(tabs, EXT_VIEWS.MEDIA), 2);
});

test('スターターパック数はリスト数から差し引く', () => {
    // lists 2 のうち 2 件がスターターパックなら listCount は 0 になり lists タブは出ない
    const tabs = build(
        {did: 'did:plc:a', associated: {lists: 2, starterPacks: 2}},
        {isMe: false, hasSession: true}
    );
    assert.deepStrictEqual(names(tabs), ['posts', 'replies', 'media', 'videos', 'starterPacks']);
});

test('profile が壊れていても posts だけの列を返す (例外を投げない)', () => {
    assert.deepStrictEqual(names(build(null, {isMe: false, hasSession: false})), ['posts']);
    assert.deepStrictEqual(names(build({}, {isMe: false, hasSession: false})),
        ['posts', 'media', 'videos']);
});
