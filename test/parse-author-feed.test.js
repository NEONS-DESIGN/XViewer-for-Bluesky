import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import {EXT_CONFIG} from '../src/common/config.js';
import {
	parseAuthorFeed, extractMediaFromEmbed, extractLabels, toMediaEntries,
	toLightboxImages, matchBlurLabels, formatBlurLabels
} from '../src/content/media-source.js';

const config = EXT_CONFIG.mediaGrid;
/** 動画除外を切ったときの挙動 (旧仕様) を確かめるための設定 */
const configWithVideos = {...EXT_CONFIG.mediaGrid, excludeVideos: false};
/**
 * fixtures の JSON を読む。呼ぶたびに新しいオブジェクトを返す。
 * @param {string} name 拡張子を除いたファイル名
 * @returns {Object} 解析した JSON
 */
const load = (name) => JSON.parse(
	fs.readFileSync(path.join(import.meta.dirname, 'fixtures', `${name}.json`), 'utf8')
);

test('images#view の複数画像投稿は 1 件にまとめる', () => {
	const result = parseAuthorFeed(load('feed-images'), config);
	assert.strictEqual(result.ok, true);
	// 1 投稿 = 1 エントリ。画像 2 枚でも件数は増えない
	assert.strictEqual(result.entries.length, 1);

	const entry = result.entries[0];
	// タイルに出るのは先頭画像の情報
	assert.strictEqual(entry.type, 'image');
	assert.strictEqual(entry.thumbUrl, 'https://cdn.test/thumb/1');
	assert.strictEqual(entry.fullsizeUrl, 'https://cdn.test/full/1');
	assert.strictEqual(entry.alt, '一枚目');
	assert.deepStrictEqual(entry.dimensions, {width: 1000, height: 500});
	assert.strictEqual(entry.postId, 'aaa111');
	assert.strictEqual(entry.postHref, '/profile/alice.test/post/aaa111');
	assert.strictEqual(entry.authorHandle, 'alice.test');
	assert.strictEqual(entry.mediaCount, 2);
	// key は postId そのもの (mediaIndex を含まない)
	assert.strictEqual(entry.key, 'aaa111');
	assert.strictEqual(entry.mediaIndex, undefined);

	// siblings は同じ投稿の全画像で、ライトボックスにそのまま渡せる形
	assert.strictEqual(entry.siblings.length, 2);
	assert.deepStrictEqual(entry.siblings[0], {
		type: 'image',
		uri: 'https://cdn.test/full/1',
		thumbUri: 'https://cdn.test/thumb/1',
		alt: '一枚目',
		dimensions: {width: 1000, height: 500}
	});
	assert.deepStrictEqual(entry.siblings[1], {
		type: 'image',
		uri: 'https://cdn.test/full/2',
		thumbUri: 'https://cdn.test/thumb/2',
		alt: '',
		dimensions: {width: 800, height: 800}
	});
});

test('gallery#view の複数画像投稿も 1 件にまとめ、サムネイルのキーが thumbnail である', () => {
	const result = parseAuthorFeed(load('feed-gallery'), config);
	assert.strictEqual(result.entries.length, 1);
	const entry = result.entries[0];
	assert.strictEqual(entry.thumbUrl, 'https://cdn.test/thumb/g1');
	assert.strictEqual(entry.fullsizeUrl, 'https://cdn.test/full/g1');
	assert.strictEqual(entry.mediaCount, 3);
	assert.strictEqual(entry.siblings.length, 3);
	assert.strictEqual(entry.key, 'bbb222');
});

test('既定 (excludeVideos: true) では video#view の投稿はグリッドに出ない', () => {
	// ビデオタブが別にあるため、メディアグリッドは画像だけを並べる
	const result = parseAuthorFeed(load('feed-video'), config);
	assert.strictEqual(result.ok, true);
	assert.strictEqual(result.entries.length, 0);
	// 終端扱いにならないよう cursor は取れたままであること
	assert.strictEqual(result.cursor, '2026-01-03T00:00:00.000Z');
});

test('既定では recordWithMedia の中の動画も除外する', () => {
	const result = parseAuthorFeed(load('feed-record-with-video'), config);
	assert.strictEqual(result.ok, true);
	assert.strictEqual(result.entries.length, 0);
});

test('excludeVideos: false なら video#view は type=video、fullsizeUrl は null', () => {
	const result = parseAuthorFeed(load('feed-video'), configWithVideos);
	assert.strictEqual(result.entries.length, 1);
	const entry = result.entries[0];
	assert.strictEqual(entry.type, 'video');
	assert.strictEqual(entry.thumbUrl, 'https://video.test/thumb/v1');
	assert.strictEqual(entry.fullsizeUrl, null);
});

test('recordWithMedia#view は media を再帰的に処理する', () => {
	const result = parseAuthorFeed(load('feed-record-with-media'), config);
	assert.strictEqual(result.entries.length, 1);
	assert.strictEqual(result.entries[0].thumbUrl, 'https://cdn.test/thumb/q1');
	assert.strictEqual(result.entries[0].type, 'image');
});

test('メディアの無い投稿は 0 件になる', () => {
	const result = parseAuthorFeed(load('feed-empty'), config);
	assert.strictEqual(result.ok, true);
	assert.strictEqual(result.entries.length, 0);
});

test('cursor を取り出す。無ければ null', () => {
	assert.strictEqual(parseAuthorFeed(load('feed-images'), config).cursor,
		'2026-01-02T00:00:00.000Z');
	assert.strictEqual(parseAuthorFeed(load('feed-gallery'), config).cursor, null);
	assert.strictEqual(parseAuthorFeed(load('feed-empty'), config).cursor, null);
});

test('feed が配列でなければ ok:false を返す', () => {
	const failed = {ok: false, entries: [], feedCount: 0, cursor: null};
	assert.deepStrictEqual(parseAuthorFeed({}, config), failed);
	assert.deepStrictEqual(parseAuthorFeed(null, config), failed);
	assert.deepStrictEqual(parseAuthorFeed({feed: 'not-array'}, config), failed);
});

test('parseAuthorFeed は生のフィード件数 (feedCount) を返す (動画だけでも 0 にならない)', () => {
	const parsed = parseAuthorFeed(load('feed-video'), config);
	assert.strictEqual(parsed.ok, true);
	assert.strictEqual(parsed.entries.length, 0, '動画は除外される');
	assert.strictEqual(parsed.feedCount, load('feed-video').feed.length);
	assert.strictEqual(parseAuthorFeed({feed: [], cursor: 'c'}, config).feedCount, 0);
});

test('未知の embed 形式は 0 件を返す (例外を投げない)', () => {
	const media = extractMediaFromEmbed({$type: 'app.bsky.embed.external#view'}, config);
	assert.deepStrictEqual(media, []);
	assert.deepStrictEqual(extractMediaFromEmbed(null, config), []);
});

test('maxMediaPerPost を超える添付は切り捨てる', () => {
	const images = Array.from({length: 15}, (_, i) => ({
		thumb: `https://cdn.test/t${i}`,
		fullsize: `https://cdn.test/f${i}`,
		alt: ''
	}));
	const media = extractMediaFromEmbed(
		{$type: 'app.bsky.embed.images#view', images},
		config
	);
	assert.strictEqual(media.length, config.maxMediaPerPost);
});

test('maxMediaPerPost を超える添付は 1 件のエントリに畳んだ上で siblings も切り捨てる', () => {
	const images = Array.from({length: 15}, (_, i) => ({
		thumb: `https://cdn.test/t${i}`,
		fullsize: `https://cdn.test/f${i}`,
		alt: ''
	}));
	const feedItem = {
		post: {
			uri: 'at://did:plc:many/app.bsky.feed.post/many001',
			author: {handle: 'many.test', did: 'did:plc:many', labels: []},
			embed: {$type: 'app.bsky.embed.images#view', images},
			labels: []
		}
	};
	const entries = toMediaEntries(feedItem, config);
	// 添付が maxMediaPerPost を超えていても、投稿自体は依然として 1 エントリ
	assert.strictEqual(entries.length, 1);
	assert.strictEqual(entries[0].mediaCount, config.maxMediaPerPost);
	assert.strictEqual(entries[0].siblings.length, config.maxMediaPerPost);
});

test('1 件の壊れた投稿があっても他の投稿は残る', () => {
	const json = {
		feed: [
			{post: null},
			{
				post: {
					uri: 'at://did:plc:z/app.bsky.feed.post/zzz999',
					author: {handle: 'zoe.test', did: 'did:plc:z', labels: []},
					embed: {
						$type: 'app.bsky.embed.images#view',
						images: [{thumb: 'https://cdn.test/t', fullsize: 'https://cdn.test/f', alt: ''}]
					},
					labels: []
				}
			}
		]
	};
	const result = parseAuthorFeed(json, config);
	assert.strictEqual(result.ok, true);
	assert.strictEqual(result.entries.length, 1);
	assert.strictEqual(result.entries[0].postId, 'zzz999');
});

test('先頭側に thumbUrl 無しの要素が混じった場合も有効な画像を拾う', () => {
	// 先頭に thumbUrl 無しの要素 5 個、その後に有効な要素 15 個
	// filter してから slice するため、有効な要素だけから上限分を取る -> 10 件
	// 逆に slice してから filter したら、最初の 10 個を取ってから filter -> 5 件になり失敗
	const images = [
		...Array.from({length: 5}, (_, i) => ({
			// thumb なし
			fullsize: `https://cdn.test/f-invalid-${i}`,
			alt: ''
		})),
		...Array.from({length: 15}, (_, i) => ({
			thumb: `https://cdn.test/t-valid-${i}`,
			fullsize: `https://cdn.test/f-valid-${i}`,
			alt: ''
		}))
	];
	const media = extractMediaFromEmbed(
		{$type: 'app.bsky.embed.images#view', images},
		config
	);
	// 最初の 5 個は thumbUrl がないので除外され、その後の 15 個から maxMediaPerPost (10) 件を取る
	assert.strictEqual(media.length, config.maxMediaPerPost);
	assert.strictEqual(media[0].thumbUrl, 'https://cdn.test/t-valid-0');
	assert.strictEqual(media[9].thumbUrl, 'https://cdn.test/t-valid-9');
});

test('MediaEntry は postUri と authorDid を持つ', () => {
	const json = load('feed-images');
	const {entries} = parseAuthorFeed(json, config);
	const entry = entries[0];
	// ライトボックスに metricsContext を添えるために要る (設計文書 3 節)
	assert.equal(entry.postUri, json.feed[0].post.uri);
	assert.equal(entry.authorDid, json.feed[0].post.author.did);
	// postUri は postId (rkey) と整合していること
	assert.ok(entry.postUri.endsWith(`/${entry.postId}`));
});

test('extractLabels: 投稿と作者のラベルを合流し、重複を除く', () => {
	const labels = extractLabels({
		labels: [{val: 'porn'}, {val: 'sexual'}],
		author: {labels: [{val: 'porn'}, {val: 'nudity'}]}
	});
	assert.deepStrictEqual(labels, ['porn', 'sexual', 'nudity']);
});

test('extractLabels: val が文字列でない要素と null は落とし、labels が無ければ空', () => {
	assert.deepStrictEqual(
		extractLabels({labels: [{val: 1}, null, {val: 'porn'}, {}], author: {}}),
		['porn']
	);
	assert.deepStrictEqual(extractLabels({}), []);
	assert.deepStrictEqual(extractLabels({labels: 'porn', author: {labels: null}}), []);
});

test('toLightboxImages: 原寸が無ければサムネイルで補い、配列でなければ空', () => {
	const images = toLightboxImages([
		{type: 'image', thumbUrl: 't1', fullsizeUrl: 'f1', alt: 'a', dimensions: {width: 2, height: 1}},
		{type: 'image', thumbUrl: 't2', fullsizeUrl: null, alt: '', dimensions: null}
	]);
	assert.deepStrictEqual(images, [
		{type: 'image', uri: 'f1', thumbUri: 't1', alt: 'a', dimensions: {width: 2, height: 1}},
		{type: 'image', uri: 't2', thumbUri: 't2', alt: '', dimensions: null}
	]);
	assert.deepStrictEqual(toLightboxImages(null), []);
});

test('matchBlurLabels / formatBlurLabels: ぼかし対象だけを拾い、表示名に直す', () => {
	const matched = matchBlurLabels(['spam', 'porn', 'custom-nsfw'], {
		...config, blurLabels: [...config.blurLabels, 'custom-nsfw']
	});
	assert.deepStrictEqual(matched, ['porn', 'custom-nsfw']);
	// マップに無い値は生の値のまま出す
	assert.strictEqual(formatBlurLabels(matched, config), 'ポルノ・custom-nsfw');
	assert.deepStrictEqual(matchBlurLabels(null, config), []);
	assert.deepStrictEqual(matchBlurLabels(['spam'], config), []);
});
