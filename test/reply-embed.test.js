/**
 * reply-embed.js の純関数。添付の embed・自己ラベル・送信の可否・言語の扱い・
 * 自分の返信の embed view の組み立てを確かめる。
 */

import test from 'node:test';
import assert from 'node:assert';

import {
	buildMediaEmbed, buildSelfLabels, acceptImages, canSubmitComposer,
	normalizeLanguages, suggestReplyLanguage, buildOwnEmbedView,
	buildPostEmbed, hasLabelableMedia, buildOwnPostEmbedView, toQuoteViewRecord, buildVideoEmbed
} from '../src/content/reply-embed.js';

const LEGACY_MAX = 4;
const LIMITS = {maxGraphemes: 300, maxBytes: 3000};
const KNOWN = ['ja', 'en', 'fr', 'de', 'ko'];
const CDN = {
	thumb: 'https://cdn.bsky.app/img/feed_thumbnail/plain',
	fullsize: 'https://cdn.bsky.app/img/feed_fullsize/plain'
};
const DID = 'did:plc:abc';

/** 偽の UploadedImage を n 枚作る */
function images(n) {
	return Array.from({length: n}, (unused, i) => ({
		blob: {$type: 'blob', ref: {$link: `cid${i}`}, mimeType: 'image/jpeg', size: 10},
		alt: `alt${i}`,
		width: 400 + i,
		height: 300
	}));
}

test('buildMediaEmbed: 4 枚は images、5 枚は gallery、0 枚は null', () => {
	assert.strictEqual(buildMediaEmbed([], LEGACY_MAX), null);
	const four = buildMediaEmbed(images(4), LEGACY_MAX);
	assert.strictEqual(four.$type, 'app.bsky.embed.images');
	assert.strictEqual(four.images.length, 4);
	assert.deepStrictEqual(four.images[0].aspectRatio, {width: 400, height: 300});
	assert.strictEqual(four.images[0].alt, 'alt0');
	const five = buildMediaEmbed(images(5), LEGACY_MAX);
	assert.strictEqual(five.$type, 'app.bsky.embed.gallery');
	assert.strictEqual(five.items.length, 5);
	assert.strictEqual(five.items[0].$type, 'app.bsky.embed.gallery#image');
	assert.deepStrictEqual(five.items[0].aspectRatio, {width: 400, height: 300});
});

test('buildMediaEmbed: images では寸法が読めない画像に aspectRatio を付けない', () => {
	const list = images(1);
	list[0].width = 0;
	const embed = buildMediaEmbed(list, LEGACY_MAX);
	assert.ok(!('aspectRatio' in embed.images[0]));
});

test('buildSelfLabels: なし・成人向けのみ・graphic のみ・両方', () => {
	assert.strictEqual(buildSelfLabels({adult: null, graphic: false}), null);
	assert.deepStrictEqual(buildSelfLabels({adult: 'porn', graphic: false}), {
		$type: 'com.atproto.label.defs#selfLabels', values: [{val: 'porn'}]
	});
	assert.deepStrictEqual(buildSelfLabels({adult: null, graphic: true}).values, [{val: 'graphic-media'}]);
	assert.deepStrictEqual(buildSelfLabels({adult: 'sexual', graphic: true}).values,
		[{val: 'sexual'}, {val: 'graphic-media'}]);
});

test('acceptImages: 8 枚あるところへ 3 枚 → 2 枚受け取り tooMany 1', () => {
	const files = [{type: 'image/png'}, {type: 'image/png'}, {type: 'image/png'}];
	const result = acceptImages(8, files, ['image/png'], 10);
	assert.deepStrictEqual(result, {accepted: [0, 1], tooMany: 1, unsupported: 0});
});

test('acceptImages: video/mp4 は unsupported', () => {
	const files = [{type: 'video/mp4'}, {type: 'image/png'}];
	const result = acceptImages(0, files, ['image/png'], 10);
	assert.deepStrictEqual(result, {accepted: [1], tooMany: 0, unsupported: 1});
});

test('canSubmitComposer: 空白だけの本文でも画像があれば送れる', () => {
	assert.strictEqual(canSubmitComposer('   ', 1, LIMITS).ok, true);
});

test('canSubmitComposer: 本文も添付も無ければ送れない', () => {
	assert.strictEqual(canSubmitComposer('  ', 0, LIMITS).ok, false);
	assert.strictEqual(canSubmitComposer('', 0, LIMITS).ok, false);
});

test('canSubmitComposer: 301 書記素は送れない', () => {
	const result = canSubmitComposer('あ'.repeat(301), 1, LIMITS);
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.remaining, -1);
	assert.strictEqual(canSubmitComposer('あ'.repeat(300), 0, LIMITS).ok, true);
});

test('normalizeLanguages: 重複・未知のコード・4 つ目を落とす', () => {
	assert.deepStrictEqual(normalizeLanguages(['ja', 'ja', 'xx', 'en', 'fr', 'de'], 3, KNOWN), ['ja', 'en', 'fr']);
	assert.deepStrictEqual(normalizeLanguages('ja', 3, KNOWN), []);
	assert.deepStrictEqual(normalizeLanguages([1, null, 'ko'], 3, KNOWN), ['ko']);
});

test('suggestReplyLanguage: 返信先の言語が選択に無ければ主タグを返す', () => {
	assert.strictEqual(suggestReplyLanguage(['en-US'], ['ja'], KNOWN), 'en');
	assert.strictEqual(suggestReplyLanguage(['en-US'], ['ja', 'en'], KNOWN), null);
	assert.strictEqual(suggestReplyLanguage(undefined, ['ja'], KNOWN), null);
	assert.strictEqual(suggestReplyLanguage([], ['ja'], KNOWN), null);
});

test('suggestReplyLanguage: 選べる一覧に無い言語は出さない', () => {
	assert.strictEqual(suggestReplyLanguage(['fil'], ['ja'], KNOWN), null);
	assert.strictEqual(suggestReplyLanguage(['pt-BR'], ['ja'], ['ja', 'pt']), 'pt');
	assert.strictEqual(suggestReplyLanguage(['en'], ['ja'], null), null);
});

test('acceptImages: 配列でなければ FileList のような形だけ読み、それ以外は空として扱う', () => {
	assert.deepStrictEqual(acceptImages(0, null, ['image/png'], 10), {accepted: [], tooMany: 0, unsupported: 0});
	assert.deepStrictEqual(acceptImages(0, 'x', ['image/png'], 10), {accepted: [], tooMany: 0, unsupported: 0});
	const fileList = {length: 2, 0: {type: 'image/png'}, 1: {type: 'text/plain'}};
	assert.deepStrictEqual(acceptImages(0, fileList, ['image/png'], 10), {accepted: [0], tooMany: 0, unsupported: 1});
});

test('buildOwnEmbedView: CID の無い画像は URL を作らずに除き、残らなければ null', () => {
	const list = images(2);
	delete list[0].blob.ref.$link;
	const view = buildOwnEmbedView(list, DID, CDN, LEGACY_MAX);
	assert.strictEqual(view.images.length, 1);
	assert.strictEqual(view.images[0].thumb, `${CDN.thumb}/${DID}/cid1`);
	const broken = images(1);
	broken[0].blob = null;
	assert.strictEqual(buildOwnEmbedView(broken, DID, CDN, LEGACY_MAX), null);
});

test('buildOwnEmbedView: 1 枚は images#view で thumb が CDN の形', () => {
	const view = buildOwnEmbedView(images(1), DID, CDN, LEGACY_MAX);
	assert.strictEqual(view.$type, 'app.bsky.embed.images#view');
	assert.strictEqual(view.images[0].thumb, `${CDN.thumb}/${DID}/cid0`);
	assert.strictEqual(view.images[0].fullsize, `${CDN.fullsize}/${DID}/cid0`);
	assert.strictEqual(view.images[0].alt, 'alt0');
	assert.deepStrictEqual(view.images[0].aspectRatio, {width: 400, height: 300});
	assert.strictEqual(buildOwnEmbedView([], DID, CDN, LEGACY_MAX), null);
});

test('buildOwnEmbedView: 5 枚は gallery#view で items[].thumbnail', () => {
	const view = buildOwnEmbedView(images(5), DID, CDN, LEGACY_MAX);
	assert.strictEqual(view.$type, 'app.bsky.embed.gallery#view');
	assert.strictEqual(view.items.length, 5);
	assert.strictEqual(view.items[1].thumbnail, `${CDN.thumb}/${DID}/cid1`);
	assert.strictEqual(view.items[1].fullsize, `${CDN.fullsize}/${DID}/cid1`);
});

const EXT = {$type: 'app.bsky.embed.external', external: {uri: 'https://e.com', title: 't', description: 'd'}};
const Q = {uri: 'at://did:plc:x/app.bsky.feed.post/a', cid: 'c'};

test('buildPostEmbed: 5 通りの組み合わせ', () => {
	assert.strictEqual(buildPostEmbed({images: [], external: null, quote: null}, 4), null);
	assert.strictEqual(buildPostEmbed({images: images(2), external: null, quote: null}, 4).$type, 'app.bsky.embed.images');
	assert.deepStrictEqual(buildPostEmbed({images: [], external: EXT, quote: null}, 4), EXT);
	assert.deepStrictEqual(buildPostEmbed({images: [], external: null, quote: Q}, 4), {$type: 'app.bsky.embed.record', record: Q});
	const rwm = buildPostEmbed({images: images(5), external: null, quote: Q}, 4);
	assert.strictEqual(rwm.$type, 'app.bsky.embed.recordWithMedia');
	assert.strictEqual(rwm.media.$type, 'app.bsky.embed.gallery');
	assert.deepStrictEqual(rwm.record, {$type: 'app.bsky.embed.record', record: Q});
	assert.strictEqual(buildPostEmbed({images: [], external: EXT, quote: Q}, 4).media, EXT);
	assert.strictEqual(buildPostEmbed({images: images(1), external: EXT, quote: null}, 4).$type, 'app.bsky.embed.images');
});

test('hasLabelableMedia: 画像・GIF・カードのどれかがあるときだけ', () => {
	assert.strictEqual(hasLabelableMedia({imageCount: 0, hasGif: false, hasCard: false}), false);
	assert.strictEqual(hasLabelableMedia({imageCount: 1, hasGif: false, hasCard: false}), true);
	assert.strictEqual(hasLabelableMedia({imageCount: 0, hasGif: true, hasCard: false}), true);
	assert.strictEqual(hasLabelableMedia({imageCount: 0, hasGif: false, hasCard: true}), true);
});

test('buildOwnPostEmbedView: external の thumb を CDN の URL にし、引用と組むと recordWithMedia#view', () => {
	const ext = {$type: 'app.bsky.embed.external', external: {
		uri: 'https://e.com', title: 't', description: 'd',
		thumb: {$type: 'blob', ref: {$link: 'bafy'}, mimeType: 'image/jpeg', size: 1}
	}};
	const view = buildOwnPostEmbedView({images: [], external: ext, quoteView: null}, 'did:plc:me', CDN, 4);
	assert.deepStrictEqual(view, {
		$type: 'app.bsky.embed.external#view',
		external: {uri: 'https://e.com', title: 't', description: 'd', thumb: `${CDN.thumb}/did:plc:me/bafy`}
	});
	const noThumb = buildOwnPostEmbedView({images: [], external: EXT, quoteView: null}, 'did:plc:me', CDN, 4);
	assert.strictEqual('thumb' in noThumb.external, false);
	const qv = {$type: 'app.bsky.embed.record#viewRecord', uri: Q.uri};
	assert.deepStrictEqual(buildOwnPostEmbedView({images: [], external: null, quoteView: qv}, 'did:plc:me', CDN, 4),
		{$type: 'app.bsky.embed.record#view', record: qv});
	const rwm = buildOwnPostEmbedView({images: [], external: ext, quoteView: qv}, 'did:plc:me', CDN, 4);
	assert.strictEqual(rwm.$type, 'app.bsky.embed.recordWithMedia#view');
	assert.strictEqual(rwm.media.$type, 'app.bsky.embed.external#view');
	assert.deepStrictEqual(rwm.record, {$type: 'app.bsky.embed.record#view', record: qv});
	const img = buildOwnPostEmbedView({images: images(1), external: null, quoteView: qv}, 'did:plc:me', CDN, 4);
	assert.strictEqual(img.media.$type, 'app.bsky.embed.images#view');
	assert.strictEqual(buildOwnPostEmbedView({images: [], external: null, quoteView: null}, 'did:plc:me', CDN, 4), null);
});

test('toQuoteViewRecord: record を value に、embed を embeds に写す', () => {
	const post = {uri: 'at://x/p/1', cid: 'c1', author: {did: 'd'}, record: {text: 'hi'}, indexedAt: 'T', labels: [], embed: {$type: 'e'}};
	assert.deepStrictEqual(toQuoteViewRecord(post), {
		$type: 'app.bsky.embed.record#viewRecord', uri: 'at://x/p/1', cid: 'c1', author: {did: 'd'},
		value: {text: 'hi'}, indexedAt: 'T', labels: [], embeds: [{$type: 'e'}]
	});
	assert.deepStrictEqual(toQuoteViewRecord({...post, embed: undefined, labels: undefined}).embeds, []);
	assert.strictEqual(toQuoteViewRecord(null), null);
	assert.strictEqual(toQuoteViewRecord({uri: 'x'}), null);
});

/** 偽の UploadedVideo */
const VIDEO_BLOB_REF = {$type: 'blob', ref: {$link: 'bafkreivideo'}, mimeType: 'video/mp4', size: 1000};
const VTT_REF = {$type: 'blob', ref: {$link: 'bafkreivtt'}, mimeType: 'text/vtt', size: 100};
const CDN_WITH_VIDEO = {...CDN, video: 'https://video.bsky.app/watch'};
function uploadedVideo(overrides) {
	return {blob: VIDEO_BLOB_REF, alt: '説明', width: 640.6, height: 360, captions: [{lang: 'ja', file: VTT_REF}], ...overrides};
}

test('buildVideoEmbed: ALT・字幕・縦横比は値があるときだけ付ける', () => {
	assert.deepStrictEqual(buildVideoEmbed(uploadedVideo()), {
		$type: 'app.bsky.embed.video',
		video: VIDEO_BLOB_REF,
		alt: '説明',
		captions: [{lang: 'ja', file: VTT_REF}],
		aspectRatio: {width: 641, height: 360},
		presentation: 'default'
	});
	assert.deepStrictEqual(buildVideoEmbed(uploadedVideo({alt: '', captions: [], height: 0})), {
		$type: 'app.bsky.embed.video', video: VIDEO_BLOB_REF, presentation: 'default'
	});
	assert.strictEqual(buildVideoEmbed(null), null);
});

test('buildPostEmbed: 動画だけは video、引用と一緒なら recordWithMedia の media が video', () => {
	const video = uploadedVideo();
	const only = buildPostEmbed({images: [], video, external: null, quote: null}, 4);
	assert.strictEqual(only.$type, 'app.bsky.embed.video');
	const withQuote = buildPostEmbed({images: [], video, external: null, quote: Q}, 4);
	assert.strictEqual(withQuote.$type, 'app.bsky.embed.recordWithMedia');
	assert.strictEqual(withQuote.media.$type, 'app.bsky.embed.video');
});

test('buildPostEmbed: 動画があるとき external は使わない', () => {
	const embed = buildPostEmbed({images: [], video: uploadedVideo(), external: EXT, quote: null}, 4);
	assert.strictEqual(embed.$type, 'app.bsky.embed.video');
});

test('hasLabelableMedia: 動画だけでもラベルを出す', () => {
	assert.strictEqual(hasLabelableMedia({imageCount: 0, hasGif: false, hasCard: false, hasVideo: true}), true);
	assert.strictEqual(hasLabelableMedia({imageCount: 0, hasGif: false, hasCard: false, hasVideo: false}), false);
});

test('buildOwnPostEmbedView: 動画の view は video.bsky.app の playlist と thumbnail を組む', () => {
	const view = buildOwnPostEmbedView({images: [], video: uploadedVideo(), external: null, quoteView: null}, DID, CDN_WITH_VIDEO, 4);
	assert.deepStrictEqual(view, {
		$type: 'app.bsky.embed.video#view',
		cid: 'bafkreivideo',
		playlist: 'https://video.bsky.app/watch/did%3Aplc%3Aabc/bafkreivideo/playlist.m3u8',
		thumbnail: 'https://video.bsky.app/watch/did%3Aplc%3Aabc/bafkreivideo/thumbnail.jpg',
		alt: '説明',
		aspectRatio: {width: 641, height: 360}
	});
	const bare = buildOwnPostEmbedView({images: [], video: uploadedVideo({alt: '', width: 0}), external: null, quoteView: null}, DID, CDN_WITH_VIDEO, 4);
	assert.ok(!('alt' in bare));
	assert.ok(!('aspectRatio' in bare));
});
