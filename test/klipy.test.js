/**
 * klipy.js の純関数。問い合わせの組み立て・応答の解析・external の組み立て・動画 URL の算出を確かめる。
 */

import test from 'node:test';
import assert from 'node:assert';
import {readFileSync} from 'node:fs';

import {
	buildKlipyUrl,
	parseKlipyResponse,
	gifDescription,
	buildGifExternal,
	gifPlayerFromUri,
	stripAltPrefix,
} from '../src/content/klipy.js';
import {countGraphemes} from '../src/content/reply-text.js';

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/klipy-search.json', import.meta.url), 'utf8'));
const QUERY_RULE = {
	origin: 'https://api.example.test',
	paths: {featured: '/v2/featured', search: '/v2/search'},
	clientKey: 'bluesky-web',
	limit: 30,
	contentFilter: 'low',
};
const PARSE_RULE = {playerHost: 'k.gifs.bsky.app', sourceHost: 'static.klipy.com'};
const PLAYER_RULE = {
	klipy: {sourceHost: 'static.klipy.com', playerHost: 'k.gifs.bsky.app'},
	tenor: {sourceHost: 'media.tenor.com', playerHost: 't.gifs.bsky.app'},
};
const HEX = 'a'.repeat(32);

test('buildKlipyUrl: featured と search の問い合わせを本体と同じ値で組む', () => {
	const featured = new URL(buildKlipyUrl('featured', {}, QUERY_RULE));
	assert.strictEqual(featured.origin + featured.pathname, 'https://api.example.test/v2/featured');
	assert.strictEqual(featured.search, '?client_key=bluesky-web&limit=30&contentfilter=low');

	const search = new URL(buildKlipyUrl('search', {q: '猫', pos: 'Mg==', locale: 'jp'}, QUERY_RULE));
	assert.strictEqual(search.pathname, '/v2/search');
	assert.strictEqual(search.searchParams.get('q'), '猫');
	assert.strictEqual(search.searchParams.get('pos'), 'Mg==');
	assert.strictEqual(search.searchParams.get('locale'), 'jp');
	assert.strictEqual(search.searchParams.get('client_key'), 'bluesky-web');
	assert.ok(search.search.includes('q=%E7%8C%AB'));

	const noLocale = new URL(buildKlipyUrl('search', {q: 'a', locale: null}, QUERY_RULE));
	assert.strictEqual(noLocale.searchParams.has('locale'), false);
	assert.strictEqual(noLocale.searchParams.has('pos'), false);
});

test('parseKlipyResponse: 欠けた項目を捨て、tinygif のホストを k.gifs.bsky.app に替える', () => {
	const {items, next} = parseKlipyResponse(FIXTURE, PARSE_RULE);
	assert.strictEqual(items.length, 1);
	assert.strictEqual(next, 'Mg==');
	const item = items[0];
	assert.strictEqual(item.id, '1001');
	assert.strictEqual(item.title, 'Cat Typing');
	assert.strictEqual(item.gifUrl, `https://static.klipy.com/ii/${HEX}/ab/cd/cat.gif`);
	assert.strictEqual(item.width, 498);
	assert.strictEqual(item.height, 280);
	assert.strictEqual(item.tinyUrl, `https://k.gifs.bsky.app/ii/${HEX}/ab/cd/cat_tiny.gif`);
	assert.strictEqual(item.tinyWidth, 220);
	assert.strictEqual(item.tinyHeight, 124);
	assert.strictEqual(item.previewUrl, `https://static.klipy.com/ii/${HEX}/ab/cd/cat_preview.jpg`);
	assert.strictEqual(item.playerUrl, `https://k.gifs.bsky.app/ii/${HEX}/ab/cd/cat_tw.webm`);
	assert.strictEqual(item.mp4Slug, 'cat_m');
	assert.strictEqual(item.webmSlug, 'cat_w');

	assert.strictEqual(parseKlipyResponse({...FIXTURE, next: ''}, PARSE_RULE).next, null);
	assert.strictEqual(parseKlipyResponse({results: FIXTURE.results}, PARSE_RULE).next, null);
	assert.deepStrictEqual(parseKlipyResponse({results: 'x', next: 'Mg=='}, PARSE_RULE), {items: [], next: null});
	assert.deepStrictEqual(parseKlipyResponse(null, PARSE_RULE), {items: [], next: null});
});

test('gifDescription / stripAltPrefix: ALT の有無で Alt: / ALT: を切り替え、先頭を外せる', () => {
	assert.strictEqual(gifDescription('Cat', 'かわいい猫'), 'Alt: かわいい猫');
	assert.strictEqual(gifDescription('Cat', '  '), 'ALT: Cat');
	assert.strictEqual(stripAltPrefix('Alt: かわいい猫'), 'かわいい猫');
	assert.strictEqual(stripAltPrefix('ALT: Cat'), 'Cat');
	assert.strictEqual(stripAltPrefix('plain'), 'plain');
});

test('buildGifExternal: uri に hh・ww・mp4・webm を付け、ALT の有無で Alt: / ALT: を切り替える', () => {
	const gif = parseKlipyResponse(FIXTURE, PARSE_RULE).items[0];
	const withAlt = buildGifExternal(gif, 'かわいい猫', null);
	assert.strictEqual(withAlt.$type, 'app.bsky.embed.external');
	assert.strictEqual(
		withAlt.external.uri,
		`https://static.klipy.com/ii/${HEX}/ab/cd/cat.gif?hh=280&ww=498&mp4=cat_m&webm=cat_w`,
	);
	assert.strictEqual(withAlt.external.title, 'Cat Typing');
	assert.strictEqual(withAlt.external.description, 'Alt: かわいい猫');
	assert.strictEqual('thumb' in withAlt.external, false);

	const noAlt = buildGifExternal(gif, '', {ref: 'x'});
	assert.strictEqual(noAlt.external.description, 'ALT: Cat Typing');
	assert.deepStrictEqual(noAlt.external.thumb, {ref: 'x'});

	const onlyMp4 = buildGifExternal({...gif, webmSlug: null}, '', null);
	assert.ok(onlyMp4.external.uri.endsWith('?hh=280&ww=498&mp4=cat_m'));
});

test('gifPlayerFromUri: Klipy と Tenor の GIF は動画の URL を返し、名前の無い Klipy や別のホストは null', () => {
	const klipy = gifPlayerFromUri(
		`https://static.klipy.com/ii/${HEX}/ab/cd/cat.gif?hh=280&ww=498&mp4=cat_m&webm=cat_w`,
		PLAYER_RULE,
	);
	assert.deepStrictEqual(klipy, {
		sources: [
			{src: `https://k.gifs.bsky.app/ii/${HEX}/ab/cd/cat_w.webm`, type: 'video/webm'},
			{src: `https://k.gifs.bsky.app/ii/${HEX}/ab/cd/cat_m.mp4`, type: 'video/mp4'},
		],
		width: 498,
		height: 280,
	});

	const mp4Only = gifPlayerFromUri(`https://static.klipy.com/ii/${HEX}/a/b/c.gif?hh=2&ww=3&mp4=m`, PLAYER_RULE);
	assert.strictEqual(mp4Only.sources.length, 1);
	assert.strictEqual(mp4Only.sources[0].type, 'video/mp4');

	assert.strictEqual(gifPlayerFromUri(`https://static.klipy.com/ii/${HEX}/a/b/c.gif?hh=2&ww=3`, PLAYER_RULE), null);
	assert.strictEqual(gifPlayerFromUri('https://static.klipy.com/x/c.gif?hh=2&ww=3&mp4=m', PLAYER_RULE), null);
	assert.strictEqual(gifPlayerFromUri('https://static.klipy.com/ii/a/c.gif?hh=0&ww=3&mp4=m', PLAYER_RULE), null);
	assert.strictEqual(gifPlayerFromUri('https://static.klipy.com/ii/a/c.gif?ww=3&mp4=m', PLAYER_RULE), null);
	assert.strictEqual(gifPlayerFromUri('https://example.com/ii/a/c.gif?hh=2&ww=3&mp4=m', PLAYER_RULE), null);
	assert.strictEqual(gifPlayerFromUri('not a url', PLAYER_RULE), null);

	const tenor = gifPlayerFromUri('https://media.tenor.com/AAAAC12345/cat.gif?hh=100&ww=200', PLAYER_RULE);
	assert.deepStrictEqual(tenor, {
		sources: [
			{src: 'https://t.gifs.bsky.app/AAAP312345/cat.webm', type: 'video/webm'},
			{src: 'https://t.gifs.bsky.app/AAAP112345/cat.mp4', type: 'video/mp4'},
		],
		width: 200,
		height: 100,
	});
	assert.strictEqual(gifPlayerFromUri('https://media.tenor.com/x/y/cat.gif?hh=1&ww=1', PLAYER_RULE), null);
	assert.strictEqual(gifPlayerFromUri('https://media.tenor.com/AAAAC1/cat.gif?hh=-1&ww=1', PLAYER_RULE), null);
});

test('parseKlipyResponse: content_description があれば題名より優先し、external の title と ALT にも使う', () => {
	const result = structuredClone(FIXTURE.results[0]);
	result.content_description = '猫がタイプしている';
	const [item] = parseKlipyResponse({results: [result]}, PARSE_RULE).items;
	assert.strictEqual(item.title, '猫がタイプしている');
	const external = buildGifExternal(item, '', null).external;
	assert.strictEqual(external.title, '猫がタイプしている');
	assert.strictEqual(external.description, 'ALT: 猫がタイプしている');

	result.content_description = '';
	assert.strictEqual(parseKlipyResponse({results: [result]}, PARSE_RULE).items[0].title, 'Cat Typing');
});

test('parseKlipyResponse: gif の URL が static.klipy.com でなければ mp4・webm の名前を付けない', () => {
	const result = structuredClone(FIXTURE.results[0]);
	result.media_formats.gif.url = 'https://other.example.test/ii/' + HEX + '/ab/cd/cat.gif';
	const [item] = parseKlipyResponse({results: [result]}, PARSE_RULE).items;
	assert.strictEqual(item.mp4Slug, null);
	assert.strictEqual(item.webmSlug, null);
	const uri = buildGifExternal(item, '', null).external.uri;
	assert.ok(uri.endsWith('.gif?hh=280&ww=498'));
});

test('buildGifExternal: 上限を渡すと題名と説明を書記素で切る (渡さなければ切らない)', () => {
	const gif = parseKlipyResponse(FIXTURE, PARSE_RULE).items[0];
	const limits = {maxTitleGraphemes: 300, maxDescriptionGraphemes: 1000};
	const longTitle = '👍🏽'.repeat(1200);
	const noAlt = buildGifExternal({...gif, title: longTitle}, '', null, limits).external;
	assert.strictEqual(countGraphemes(noAlt.title), 300);
	assert.ok(longTitle.startsWith(noAlt.title));
	assert.strictEqual(countGraphemes(noAlt.description), 1000);
	assert.ok(noAlt.description.startsWith('ALT: 👍🏽'));
	const withAlt = buildGifExternal(gif, 'あ'.repeat(1200), null, limits).external;
	assert.strictEqual(withAlt.description, 'Alt: ' + 'あ'.repeat(995));
	assert.strictEqual(buildGifExternal({...gif, title: longTitle}, '', null).external.title, longTitle);
});
