/**
 * lightbox-replies.js のうち偽の DOM で試せる部分。返信への返信の入力欄の後始末を確かめる。
 */

import test from 'node:test';
import assert from 'node:assert';

import {EXT_CONFIG} from '../src/common/config.js';
import {FakeDocument, FakeEvent, click} from './helpers/fake-dom.js';
import {LightboxReplies} from '../src/content/lightbox-replies.js';

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

test('buildEmbed: recordWithMedia#view は画像の格子の下に引用カード、video#view は「添付あり」', () => {
	const {replies, restore} = setupEmbed();
	try {
		const both = replies.buildEmbed({uri: 'u', labels: [], embed: {
			$type: TYPES.recordWithMedia, media: IMAGES_VIEW, record: QUOTE_VIEW
		}});
		const kids = both.children;
		assert.strictEqual(kids.length, 2);
		assert.strictEqual(kids[0].className, EXT_CONFIG.lightboxReplies.classes.media);
		assert.ok([kids[1], ...kids[1].descendants()].some((n) => n.className === CARD_CLASSES.quote));

		const video = replies.buildEmbed({uri: 'u', labels: [], embed: {$type: TYPES.video}});
		assert.strictEqual(video.className, EXT_CONFIG.lightboxReplies.classes.embed);
		assert.strictEqual(video.textContent, EXT_CONFIG.lightboxReplies.text.hasEmbed);
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
