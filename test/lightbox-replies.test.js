/**
 * lightbox-replies.js のうち偽の DOM で試せる部分。返信への返信の入力欄の後始末を確かめる。
 */

import test from 'node:test';
import assert from 'node:assert';

import {EXT_CONFIG} from '../src/common/config.js';
import {FakeDocument} from './helpers/fake-dom.js';
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
