/**
 * lightbox-panel.js の解析・整形の検査。
 * DOM 操作・本体レイアウトへの介入・撤去は対象外 (実機で確認する)。
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import {EXT_CONFIG} from '../src/common/config.js';
import {readViewerState, toggleActionState} from '../src/content/post-actions.js';
import {
	parsePostUri,
	applyFacets,
	parsePostForPanel,
	formatPostDate,
	formatCount,
	shouldShowPanel,
	toSafeLinkHref,
	syncPostViewer,
	revertActionState,
	buildPendingKey
} from '../src/content/lightbox-panel.js';

const config = EXT_CONFIG.lightboxPanel;
const actionsConfig = EXT_CONFIG.postActions;

/** fixture を読む。 */
function loadFixture(name) {
	const file = path.join(import.meta.dirname, 'fixtures', name);
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

test('parsePostForPanel: raw に getPosts の post オブジェクトそのものを持ち帰る', () => {
	// openComposer の quote は完全な PostView を要求するため (2026-09-09 実機で確認)、
	// 整形前の post をそのまま持ち帰っていることを確認する
	const json = loadFixture('get-posts-simple.json');
	const post = parsePostForPanel(json, config);
	assert.strictEqual(post.raw, json.posts[0]);
	assert.strictEqual(post.raw.author.did, 'did:plc:z72i7hdynmk6r22z27h6tvur');
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

test('syncPostViewer: like を書き戻すと viewer.like / counts.like だけが変わり、他は保たれる', () => {
	const post = {
		postUri: 'at://did:plc:abc/app.bsky.feed.post/3aaa',
		cid: 'bafyreiexamplecid',
		viewer: {like: null, repost: 'at://did:plc:me/app.bsky.feed.repost/rp', bookmarked: true},
		counts: {reply: 1, repost: 2, like: 3, quote: 4}
	};
	// like 以外のフィールドは無視されるはずの「わざと違う値」を入れておく
	const state = {
		likeUri: 'at://did:plc:me/app.bsky.feed.like/def',
		repostUri: 'at://should-not-be-written',
		bookmarked: false,
		counts: {reply: 999, repost: 999, like: 4, quote: 999}
	};
	syncPostViewer(post, 'like', state);
	assert.strictEqual(post.viewer.like, 'at://did:plc:me/app.bsky.feed.like/def');
	assert.strictEqual(post.counts.like, 4);
	// like 以外のフィールドは触れられていない
	assert.strictEqual(post.viewer.repost, 'at://did:plc:me/app.bsky.feed.repost/rp');
	assert.strictEqual(post.viewer.bookmarked, true);
	assert.strictEqual(post.counts.reply, 1);
	assert.strictEqual(post.counts.repost, 2);
	assert.strictEqual(post.counts.quote, 4);
});

// 回帰テスト: raw (openComposer にそのまま渡す生の PostView) はトップレベルの
// viewer / counts とは別に持っているため、syncPostViewer() が書き戻しを
// 忘れると、パネルでいいねを付けた直後に同じ投稿を引用したとき composer に
// 渡る raw が反映前の状態のままになる (2026-09-09 実機で発見。CHANGELOG.md [2.6.9])
test('syncPostViewer: like を書き戻すと raw.viewer.like / raw.likeCount も更新され、raw.viewer.bookmarked は変わらない', () => {
	const post = {
		postUri: 'at://did:plc:abc/app.bsky.feed.post/3aaa',
		cid: 'bafyreiexamplecid',
		viewer: {like: null, repost: null, bookmarked: true},
		counts: {reply: 0, repost: 0, like: 3, quote: 0},
		raw: {
			uri: 'at://did:plc:abc/app.bsky.feed.post/3aaa',
			viewer: {like: null, repost: null, bookmarked: true},
			likeCount: 3,
			repostCount: 0
		}
	};
	const state = {
		likeUri: 'at://did:plc:me/app.bsky.feed.like/def',
		repostUri: null,
		bookmarked: false,
		counts: {reply: 0, repost: 0, like: 4, quote: 0}
	};
	syncPostViewer(post, 'like', state);
	assert.strictEqual(post.raw.viewer.like, 'at://did:plc:me/app.bsky.feed.like/def');
	assert.strictEqual(post.raw.likeCount, 4);
	// bookmark は触れられていない
	assert.strictEqual(post.raw.viewer.bookmarked, true);
	assert.strictEqual(post.raw.repostCount, 0);
});

test('syncPostViewer: raw が無くても例外を投げず、トップレベルの viewer / counts は書き戻される', () => {
	const post = {
		postUri: 'at://did:plc:abc/app.bsky.feed.post/3aaa',
		cid: 'bafyreiexamplecid',
		viewer: {like: null, repost: null, bookmarked: false},
		counts: {reply: 0, repost: 0, like: 0, quote: 0}
	};
	const state = {
		likeUri: 'at://did:plc:me/app.bsky.feed.like/def',
		repostUri: null,
		bookmarked: false,
		counts: {reply: 0, repost: 0, like: 1, quote: 0}
	};
	assert.doesNotThrow(() => syncPostViewer(post, 'like', state));
	assert.strictEqual(post.viewer.like, 'at://did:plc:me/app.bsky.feed.like/def');
	assert.strictEqual(post.counts.like, 1);
	assert.strictEqual(post.raw, undefined);
});

test('syncPostViewer: bookmark を書き戻すと viewer.bookmarked だけが変わり、viewer.like や counts には触れない', () => {
	const post = {
		postUri: 'at://did:plc:abc/app.bsky.feed.post/3aaa',
		cid: 'bafyreiexamplecid',
		viewer: {like: 'at://did:plc:me/app.bsky.feed.like/abc', repost: null, bookmarked: false},
		counts: {reply: 0, repost: 0, like: 5, quote: 0}
	};
	// bookmark 以外のフィールドは無視されるはずの「わざと違う値」を入れておく
	const state = {
		likeUri: null,
		repostUri: 'at://should-not-be-written',
		bookmarked: true,
		counts: {reply: 0, repost: 0, like: 999, quote: 0}
	};
	syncPostViewer(post, 'bookmark', state);
	assert.strictEqual(post.viewer.bookmarked, true);
	// like / repost / counts は触れられていない
	assert.strictEqual(post.viewer.like, 'at://did:plc:me/app.bsky.feed.like/abc');
	assert.strictEqual(post.viewer.repost, null);
	assert.strictEqual(post.counts.like, 5);
});

test('syncPostViewer: 壊れた post を渡しても例外を投げない', () => {
	assert.doesNotThrow(() => syncPostViewer(null, 'like', {
		likeUri: null, repostUri: null, bookmarked: false,
		counts: {reply: 0, repost: 0, like: 0, quote: 0}
	}));
});

/*
 * 回帰テスト (修正ラウンド 3): this.pending は種別ごとにしか操作を弾かないため、
 * 別種の操作 (いいねとブックマークなど) が同時に飛行中になり得る。
 * syncPostViewer() が全フィールドをまるごと書き戻す実装だと、後から書き戻した
 * 側が先に書き戻した側の結果を消してしまう (2026-09-09、修正ラウンド 3 で
 * 見つかった Important。CHANGELOG.md [2.6.3])。runAction() が実際に組み立てる
 * 値の並び (toggleActionState() を種別ごとに重ねがけし、応答の順に
 * syncPostViewer() を呼ぶ) を再現し、両方の結果が残ることを確かめる。
 * この書き戻しが種別を無視して全フィールドを書く実装に戻ると、この
 * テストは失敗する (2 回目の syncPostViewer() 呼び出しが 1 回目の
 * viewer.like を消してしまうため)
 */
test('syncPostViewer: いいねとブックマークが同時に飛行中でも、種別ごとに書き戻せば互いを消さない', () => {
	const post = {
		postUri: 'at://did:plc:abc/app.bsky.feed.post/3aaa',
		cid: 'bafyreiexamplecid',
		viewer: null,
		counts: {reply: 0, repost: 0, like: 2, quote: 0}
	};
	// t0: いいねを押す (runAction('like') が this.state を作る)
	const startState = readViewerState(post.viewer, post.counts);
	const nextLike = toggleActionState(startState, 'like');
	// t1: 応答が返る前にブックマークも押す (runAction('bookmark') は
	// this.state (= nextLike) から次の状態を作る)
	const nextBookmark = toggleActionState(nextLike, 'bookmark');

	// t2: いいねの応答が先に返る。recordUri は nextLike 自身に取り込む
	nextLike.likeUri = 'at://did:plc:me/app.bsky.feed.like/abc';
	syncPostViewer(post, 'like', nextLike);

	// t3: ブックマークの応答が返る
	syncPostViewer(post, 'bookmark', nextBookmark);

	// どちらの結果も投稿に残っていること
	const restored = readViewerState(post.viewer, post.counts);
	assert.strictEqual(restored.liked, true);
	assert.strictEqual(restored.likeUri, 'at://did:plc:me/app.bsky.feed.like/abc');
	assert.strictEqual(restored.bookmarked, true);
});

test('revertActionState: 打ち消すのはその種別だけで、飛行中の別種の操作の結果は保たれる', () => {
	const start = readViewerState(null, {reply: 0, repost: 0, like: 5, quote: 0});
	// いいねを押す (previous はいいねを押す前の start)
	const afterLike = toggleActionState(start, 'like');
	// 応答前にブックマークも押す (this.state は afterLike → afterBookmark へ進む)
	const afterBookmark = toggleActionState(afterLike, 'bookmark');
	// いいねの通信が失敗した。this.state は既に afterBookmark まで進んでいるが、
	// 打ち消すのは 'like' の分だけ
	const reverted = revertActionState(afterBookmark, 'like', start);
	assert.strictEqual(reverted.liked, false);
	assert.strictEqual(reverted.likeUri, null);
	assert.strictEqual(reverted.counts.like, 5);
	// 飛行中だったブックマークの結果は保たれる
	assert.strictEqual(reverted.bookmarked, true);
});

test('revertActionState: 取り消し (delete) が失敗すると、元の URI が戻る', () => {
	const liked = readViewerState(
		{like: 'at://did:plc:me/app.bsky.feed.like/abc'},
		{reply: 0, repost: 0, like: 5, quote: 0}
	);
	// いいねの取り消しを押す (liked: true → false)
	const afterUnlike = toggleActionState(liked, 'like');
	// toggleActionState() は方向によらず likeUri を null にする
	assert.strictEqual(afterUnlike.likeUri, null);
	// 削除が失敗した。previous (取り消し前の liked) から URI を戻す
	const reverted = revertActionState(afterUnlike, 'like', liked);
	assert.strictEqual(reverted.liked, true);
	assert.strictEqual(reverted.likeUri, 'at://did:plc:me/app.bsky.feed.like/abc');
});

test('buildPendingKey: 投稿が違えば別のキーになる (閉じて別の投稿を開いても巻き添えにしない)', () => {
	const a = buildPendingKey(
		'at://did:plc:me/app.bsky.feed.post/aaa', 'like', actionsConfig
	);
	const b = buildPendingKey(
		'at://did:plc:me/app.bsky.feed.post/bbb', 'like', actionsConfig
	);
	assert.notStrictEqual(a, b);
});

test('buildPendingKey: 同じ投稿の同じ種別なら同じキーになる (閉じて開き直しても飛行中を弾く)', () => {
	const uri = 'at://did:plc:me/app.bsky.feed.post/aaa';
	assert.strictEqual(
		buildPendingKey(uri, 'like', actionsConfig),
		buildPendingKey(uri, 'like', actionsConfig)
	);
});

test('buildPendingKey: 同じ投稿でも種別が違えば別のキーになる (別種は同時に飛べる)', () => {
	const uri = 'at://did:plc:me/app.bsky.feed.post/aaa';
	const keys = new Set([
		buildPendingKey(uri, 'like', actionsConfig),
		buildPendingKey(uri, 'repost', actionsConfig),
		buildPendingKey(uri, 'bookmark', actionsConfig)
	]);
	assert.strictEqual(keys.size, 3);
});

test('buildPendingKey: 投稿の AT URI が : を含んでも 3 種の間で衝突しない', () => {
	// AT URI は did:plc: を含む。区切りに : を使っても、種別が固定の 3 語である
	// 限り「別の投稿 + 別の種別」の組み合わせと同じ文字列にはならない
	const seen = new Set();
	const uris = [
		'at://did:plc:me/app.bsky.feed.post/aaa',
		'at://did:plc:me/app.bsky.feed.post/aaa:like',
		'at://did:plc:other/app.bsky.feed.post/bbb'
	];
	for (const uri of uris) {
		for (const kind of ['like', 'repost', 'bookmark']) {
			seen.add(buildPendingKey(uri, kind, actionsConfig));
		}
	}
	assert.strictEqual(seen.size, uris.length * 3);
});

test('revertActionState は引数を書き換えない (別の投稿の previous を渡しても、今の状態は汚れない)', () => {
	// runAction() の catch は DOM 依存でここからは呼べないため、ガードが
	// 効いた場合の「触らない」ことだけを状態の形で確かめる。
	// (前の投稿の previous を今の投稿の状態へ revert すると、今の投稿の
	//  likeUri に前の投稿のいいねの URI が入り、次の押下でそれを削除してしまう)
	const previousOfOldPost = readViewerState(
		{like: 'at://did:plc:me/app.bsky.feed.like/old'},
		{reply: 0, repost: 0, like: 5, quote: 0}
	);
	const currentOfNewPost = readViewerState(null, {reply: 0, repost: 0, like: 1, quote: 0});
	// ガードが効くとこの revert 自体が走らない。走った場合に何が起きるかを示す
	const ifNotGuarded = revertActionState(currentOfNewPost, 'like', previousOfOldPost);
	assert.strictEqual(ifNotGuarded.likeUri, 'at://did:plc:me/app.bsky.feed.like/old');
	// ガードが効いていれば、今の投稿の状態は手つかずのまま
	assert.strictEqual(currentOfNewPost.likeUri, null);
	assert.strictEqual(currentOfNewPost.liked, false);
});

test('revertActionState: 設定の ON/OFF で作り直された (押す前と同じ) 状態に掛けても、幽霊のいいねを作らない', () => {
	const start = readViewerState(null, {reply: 0, repost: 0, like: 5, quote: 0});
	// いいねを押した (previous = start) が、応答前にパネルが作り直され、
	// this.state が押す前の viewer から作り直された (= start と同じ中身)
	const rebuilt = readViewerState(null, {reply: 0, repost: 0, like: 5, quote: 0});
	// 通信が失敗。トグルで打ち消すと liked: true / likeUri: null の幽霊になるが、
	// 値で写せば押す前のまま
	const reverted = revertActionState(rebuilt, 'like', start);
	assert.strictEqual(reverted.liked, false);
	assert.strictEqual(reverted.likeUri, null);
	assert.strictEqual(reverted.counts.like, 5);
});
