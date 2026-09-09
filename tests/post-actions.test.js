/**
 * post-actions.js の純関数の検査。
 * 橋渡しの呼び出し・実通信・DOM は対象外 (実機で確認する)。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    parseRecordUri,
    readViewerState,
    toggleActionState,
    mergeActionKind,
    isActionApplied
} = require('../post-actions.js');

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
