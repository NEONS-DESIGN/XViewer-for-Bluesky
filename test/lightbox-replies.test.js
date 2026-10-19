/**
 * lightbox-replies.js のうち偽の DOM で試せる部分。返信への返信の入力欄の後始末を確かめる。
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import {EXT_CONFIG} from '../src/common/config.js';
import {FakeDocument, FakeEvent, click} from './helpers/fake-dom.js';
import {LightboxReplies} from '../src/content/lightbox-replies.js';
import {chainTargets} from '../src/content/reply-thread.js';

/** 1 段目の返信の URI */
const ANCHOR = 'at://did:plc:a/app.bsky.feed.post/A';

/**
 * 1 段目の行と、その中に開いた返信への返信の入力欄 (の代わり) を持つ返信欄を作る。
 * @returns {{replies: LightboxReplies, composer: Object, restore: () => void}}
 */
function setup() {
	const previous = globalThis.document;
	const doc = new FakeDocument();
	globalThis.document = doc;
	const replies = new LightboxReplies(EXT_CONFIG.lightboxReplies, {actions: {}});
	const li = doc.createElement('li');
	const body = doc.createElement('div');
	const area = doc.createElement('div');
	body.append(area);
	li.append(body);
	doc.body.append(li);
	replies.rows.set(ANCHOR, {
		li, body, area, depth: 0, anchorUri: ANCHOR, showButton: null,
		item: {uri: ANCHOR, replyCount: 1}
	});
	const formEl = doc.createElement('div');
	area.append(formEl);
	const composer = {
		el: formEl,
		destroyed: false,
		destroy() {
			this.destroyed = true;
			this.el.remove();
		}
	};
	const button = doc.createElement('button');
	replies.composers.add(composer);
	replies.rowForm = {composer, button};
	return {replies, composer, restore: () => {
		globalThis.document = previous;
	}};
}

test('renderBranch: 開いた返信の中にある返信への返信の入力欄は、描き直す前に閉じる', () => {
	const {replies, composer, restore} = setup();
	try {
		replies.branches.set(ANCHOR, {open: false, items: null, shown: 0});
		replies.renderBranch(ANCHOR);
		assert.strictEqual(composer.destroyed, true);
		assert.strictEqual(replies.rowForm, null);
		assert.strictEqual(replies.composers.has(composer), false);
	} finally {
		restore();
	}
});

/** buildEmbed 用に、偽の文書と host を持つ返信欄を作る */
function setupEmbed({unblur = false} = {}) {
	const previous = globalThis.document;
	const doc = new FakeDocument();
	globalThis.document = doc;
	const left = [];
	const replies = new LightboxReplies(EXT_CONFIG.lightboxReplies, {
		actions: {},
		safeHref: (uri) => (/^https?:/.test(uri) ? uri : null),
		formatDate: (iso) => `D:${iso}`,
		leaveTo: (target) => left.push(target)
	});
	replies.unblurEnabled = unblur;
	return {replies, doc, left, restore: () => {
		globalThis.document = previous;
	}};
}

const TYPES = EXT_CONFIG.lightboxReplies.cards.types;
const CARD_CLASSES = EXT_CONFIG.lightboxReplies.cards.classes;
const KLIPY_URI = 'https://static.klipy.com/ii/abc/def/x.gif?hh=100&ww=200&webm=aaa&mp4=bbb';
const IMAGES_VIEW = {
	$type: TYPES.images,
	images: [{thumb: 'https://cdn.example/t.jpg', fullsize: 'https://cdn.example/f.jpg', alt: '', aspectRatio: {width: 1, height: 1}}]
};
const QUOTE_VIEW = {
	$type: TYPES.record,
	record: {
		$type: TYPES.viewRecord,
		uri: 'at://did:plc:q/app.bsky.feed.post/3kq',
		cid: 'c',
		author: {did: 'did:plc:q', handle: 'q.test', displayName: 'Q'},
		value: {text: '引用の本文', createdAt: '2026-01-01T00:00:00Z'},
		labels: []
	}
};

test('buildEmbed: Klipy の external#view は video、ふつうの external#view はリンクカード、record#view は引用カード', () => {
	const {replies, left, restore} = setupEmbed();
	try {
		const gif = replies.buildEmbed({uri: 'u', labels: [], embed: {
			$type: TYPES.external, external: {uri: KLIPY_URI, title: 'g', description: '', thumb: 'https://cdn.example/g.jpg'}
		}});
		assert.ok(gif.descendants().some((n) => n.tagName === 'video' || n.tagName === 'VIDEO'));
		assert.strictEqual(gif.descendants().some((n) => n.className === CARD_CLASSES.linkCard), false);

		const card = replies.buildEmbed({uri: 'u', labels: [], embed: {
			$type: TYPES.external, external: {uri: 'https://example.com/a', title: 'T', description: 'D'}
		}});
		assert.ok([card, ...card.descendants()].some((n) => n.className === CARD_CLASSES.linkCard));

		const quote = replies.buildEmbed({uri: 'u', labels: [], embed: QUOTE_VIEW});
		const quoteEl = [quote, ...quote.descendants()].find((n) => n.className === CARD_CLASSES.quote);
		assert.ok(quoteEl);
		click(quoteEl);
		assert.deepStrictEqual(left[0], {route: EXT_CONFIG.mediaGrid.bridge.routes.post, params: {name: 'q.test', rkey: '3kq'}});
	} finally {
		restore();
	}
});

test('buildEmbed: GIF の読み上げ名は description から「Alt: 」「ALT: 」を除いたもの', () => {
	const {replies, restore} = setupEmbed();
	try {
		const labelOf = (external) => {
			const root = replies.buildEmbed({uri: 'u', labels: [], embed: {$type: TYPES.external, external}});
			return [root, ...root.descendants()].find((n) => n.localName === 'video').getAttribute('aria-label');
		};
		const base = {uri: KLIPY_URI, title: '題名', thumb: 'https://cdn.example/g.jpg'};
		assert.strictEqual(labelOf({...base, description: 'Alt: 踊る猫'}), '踊る猫');
		assert.strictEqual(labelOf({...base, description: 'ALT: 題名'}), '題名');
		assert.strictEqual(labelOf({...base, description: ''}), '題名');
	} finally {
		restore();
	}
});

test('buildEmbed: thumb の無い GIF は再生ではなくリンクカードにする', () => {
	const {replies, restore} = setupEmbed();
	try {
		const root = replies.buildEmbed({uri: 'u', labels: [], embed: {
			$type: TYPES.external, external: {uri: KLIPY_URI, title: 'g', description: 'Alt: g', thumb: ''}
		}});
		const all = [root, ...root.descendants()];
		assert.strictEqual(all.some((n) => n.localName === 'video'), false);
		assert.ok(all.some((n) => n.className === CARD_CLASSES.linkCard));
	} finally {
		restore();
	}
});

test('buildEmbed: recordWithMedia#view は画像の格子の下に引用カード、video#view は動画のカード', () => {
	const {replies, restore} = setupEmbed();
	try {
		const both = replies.buildEmbed({uri: 'u', labels: [], embed: {
			$type: TYPES.recordWithMedia, media: IMAGES_VIEW, record: QUOTE_VIEW
		}});
		const kids = both.children;
		assert.strictEqual(kids.length, 2);
		assert.strictEqual(kids[0].className, EXT_CONFIG.lightboxReplies.classes.media);
		assert.ok([kids[1], ...kids[1].descendants()].some((n) => n.className === CARD_CLASSES.quote));

		const video = replies.buildEmbed({uri: 'u', labels: [], embed: {$type: TYPES.video, playlist: 'https://video.bsky.app/p.m3u8', thumbnail: 'https://video.bsky.app/t.jpg'}});
		assert.strictEqual(video.className, CARD_CLASSES.video);
		assert.ok(video.querySelector(`.${CARD_CLASSES.videoPlay}`));
		assert.strictEqual(video.querySelector('img').getAttribute('src'), 'https://video.bsky.app/t.jpg');
		assert.strictEqual(replies.buildEmbed({uri: 'u', labels: [], embed: null}), null);
	} finally {
		restore();
	}
});

test('buildEmbed: sexual ラベル付きの返信のカードの画像はぼかす', () => {
	const {replies, restore} = setupEmbed();
	try {
		const embed = {$type: TYPES.external, external: {uri: 'https://example.com/a', title: 'T', thumb: 'https://cdn.example/t.jpg'}};
		const blurred = replies.buildEmbed({uri: 'u', labels: ['sexual'], embed});
		assert.ok([blurred, ...blurred.descendants()].some((n) => n.classList.contains(CARD_CLASSES.blurred)));
		const plain = replies.buildEmbed({uri: 'u', labels: [], embed});
		assert.strictEqual([plain, ...plain.descendants()].some((n) => n.classList.contains(CARD_CLASSES.blurred)), false);
	} finally {
		restore();
	}
});

const LINK_EMBED = {
	$type: TYPES.external,
	external: {uri: 'https://example.com/a', title: 'T', thumb: 'https://cdn.example/t.jpg'}
};

/** 子孫と自身から、クラスを持つ要素を集める */
function withClass(root, name) {
	return [root, ...root.descendants()].filter((n) => n.classList.contains(name));
}

/** 押下を送り、既定の動作が許されたか (止められなかったか) を返す */
function press(element) {
	return element.dispatchEvent(new FakeEvent('click'));
}

test('ぼかし: 解除が OFF のとき、カードは 1 回目の押下で止まりぼかしが外れ、2 回目で通る', () => {
	const {replies, restore} = setupEmbed();
	try {
		const root = replies.buildEmbed({uri: 'u', labels: ['sexual'], embed: LINK_EMBED});
		const anchor = [root, ...root.descendants()].find((n) => n.localName === 'a');
		assert.ok(anchor);
		assert.strictEqual(withClass(root, CARD_CLASSES.blurred).length, 1);
		assert.strictEqual(press(anchor), false);
		assert.strictEqual(withClass(root, CARD_CLASSES.blurred).length, 0);
		assert.strictEqual(withClass(root, CARD_CLASSES.blurLabel).length, 0);
		assert.strictEqual(press(anchor), true);
	} finally {
		restore();
	}
});

test('ぼかし: 引用元のラベルでぼかし、1 回目の押下では遷移せず、2 回目で遷移する', () => {
	const {replies, left, restore} = setupEmbed();
	try {
		const view = JSON.parse(JSON.stringify(QUOTE_VIEW));
		view.record.labels = [{val: 'porn'}];
		view.record.embeds = [{
			$type: TYPES.images,
			images: [{thumb: 'https://cdn.example/q.jpg', fullsize: 'https://cdn.example/q.jpg', alt: ''}]
		}];
		const root = replies.buildEmbed({uri: 'u', labels: [], embed: view});
		const quote = withClass(root, CARD_CLASSES.quote)[0];
		assert.strictEqual(withClass(root, CARD_CLASSES.blurred).length, 1);
		press(quote);
		assert.strictEqual(left.length, 0);
		assert.strictEqual(withClass(root, CARD_CLASSES.blurred).length, 0);
		press(quote);
		assert.strictEqual(left.length, 1);
	} finally {
		restore();
	}
});

test('ぼかし: GIF はクラスでぼかし 1 回目の押下で外れる。解除が ON なら 1 回目から通る', () => {
	const gifEmbed = {$type: TYPES.external, external: {uri: KLIPY_URI, title: 'g', description: '', thumb: 'https://cdn.example/g.jpg'}};
	const off = setupEmbed();
	try {
		const gif = off.replies.buildEmbed({uri: 'u', labels: ['sexual'], embed: gifEmbed});
		assert.ok(gif.classList.contains(CARD_CLASSES.blurred));
		assert.strictEqual(press(gif), false);
		assert.strictEqual(gif.classList.contains(CARD_CLASSES.blurred), false);
	} finally {
		off.restore();
	}
	const on = setupEmbed({unblur: true});
	try {
		const quoteView = JSON.parse(JSON.stringify(QUOTE_VIEW));
		quoteView.record.labels = [{val: 'porn'}];
		quoteView.record.embeds = [{
			$type: TYPES.images,
			images: [{thumb: 'https://cdn.example/q.jpg', fullsize: 'https://cdn.example/q.jpg', alt: ''}]
		}];
		const root = on.replies.buildEmbed({uri: 'u', labels: [], embed: quoteView});
		press(withClass(root, CARD_CLASSES.quote)[0]);
		assert.strictEqual(on.left.length, 1);
	} finally {
		on.restore();
	}
});

test('ぼかし: 動画のカードは根でぼかし、1 回目の押下で外れる', () => {
	const view = {$type: TYPES.video, playlist: 'https://video.bsky.app/p.m3u8', thumbnail: 'https://video.bsky.app/t.jpg', presentation: 'gif'};
	const {replies, restore} = setupEmbed();
	try {
		const card = replies.buildEmbed({uri: 'u', labels: ['sexual'], embed: view});
		assert.ok(card.classList.contains(CARD_CLASSES.blurred));
		assert.strictEqual(press(card), false);
		assert.strictEqual(card.classList.contains(CARD_CLASSES.blurred), false);
	} finally {
		restore();
	}
});

test('動画: 読み込みの待ち中に取り消された札は、届いても再生を始めない', async () => {
	const {replies, restore} = setupEmbed();
	try {
		let attached = 0;
		replies.playerPromise = Promise.resolve({attachHls: () => { attached++; return {destroy() {}}; }});
		const view = {$type: TYPES.video, playlist: 'https://video.bsky.app/p.m3u8', thumbnail: 'https://video.bsky.app/t.jpg'};
		const card = replies.buildEmbed({uri: 'u', labels: [], embed: view});
		click(card.querySelector(`.${CARD_CLASSES.videoPlay}`));
		replies.destroyPlayers('u');
		await new Promise((resolve) => setImmediate(resolve));
		assert.strictEqual(attached, 0);
		assert.strictEqual(replies.players.size, 0);
	} finally {
		restore();
	}
});

test('動画: attachHls が投げたら札を残さず、再生できない扱いにする', async () => {
	const {replies, restore} = setupEmbed();
	try {
		replies.playerPromise = Promise.resolve({attachHls: () => { throw new Error('hls'); }});
		const view = {$type: TYPES.video, playlist: 'https://video.bsky.app/p.m3u8', thumbnail: 'https://video.bsky.app/t.jpg'};
		const card = replies.buildEmbed({uri: 'u', labels: [], embed: view});
		click(card.querySelector(`.${CARD_CLASSES.videoPlay}`));
		await new Promise((resolve) => setImmediate(resolve));
		assert.strictEqual(replies.players.size, 0);
		assert.strictEqual(card.querySelector('video'), null);
	} finally {
		restore();
	}
});

test('動画: 縦横比の無い動画は compose.video.defaultAspect で枠を取る', () => {
	const {replies, doc, restore} = setupEmbed();
	try {
		// 偽の DOM の要素は style を持たないため、枠の縦横比を読めるよう足す
		const create = doc.createElement.bind(doc);
		doc.createElement = (tag) => {
			const element = create(tag);
			if (!element.style) element.style = {};
			return element;
		};
		const aspect = EXT_CONFIG.lightboxReplies.compose.video.defaultAspect;
		const view = {$type: TYPES.video, playlist: 'https://video.bsky.app/p.m3u8', thumbnail: 'https://video.bsky.app/t.jpg'};
		const card = replies.buildEmbed({uri: 'u', labels: [], embed: view});
		assert.strictEqual(card.style.aspectRatio, `${aspect.width} / ${aspect.height}`);
	} finally {
		restore();
	}
});

/** 返信の連なりを差し込む先の投稿 */
const THREAD_POST = {uri: 'at://did:plc:op/app.bsky.feed.post/P', cid: 'cP'};

/**
 * 送った連なり (3 件) の応答と record を作る。1 件目は投稿への返信、以降は直前の投稿への返信。
 * @returns {{results: Array<{uri: string, cid: string}>, values: Object[]}}
 */
function postedThread() {
	const results = [1, 2, 3].map((n) => ({uri: `at://did:plc:me/app.bsky.feed.post/r${n}`, cid: `c${n}`}));
	const root = {uri: THREAD_POST.uri, cid: THREAD_POST.cid};
	const values = results.map((result, i) => ({
		$type: 'app.bsky.feed.post',
		text: `本文${i + 1}`,
		createdAt: `2026-10-19T00:00:00.00${i}Z`,
		reply: {root, parent: i === 0 ? root : {uri: results[i - 1].uri, cid: results[i - 1].cid}}
	}));
	return {results, values};
}

test('insertOwnReply: 連なりを送った順に入れると、1 件目は 1 段目の先頭、2 件目以降はその中に古い順で入る', async () => {
	const previous = globalThis.document;
	const doc = new FakeDocument();
	globalThis.document = doc;
	const counts = [];
	const replies = new LightboxReplies(EXT_CONFIG.lightboxReplies, {
		actions: {},
		adjustReplyCount: (delta) => counts.push(delta),
		toSegments: (text) => [text],
		buildSegment: (segment) => doc.createTextNode(segment),
		leaveTo: () => {},
		safeHref: () => null,
		formatDate: (iso) => iso
	});
	try {
		replies.sessionDid = 'did:plc:me';
		replies.selfProfile = {did: 'did:plc:me', handle: 'me.example.com', displayName: '自分', avatarUrl: null};
		replies.items = [];
		const list = doc.createElement('ul');
		// 偽の DOM は prepend を持たないため、先頭への差し込みだけを足す
		list.prepend = (node) => list.insertBefore(node, list.childNodes[0] ?? null);
		replies.listEl = list;
		doc.body.append(list);
		const first = {uri: THREAD_POST.uri, cid: THREAD_POST.cid, replyRef: null, isPost: true, anchorUri: null, handle: 'op'};
		const {results, values} = postedThread();
		const targets = chainTargets(first, results, values, 'me.example.com');
		results.forEach((result, i) => {
			replies.insertOwnReply(targets[i], replies.buildOwnItem(result, values[i], targets[i], null), null);
		});
		assert.deepStrictEqual(replies.items.map((item) => item.uri), [results[0].uri]);
		assert.deepStrictEqual(counts, [1]);
		assert.strictEqual(replies.listEl.children.length, 1);
		const branch = replies.branches.get(results[0].uri);
		assert.ok(branch && branch.open, '1 件目の返信の中が開いていない');
		assert.deepStrictEqual(branch.items.map((item) => item.uri), [results[1].uri, results[2].uri]);
		// 1 件目への直接の返信だけを数え、3 件目には「返信先 @自分」が付く
		assert.strictEqual(replies.rows.get(results[0].uri).item.replyCount, 1);
		assert.strictEqual(branch.items[0].parentHandle, null);
		assert.strictEqual(branch.items[1].parentHandle, 'me.example.com');
		assert.strictEqual(replies.rows.get(results[0].uri).area.hidden, false);
	} finally {
		globalThis.document = previous;
	}
});

/**
 * 1 段目の返信 1 件と、その「返信」から開いた返信への返信の入力欄 (偽物) を持つ返信欄を作る。
 * @returns {Object}
 */
function setupRowForm() {
	const previous = globalThis.document;
	const doc = new FakeDocument();
	globalThis.document = doc;
	const replies = new LightboxReplies(EXT_CONFIG.lightboxReplies, {
		actions: {},
		adjustReplyCount: () => {},
		toSegments: (text) => [text],
		buildSegment: (segment) => doc.createTextNode(segment),
		leaveTo: () => {},
		safeHref: () => null,
		formatDate: (iso) => iso
	});
	replies.requestedCanWrite = true;
	replies.sessionDid = 'did:plc:me';
	replies.selfProfile = {did: 'did:plc:me', handle: 'me.example.com', displayName: '自分', avatarUrl: null};
	replies.items = [];
	const list = doc.createElement('ul');
	list.prepend = (node) => list.insertBefore(node, list.childNodes[0] ?? null);
	replies.listEl = list;
	doc.body.append(list);
	const first = {uri: THREAD_POST.uri, cid: THREAD_POST.cid, replyRef: null, isPost: true, anchorUri: null, handle: 'op'};
	const {results, values} = postedThread();
	replies.insertOwnReply(first, replies.buildOwnItem(results[0], values[0], first, null), null);
	const anchorUri = results[0].uri;
	const row = replies.rows.get(anchorUri);
	const toggle = row.body.querySelector(`.${EXT_CONFIG.lightboxReplies.classes.toggle}`);
	toggle.isConnected = true;
	const formEl = doc.createElement('div');
	const input = doc.createElement('textarea');
	input.isConnected = true;
	formEl.append(input);
	row.body.append(formEl);
	// 偽の DOM は外した要素の isConnected を下ろさないため、外すときに自分で下ろす
	const composer = {el: formEl, destroyed: false, destroy() {
		this.destroyed = true;
		this.el.remove();
		input.isConnected = false;
	}};
	replies.composers.add(composer);
	replies.rowForm = {composer, button: toggle};
	const target = {uri: anchorUri, cid: results[0].cid, replyRef: null, isPost: false, anchorUri, handle: 'me.example.com'};
	const child = {uri: 'at://did:plc:me/app.bsky.feed.post/c1', cid: 'cc1'};
	const record = {$type: 'app.bsky.feed.post', text: '返信への返信', createdAt: '2026-10-19T00:00:01.000Z',
		reply: {root: {uri: THREAD_POST.uri, cid: THREAD_POST.cid}, parent: {uri: anchorUri, cid: results[0].cid}}};
	return {doc, replies, composer, input, toggle, insert: () => {
		replies.insertOwnReply(target, replies.buildOwnItem(child, record, target, null), composer);
	}, restore: () => {
		globalThis.document = previous;
	}};
}

test('insertOwnReply: 返信への返信の入力欄から送れたら、入力欄を閉じて押した「返信」ボタンへフォーカスを戻す', () => {
	// 本文の欄から Ctrl+Enter で送った / 送信ボタンが送信中に止まってフォーカスが body へ落ちた
	for (const focused of ['input', 'lost']) {
		const {doc, replies, composer, input, toggle, insert, restore} = setupRowForm();
		try {
			if (focused === 'input') input.focus();
			else doc.activeElement = doc.body;
			insert();
			assert.strictEqual(composer.destroyed, true, focused);
			assert.strictEqual(replies.rowForm, null, focused);
			assert.strictEqual(doc.activeElement, toggle, focused);
		} finally {
			restore();
		}
	}
});

test('insertOwnReply: 送信中に利用者がフォーカスを入力欄の外へ移していたら、送れた後も動かさない', () => {
	const {doc, replies, composer, insert, restore} = setupRowForm();
	try {
		const elsewhere = doc.createElement('button');
		doc.body.append(elsewhere);
		elsewhere.focus();
		insert();
		assert.strictEqual(composer.destroyed, true);
		assert.strictEqual(replies.rowForm, null);
		assert.strictEqual(doc.activeElement, elsewhere);
	} finally {
		restore();
	}
});

/**
 * 一覧の取り直し (reloadList) を試す返信欄を作る。待ち時間は config の写しで短くする
 * (待つ時間は呼んだときに this.config から読むため、写しを渡せば本物のタイマーのまま短くできる)。
 * @param {{delayMs: number, thread: Object|null}} options 待ち時間と、fetchThread が返すスレッド
 * @returns {Object}
 */
function setupReload({delayMs, thread}) {
	const previous = globalThis.document;
	const doc = new FakeDocument();
	globalThis.document = doc;
	const base = EXT_CONFIG.lightboxReplies;
	const config = {...base, compose: {...base.compose, thread: {...base.compose.thread, unconfirmedReloadDelayMs: delayMs}}};
	const fetched = [];
	const replies = new LightboxReplies(config, {
		actions: {fetchThread: async (uri, depth) => {
			fetched.push({uri, depth});
			return thread
				? {ok: true, json: thread, reason: null, status: 200}
				: {ok: false, json: null, reason: 'fetch-failed', status: null};
		}},
		adjustReplyCount: () => {},
		toSegments: (text) => [text],
		buildSegment: (segment) => doc.createTextNode(segment),
		leaveTo: () => {},
		safeHref: () => null,
		formatDate: (iso) => iso
	});
	replies.fetchPublicJson = async () => null;
	replies.sessionDid = 'did:plc:me';
	// 返信数 0 の投稿 (load() なら取りに行かない)
	replies.post = {postUri: 'at://did:plc:op/app.bsky.feed.post/root1', cid: 'c', counts: {reply: 0}, viewer: {}};
	replies.items = [];
	replies.loadState = 'loaded';
	replies.listEl = doc.createElement('ul');
	replies.statusEl = doc.createElement('div');
	replies.moreButton = doc.createElement('button');
	const fake = (el) => ({el, destroyed: false, destroy() {
		this.destroyed = true;
		this.el.remove();
	}});
	replies.formSlot = doc.createElement('div');
	const main = fake(doc.createElement('div'));
	replies.formSlot.append(main.el);
	replies.mainComposer = main;
	replies.composers.add(main);
	const row = fake(doc.createElement('div'));
	replies.composers.add(row);
	replies.rowForm = {composer: row, button: doc.createElement('button')};
	return {replies, fetched, main, row, restore: () => {
		globalThis.document = previous;
	}};
}

/**
 * ms ミリ秒待つ。
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test('reloadList: 待った後に返信数によらず取り直し、一覧だけを描き直す (入力欄は作り直さず、返信への返信の入力欄は閉じる)', async () => {
	const thread = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'get-post-thread-root.json'), 'utf8'));
	const {replies, fetched, main, row, restore} = setupReload({delayMs: 1, thread});
	try {
		await replies.reloadList();
		assert.deepStrictEqual(fetched, [{uri: replies.post.postUri, depth: EXT_CONFIG.lightboxReplies.depth.root}]);
		assert.strictEqual(replies.loadState, 'loaded');
		assert.ok(replies.items.length > 0, '取り直した返信が入っていない');
		assert.strictEqual(replies.listEl.children.length, Math.min(replies.items.length, EXT_CONFIG.lightboxReplies.pageSize));
		assert.strictEqual(replies.mainComposer, main);
		assert.strictEqual(main.destroyed, false);
		assert.strictEqual(main.el.parentNode, replies.formSlot);
		assert.strictEqual(row.destroyed, true);
		assert.strictEqual(replies.rowForm, null);
	} finally {
		restore();
	}
});

test('reloadList: 待っているあいだに世代が変わったら何もしない', async () => {
	const {replies, fetched, row, restore} = setupReload({delayMs: 20, thread: {thread: {replies: []}}});
	try {
		const reloading = replies.reloadList();
		replies.generation += 1;
		await reloading;
		assert.deepStrictEqual(fetched, []);
		assert.strictEqual(row.destroyed, false);
		assert.strictEqual(replies.loadState, 'loaded');
	} finally {
		restore();
	}
});

test('reloadList: 取り直しに失敗したら一覧を読み込めなかった状態にし、入力欄は残す', async () => {
	const {replies, main, restore} = setupReload({delayMs: 1, thread: null});
	try {
		await replies.reloadList();
		assert.strictEqual(replies.loadState, 'error');
		assert.ok(replies.statusEl.textContent.includes(EXT_CONFIG.lightboxReplies.text.error));
		assert.strictEqual(main.destroyed, false);
	} finally {
		restore();
	}
});

test('reloadList: 返信への返信の入力欄に書きかけがあるか送信中なら、取り直さずに入力欄を残す', async () => {
	for (const state of [{draft: true, busy: false}, {draft: false, busy: true}]) {
		const {replies, fetched, row, main, restore} = setupReload({delayMs: 1, thread: {thread: {replies: []}}});
		try {
			row.hasDraft = () => state.draft;
			row.busy = state.busy;
			await replies.reloadList();
			assert.deepStrictEqual(fetched, [], JSON.stringify(state));
			assert.strictEqual(row.destroyed, false);
			assert.ok(replies.rowForm && replies.rowForm.composer === row, '返信への返信の入力欄が閉じられた');
			assert.strictEqual(main.destroyed, false);
		} finally {
			restore();
		}
	}
});
