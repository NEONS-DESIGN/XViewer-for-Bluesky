/**
 * reply-extras.js の確認。入力欄の GIF・リンクカード・引用の状態と、取得の応答の扱い・送信時の組み立て。
 */

import test from 'node:test';
import assert from 'node:assert';

import {EXT_CONFIG} from '../src/common/config.js';
import {BRIDGE_PROTOCOL} from '../src/common/bridge-protocol.js';
import {FakeDocument, click} from './helpers/fake-dom.js';
import {ComposerExtras} from '../src/content/reply-extras.js';

const CONFIG = EXT_CONFIG.lightboxReplies;
const COMPOSE = CONFIG.compose;
const CARDS = CONFIG.cards;
const EXTERNAL_TYPE = BRIDGE_PROTOCOL.postRecord.embedTypes.external;

const CARD_URL = 'https://example.com/article';
const POST_URL = 'https://bsky.app/profile/alice.bsky.social/post/3kabc';
const DID = 'did:plc:alice';
const POST_URI = `at://${DID}/app.bsky.feed.post/3kabc`;

/**
 * 外から解決できる約束を作る。
 * @returns {{promise: Promise<any>, resolve: (value: any) => void}}
 */
function deferred() {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return {promise, resolve};
}

/**
 * 保留中の約束の続きを走らせる。
 * @returns {Promise<void>}
 */
function flush() {
	return new Promise((done) => setImmediate(done));
}

/**
 * getPosts の PostView を作る。
 * @param {Object} [extra] 上書きする値
 * @returns {Object}
 */
function postView(extra = {}) {
	return {
		uri: POST_URI,
		cid: 'bafypost',
		author: {did: DID, handle: 'alice.bsky.social', displayName: 'Alice'},
		record: {text: '引用元', createdAt: '2026-10-19T00:00:00.000Z'},
		indexedAt: '2026-10-19T00:00:01.000Z',
		labels: [],
		viewer: {},
		...extra
	};
}

/**
 * GifItem を作る。
 * @param {Object} [extra] 上書きする値
 * @returns {Object}
 */
function gifItem(extra = {}) {
	return {
		id: 'g1',
		title: '踊る猫',
		gifUrl: 'https://static.klipy.com/ii/abc/def/cat.gif',
		width: 320,
		height: 240,
		previewUrl: 'https://static.klipy.com/ii/abc/def/cat.jpg',
		tinyUrl: 'https://k.gifs.bsky.app/ii/abc/def/cat-tiny.gif',
		tinyWidth: 160,
		tinyHeight: 120,
		playerUrl: 'https://k.gifs.bsky.app/ii/abc/def/cat-tiny.webm',
		mp4Slug: 'cat',
		webmSlug: 'cat',
		...extra
	};
}

/**
 * 偽の依存を作る。呼ばれた引数を記録し、応答は既定の値か差し替えた関数で返す。
 * @param {Object} [overrides] 差し替える依存
 * @returns {{deps: Object, calls: Object}}
 */
function makeDeps(overrides = {}) {
	const calls = {fetchJson: [], fetchBlob: [], resolveHandle: [], fetchPost: [], prepareImage: [], uploadBlob: [], onChange: 0};
	const deps = {
		fetchJson: async (url, timeoutMs) => {
			calls.fetchJson.push({url, timeoutMs});
			return {status: 200, json: {error: '', title: '題名', description: '説明', image: 'https://cardyb.bsky.app/v1/image?url=x'}};
		},
		fetchBlob: async (url) => {
			calls.fetchBlob.push(url);
			return {size: 10, type: 'image/jpeg'};
		},
		resolveHandle: async (handle) => {
			calls.resolveHandle.push(handle);
			return DID;
		},
		fetchPost: async (uri) => {
			calls.fetchPost.push(uri);
			return {posts: [postView()]};
		},
		prepareImage: async (blob, crop, rules) => {
			calls.prepareImage.push({blob, crop, rules});
			return {blob: {size: 5}, width: 100, height: 100, previewUrl: null};
		},
		uploadBlob: async (blob) => {
			calls.uploadBlob.push(blob);
			return {ok: true, blob: {$type: 'blob', ref: {$link: 'bafythumb'}, mimeType: 'image/jpeg', size: 5}, reason: null};
		},
		safeHref: (uri) => uri,
		formatDate: (iso) => iso,
		onChange: () => {
			calls.onChange += 1;
		}
	};
	for (const [key, value] of Object.entries(overrides)) {
		deps[key] = async (...args) => {
			calls[key].push(args.length === 1 ? args[0] : args);
			return value(...args);
		};
	}
	return {deps, calls};
}

/**
 * 偽の依存で ComposerExtras を作る (状態の変化は deps.onChange へ知らせる)。
 * @param {Object} deps
 * @returns {ComposerExtras}
 */
function newExtras(deps) {
	return new ComposerExtras(CONFIG, deps, deps.onChange);
}

/**
 * プレビューに「読み込み中」の 1 行が出るか。
 * @param {ComposerExtras} extras
 * @returns {boolean}
 */
function showsLoading(extras) {
	const container = new FakeDocument().createElement('div');
	extras.render(container, 0, {onGifAlt: () => {}});
	return container.textContent.includes(COMPOSE.text.cardLoading);
}

/**
 * 打鍵で URL を打ち終える (URL だけ → URL の後ろに空白) 流れを再現する。
 * @param {ComposerExtras} extras
 * @param {string} url
 * @returns {void}
 */
function typeUrl(extras, url) {
	extras.onTextChange(url, [url], false);
	extras.onTextChange(`${url} `, [url], false);
}

test('ComposerExtras: 打鍵で URL の後ろに空白が来たらカードを取得し、ready になる', async () => {
	const {deps, calls} = makeDeps();
	const extras = new ComposerExtras(CONFIG, deps, deps.onChange);
	extras.onTextChange(CARD_URL, [CARD_URL], false);
	assert.strictEqual(calls.fetchJson.length, 0, 'URL を打っている途中では取得しない');
	extras.onTextChange(`${CARD_URL} `, [CARD_URL], false);
	assert.strictEqual(calls.fetchJson.length, 1);
	assert.strictEqual(calls.fetchJson[0].url, `${COMPOSE.card.extractUrl}?url=${encodeURIComponent(CARD_URL)}`);
	assert.strictEqual(calls.fetchJson[0].timeoutMs, COMPOSE.card.timeoutMs);
	assert.strictEqual(extras.card.status, 'loading');
	assert.strictEqual(showsLoading(extras), true, '取得中の 1 行を出す');
	await flush();
	assert.strictEqual(extras.card.status, 'ready');
	assert.strictEqual(extras.card.url, CARD_URL);
	assert.deepStrictEqual(extras.card.data, {title: '題名', description: '説明', imageUrl: 'https://cardyb.bsky.app/v1/image?url=x'});
	assert.strictEqual(showsLoading(extras), false);
	assert.ok(calls.onChange >= 2, '取得の開始と完了で知らせる');

	// 同じ URL がまだ本文にあれば取り直さない
	extras.onTextChange(`${CARD_URL} あ`, [CARD_URL], false);
	assert.strictEqual(calls.fetchJson.length, 1);
	assert.strictEqual(extras.card.status, 'ready');
});

test('ComposerExtras: 貼り付けた URL は空白を待たずに取得する', async () => {
	const {deps, calls} = makeDeps();
	const extras = new ComposerExtras(CONFIG, deps, deps.onChange);
	extras.onTextChange(CARD_URL, [CARD_URL], true);
	assert.strictEqual(calls.fetchJson.length, 1);
	await flush();
	assert.strictEqual(extras.card.status, 'ready');
});

test('ComposerExtras: 取得中に本文から URL が消えたら、届いた応答を捨てる', async () => {
	const pending = deferred();
	const {deps} = makeDeps({fetchJson: () => pending.promise});
	const extras = new ComposerExtras(CONFIG, deps, deps.onChange);
	typeUrl(extras, CARD_URL);
	assert.strictEqual(extras.card.status, 'loading');
	extras.onTextChange('', [], false);
	assert.strictEqual(extras.card, null);
	pending.resolve({status: 200, json: {error: '', title: '遅れた題名', description: '', image: ''}});
	await flush();
	assert.strictEqual(extras.card, null);
	assert.strictEqual(showsLoading(extras), false);
});

test('ComposerExtras: 古い取得の応答は、同じ URL を取り直した後に届いても反映しない', async () => {
	const first = deferred();
	const second = deferred();
	const queue = [first.promise, second.promise];
	const {deps} = makeDeps({fetchJson: () => queue.shift()});
	const extras = new ComposerExtras(CONFIG, deps, deps.onChange);
	typeUrl(extras, CARD_URL);
	extras.onTextChange('', [], false);
	typeUrl(extras, CARD_URL);
	first.resolve({status: 200, json: {error: '', title: '古い', description: '', image: ''}});
	await flush();
	assert.strictEqual(extras.card.status, 'loading', '古い応答で ready にしない');
	second.resolve({status: 200, json: {error: '', title: '新しい', description: '', image: ''}});
	await flush();
	assert.strictEqual(extras.card.data.title, '新しい');
});

test('ComposerExtras: × で外した URL は本文に残っているあいだ再提案しない', async () => {
	const {deps, calls} = makeDeps();
	const extras = new ComposerExtras(CONFIG, deps, deps.onChange);
	extras.onTextChange(CARD_URL, [CARD_URL], true);
	await flush();
	extras.removeCard();
	assert.strictEqual(extras.card, null);
	assert.strictEqual(extras.isSuppressed(CARD_URL, 'dismissed'), true);
	extras.onTextChange(`${CARD_URL} `, [CARD_URL], false);
	extras.onTextChange(`${CARD_URL}  `, [CARD_URL], true);
	assert.strictEqual(calls.fetchJson.length, 1, '外した URL は貼り付け直しても取得しない');

	// 本文から消えたら忘れ、もう一度貼れば提案する
	extras.onTextChange('', [], false);
	assert.strictEqual(extras.isSuppressed(CARD_URL, 'dismissed'), false);
	extras.onTextChange(CARD_URL, [CARD_URL], true);
	assert.strictEqual(calls.fetchJson.length, 2);
});

test('ComposerExtras: 引用はハンドルを DID に直して fetchPost し、embeddingDisabled なら付けず quoteDisabled を出す', async () => {
	const {deps, calls} = makeDeps();
	const extras = new ComposerExtras(CONFIG, deps, deps.onChange);
	typeUrl(extras, POST_URL);
	assert.strictEqual(calls.fetchJson.length, 0, 'bsky.app の投稿の URL はカードにしない');
	assert.strictEqual(extras.quote.status, 'loading');
	await flush();
	assert.deepStrictEqual(calls.resolveHandle, ['alice.bsky.social']);
	assert.deepStrictEqual(calls.fetchPost, [POST_URI]);
	assert.strictEqual(extras.quote.status, 'ready');
	assert.deepStrictEqual(extras.quote.ref, {uri: POST_URI, cid: 'bafypost'});
	assert.strictEqual(extras.notice, null);

	// DID の URL はそのまま使う
	const direct = makeDeps();
	const extrasDid = new ComposerExtras(CONFIG, direct.deps, direct.deps.onChange);
	const didUrl = `https://bsky.app/profile/${DID}/post/3kabc`;
	extrasDid.onTextChange(didUrl, [didUrl], true);
	await flush();
	assert.deepStrictEqual(direct.calls.resolveHandle, []);
	assert.deepStrictEqual(direct.calls.fetchPost, [POST_URI]);

	// 引用が許されていない投稿
	const disabled = makeDeps({fetchPost: () => ({posts: [postView({viewer: {embeddingDisabled: true}})]})});
	const extrasDisabled = new ComposerExtras(CONFIG, disabled.deps, disabled.deps.onChange);
	extrasDisabled.onTextChange(POST_URL, [POST_URL], true);
	await flush();
	assert.strictEqual(extrasDisabled.quote, null);
	assert.strictEqual(extrasDisabled.notice, COMPOSE.text.quoteDisabled);
	// 本文に残っているあいだは取り直さない
	extrasDisabled.onTextChange(`${POST_URL} `, [POST_URL], true);
	assert.strictEqual(disabled.calls.fetchPost.length, 1);
	// 本文から消えたら知らせも消える
	extrasDisabled.onTextChange('', [], false);
	assert.strictEqual(extrasDisabled.notice, null);
});

test('ComposerExtras: 0 件の引用は quoteNotFound、cardyb の失敗はカードを付けない', async () => {
	const empty = makeDeps({fetchPost: () => ({posts: []})});
	const extras = new ComposerExtras(CONFIG, empty.deps, empty.deps.onChange);
	extras.onTextChange(POST_URL, [POST_URL], true);
	await flush();
	assert.strictEqual(extras.quote, null);
	assert.strictEqual(extras.notice, CARDS.text.quoteNotFound);

	const unresolved = makeDeps({resolveHandle: () => null});
	const extrasUnresolved = new ComposerExtras(CONFIG, unresolved.deps, unresolved.deps.onChange);
	extrasUnresolved.onTextChange(POST_URL, [POST_URL], true);
	await flush();
	assert.strictEqual(extrasUnresolved.quote, null);
	assert.strictEqual(extrasUnresolved.notice, CARDS.text.quoteNotFound);
	assert.deepStrictEqual(unresolved.calls.fetchPost, []);

	for (const response of [null, {status: 500, json: null}, {status: 200, json: {error: 'failed'}}]) {
		const failing = makeDeps({fetchJson: () => response});
		const extrasCard = new ComposerExtras(CONFIG, failing.deps, failing.deps.onChange);
		extrasCard.onTextChange(CARD_URL, [CARD_URL], true);
		await flush();
		assert.strictEqual(extrasCard.card, null);
		assert.strictEqual(extrasCard.notice, null, 'カードの失敗は知らせない');
		// 失敗した URL は本文に残っているあいだ取り直さない
		extrasCard.onTextChange(`${CARD_URL} `, [CARD_URL], true);
		assert.strictEqual(failing.calls.fetchJson.length, 1);
	}

	const throwing = makeDeps({fetchJson: () => {
		throw new Error('network');
	}});
	const extrasThrow = new ComposerExtras(CONFIG, throwing.deps, throwing.deps.onChange);
	extrasThrow.onTextChange(CARD_URL, [CARD_URL], true);
	await flush();
	assert.strictEqual(extrasThrow.card, null);
});

test('ComposerExtras: カードと引用は 1 つずつ共存する', async () => {
	const {deps} = makeDeps();
	const extras = new ComposerExtras(CONFIG, deps, deps.onChange);
	const text = `${CARD_URL} ${POST_URL}`;
	extras.onTextChange(text, [CARD_URL, POST_URL], true);
	await flush();
	assert.strictEqual(extras.card.status, 'ready');
	assert.strictEqual(extras.quote.status, 'ready');
	assert.strictEqual(extras.contentCount(0), 2);
});

test('ComposerExtras: 画像があると sendableCard は null、画像を外すと戻る', async () => {
	const {deps} = makeDeps();
	const extras = new ComposerExtras(CONFIG, deps, deps.onChange);
	extras.onTextChange(CARD_URL, [CARD_URL], true);
	assert.strictEqual(extras.sendableCard(0), null, '読み込み中のカードは送らない');
	await flush();
	assert.ok(extras.sendableCard(0));
	assert.strictEqual(extras.hasMedia(0), false);
	assert.strictEqual(extras.hasMedia(2), true);
	assert.strictEqual(extras.sendableCard(2), null);
	assert.strictEqual(extras.contentCount(2), 2, '画像 2 枚だけ (カードは数えない)');
	assert.ok(extras.sendableCard(0), '状態は残り、画像を外すと戻る');
	assert.strictEqual(extras.contentCount(0), 1);

	extras.setGif(gifItem());
	assert.deepStrictEqual(extras.gif.alt, '');
	assert.strictEqual(extras.hasMedia(0), true);
	assert.strictEqual(extras.sendableCard(0), null);
	assert.strictEqual(extras.contentCount(0), 1, 'GIF だけ (カードは隠れる)');
	extras.setGifAlt('猫が踊る');
	assert.strictEqual(extras.gif.alt, '猫が踊る');
	extras.removeGif();
	assert.strictEqual(extras.gif, null);
	assert.ok(extras.sendableCard(0));
});

test('ComposerExtras: resolveForSubmit は GIF の previewUrl を縮めて thumb にし、引用の ref は uri と cid だけ', async () => {
	const {deps, calls} = makeDeps();
	const extras = new ComposerExtras(CONFIG, deps, deps.onChange);
	extras.onTextChange(POST_URL, [POST_URL], true);
	await flush();
	extras.setGif(gifItem());
	extras.setGifAlt('猫');
	const progress = [];
	const result = await extras.resolveForSubmit((done, total) => progress.push([done, total]));
	assert.deepStrictEqual(calls.fetchBlob, [gifItem().previewUrl]);
	assert.strictEqual(calls.prepareImage[0].crop, null);
	assert.strictEqual(calls.prepareImage[0].rules, COMPOSE.thumb);
	assert.strictEqual(result.external.$type, EXTERNAL_TYPE);
	assert.strictEqual(result.external.external.description, 'Alt: 猫');
	assert.strictEqual(result.external.external.thumb.ref.$link, 'bafythumb');
	assert.deepStrictEqual(result.quote, {uri: POST_URI, cid: 'bafypost'});
	assert.deepStrictEqual(Object.keys(result.quote).sort(), ['cid', 'uri']);
	assert.strictEqual(result.quoteView.uri, POST_URI);
	assert.strictEqual(result.quoteView.value.text, '引用元');
	assert.deepStrictEqual(progress, [[0, 1], [1, 1]]);
});

test('ComposerExtras: resolveForSubmit はカードを external にし、画像があるときは付けない', async () => {
	const {deps, calls} = makeDeps();
	const extras = new ComposerExtras(CONFIG, deps, deps.onChange);
	extras.onTextChange(CARD_URL, [CARD_URL], true);
	await flush();
	const result = await extras.resolveForSubmit(() => {});
	assert.deepStrictEqual(calls.fetchBlob, ['https://cardyb.bsky.app/v1/image?url=x']);
	assert.deepStrictEqual(result.external, {
		$type: EXTERNAL_TYPE,
		external: {uri: CARD_URL, title: '題名', description: '説明', thumb: {$type: 'blob', ref: {$link: 'bafythumb'}, mimeType: 'image/jpeg', size: 5}}
	});
	assert.strictEqual(result.quote, null);
	assert.strictEqual(result.quoteView, null);

	const withImages = await extras.resolveForSubmit(() => {}, 1);
	assert.strictEqual(withImages.external, null);
	assert.strictEqual(calls.fetchBlob.length, 1, '画像があるときはカードのサムネイルを取らない');
});

test('ComposerExtras: resolveForSubmit はサムネイルの取得に失敗しても thumb 無しの external を返す', async () => {
	const cases = [
		{fetchBlob: () => null},
		{fetchBlob: () => {
			throw new Error('network');
		}},
		{prepareImage: () => null},
		{uploadBlob: () => ({ok: false, blob: null, reason: 'failed'})},
		{uploadBlob: () => {
			throw new Error('bridge');
		}}
	];
	for (const override of cases) {
		const {deps} = makeDeps(override);
		const extras = new ComposerExtras(CONFIG, deps, deps.onChange);
		extras.setGif(gifItem());
		const result = await extras.resolveForSubmit(() => {});
		assert.strictEqual(result.external.$type, EXTERNAL_TYPE);
		assert.strictEqual('thumb' in result.external.external, false);
		assert.strictEqual(result.external.external.description, `ALT: ${gifItem().title}`);
	}

	// 画像の URL を持たないカードは取得せずに thumb 無しで作る
	const {deps, calls} = makeDeps({fetchJson: () => ({status: 200, json: {error: '', title: 't', description: '', image: ''}})});
	const extras = new ComposerExtras(CONFIG, deps, deps.onChange);
	extras.onTextChange(CARD_URL, [CARD_URL], true);
	await flush();
	const result = await extras.resolveForSubmit(() => {});
	assert.deepStrictEqual(result.external, {$type: EXTERNAL_TYPE, external: {uri: CARD_URL, title: 't', description: ''}});
	assert.deepStrictEqual(calls.fetchBlob, []);

	// 何も無ければすべて null
	const none = newExtras(makeDeps().deps);
	assert.deepStrictEqual(await none.resolveForSubmit(() => {}), {external: null, quote: null, quoteView: null});
});

test('ComposerExtras: destroy の後に届いた応答は反映しない', async () => {
	const card = deferred();
	const post = deferred();
	const {deps, calls} = makeDeps({fetchJson: () => card.promise, fetchPost: () => post.promise});
	const extras = new ComposerExtras(CONFIG, deps, deps.onChange);
	extras.onTextChange(`${CARD_URL} ${POST_URL}`, [CARD_URL, POST_URL], true);
	await flush();
	const before = calls.onChange;
	extras.destroy();
	card.resolve({status: 200, json: {error: '', title: '題名', description: '', image: ''}});
	post.resolve({posts: [postView()]});
	await flush();
	assert.strictEqual(extras.card, null);
	assert.strictEqual(extras.quote, null);
	assert.strictEqual(calls.onChange, before, 'destroy の後は知らせない');
	// destroy の後の入力は何もしない
	extras.onTextChange(`${CARD_URL} `, [CARD_URL], true);
	assert.strictEqual(calls.fetchJson.length, 1);
});

test('ComposerExtras: reset は状態を空に戻し、取得中の応答を捨てる', async () => {
	const card = deferred();
	const {deps} = makeDeps({fetchJson: () => card.promise});
	const extras = new ComposerExtras(CONFIG, deps, deps.onChange);
	extras.setGif(gifItem());
	extras.onTextChange(CARD_URL, [CARD_URL], true);
	extras.reset();
	assert.strictEqual(extras.gif, null);
	assert.strictEqual(extras.card, null);
	assert.strictEqual(extras.quote, null);
	assert.strictEqual(extras.suppressed.size, 0);
	assert.strictEqual(extras.notice, null);
	card.resolve({status: 200, json: {error: '', title: '題名', description: '', image: ''}});
	await flush();
	assert.strictEqual(extras.card, null);
	// reset の後も使い続けられる
	extras.onTextChange(POST_URL, [POST_URL], true);
	await flush();
	assert.strictEqual(extras.quote.status, 'ready');
});

/**
 * クラス名を持つ子孫を探す。
 * @param {Object} root
 * @param {string} className
 * @returns {Object[]}
 */
function allByClass(root, className) {
	return root.descendants().filter((node) => node.className.split(' ').includes(className));
}

test('ComposerExtras: render はメディアがあるあいだカードを隠し、引用カードと知らせを描く', async () => {
	const doc = new FakeDocument();
	const container = doc.createElement('div');
	const {deps} = makeDeps();
	const extras = new ComposerExtras(CONFIG, deps, deps.onChange);
	extras.onTextChange(`${CARD_URL} ${POST_URL}`, [CARD_URL, POST_URL], true);

	extras.render(container, 0, {onGifAlt: () => {}});
	assert.strictEqual(container.textContent.includes(COMPOSE.text.cardLoading), true, '取得中は 1 行を出す');

	await flush();
	extras.render(container, 0, {onGifAlt: () => {}});
	assert.strictEqual(allByClass(container, CARDS.classes.linkCard).length, 1);
	assert.strictEqual(allByClass(container, CARDS.classes.quote).length, 1);
	assert.strictEqual(container.textContent.includes(COMPOSE.text.cardLoading), false);
	assert.strictEqual(container.hidden, false);

	extras.render(container, 1, {onGifAlt: () => {}});
	assert.strictEqual(allByClass(container, CARDS.classes.linkCard).length, 0, '画像があるあいだカードは描かない');
	assert.strictEqual(allByClass(container, CARDS.classes.quote).length, 1, '引用は残る');

	// カードの × で外れ、onChange が呼ばれる
	extras.render(container, 0, {onGifAlt: () => {}});
	const remove = allByClass(container, CARDS.classes.remove)[0];
	click(remove);
	assert.strictEqual(extras.card, null);
	assert.strictEqual(extras.isSuppressed(CARD_URL, 'dismissed'), true);

	// 引用できない知らせ
	const disabled = makeDeps({fetchPost: () => ({posts: [postView({viewer: {embeddingDisabled: true}})]})});
	const extrasDisabled = new ComposerExtras(CONFIG, disabled.deps, disabled.deps.onChange);
	extrasDisabled.onTextChange(POST_URL, [POST_URL], true);
	await flush();
	const box = doc.createElement('div');
	extrasDisabled.render(box, 0, {onGifAlt: () => {}});
	assert.strictEqual(box.textContent, COMPOSE.text.quoteDisabled);

	// 何も無ければ隠す
	const empty = doc.createElement('div');
	newExtras(makeDeps().deps).render(empty, 0, {onGifAlt: () => {}});
	assert.strictEqual(empty.children.length, 0);
	assert.strictEqual(empty.hidden, true);
});

test('ComposerExtras: render は GIF のプレビューを描き、ALT のボタンから onGifAlt を呼ぶ', () => {
	const doc = new FakeDocument();
	const create = doc.createElement.bind(doc);
	doc.createElement = (tag) => {
		const element = create(tag);
		if (tag === 'video') {
			element.paused = true;
			element.play = () => Promise.resolve();
			element.pause = () => {};
		}
		return element;
	};
	const container = doc.createElement('div');
	const {deps} = makeDeps();
	const extras = new ComposerExtras(CONFIG, deps, deps.onChange);
	extras.setGif(gifItem());
	let altButton = null;
	extras.render(container, 0, {onGifAlt: (button) => {
		altButton = button;
	}});
	const sources = container.querySelectorAll('source');
	assert.strictEqual(sources.length, 1);
	assert.strictEqual(sources[0].getAttribute('src'), gifItem().playerUrl);
	assert.strictEqual(sources[0].getAttribute('type'), 'video/webm');
	const alt = allByClass(container, CARDS.classes.gifAlt)[0];
	click(alt);
	assert.strictEqual(altButton, alt);

	// 動画の URL が無い GIF は静止画で出す
	const still = newExtras(makeDeps().deps);
	still.setGif(gifItem({playerUrl: null, mp4Slug: null, webmSlug: null, gifUrl: 'https://example.com/a.gif'}));
	const box = doc.createElement('div');
	still.render(box, 0, {onGifAlt: () => {}});
	assert.strictEqual(box.querySelectorAll('video').length, 0);
	const poster = allByClass(box, CARDS.classes.gifPoster)[0];
	assert.strictEqual(poster.getAttribute('src'), gifItem().previewUrl);
	assert.strictEqual(allByClass(box, CARDS.classes.gifAlt).length, 1, '静止画でも ALT と × は残る');
});

/**
 * URL.createObjectURL / revokeObjectURL を差し替え、テストの終わりに戻す。
 * @param {import('node:test').TestContext} t
 * @returns {{created: string[], revoked: string[]}}
 */
function stubUrls(t) {
	const original = {create: URL.createObjectURL, revoke: URL.revokeObjectURL};
	const log = {created: [], revoked: []};
	URL.createObjectURL = () => {
		const url = `blob:thumb-${log.created.length + 1}`;
		log.created.push(url);
		return url;
	};
	URL.revokeObjectURL = (url) => {
		log.revoked.push(url);
	};
	t.after(() => {
		URL.createObjectURL = original.create;
		URL.revokeObjectURL = original.revoke;
	});
	return log;
}

test('ComposerExtras: カードのサムネイルは取れた時点で 1 回だけ取り、プレビューは object URL、送信はその画像を縮めるだけ', async (t) => {
	const urls = stubUrls(t);
	const {deps, calls} = makeDeps();
	const extras = newExtras(deps);
	const container = new FakeDocument().createElement('div');
	extras.onTextChange(CARD_URL, [CARD_URL], true);
	await flush();
	await flush();
	assert.deepStrictEqual(calls.fetchBlob, ['https://cardyb.bsky.app/v1/image?url=x']);
	assert.strictEqual(extras.card.thumb.status, 'ready');
	extras.render(container, 0, {onGifAlt: () => {}});
	const image = container.querySelector('img');
	assert.strictEqual(image.getAttribute('src'), urls.created[0], 'プレビューが取得した画像の URL でない');

	const result = await extras.resolveForSubmit(() => {});
	assert.strictEqual(calls.fetchBlob.length, 1, '送信で取り直した');
	assert.strictEqual(calls.prepareImage.length, 1);
	assert.strictEqual(calls.prepareImage[0].blob, await extras.card.thumb.done);
	assert.strictEqual(result.external.external.thumb.ref.$link, 'bafythumb');

	// 外すと URL を捨てる
	extras.removeCard();
	assert.deepStrictEqual(urls.revoked, [urls.created[0]]);
});

test('ComposerExtras: サムネイルの取得中にカードを外すと、通信を打ち切り、届いた画像を使わない', async (t) => {
	const urls = stubUrls(t);
	const pending = deferred();
	const signals = [];
	const {deps} = makeDeps({fetchBlob: (url, timeoutMs, signal) => {
		signals.push(signal);
		return pending.promise;
	}});
	const extras = newExtras(deps);
	extras.onTextChange(CARD_URL, [CARD_URL], true);
	await flush();
	assert.strictEqual(extras.card.thumb.status, 'loading');
	assert.ok(signals[0] && signals[0].aborted === false, 'signal を渡していない');
	const thumb = extras.card.thumb;
	extras.removeCard();
	assert.strictEqual(signals[0].aborted, true, '外しても通信を止めない');
	pending.resolve({size: 1, type: 'image/jpeg'});
	assert.strictEqual(await thumb.done, null);
	await flush();
	assert.deepStrictEqual(urls.created, [], '外した後に URL を作った');
});

test('ComposerExtras: サムネイルが取れなければプレビューは画像無しで、送信も thumb 無し', async () => {
	const {deps, calls} = makeDeps({fetchBlob: () => null});
	const extras = newExtras(deps);
	extras.onTextChange(CARD_URL, [CARD_URL], true);
	await flush();
	await flush();
	assert.strictEqual(extras.card.thumb.status, 'failed');
	const container = new FakeDocument().createElement('div');
	extras.render(container, 0, {onGifAlt: () => {}});
	assert.strictEqual(container.querySelector('img'), null);
	const result = await extras.resolveForSubmit(() => {});
	assert.strictEqual('thumb' in result.external.external, false);
	assert.strictEqual(calls.fetchBlob.length, 1);
	assert.strictEqual(calls.prepareImage.length, 0);
});

test('ComposerExtras: カードの取得中に URL が消えたら、cardyb への通信を打ち切る', async () => {
	const signals = [];
	const {deps} = makeDeps({fetchJson: (url, timeoutMs, signal) => {
		signals.push(signal);
		return deferred().promise;
	}});
	const extras = newExtras(deps);
	extras.onTextChange(CARD_URL, [CARD_URL], true);
	assert.strictEqual(signals[0].aborted, false);
	extras.onTextChange('', [], false);
	assert.strictEqual(signals[0].aborted, true);
});

test('ComposerExtras: サムネイルを縮めるときプレビューを作らせない', async () => {
	const {deps, calls} = makeDeps();
	const extras = newExtras(deps);
	calls.options = [];
	const prepare = deps.prepareImage;
	deps.prepareImage = (blob, crop, rules, options) => {
		calls.options.push(options);
		return prepare(blob, crop, rules);
	};
	extras.setGif(gifItem());
	await extras.resolveForSubmit(() => {});
	assert.deepStrictEqual(calls.options, [{preview: false}]);
});

test('ComposerExtras: render は変わらない部品を作り直さない (GIF を付けたまま URL を打っても GIF を作り直さない)', async () => {
	const doc = new FakeDocument();
	const create = doc.createElement.bind(doc);
	doc.createElement = (tag) => {
		const element = create(tag);
		if (tag === 'video') {
			element.paused = true;
			element.play = () => Promise.resolve();
			element.pause = () => {};
		}
		return element;
	};
	const container = doc.createElement('div');
	const {deps} = makeDeps({fetchPost: () => deferred().promise});
	const extras = newExtras(deps);
	extras.setGif(gifItem());
	extras.render(container, 0, {onGifAlt: () => {}});
	const gifRoot = container.children[0];
	const player = container.querySelector('video');
	// 引用の取得が始まり「読み込み中」の 1 行が足される
	extras.onTextChange(POST_URL, [POST_URL], true);
	extras.render(container, 0, {onGifAlt: () => {}});
	assert.strictEqual(container.children[0], gifRoot, 'GIF を作り直した');
	assert.strictEqual(container.querySelector('video'), player);
	assert.strictEqual(container.children.length, 2);
	// ALT が変わったら作り直す
	extras.setGifAlt('猫');
	extras.render(container, 0, {onGifAlt: () => {}});
	assert.notStrictEqual(container.children[0], gifRoot);
});
