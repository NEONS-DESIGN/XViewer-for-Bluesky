/**
 * reply-links.js の純関数。リンクの短縮と、カード・引用の提案の規則を確かめる。
 */

import test from 'node:test';
import assert from 'node:assert';

import {
	toShortUrl,
	shortenLinks,
	parsePostUrl,
	isCardableUrl,
	pickSuggestion,
	suppressUrl,
	suppressedUrls,
	pruneSuppressed,
	parseCardResponse,
} from '../src/content/reply-links.js';
import {detectRichText, buildFacets} from '../src/content/reply-text.js';

const RULE = {maxRestChars: 15, keepChars: 13};
const HOSTS = ['bsky.app'];
const CARD_RULE = {
	excludedHosts: ['bsky.app'],
	imageExtensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg'],
};

/** 範囲を UTF-8 のバイト列から切り出して文字列にする */
function sliceBytes(text, start, end) {
	return new TextDecoder().decode(new TextEncoder().encode(text).slice(start, end));
}

test('toShortUrl: スキームを除き、ホストより後ろが 15 文字を超えたら 13 文字 + ...', () => {
	assert.strictEqual(toShortUrl('https://github.com', RULE), 'github.com');
	assert.strictEqual(toShortUrl('https://github.com/', RULE), 'github.com');
	assert.strictEqual(toShortUrl('https://github.com/a/b', RULE), 'github.com/a/b');
	assert.strictEqual(toShortUrl('https://e.com/12345678901234', RULE), 'e.com/12345678901234');
	assert.strictEqual(toShortUrl('https://e.com/123456789012345', RULE), 'e.com/123456789012...');
	assert.strictEqual(toShortUrl('http://e.com/?q=1#h', RULE), 'e.com?q=1#h');
	assert.strictEqual(toShortUrl('ftp://e.com/x', RULE), 'ftp://e.com/x');
	assert.strictEqual(toShortUrl('not a url', RULE), 'not a url');
});

test('shortenLinks: 日本語と絵文字を含む本文で、後ろのタグとメンションの位置もずらす', () => {
	const text = 'あ😀 https://example.com/abcdefghijklmnop #タグ @a.bsky.social';
	const facets = buildFacets(detectRichText(text), new Map([['a.bsky.social', 'did:plc:aaa']]));
	assert.strictEqual(facets.length, 3);
	const snapshot = JSON.stringify(facets);

	const result = shortenLinks(text, facets, RULE);
	assert.strictEqual(JSON.stringify(facets), snapshot);
	assert.strictEqual(result.text, 'あ😀 example.com/abcdefghijkl... #タグ @a.bsky.social');
	assert.strictEqual(result.facets.length, 3);
	const cut = (f) => sliceBytes(result.text, f.index.byteStart, f.index.byteEnd);
	assert.strictEqual(cut(result.facets[0]), 'example.com/abcdefghijkl...');
	assert.strictEqual(cut(result.facets[1]), '#タグ');
	assert.strictEqual(cut(result.facets[2]), '@a.bsky.social');
	assert.strictEqual(result.facets[0].features[0].uri, 'https://example.com/abcdefghijklmnop');
});

test('shortenLinks: facets が空ならそのまま返す', () => {
	const result = shortenLinks('こんにちは', [], RULE);
	assert.strictEqual(result.text, 'こんにちは');
	assert.deepStrictEqual(result.facets, []);
});

/** 本文中の部分文字列の UTF-8 のバイト範囲を返す */
function byteRange(text, part, from = 0) {
	const at = text.indexOf(part, from);
	const encoder = new TextEncoder();
	const byteStart = encoder.encode(text.slice(0, at)).length;
	return {byteStart, byteEnd: byteStart + encoder.encode(part).length};
}

test('shortenLinks: 先頭が U+FEFF の本文で、link が無ければ入力のまま、あっても後ろの facet がずれない', () => {
	const tagFeature = {$type: 'app.bsky.richtext.facet#tag', tag: 'tag'};
	const plain = '﻿#tag only';
	const plainFacets = [{index: byteRange(plain, '#tag'), features: [tagFeature]}];
	const unchanged = shortenLinks(plain, plainFacets, RULE);
	assert.strictEqual(unchanged.text, plain);
	assert.strictEqual(unchanged.facets, plainFacets);

	const uri = 'https://example.com/abcdefghijklmnop';
	const linked = `﻿${uri} #tag`;
	const facets = [
		{index: byteRange(linked, uri), features: [{$type: 'app.bsky.richtext.facet#link', uri}]},
		{index: byteRange(linked, '#tag'), features: [tagFeature]},
	];
	const result = shortenLinks(linked, facets, RULE);
	assert.strictEqual(result.text, '﻿example.com/abcdefghijkl... #tag');
	const cut = (f) => sliceBytes(result.text, f.index.byteStart, f.index.byteEnd);
	assert.strictEqual(cut(result.facets[0]), 'example.com/abcdefghijkl...');
	assert.strictEqual(cut(result.facets[1]), '#tag');
});

test('shortenLinks: link の範囲と重なる facet (URL の中のメンション) は落とす', () => {
	const uri = 'https://example.com/abcdefghijklmnop(@a.bsky.social)';
	const text = `${uri} #tag`;
	const facets = [
		{index: byteRange(text, uri), features: [{$type: 'app.bsky.richtext.facet#link', uri}]},
		{index: byteRange(text, '@a.bsky.social'), features: [{$type: 'app.bsky.richtext.facet#mention', did: 'did:plc:aaa'}]},
		{index: byteRange(text, '#tag'), features: [{$type: 'app.bsky.richtext.facet#tag', tag: 'tag'}]},
	];
	const result = shortenLinks(text, facets, RULE);
	assert.strictEqual(result.facets.length, 2);
	const cut = (f) => sliceBytes(result.text, f.index.byteStart, f.index.byteEnd);
	assert.strictEqual(cut(result.facets[0]), 'example.com/abcdefghijkl...');
	assert.strictEqual(result.facets[1].features[0].$type, 'app.bsky.richtext.facet#tag');
	assert.strictEqual(cut(result.facets[1]), '#tag');
});

test('parsePostUrl: 壊れた % を含む URL は例外を投げず null', () => {
	assert.strictEqual(parsePostUrl('https://bsky.app/profile/%E0%A4%A/post/abc', HOSTS), null);
	assert.strictEqual(parsePostUrl('https://bsky.app/profile/a/post/%ZZ', HOSTS), null);
});

test('parsePostUrl: ハンドル・DID・末尾のスラッシュを読み、別のパスや別のホストは null', () => {
	assert.deepStrictEqual(parsePostUrl('https://bsky.app/profile/bsky.app/post/3lifogne32c25', HOSTS), {actor: 'bsky.app', rkey: '3lifogne32c25'});
	assert.deepStrictEqual(parsePostUrl('https://bsky.app/profile/did:plc:z72i/post/abc/', HOSTS), {actor: 'did:plc:z72i', rkey: 'abc'});
	assert.deepStrictEqual(parsePostUrl('https://bsky.app/profile/a/post/b?x=1#h', HOSTS), {actor: 'a', rkey: 'b'});
	assert.strictEqual(parsePostUrl('https://bsky.app/profile/bsky.app/feed/x', HOSTS), null);
	assert.strictEqual(parsePostUrl('https://evil.example/profile/a/post/b', HOSTS), null);
	assert.strictEqual(parsePostUrl('garbage', HOSTS), null);
});

test('isCardableUrl: bsky.app・画像の URL・ドメインらしくないホストはカードにしない', () => {
	assert.strictEqual(isCardableUrl('https://example.com/page', CARD_RULE), true);
	assert.strictEqual(isCardableUrl('https://bsky.app/profile/a', CARD_RULE), false);
	assert.strictEqual(isCardableUrl('https://example.com/a/pic.PNG', CARD_RULE), false);
	assert.strictEqual(isCardableUrl('https://localhost/x', CARD_RULE), false);
	assert.strictEqual(isCardableUrl('ftp://example.com/x', CARD_RULE), false);
	assert.strictEqual(isCardableUrl('not a url', CARD_RULE), false);
});

test('pickSuggestion: 貼り付けなら即、打鍵なら前回もあって直後が空白のときだけ。外した URL は除く', () => {
	const base = {links: [], previousLinks: [], text: '', pasted: false, dismissed: [], hosts: HOSTS, cardRule: CARD_RULE};
	const pick = (o) => pickSuggestion({...base, ...o});

	// 打ち終えただけ (直後が空白でない)
	assert.deepStrictEqual(pick({links: ['https://a.com'], previousLinks: ['https://a.com'], text: 'https://a.com'}), {card: null, quote: null});
	// 前回もなく打鍵
	assert.deepStrictEqual(pick({links: ['https://a.com'], previousLinks: [], text: 'https://a.com '}), {card: null, quote: null});
	// 前回もあり直後が空白
	assert.deepStrictEqual(pick({links: ['https://a.com'], previousLinks: ['https://a.com'], text: 'https://a.com '}), {card: 'https://a.com', quote: null});
	// 貼り付け
	assert.deepStrictEqual(pick({links: ['https://a.com'], text: 'https://a.com', pasted: true}), {card: 'https://a.com', quote: null});
	// 外した URL
	assert.deepStrictEqual(pick({links: ['https://a.com'], text: 'https://a.com', pasted: true, dismissed: ['https://a.com']}), {card: null, quote: null});
	// 最初の 1 つ
	const two = 'https://a.com https://b.com ';
	assert.strictEqual(pick({links: ['https://a.com', 'https://b.com'], previousLinks: ['https://a.com', 'https://b.com'], text: two}).card, 'https://a.com');
	// 同じ URL が 2 回: 後ろを打っている最中は出さない
	assert.strictEqual(pick({links: ['https://a.com', 'https://a.com'], previousLinks: ['https://a.com', 'https://a.com'], text: 'https://a.com https://a.com'}).card, null);
	// 長い URL の一部の出現は無視し、後ろの単独の出現を見る
	assert.strictEqual(pick({links: ['https://a.com/foo', 'https://a.com'], previousLinks: ['https://a.com/foo', 'https://a.com'], text: 'https://a.com/foo https://a.com '}).card, 'https://a.com/foo');
	assert.strictEqual(pick({links: ['https://a.com'], previousLinks: ['https://a.com'], text: 'https://a.com/foo https://a.com '}).card, 'https://a.com');
	// 投稿の URL は引用
	const post = 'https://bsky.app/profile/x/post/y';
	assert.deepStrictEqual(pick({links: [post], previousLinks: [post], text: post + ' '}), {card: null, quote: post});
});

test('suppressUrl / suppressedUrls: 理由ごとに提案しない URL を引き、× の理由はカードにも引用にも効く', () => {
	const suppressed = new Map();
	suppressUrl(suppressed, 'https://a.com', 'failedCard');
	suppressUrl(suppressed, 'https://b.com', 'dismissed');
	suppressUrl(suppressed, 'https://c.com', 'failedQuote');
	suppressUrl(suppressed, 'https://a.com', 'failedQuote');
	assert.deepStrictEqual(suppressedUrls(suppressed, ['dismissed', 'failedCard']), ['https://a.com', 'https://b.com']);
	assert.deepStrictEqual(suppressedUrls(suppressed, ['dismissed', 'failedQuote']), ['https://a.com', 'https://b.com', 'https://c.com']);
	assert.deepStrictEqual(suppressedUrls(new Map(), ['dismissed']), []);
});

test('pruneSuppressed: 本文から消えた URL だけを忘れる', () => {
	const suppressed = new Map();
	suppressUrl(suppressed, 'https://a.com', 'dismissed');
	suppressUrl(suppressed, 'https://b.com', 'failedCard');
	pruneSuppressed(suppressed, ['https://b.com']);
	assert.deepStrictEqual(Array.from(suppressed.keys()), ['https://b.com']);
	pruneSuppressed(suppressed, []);
	assert.strictEqual(suppressed.size, 0);
});

test('pickSuggestion: 空の link は提案にならず、固まらない', () => {
	const result = pickSuggestion({
		links: [''], previousLinks: [''], text: 'abc', pasted: false, dismissed: [], hosts: HOSTS, cardRule: CARD_RULE,
	});
	assert.deepStrictEqual(result, {card: null, quote: null});
});

test('parseCardResponse: 400 の {"Error"} と error 付きは null、題名・説明を上限で切る', () => {
	const limits = {maxTitleGraphemes: 3, maxDescriptionGraphemes: 4};
	const family = '\u{1F468}\u200D\u{1F469}';
	const image = 'https://cardyb.bsky.app/v1/image?url=x';
	const ok = {error: '', title: 'ab' + family + 'cd', description: 'abcdef', image};
	assert.deepStrictEqual(parseCardResponse(200, ok, limits), {
		title: 'ab' + family, description: 'abcd', imageUrl: image,
	});
	assert.strictEqual(parseCardResponse(200, {...ok, image: ''}, limits).imageUrl, null);
	assert.strictEqual(parseCardResponse(200, {...ok, image: 'javascript:alert(1)'}, limits).imageUrl, null);
	assert.strictEqual(parseCardResponse(200, {error: '', title: 1}, limits).title, '');
	assert.strictEqual(parseCardResponse(400, {Error: 'invalid URL'}, limits), null);
	assert.strictEqual(parseCardResponse(400, {error: 'Unable to generate link preview'}, limits), null);
	assert.strictEqual(parseCardResponse(200, {error: 'x', title: 'a'}, limits), null);
	assert.strictEqual(parseCardResponse(200, {title: 'a'}, limits), null);
	assert.strictEqual(parseCardResponse(200, null, limits), null);
});
