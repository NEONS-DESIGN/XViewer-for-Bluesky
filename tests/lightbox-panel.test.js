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
    toSafeLinkHref
} = require('../lightbox-panel.js');

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
