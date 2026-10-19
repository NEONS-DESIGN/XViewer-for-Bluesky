/**
 * reply-text.js の純関数。書記素の数え方・facets の検出・返信の record の組み立て・
 * getPostThread の応答の整形を確かめる。DOM と通信は対象外 (実機で確認する)。
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import {
	countGraphemes, detectRichText, buildFacets, resolveReplyRef, buildReplyRecord,
	primaryLanguage, parseThreadReplies, flattenThreadBranch, sortNewestFirst,
	formatReplyDate, insertVisible, fitTextareaHeight, mediaAspectRatio, threadPostView, threadFromNode
} from '../src/content/reply-text.js';

/** fixture を読む。 */
function loadFixture(name) {
	const file = path.join(import.meta.dirname, 'fixtures', name);
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 文字列の UTF-8 のバイト数 */
function bytes(text) {
	return new TextEncoder().encode(text).length;
}

const LIMITS = {maxGraphemes: 300, maxBytes: 3000};

test('countGraphemes: 結合した絵文字と結合文字を 1 つと数える', () => {
	assert.strictEqual(countGraphemes('👨‍👩‍👧'), 1);
	assert.strictEqual(countGraphemes('が'), 1);
	assert.strictEqual(countGraphemes('abc'), 3);
	assert.strictEqual(countGraphemes(''), 0);
});

test('detectRichText: リンク・タグ・メンションを UTF-8 のバイト位置で拾う', () => {
	const text = '見て https://example.com/a?b=1. #タグ @alice.bsky.social';
	const detected = detectRichText(text);
	assert.strictEqual(detected.links.length, 1);
	assert.strictEqual(detected.links[0].uri, 'https://example.com/a?b=1');
	assert.strictEqual(detected.links[0].byteStart, 7);
	assert.strictEqual(detected.links[0].byteEnd, 7 + bytes('https://example.com/a?b=1'));
	assert.strictEqual(detected.tags.length, 1);
	assert.strictEqual(detected.tags[0].tag, 'タグ');
	const tagStart = bytes('見て https://example.com/a?b=1. ');
	assert.strictEqual(detected.tags[0].byteStart, tagStart);
	assert.strictEqual(detected.tags[0].byteEnd, tagStart + bytes('#タグ'));
	assert.strictEqual(detected.mentions.length, 1);
	assert.strictEqual(detected.mentions[0].handle, 'alice.bsky.social');
	assert.strictEqual(detected.mentions[0].byteEnd, bytes(text));
});

test('detectRichText: 数字だけのタグ・括弧の閉じ・英数字に続く @ は拾わない', () => {
	assert.strictEqual(detectRichText('#123').tags.length, 0);
	const paren = detectRichText('(https://x.y)');
	assert.strictEqual(paren.links.length, 1);
	assert.strictEqual(paren.links[0].uri, 'https://x.y');
	assert.strictEqual(detectRichText('a@b.c').mentions.length, 0);
	assert.strictEqual(detectRichText('@nodot').mentions.length, 0);
});

test('buildFacets: 種別ごとの feature を作り、引けなかったメンションは除く', () => {
	const detected = detectRichText('@alice.bsky.social #tag https://e.com @bob.bsky.social');
	const facets = buildFacets(detected, new Map([['alice.bsky.social', 'did:plc:alice']]));
	assert.strictEqual(facets.length, 3);
	assert.deepStrictEqual(facets[0], {
		index: {byteStart: 0, byteEnd: bytes('@alice.bsky.social')},
		features: [{$type: 'app.bsky.richtext.facet#mention', did: 'did:plc:alice'}]
	});
	assert.deepStrictEqual(facets[1].features, [{$type: 'app.bsky.richtext.facet#tag', tag: 'tag'}]);
	assert.deepStrictEqual(facets[2].features, [{$type: 'app.bsky.richtext.facet#link', uri: 'https://e.com'}]);
	for (let i = 1; i < facets.length; i += 1) {
		assert.ok(facets[i - 1].index.byteStart < facets[i].index.byteStart);
	}
});

test('resolveReplyRef: 返信先が返信なら root を引き継ぎ、そうでなければ返信先を root にする', () => {
	const target = {uri: 'at://did:plc:a/app.bsky.feed.post/p', cid: 'p'};
	assert.deepStrictEqual(resolveReplyRef(Object.assign({replyRef: null}, target)), {
		root: target, parent: target
	});
	const root = {uri: 'at://did:plc:op/app.bsky.feed.post/r', cid: 'r'};
	const ref = resolveReplyRef(Object.assign({
		replyRef: {root, parent: {uri: 'at://did:plc:x/app.bsky.feed.post/x', cid: 'x'}}
	}, target));
	assert.deepStrictEqual(ref, {root, parent: target});
});

test('buildReplyRecord: $type を付け、空の facets と langs は出さない', () => {
	const reply = {
		root: {uri: 'at://did:plc:a/app.bsky.feed.post/1', cid: '1'},
		parent: {uri: 'at://did:plc:a/app.bsky.feed.post/1', cid: '1'}
	};
	const plain = buildReplyRecord({
		text: 'x', reply, createdAt: '2026-10-18T00:00:00.000Z', langs: null, facets: []
	});
	assert.deepStrictEqual(plain, {
		$type: 'app.bsky.feed.post', text: 'x', createdAt: '2026-10-18T00:00:00.000Z', reply
	});
	const rich = buildReplyRecord({
		text: 'x', reply, createdAt: 'c', langs: ['ja'], facets: [{index: {}, features: []}]
	});
	assert.deepStrictEqual(rich.langs, ['ja']);
	assert.strictEqual(rich.facets.length, 1);
});

test('primaryLanguage: 言語タグの主タグだけを返す', () => {
	assert.strictEqual(primaryLanguage('ja-JP'), 'ja');
	assert.strictEqual(primaryLanguage('en'), 'en');
	assert.strictEqual(primaryLanguage(undefined), null);
	assert.strictEqual(primaryLanguage(''), null);
});

test('parseThreadReplies: 1 段目の返信を整形し、見つからない・ブロックされた投稿を捨てる', () => {
	const items = parseThreadReplies(loadFixture('get-post-thread-root.json'));
	assert.deepStrictEqual(items.map((item) => item.rkey), ['r1', 'r2']);
	const alice = items[0];
	assert.strictEqual(alice.uri, 'at://did:plc:alice/app.bsky.feed.post/r1');
	assert.strictEqual(alice.cid, 'cid-r1');
	assert.strictEqual(alice.authorDid, 'did:plc:alice');
	assert.strictEqual(alice.handle, 'alice.example.com');
	assert.strictEqual(alice.displayName, 'Alice');
	assert.strictEqual(alice.avatarUrl, 'https://cdn.example.com/a.jpg');
	assert.strictEqual(alice.facets.length, 1);
	assert.strictEqual(alice.replyCount, 2);
	assert.strictEqual(alice.hasEmbed, false);
	assert.strictEqual(alice.parentUri, 'at://did:plc:op/app.bsky.feed.post/root1');
	assert.strictEqual(alice.replyRef.root.cid, 'cid-root1');
	const bob = items[1];
	assert.strictEqual(bob.displayName, 'bob.example.com');
	assert.strictEqual(bob.avatarUrl, null);
	assert.strictEqual(bob.hasEmbed, true);
	// 画像の取り出しは描く側が行うため、embed はそのまま渡す
	assert.strictEqual(bob.embed.$type, 'app.bsky.embed.images#view');
	assert.strictEqual(alice.embed, null);
	// 作者のラベルも拾う (ぼかしの判定に使う)
	assert.deepStrictEqual(bob.labels, ['nudity']);
	assert.deepStrictEqual(alice.labels, []);
	assert.deepStrictEqual(bob.facets, []);
	// record.createdAt が無ければ indexedAt で補う
	assert.strictEqual(bob.createdAt, '2026-10-03T00:00:00.000Z');
	assert.deepStrictEqual(parseThreadReplies(null), []);
	assert.deepStrictEqual(parseThreadReplies({thread: {$type: 'app.bsky.feed.defs#notFoundPost'}}), []);
});

test('parseThreadReplies: record.langs を文字列だけ残して持ち、無ければ null', () => {
	const reply = (rkey, langs) => ({
		$type: 'app.bsky.feed.defs#threadViewPost',
		post: {
			uri: `at://did:plc:a/app.bsky.feed.post/${rkey}`,
			cid: `cid-${rkey}`,
			author: {did: 'did:plc:a', handle: 'a.example.com'},
			record: {text: 'x', createdAt: '2026-10-01T00:00:00.000Z', ...(langs === undefined ? {} : {langs})}
		}
	});
	const items = parseThreadReplies({thread: {
		$type: 'app.bsky.feed.defs#threadViewPost',
		post: {uri: 'at://did:plc:op/app.bsky.feed.post/root', cid: 'c'},
		replies: [reply('l1', ['en-US', 3, 'fr']), reply('l2', undefined), reply('l3', 'en')]
	}});
	assert.deepStrictEqual(items.map((item) => item.langs), [['en-US', 'fr'], null, null]);
});

test('flattenThreadBranch: 起点を除く部分木を古い順に平らにし、孫には親の handle を付ける', () => {
	const items = flattenThreadBranch(
		loadFixture('get-post-thread-branch.json'), 'at://did:plc:a/app.bsky.feed.post/A'
	);
	assert.deepStrictEqual(items.map((item) => item.rkey), ['C', 'B', 'D']);
	assert.strictEqual(items[0].parentHandle, null);
	assert.strictEqual(items[1].parentHandle, null);
	assert.strictEqual(items[2].parentHandle, 'b.example.com');
	assert.deepStrictEqual(flattenThreadBranch(null, 'at://x'), []);
});

test('sortNewestFirst: 新しい順に並べ、元の配列を変えない', () => {
	const items = [
		{uri: 'a', createdAt: '2026-10-01T00:00:00.000Z'},
		{uri: 'b', createdAt: '2026-10-03T00:00:00.000Z'},
		{uri: 'c', createdAt: '2026-10-02T00:00:00.000Z'}
	];
	const sorted = sortNewestFirst(items);
	assert.deepStrictEqual(sorted.map((item) => item.uri), ['b', 'c', 'a']);
	assert.deepStrictEqual(items.map((item) => item.uri), ['a', 'b', 'c']);
});

test('formatReplyDate: YYYY-MM-DD HH:mm の形にし、読めない値は空文字', () => {
	assert.match(formatReplyDate('2026-10-18T04:05:00.000Z'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
	assert.strictEqual(formatReplyDate('x'), '');
	assert.strictEqual(formatReplyDate(''), '');
});

test('threadPostView: 中身のある起点だけ PostView を返す', () => {
	const post = {uri: 'at://did:plc:a/app.bsky.feed.post/1'};
	assert.strictEqual(threadPostView({thread: {$type: 'app.bsky.feed.defs#threadViewPost', post}}), post);
	assert.strictEqual(threadPostView({thread: {$type: 'app.bsky.feed.defs#blockedPost', uri: post.uri}}), null);
	assert.strictEqual(threadPostView(null), null);
});

test('threadFromNode: 直接の返信が揃っているノードだけを応答の形にする', () => {
	const type = 'app.bsky.feed.defs#threadViewPost';
	const withReplies = {$type: type, post: {replyCount: 2}, replies: []};
	assert.deepStrictEqual(threadFromNode(withReplies), {thread: withReplies});
	// 返信 0 件なら replies が無くても揃っている
	assert.deepStrictEqual(threadFromNode({$type: type, post: {replyCount: 0}}).thread.replies, []);
	// 深さの上限に届いたノード (replies を持たず、返信がある) は引き直させる
	assert.strictEqual(threadFromNode({$type: type, post: {replyCount: 3}}), null);
	assert.strictEqual(threadFromNode({$type: 'app.bsky.feed.defs#notFoundPost'}), null);
});

test('insertVisible: 投稿した返信を表示範囲の末尾に入れ、「もっと見る」の奥に隠さない', () => {
	const items = Array.from({length: 30}, (unused, i) => ({uri: `u${i}`}));
	const result = insertVisible(items, 20, {uri: 'mine'});
	assert.strictEqual(result.shown, 21);
	assert.strictEqual(result.items[20].uri, 'mine');
	assert.strictEqual(result.items.length, 31);
	assert.strictEqual(items.length, 30);
	const all = insertVisible([{uri: 'a'}], 1, {uri: 'mine'});
	assert.deepStrictEqual(all.items.map((item) => item.uri), ['a', 'mine']);
	assert.strictEqual(all.shown, 2);
});

test('fitTextareaHeight: 枠線ぶんを足した高さにし、上限に届くまではスクロールバーを出さない', () => {
	// 1 行 (中身 31px + 枠線 2px)。上限 (10 行) に届かないので隠す
	assert.deepStrictEqual(fitTextareaHeight(31, 2, 222), {height: 33, scroll: false});
	// ちょうど上限は隠したまま
	assert.deepStrictEqual(fitTextareaHeight(220, 2, 222), {height: 222, scroll: false});
	// 上限が小数 (10lh の計算結果) で、ちょうど 10 行が丸めでわずかに上回っても隠したまま
	// (2026-10-18 実機で上限 221.969px・中身 220 + 枠線 2 になった)
	assert.deepStrictEqual(fitTextareaHeight(220, 2, 221.969), {height: 221.969, scroll: false});
	// 上限を超えたら上限で止め、欄の中で送る
	assert.deepStrictEqual(fitTextareaHeight(400, 2, 222), {height: 222, scroll: true});
	// 上限が読めない (none など) ときは伸ばし続け、スクロールバーは出さない
	assert.deepStrictEqual(fitTextareaHeight(400, 2, NaN), {height: 402, scroll: false});
});

test('mediaAspectRatio: 画像の比を範囲に収め、寸法が読めなければ正方形', () => {
	const range = {min: 3 / 4, max: 16 / 9};
	assert.strictEqual(mediaAspectRatio({width: 400, height: 300}, range), 4 / 3);
	// 縦長・横長に寄りすぎた画像は端で止める
	assert.strictEqual(mediaAspectRatio({width: 100, height: 1000}, range), 3 / 4);
	assert.strictEqual(mediaAspectRatio({width: 3000, height: 100}, range), 16 / 9);
	assert.strictEqual(mediaAspectRatio(null, range), 1);
	assert.strictEqual(mediaAspectRatio({width: 0, height: 100}, range), 1);
});

test('buildReplyRecord: embed と labels を渡すとキーが付き、null なら付かない', () => {
	const base = {text: 'a', createdAt: '2026-10-18T00:00:00.000Z', reply: {root: {}, parent: {}}, langs: null, facets: []};
	const embed = {$type: 'app.bsky.embed.images', images: []};
	const labels = {$type: 'com.atproto.label.defs#selfLabels', values: [{val: 'porn'}]};
	const withBoth = buildReplyRecord(Object.assign({}, base, {embed, labels}));
	assert.deepStrictEqual(withBoth.embed, embed);
	assert.deepStrictEqual(withBoth.labels, labels);
	const without = buildReplyRecord(Object.assign({}, base, {embed: null, labels: null}));
	assert.ok(!('embed' in without));
	assert.ok(!('labels' in without));
	assert.ok(!('embed' in buildReplyRecord(base)));
});
