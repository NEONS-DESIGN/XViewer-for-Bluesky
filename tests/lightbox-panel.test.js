/**
 * lightbox-panel.js の解析・整形の検査。
 * DOM 操作・本体レイアウトへの介入・撤去は対象外 (実機で確認する)。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {EXT_CONFIG} = require('../config.js');
const {
    parsePostUri,
    applyFacets,
    parsePostForPanel,
    formatPostDate,
    formatCount,
    shouldShowPanel,
    toSafeLinkHref,
    syncPostViewer
} = require('../lightbox-panel.js');
const {readViewerState, toggleActionState} = require('../post-actions.js');

const config = EXT_CONFIG.lightboxPanel;

/** fixture を読む。 */
function loadFixture(name) {
    const file = path.join(__dirname, 'fixtures', name);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('parsePostUri は AT URI から did と rkey を取り出す', () => {
    assert.deepEqual(
        parsePostUri('at://did:plc:abc/app.bsky.feed.post/3mupeo3so622k'),
        {did: 'did:plc:abc', rkey: '3mupeo3so622k'}
    );
});

test('parsePostUri は投稿以外のコレクションを弾く', () => {
    assert.equal(parsePostUri('at://did:plc:abc/app.bsky.feed.like/3abc'), null);
    assert.equal(parsePostUri('https://bsky.app/profile/a/post/b'), null);
    assert.equal(parsePostUri(''), null);
    assert.equal(parsePostUri(null), null);
});

test('applyFacets は facets が無ければ 1 つの断片を返す', () => {
    const segments = applyFacets('ただの本文', undefined, config);
    assert.deepEqual(segments, [{text: 'ただの本文', kind: 'text', value: null}]);
});

test('applyFacets は空文字で空の配列を返す', () => {
    assert.deepEqual(applyFacets('', [], config), []);
});

test('applyFacets は日本語と絵文字を含む本文でも位置がズレない', () => {
    const post = loadFixture('get-posts-facets.json').posts[0];
    const segments = applyFacets(post.record.text, post.record.facets, config);
    assert.deepEqual(segments, [
        {text: '猫🐈 ', kind: 'text', value: null},
        {text: 'https://example.com/a', kind: 'link', value: 'https://example.com/a'},
        {text: ' を見て ', kind: 'text', value: null},
        {text: '@alice.bsky.social', kind: 'mention', value: 'did:plc:bbbb'},
        {text: ' ', kind: 'text', value: null},
        {text: '#ねこ', kind: 'tag', value: 'ねこ'}
    ]);
});

test('applyFacets は範囲外の facet を捨てて本文を素通しする', () => {
    const facets = [{
        index: {byteStart: 0, byteEnd: 9999},
        features: [{$type: 'app.bsky.richtext.facet#link', uri: 'https://example.com/'}]
    }];
    assert.deepEqual(
        applyFacets('あいう', facets, config),
        [{text: 'あいう', kind: 'text', value: null}]
    );
});

test('applyFacets は逆順の facet を捨てる', () => {
    const facets = [{
        index: {byteStart: 5, byteEnd: 2},
        features: [{$type: 'app.bsky.richtext.facet#tag', tag: 'x'}]
    }];
    assert.deepEqual(
        applyFacets('abcdefg', facets, config),
        [{text: 'abcdefg', kind: 'text', value: null}]
    );
});

test('applyFacets は重なった facet の後ろ側を捨てる', () => {
    const facets = [
        {index: {byteStart: 0, byteEnd: 4}, features: [{$type: 'app.bsky.richtext.facet#tag', tag: 'a'}]},
        {index: {byteStart: 2, byteEnd: 6}, features: [{$type: 'app.bsky.richtext.facet#tag', tag: 'b'}]}
    ];
    assert.deepEqual(applyFacets('abcdefg', facets, config), [
        {text: 'abcd', kind: 'tag', value: 'a'},
        {text: 'efg', kind: 'text', value: null}
    ]);
});

test('applyFacets は未知の $type を普通の文字列として扱う', () => {
    const facets = [{
        index: {byteStart: 0, byteEnd: 3},
        features: [{$type: 'app.bsky.richtext.facet#unknown', value: 'x'}]
    }];
    assert.deepEqual(
        applyFacets('abcdef', facets, config),
        [{text: 'abcdef', kind: 'text', value: null}]
    );
});

test('parsePostForPanel は getPosts のレスポンスをパネルの形にする', () => {
    const result = parsePostForPanel(loadFixture('get-posts-simple.json'), config);
    assert.equal(result.postUri, 'at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3mupeo3so622k');
    assert.equal(result.handle, 'bsky.app');
    assert.equal(result.displayName, 'Bluesky');
    assert.equal(result.text, 'v1.132 is live!');
    assert.equal(result.createdAt, '2026-09-04T16:21:11.628Z');
    assert.equal(result.rkey, '3mupeo3so622k');
    assert.deepEqual(result.counts, {reply: 60, repost: 255, like: 1377, quote: 47});
    assert.deepEqual(result.segments, [{text: 'v1.132 is live!', kind: 'text', value: null}]);
});

test('parsePostForPanel は表示名が無ければハンドルを使い、avatar が無ければ null にする', () => {
    const json = loadFixture('get-posts-simple.json');
    delete json.posts[0].author.displayName;
    json.posts[0].author.avatar = null;
    const result = parsePostForPanel(json, config);
    assert.equal(result.displayName, 'bsky.app');
    assert.equal(result.avatarUrl, null);
});

test('parsePostForPanel は壊れた入力で null を返す', () => {
    assert.equal(parsePostForPanel(null, config), null);
    assert.equal(parsePostForPanel({}, config), null);
    assert.equal(parsePostForPanel({posts: []}, config), null);
    assert.equal(parsePostForPanel({posts: [{uri: 'at://x/y/z'}]}, config), null);
});

test('parsePostForPanel は反応数が欠けていても 0 に倒す', () => {
    const json = loadFixture('get-posts-simple.json');
    delete json.posts[0].likeCount;
    json.posts[0].replyCount = null;
    const result = parsePostForPanel(json, config);
    assert.equal(result.counts.like, 0);
    assert.equal(result.counts.reply, 0);
});

test('formatPostDate は日本語の絶対表記を返す', () => {
    const text = formatPostDate('2026-09-04T16:21:11.628Z', config);
    assert.equal(typeof text, 'string');
    assert.ok(text.includes('2026'));
    assert.ok(text.includes('年'));
    assert.ok(text.includes('月'));
});

test('formatPostDate は不正な入力で null を返す', () => {
    assert.equal(formatPostDate('', config), null);
    assert.equal(formatPostDate('これは日付ではない', config), null);
    assert.equal(formatPostDate(null, config), null);
});

test('formatCount は桁区切りを付け、非数は 0 にする', () => {
    assert.equal(formatCount(1377, config), '1,377');
    assert.equal(formatCount(0, config), '0');
    assert.equal(formatCount(null, config), '0');
    assert.equal(formatCount(Number.NaN, config), '0');
});

test('shouldShowPanel は設定とウィンドウ幅の両方を見る', () => {
    assert.equal(shouldShowPanel({enabled: true, innerWidth: 1920}, config), true);
    assert.equal(shouldShowPanel({enabled: true, innerWidth: 800}, config), true);
    assert.equal(shouldShowPanel({enabled: true, innerWidth: 799}, config), false);
    assert.equal(shouldShowPanel({enabled: false, innerWidth: 1920}, config), false);
    assert.equal(shouldShowPanel(null, config), false);
});

test('toSafeLinkHref は http と https だけを通す', () => {
    assert.equal(
        toSafeLinkHref('https://example.com/a', config),
        'https://example.com/a'
    );
    assert.equal(toSafeLinkHref('http://example.com/', config), 'http://example.com/');
});

test('toSafeLinkHref は押させてはいけない URL を null にする', () => {
    // facets の uri は投稿者が自由に決められるため、ここを通すと XSS になる
    assert.equal(toSafeLinkHref('javascript:alert(1)', config), null);
    assert.equal(toSafeLinkHref('JavaScript:alert(1)', config), null);
    assert.equal(toSafeLinkHref('data:text/html,<script>alert(1)</script>', config), null);
    assert.equal(toSafeLinkHref('vbscript:msgbox(1)', config), null);
    assert.equal(toSafeLinkHref('file:///etc/passwd', config), null);
});

test('toSafeLinkHref は相対 URL と壊れた入力を null にする', () => {
    assert.equal(toSafeLinkHref('/relative/path', config), null);
    assert.equal(toSafeLinkHref('example.com', config), null);
    assert.equal(toSafeLinkHref('', config), null);
    assert.equal(toSafeLinkHref(null, config), null);
});

test('parsePostForPanel: cid と viewer をそのまま持ち帰る', () => {
    const post = parsePostForPanel({
        posts: [{
            uri: 'at://did:plc:abc/app.bsky.feed.post/3aaa',
            cid: 'bafyreiexamplecid',
            author: {handle: 'alice.bsky.social'},
            record: {text: 'こんにちは', createdAt: '2026-09-09T00:00:00.000Z'},
            likeCount: 5,
            viewer: {like: 'at://did:plc:me/app.bsky.feed.like/1', bookmarked: true}
        }]
    }, EXT_CONFIG.lightboxPanel);
    assert.strictEqual(post.cid, 'bafyreiexamplecid');
    assert.strictEqual(post.viewer.like, 'at://did:plc:me/app.bsky.feed.like/1');
    assert.strictEqual(post.viewer.bookmarked, true);
});

test('parsePostForPanel: viewer が無ければ null、cid が無ければ空文字', () => {
    const post = parsePostForPanel({
        posts: [{
            uri: 'at://did:plc:abc/app.bsky.feed.post/3aaa',
            author: {handle: 'alice.bsky.social'},
            record: {text: '', createdAt: '2026-09-09T00:00:00.000Z'}
        }]
    }, EXT_CONFIG.lightboxPanel);
    assert.strictEqual(post.viewer, null);
    assert.strictEqual(post.cid, '');
});

test('syncPostViewer: 書き戻した投稿に readViewerState を通すと、同じ状態が復元される', () => {
    const post = {
        postUri: 'at://did:plc:abc/app.bsky.feed.post/3aaa',
        cid: 'bafyreiexamplecid',
        viewer: null,
        counts: {reply: 0, repost: 0, like: 3, quote: 0}
    };
    const state = {
        liked: true,
        likeUri: 'at://did:plc:me/app.bsky.feed.like/def',
        reposted: false,
        repostUri: null,
        bookmarked: true,
        counts: {reply: 0, repost: 0, like: 4, quote: 0}
    };
    syncPostViewer(post, state);
    // post.counts / post.viewer が更新された投稿を、開き直したときと同じ経路
    // (readViewerState) に通す。操作前の状態へ巻き戻らないことを確かめる
    assert.deepStrictEqual(readViewerState(post.viewer, post.counts), state);
});

test('syncPostViewer: 取り消した後は liked / reposted が false に戻る', () => {
    const post = {
        postUri: 'at://did:plc:abc/app.bsky.feed.post/3aaa',
        cid: 'bafyreiexamplecid',
        viewer: {like: 'at://did:plc:me/app.bsky.feed.like/abc', repost: null, bookmarked: false},
        counts: {reply: 0, repost: 0, like: 4, quote: 0}
    };
    const state = {
        liked: false,
        likeUri: null,
        reposted: false,
        repostUri: null,
        bookmarked: false,
        counts: {reply: 0, repost: 0, like: 3, quote: 0}
    };
    syncPostViewer(post, state);
    assert.strictEqual(post.viewer.like, null);
    assert.deepStrictEqual(readViewerState(post.viewer, post.counts), state);
});

test('syncPostViewer: 壊れた post を渡しても例外を投げない', () => {
    assert.doesNotThrow(() => syncPostViewer(null, {
        likeUri: null, repostUri: null, bookmarked: false,
        counts: {reply: 0, repost: 0, like: 0, quote: 0}
    }));
});

/*
 * 回帰テスト (修正ラウンド 2): runAction() は createRecord の応答の URI を
 * this.state ではなく next (toggleActionState() が返す、押した後の状態) へ
 * 取り込み、syncPostViewer(post, next) を「別の投稿へ移った・閉じて開き直された」
 * 破棄ガードより前で無条件に呼ぶ。応答が返る前にライトボックスを閉じても、
 * 成功した書き込みだけはキャッシュ (PanelPost) へ確実に反映されることを保証する
 * ための並び順で、runAction() のクラス構造を変えずには async の実行順序その
 * ものは単体テストできない。ここでは runAction() の成功経路が組み立てる値
 * (toggleActionState() の戻り値に createRecord の応答の URI を足したもの) を
 * syncPostViewer() に通し、その値がそのまま投稿へ書き戻ることを検証する
 */
test('syncPostViewer: recordUri を取り込んだ next を渡すと、いいねの URI ごと書き戻る', () => {
    const post = {
        postUri: 'at://did:plc:abc/app.bsky.feed.post/3aaa',
        cid: 'bafyreiexamplecid',
        viewer: null,
        counts: {reply: 0, repost: 0, like: 2, quote: 0}
    };
    const previous = readViewerState(null, post.counts);
    // runAction() が押した瞬間に作る楽観的な状態
    const next = toggleActionState(previous, 'like');
    assert.strictEqual(next.likeUri, null, '取り込み前は URI がまだ無い');
    // createRecord の応答が返った直後、runAction() は this.state ではなく
    // next 自身に recordUri を取り込む
    next.likeUri = 'at://did:plc:me/app.bsky.feed.like/xyz';
    // 破棄ガードの成否によらず、書き戻しは post に対して行われる
    syncPostViewer(post, next);
    assert.deepStrictEqual(readViewerState(post.viewer, post.counts), next);
});
