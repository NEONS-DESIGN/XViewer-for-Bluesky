/**
 * embed-cards.js の確認。embed の view の分類 (純関数) と、リンクカード・引用カードの組み立て。
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import {EXT_CONFIG} from '../src/common/config.js';
import {BRIDGE_PROTOCOL} from '../src/common/bridge-protocol.js';
import {FakeDocument, FakeEvent, click} from './helpers/fake-dom.js';
import {classifyEmbedView, buildLinkCard, buildQuoteCard, buildGifPlayer, buildVideoCard, prefersReducedMotion} from '../src/content/embed-cards.js';

const CARDS = EXT_CONFIG.lightboxReplies.cards;
const RULE = CARDS.types;
const T = RULE;

/**
 * 投稿の viewRecord を作る。
 * @param {Object} [extra] 上書きする値
 * @returns {Object}
 */
function viewRecord(extra = {}) {
	return {
		$type: T.viewRecord,
		uri: 'at://did:plc:abc/app.bsky.feed.post/3kxyz',
		cid: 'bafy',
		author: {did: 'did:plc:abc', handle: 'a.bsky.social', displayName: 'A', avatar: 'https://cdn/a.jpg'},
		value: {text: '本文', createdAt: '2026-10-19T00:00:00.000Z'},
		labels: [{val: 'porn'}],
		embeds: [{$type: T.images, images: [{thumb: 'https://cdn/t1.jpg', fullsize: 'https://cdn/f1.jpg', alt: ''}]}],
		...extra
	};
}

test('classifyEmbedView: recordWithMedia#view を media と quote に分け、viewNotFound は unavailable', () => {
	const media = {$type: T.images, images: [{thumb: 't', fullsize: 'f', alt: ''}]};
	const result = classifyEmbedView({$type: T.recordWithMedia, record: {record: viewRecord()}, media}, RULE);
	assert.strictEqual(result.media, media);
	assert.strictEqual(result.external, null);
	assert.strictEqual(result.other, false);
	assert.strictEqual(result.quote.kind, 'post');
	assert.strictEqual(result.quote.handle, 'a.bsky.social');
	assert.strictEqual(result.quote.displayName, 'A');
	assert.strictEqual(result.quote.avatarUrl, 'https://cdn/a.jpg');
	assert.strictEqual(result.quote.text, '本文');
	assert.strictEqual(result.quote.rkey, '3kxyz');
	assert.strictEqual(result.quote.imageUrl, 'https://cdn/t1.jpg');
	assert.deepStrictEqual(result.quote.labels, ['porn']);

	const notFound = classifyEmbedView({$type: T.record, record: {$type: T.viewNotFound, uri: 'at://x'}}, RULE);
	assert.strictEqual(notFound.quote.kind, 'unavailable');
	assert.strictEqual(notFound.media, null);
	for (const type of [T.viewBlocked, T.viewDetached]) {
		assert.strictEqual(classifyEmbedView({$type: T.record, record: {$type: type}}, RULE).quote.kind, 'unavailable');
	}
});

test('classifyEmbedView: 引用先の embeds が gallery・recordWithMedia でも先頭の画像を拾う', () => {
	const gallery = {$type: T.gallery, items: [{thumbnail: 'https://cdn/g.jpg', fullsize: 'f', alt: ''}]};
	assert.strictEqual(classifyEmbedView({$type: T.record, record: viewRecord({embeds: [gallery]})}, RULE).quote.imageUrl,
		'https://cdn/g.jpg');
	const rwm = {$type: T.recordWithMedia, record: {record: {}}, media: {$type: T.images, images: [{thumb: 'https://cdn/m.jpg'}]}};
	assert.strictEqual(classifyEmbedView({$type: T.record, record: viewRecord({embeds: [rwm]})}, RULE).quote.imageUrl,
		'https://cdn/m.jpg');
	assert.strictEqual(classifyEmbedView({$type: T.record, record: viewRecord({embeds: []})}, RULE).quote.imageUrl, null);
});

test('classifyEmbedView: external#view は external、フィードの record は other', () => {
	const external = {uri: 'https://example.com', title: 't', description: 'd'};
	const ext = classifyEmbedView({$type: T.external, external}, RULE);
	assert.strictEqual(ext.external, external);
	assert.strictEqual(ext.other, false);
	assert.strictEqual(ext.quote, null);

	const feed = classifyEmbedView({$type: T.record, record: {$type: 'app.bsky.feed.defs#generatorView', uri: 'at://x'}}, RULE);
	assert.strictEqual(feed.other, true);
	assert.strictEqual(feed.quote, null);
	const withVideo = classifyEmbedView({$type: T.recordWithMedia, record: {record: viewRecord()}, media: {$type: T.video}}, RULE);
	assert.strictEqual(withVideo.other, false);
	assert.strictEqual(withVideo.quote.kind, 'post');
	assert.strictEqual(withVideo.media, null);
	assert.deepStrictEqual(withVideo.video, {$type: T.video});
});

test('classifyEmbedView: video#view は video に入り、recordWithMedia の media の video も拾う', () => {
	const view = {$type: T.video, playlist: 'https://video.bsky.app/watch/x/p.m3u8', thumbnail: 'https://video.bsky.app/watch/x/t.jpg'};
	const single = classifyEmbedView(view, RULE);
	assert.strictEqual(single.video, view);
	assert.strictEqual(single.other, false);
	assert.strictEqual(single.media, null);
	const combined = classifyEmbedView({$type: T.recordWithMedia, record: {record: viewRecord()}, media: view}, RULE);
	assert.strictEqual(combined.video, view);
	assert.strictEqual(combined.other, false);
	assert.strictEqual(combined.quote.kind, 'post');
});

test('classifyEmbedView: null・未知の形は何も返さない', () => {
	for (const input of [null, undefined, {}, {$type: 'x'}, 'str']) {
		assert.deepStrictEqual(classifyEmbedView(input, RULE), {media: null, external: null, quote: null, video: null, other: false});
	}
});

test('buildLinkCard: safeHref が null の URL は a にせず、onRemove があれば × を出す', () => {
	const doc = new FakeDocument();
	const text = EXT_CONFIG.lightboxReplies.compose.text;
	const external = {uri: 'javascript:alert(1)', title: '題', description: '説明', thumb: 'https://cdn/c.jpg'};
	let removed = 0;
	const unsafe = buildLinkCard(doc, external, {
		classes: CARDS.classes, text, safeHref: () => null, blurText: null, onRemove: () => { removed++; }
	});
	assert.strictEqual(unsafe.tagName.toLowerCase(), 'div');
	assert.ok(!unsafe.querySelector('a'));
	const buttons = unsafe.querySelectorAll('button');
	assert.strictEqual(buttons.length, 1);
	assert.strictEqual(buttons[0].getAttribute('aria-label'), text.removeCard);
	click(buttons[0]);
	assert.strictEqual(removed, 1);

	const safe = buildLinkCard(doc, {...external, uri: 'https://example.com/x'}, {
		classes: CARDS.classes, text, safeHref: (uri) => uri, blurText: null
	});
	assert.strictEqual(safe.tagName.toLowerCase(), 'a');
	assert.strictEqual(safe.getAttribute('href'), 'https://example.com/x');
	assert.strictEqual(safe.getAttribute('target'), '_blank');
	assert.strictEqual(safe.getAttribute('rel'), 'noopener noreferrer');
	assert.ok(!safe.querySelector('button'));
});

test('buildQuoteCard: 引用の投稿を出し、onOpen で開き、unavailable は文言だけを出す', () => {
	const doc = new FakeDocument();
	const text = {...EXT_CONFIG.lightboxReplies.compose.text, ...CARDS.text};
	let opened = 0;
	const model = {
		kind: 'post', uri: 'at://did:plc:abc/app.bsky.feed.post/3kxyz', handle: 'a.bsky.social', displayName: 'A',
		avatarUrl: null, text: '本文', createdAt: '2026-10-19T00:00:00.000Z', rkey: '3kxyz', imageUrl: 'https://cdn/t.jpg',
		labels: ['porn']
	};
	const card = buildQuoteCard(doc, model, {
		classes: CARDS.classes, text, onOpen: () => { opened++; }, blurText: '成人向け', formatDate: (iso) => `D:${iso}`
	});
	assert.ok(card.textContent.includes('A'));
	assert.ok(card.textContent.includes('@a.bsky.social'));
	assert.ok(card.textContent.includes('本文'));
	assert.ok(card.textContent.includes('D:2026-10-19T00:00:00.000Z'));
	assert.ok(card.textContent.includes('成人向け'));
	const image = card.querySelector('img');
	assert.strictEqual(image.getAttribute('alt'), text.quoteImage);
	click(card);
	assert.strictEqual(opened, 1);

	const gone = buildQuoteCard(doc, {kind: 'unavailable'}, {
		classes: CARDS.classes, text, blurText: null, formatDate: String, onRemove: () => {}
	});
	assert.ok(gone.textContent.includes(text.quoteUnavailable));
	assert.ok(!gone.querySelector('img'));
	assert.strictEqual(gone.querySelectorAll('button').length, 1);
});

/**
 * video だけ play / pause を最小のスタブにした偽の文書。
 * @returns {{doc: FakeDocument, videos: Object[]}}
 */
function docWithVideoStub() {
	const doc = new FakeDocument();
	const videos = [];
	const create = doc.createElement.bind(doc);
	doc.createElement = (tag) => {
		const element = create(tag);
		element.style = {};
		if (tag === 'video') {
			element.paused = true;
			element.play = () => {
				element.paused = false;
				element.dispatchEvent(new FakeEvent('play'));
				return Promise.resolve();
			};
			element.pause = () => {
				element.paused = true;
				element.dispatchEvent(new FakeEvent('pause'));
			};
			videos.push(element);
		}
		return element;
	};
	return {doc, videos};
}

/**
 * クラス名で最初の子孫を探す (偽の DOM はクラスの選択子を持たない)。
 * @param {Object} root 起点の要素
 * @param {string} className クラス名
 * @returns {Object|null}
 */
function byClass(root, className) {
	return root.descendants().find((node) => node.className.split(' ').includes(className)) ?? null;
}

const GIF_PLAYER = {
	sources: [{src: 'https://k.gifs.bsky.app/a.webm', type: 'video/webm'}, {src: 'https://k.gifs.bsky.app/a.mp4', type: 'video/mp4'}],
	width: 200, height: 100
};
const GIF_TEXT = {...EXT_CONFIG.lightboxReplies.compose.text, ...CARDS.text};

test('buildGifPlayer: 消音・ループ・インラインで、autoplay の真偽で初期の再生状態とボタンの名前が変わる', () => {
	const stopped = docWithVideoStub();
	const idle = buildGifPlayer(stopped.doc, GIF_PLAYER, {classes: CARDS.classes, text: GIF_TEXT, label: 'ねこ', autoplay: false});
	const video = stopped.videos[0];
	assert.strictEqual(video.muted, true);
	assert.strictEqual(video.loop, true);
	assert.strictEqual(video.playsInline, true);
	assert.strictEqual(video.getAttribute('playsinline'), '');
	assert.strictEqual(video.paused, true);
	assert.strictEqual(video.querySelectorAll('source').length, 2);
	const button = idle.querySelector('button');
	assert.strictEqual(button.getAttribute('aria-label'), GIF_TEXT.gifPlay);

	const playing = docWithVideoStub();
	const auto = buildGifPlayer(playing.doc, GIF_PLAYER, {classes: CARDS.classes, text: GIF_TEXT, label: 'ねこ', autoplay: true});
	assert.strictEqual(playing.videos[0].paused, false);
	assert.strictEqual(auto.querySelector('button').getAttribute('aria-label'), GIF_TEXT.gifPause);
});

test('buildGifPlayer: ボタンで再生と停止が切り替わり、onAlt / onRemove が呼ばれる', () => {
	const {doc, videos} = docWithVideoStub();
	const calls = [];
	const root = buildGifPlayer(doc, GIF_PLAYER, {
		classes: CARDS.classes, text: GIF_TEXT, label: 'ねこ', autoplay: false, altDone: true,
		onRemove: () => calls.push('remove'), onAlt: (button) => calls.push(['alt', button.textContent])
	});
	const video = videos[0];
	const toggle = byClass(root, CARDS.classes.gifPlay);
	click(toggle);
	assert.strictEqual(video.paused, false);
	assert.strictEqual(toggle.getAttribute('aria-label'), GIF_TEXT.gifPause);
	click(toggle);
	assert.strictEqual(video.paused, true);
	assert.strictEqual(toggle.getAttribute('aria-label'), GIF_TEXT.gifPlay);

	click(byClass(root, CARDS.classes.gifAlt));
	click(root.querySelector('[aria-label="' + GIF_TEXT.removeGif + '"]'));
	assert.deepStrictEqual(calls, [['alt', GIF_TEXT.gifAltDone], 'remove']);
});

test('buildGifPlayer: 全部の source が失敗したら静止画に替え、posterUrl が無ければ何もしない', () => {
	const {doc} = docWithVideoStub();
	const root = buildGifPlayer(doc, GIF_PLAYER, {
		classes: CARDS.classes, text: GIF_TEXT, label: 'ねこ', autoplay: false, posterUrl: 'https://cdn/p.jpg'
	});
	const sources = root.querySelectorAll('source');
	sources[0].dispatchEvent(new FakeEvent('error', {bubbles: false}));
	assert.ok(root.querySelector('video'), '最後の source が失敗するまでは動画のまま');
	sources[1].dispatchEvent(new FakeEvent('error', {bubbles: false}));
	assert.ok(!root.querySelector('video'));
	assert.strictEqual(root.querySelector('img').getAttribute('src'), 'https://cdn/p.jpg');
	assert.ok(!root.querySelector('button'));

	const bare = buildGifPlayer(doc, GIF_PLAYER, {classes: CARDS.classes, text: GIF_TEXT, label: 'ねこ', autoplay: false});
	for (const source of bare.querySelectorAll('source')) source.dispatchEvent(new FakeEvent('error', {bubbles: false}));
	assert.ok(bare.querySelector('video'));
	assert.ok(!bare.querySelector('img'));
});

test('prefersReducedMotion: matchMedia の結果を返し、例外や未対応は false', () => {
	assert.strictEqual(prefersReducedMotion({matchMedia: () => ({matches: true})}), true);
	assert.strictEqual(prefersReducedMotion({matchMedia: () => ({matches: false})}), false);
	assert.strictEqual(prefersReducedMotion({matchMedia: () => { throw new Error('x'); }}), false);
	assert.strictEqual(prefersReducedMotion({}), false);
});

test('config: compose.gif / card / links の値が設計どおり、thumb.maxBytes が橋渡しの maxThumbBytes と同じ', () => {
	const compose = EXT_CONFIG.lightboxReplies.compose;
	assert.deepStrictEqual(compose.gif, {
		origin: 'https://gifs.bsky.app',
		paths: {featured: '/klipy/v2/featured', search: '/klipy/v2/search'},
		clientKey: 'bluesky-web', limit: 30, contentFilter: 'low', debounceMs: 750,
		sourceHost: 'static.klipy.com', playerHost: 'k.gifs.bsky.app',
		tenor: {sourceHost: 'media.tenor.com', playerHost: 't.gifs.bsky.app'}, timeoutMs: 12000
	});
	assert.deepStrictEqual(compose.card, {
		extractUrl: 'https://cardyb.bsky.app/v1/extract', timeoutMs: 10000, excludedHosts: ['bsky.app'],
		imageExtensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg']
	});
	assert.deepStrictEqual(compose.quote, {hosts: ['bsky.app']});
	assert.deepStrictEqual(compose.links, {maxRestChars: 15, keepChars: 13});
	assert.strictEqual(compose.thumb.maxBytes, BRIDGE_PROTOCOL.postRecord.external.maxThumbBytes);
	assert.deepStrictEqual({...compose.thumb, maxBytes: 0}, {
		maxDimension: 2000, maxBytes: 0, minQuality: 0.13, scaleStep: 0.8, maxScaleRetries: 4, qualitySteps: 7
	});
});

test('config: カードの文言とクラス名が揃い、クラス名はすべて content.css にある', () => {
	const css = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'content', 'content.css'), 'utf8');
	for (const [key, cls] of Object.entries(CARDS.classes)) {
		assert.ok(typeof cls === 'string' && cls !== '', key);
		assert.ok(css.includes(`.${cls}`), `${key} (${cls}) が content.css に無い`);
	}
	const compose = EXT_CONFIG.lightboxReplies.compose;
	assert.ok(css.includes(`.${compose.classes.embedPreview}`), 'embedPreview が content.css に無い');
	const expected = {
		addGif: 'GIF を追加', gifTitle: 'GIF を選ぶ', gifSearch: 'KLIPY を検索', gifFailed: 'GIF を読み込めませんでした',
		gifRetry: '再試行', gifEmpty: '見つかりませんでした', gifItem: 'GIF「{title}」を選ぶ', gifPlay: 'GIF を再生',
		gifPause: 'GIF を止める', removeGif: 'GIF を外す', cardLoading: 'リンクを読み込み中…',
		removeCard: 'リンクカードを外す', removeQuote: '引用を外す', quoteNotFound: '引用元が見つかりませんでした',
		quoteDisabled: 'この投稿は引用できません', quoteUnavailable: '引用元を表示できません', quoteImage: '引用元の画像'
	};
	const merged = {...compose.text, ...CARDS.text};
	for (const [key, value] of Object.entries(expected)) assert.strictEqual(merged[key], value, key);
});

const VIDEO_VIEW = {
	$type: T.video, cid: 'bafy', playlist: 'https://video.bsky.app/watch/did/cid/playlist.m3u8',
	thumbnail: 'https://video.bsky.app/watch/did/cid/thumbnail.jpg', alt: '猫の動画', aspectRatio: {width: 1920, height: 1080}
};
const VIDEO_TEXT = {...EXT_CONFIG.lightboxReplies.compose.text, ...CARDS.text};
const VIDEO_DEFAULT_ASPECT = EXT_CONFIG.lightboxReplies.compose.video.defaultAspect;

/**
 * 動画カードの組み立てに渡す共通の引数を作る。
 * @param {Object} extra 上書き
 * @returns {Object}
 */
function videoOpts(extra = {}) {
	return {classes: CARDS.classes, text: VIDEO_TEXT, autoplay: false, blurText: null, startPlayback: async () => true, onOpenPost: null, ...extra};
}

test('buildVideoCard: サムネイルと再生ボタンを出し、押すと startPlayback に playlist を渡す', async () => {
	const {doc, videos} = docWithVideoStub();
	const calls = [];
	const card = buildVideoCard(doc, VIDEO_VIEW, videoOpts({startPlayback: async (video, url) => { calls.push([video, url]); return true; }}));
	const thumb = card.querySelector('img');
	assert.strictEqual(thumb.getAttribute('src'), VIDEO_VIEW.thumbnail);
	assert.strictEqual(card.style.aspectRatio, '1920 / 1080');
	const play = card.querySelector(`.${CARDS.classes.videoPlay}`);
	assert.strictEqual(play.getAttribute('aria-label'), VIDEO_TEXT.videoPlay);
	click(play);
	await new Promise((resolve) => setImmediate(resolve));
	assert.strictEqual(calls.length, 1);
	assert.strictEqual(calls[0][1], VIDEO_VIEW.playlist);
	assert.strictEqual(calls[0][0], videos[0]);
	assert.strictEqual(videos[0].controls, true);
	assert.strictEqual(videos[0].getAttribute('playsinline'), '');
	assert.ok(!card.querySelector('img'), 'サムネイルは動画に替わる');
});

test('buildVideoCard: 縦横比が無ければ opts.defaultAspect を使い、それも無ければ指定しない', () => {
	const card = buildVideoCard(docWithVideoStub().doc, {...VIDEO_VIEW, aspectRatio: undefined}, videoOpts({defaultAspect: VIDEO_DEFAULT_ASPECT}));
	assert.strictEqual(card.style.aspectRatio, `${VIDEO_DEFAULT_ASPECT.width} / ${VIDEO_DEFAULT_ASPECT.height}`);
	const bare = buildVideoCard(docWithVideoStub().doc, {...VIDEO_VIEW, aspectRatio: undefined}, videoOpts());
	assert.strictEqual(bare.style.aspectRatio, undefined);
});

test('embed-cards.js: EXT_CONFIG を import しない (設定は引数で受け取る)', () => {
	const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'content', 'embed-cards.js'), 'utf8');
	assert.ok(!/import\s*\{[^}]*EXT_CONFIG[^}]*\}\s*from/.test(source));
});

test('buildVideoCard: 再生ボタンを押すと video へフォーカスを移す', async () => {
	const {doc, videos} = docWithVideoStub();
	const card = buildVideoCard(doc, VIDEO_VIEW, videoOpts());
	click(card.querySelector(`.${CARDS.classes.videoPlay}`));
	assert.strictEqual(doc.activeElement, videos[0]);
	await new Promise((resolve) => setImmediate(resolve));
	assert.strictEqual(doc.activeElement, videos[0]);
});

test('buildVideoCard: gif の動画は切り替えのボタンで止めて再び流せる', async () => {
	const {doc, videos} = docWithVideoStub();
	const card = buildVideoCard(doc, {...VIDEO_VIEW, presentation: 'gif'}, videoOpts({autoplay: true}));
	await new Promise((resolve) => setImmediate(resolve));
	const video = videos[0];
	assert.strictEqual(video.paused, false);
	const toggle = byClass(card, CARDS.classes.gifPlay);
	assert.ok(toggle, '切り替えのボタンが無い');
	assert.strictEqual(toggle.getAttribute('aria-label'), VIDEO_TEXT.videoPause);
	click(toggle);
	assert.strictEqual(video.paused, true);
	assert.strictEqual(toggle.getAttribute('aria-label'), VIDEO_TEXT.videoPlay);
	click(toggle);
	assert.strictEqual(video.paused, false);
	assert.strictEqual(toggle.getAttribute('aria-label'), VIDEO_TEXT.videoPause);

	// 自動再生しないときは再生ボタンから始め、切り替えのボタンへフォーカスを移す
	const manual = docWithVideoStub();
	const idle = buildVideoCard(manual.doc, {...VIDEO_VIEW, presentation: 'gif'}, videoOpts({autoplay: false}));
	assert.ok(!byClass(idle, CARDS.classes.gifPlay), '始める前は切り替えのボタンを出さない');
	click(idle.querySelector(`.${CARDS.classes.videoPlay}`));
	const manualToggle = byClass(idle, CARDS.classes.gifPlay);
	assert.strictEqual(manual.doc.activeElement, manualToggle);
	await new Promise((resolve) => setImmediate(resolve));
	assert.strictEqual(manual.videos[0].paused, false);

	// 再生できなければ切り替えのボタンも外す
	const failing = docWithVideoStub();
	const broken = buildVideoCard(failing.doc, {...VIDEO_VIEW, presentation: 'gif'}, videoOpts({autoplay: true, startPlayback: async () => false}));
	await new Promise((resolve) => setImmediate(resolve));
	assert.ok(!byClass(broken, CARDS.classes.gifPlay));
	assert.ok(!broken.querySelector('video'));
});

test('buildVideoCard: startPlayback が偽なら投稿で見るを出し、押すと onOpenPost', async () => {
	const {doc} = docWithVideoStub();
	let opened = 0;
	const card = buildVideoCard(doc, VIDEO_VIEW, videoOpts({startPlayback: async () => false, onOpenPost: () => { opened++; }}));
	click(card.querySelector(`.${CARDS.classes.videoPlay}`));
	await new Promise((resolve) => setImmediate(resolve));
	const fallback = card.querySelector(`.${CARDS.classes.videoFallback}`);
	assert.ok(fallback);
	assert.ok(fallback.textContent.includes(VIDEO_TEXT.videoOpenPost));
	click(fallback);
	assert.strictEqual(opened, 1);

	const thrown = buildVideoCard(docWithVideoStub().doc, VIDEO_VIEW, videoOpts({startPlayback: async () => { throw new Error('x'); }, onOpenPost: null}));
	click(thrown.querySelector(`.${CARDS.classes.videoPlay}`));
	await new Promise((resolve) => setImmediate(resolve));
	assert.ok(!thrown.querySelector(`.${CARDS.classes.videoFallback}`), 'onOpenPost が無ければ出さない');
});

test('buildVideoCard: presentation が gif で autoplay なら最初から音なしで流す', async () => {
	const {doc, videos} = docWithVideoStub();
	const calls = [];
	const card = buildVideoCard(doc, {...VIDEO_VIEW, presentation: 'gif'}, videoOpts({autoplay: true, startPlayback: async (video, url) => { calls.push(url); return true; }}));
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepStrictEqual(calls, [VIDEO_VIEW.playlist]);
	assert.strictEqual(videos[0].muted, true);
	assert.strictEqual(videos[0].loop, true);
	assert.notStrictEqual(videos[0].controls, true);
	assert.ok(card);
});

test('buildVideoCard: 再生が始まった後に video が error を出したら投稿で見るに替える', async () => {
	const {doc, videos} = docWithVideoStub();
	let opened = 0;
	const card = buildVideoCard(doc, VIDEO_VIEW, videoOpts({onOpenPost: () => { opened++; }}));
	click(card.querySelector(`.${CARDS.classes.videoPlay}`));
	await new Promise((resolve) => setImmediate(resolve));
	assert.ok(!card.querySelector(`.${CARDS.classes.videoFallback}`));
	videos[0].dispatchEvent(new FakeEvent('error'));
	const fallback = card.querySelector(`.${CARDS.classes.videoFallback}`);
	assert.ok(fallback);
	assert.ok(!card.querySelector('video'));
	click(fallback);
	assert.strictEqual(opened, 1);
});

test('buildVideoCard: gif の自動再生でもぼかしは根に残り、最初の押下で外せる', async () => {
	const {doc} = docWithVideoStub();
	const card = buildVideoCard(doc, {...VIDEO_VIEW, presentation: 'gif'}, videoOpts({autoplay: true, blurText: '成人向け'}));
	await new Promise((resolve) => setImmediate(resolve));
	assert.ok(card.querySelector('video'));
	assert.ok(card.classList.contains(CARDS.classes.blurred));
	assert.ok(card.textContent.includes('成人向け'));
});
