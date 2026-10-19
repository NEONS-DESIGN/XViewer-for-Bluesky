/**
 * ライトボックスの取得の回数を減らす仕組み (返信欄が一覧を受け取る・畳んでも中身を残す・
 * 見つからない投稿で公開 API に行かない・結果を覚える・開き直しの手がかり) と、
 * パネルの反応の結果の重ね描き・書きかけがあるときの移動の聞き返し。
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import {EXT_CONFIG} from '../src/common/config.js';
import {FakeDocument} from './helpers/fake-dom.js';
import {LightboxReplies} from '../src/content/lightbox-replies.js';
import {LightboxPanel, buildPendingKey, actionOwnerDid} from '../src/content/lightbox-panel.js';
import {isMaybeWritten, toCount} from '../src/content/post-actions.js';

const ROOT_FIXTURE = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'get-post-thread-root.json'), 'utf8'));
const POST_URI = 'at://did:plc:op/app.bsky.feed.post/root1';
const THREAD_TYPE = 'app.bsky.feed.defs#threadViewPost';

/**
 * 偽の document を置いて返信欄を作る。
 * @param {Object} actions host.actions
 * @returns {{replies: LightboxReplies, doc: FakeDocument, publicCalls: Array, restore: () => void}}
 */
function setup(actions) {
	const previous = globalThis.document;
	const doc = new FakeDocument();
	globalThis.document = doc;
	const publicCalls = [];
	const replies = new LightboxReplies(EXT_CONFIG.lightboxReplies, {
		actions,
		adjustReplyCount: () => {},
		toSegments: (text) => [text],
		buildSegment: (segment) => doc.createTextNode(segment),
		leaveTo: () => {},
		safeHref: () => null,
		formatDate: (iso) => iso
	});
	replies.fetchPublicJson = async (apiPath, params) => {
		publicCalls.push({apiPath, params});
		return null;
	};
	return {replies, doc, publicCalls, restore: () => {
		globalThis.document = previous;
	}};
}

test('fetchThread: 認証付きが見つからない (400) と答えたら公開 API に行かない', async () => {
	const {replies, publicCalls, restore} = setup({
		fetchThread: async () => ({ok: false, json: null, reason: 'http-error', status: 400})
	});
	try {
		assert.deepStrictEqual(await replies.fetchThread(POST_URI, 1), {json: null, fromPublic: false, notFound: true});
		assert.strictEqual(publicCalls.length, 0);
	} finally {
		restore();
	}
});

test('fetchThread: 認証付きが使えないときだけ公開 API に落ちる', async () => {
	const {replies, publicCalls, restore} = setup({
		fetchThread: async () => ({ok: false, json: null, reason: 'no-agent', status: null})
	});
	try {
		const result = await replies.fetchThread(POST_URI, 1);
		assert.strictEqual(result.notFound, false);
		assert.strictEqual(publicCalls.length, 1);
		assert.deepStrictEqual(publicCalls[0].params, {uri: POST_URI, depth: 1, parentHeight: 0});
	} finally {
		restore();
	}
});

test('load: パネルが一緒に読んだ一覧があれば引かずに使う', async () => {
	let fetched = 0;
	const {replies, publicCalls, restore} = setup({
		fetchThread: async () => {
			fetched += 1;
			return {ok: false, json: null, reason: 'x', status: null};
		}
	});
	try {
		replies.post = {postUri: POST_URI, counts: {reply: 5}, viewer: {}};
		replies.sessionPromise = Promise.resolve();
		await replies.load({json: ROOT_FIXTURE, fromPublic: false, notFound: false});
		assert.strictEqual(fetched, 0);
		assert.strictEqual(publicCalls.length, 0);
		assert.strictEqual(replies.loadState, 'loaded');
		assert.ok(replies.items.length > 0);
	} finally {
		restore();
	}
});

test('toggleBranch: 畳んでも中身を残し、開き直しても引き直さない。失敗していたら引き直す', async () => {
	const anchor = 'at://did:plc:a/app.bsky.feed.post/A';
	let fetched = 0;
	const {replies, restore} = setup({
		fetchThread: async () => {
			fetched += 1;
			return {ok: true, json: {thread: {$type: THREAD_TYPE, post: {uri: anchor}, replies: []}}, reason: null, status: 200};
		}
	});
	try {
		replies.toggleBranch(anchor);
		await new Promise((resolve) => setImmediate(resolve));
		assert.strictEqual(fetched, 1);
		const branch = replies.branches.get(anchor);
		assert.deepStrictEqual(branch.items, []);
		assert.ok(branch.node, '読んだノードを覚えていない');
		replies.toggleBranch(anchor);
		assert.strictEqual(replies.branches.get(anchor).open, false);
		replies.toggleBranch(anchor);
		assert.strictEqual(replies.branches.get(anchor).open, true);
		assert.strictEqual(fetched, 1);
		// 失敗した中身は開き直すときに引き直す
		replies.branches.get(anchor).error = true;
		replies.toggleBranch(anchor);
		replies.toggleBranch(anchor);
		await new Promise((resolve) => setImmediate(resolve));
		assert.strictEqual(fetched, 2);
	} finally {
		restore();
	}
});

test('seedFor: 中を読んだ返信は一覧ごと、返信 0 件は空の一覧、読んでいない返信は投稿だけを渡す', () => {
	const {replies, restore} = setup({});
	try {
		const view = {uri: 'at://did:plc:b/app.bsky.feed.post/B', replyCount: 3};
		const shallow = {uri: view.uri, node: {$type: THREAD_TYPE, post: view}};
		assert.deepStrictEqual(replies.seedFor(shallow), {view, thread: null});
		const loaded = {$type: THREAD_TYPE, post: view, replies: []};
		replies.branches.set(view.uri, {open: false, items: [], shown: 0, node: loaded});
		assert.deepStrictEqual(replies.seedFor(shallow).thread.json, {thread: loaded});
		const empty = {uri: 'at://did:plc:b/app.bsky.feed.post/C', node: {$type: THREAD_TYPE, post: {replyCount: 0}}};
		assert.deepStrictEqual(replies.seedFor(empty).thread.json.thread.replies, []);
		assert.strictEqual(replies.seedFor({uri: 'x'}), null);
	} finally {
		restore();
	}
});

test('resolveHandle と引用の取得は同じ値で 2 回引かない。引用は閉じたら (destroy) 忘れる', async () => {
	let posts = 0;
	const {replies, publicCalls, restore} = setup({
		fetchPost: async () => {
			posts += 1;
			return {posts: [{}]};
		}
	});
	try {
		replies.fetchPublicJson = async (apiPath, params) => {
			publicCalls.push(params);
			return {did: 'did:plc:x'};
		};
		assert.strictEqual(await replies.resolveHandle('Alice.example.com'), 'did:plc:x');
		assert.strictEqual(await replies.resolveHandle('alice.example.com'), 'did:plc:x');
		assert.strictEqual(publicCalls.length, 1);
		const load = () => replies.quoteCache.get('q', () => replies.host.actions.fetchPost('q'));
		await load();
		await load();
		assert.strictEqual(posts, 1);
		replies.destroy();
		await load();
		assert.strictEqual(posts, 2);
	} finally {
		restore();
	}
});

test('isMaybeWritten: 打ち切り・回線切れ・5xx は書けているかもしれない', () => {
	assert.strictEqual(isMaybeWritten({reason: 'timeout', status: null}), true);
	assert.strictEqual(isMaybeWritten({reason: 'fetch-failed', status: null}), true);
	assert.strictEqual(isMaybeWritten({reason: 'http-error', status: 502}), true);
	assert.strictEqual(isMaybeWritten({reason: 'http-error', status: 400}), false);
	assert.strictEqual(isMaybeWritten({reason: 'repo-not-self', status: null}), false);
	assert.strictEqual(toCount(3.7), 3);
	assert.strictEqual(toCount(-1), 0);
});

/**
 * パネルを作る (DOM は使わない)。
 * @returns {LightboxPanel}
 */
function makePanel() {
	return new LightboxPanel(EXT_CONFIG.lightboxPanel);
}

test('applyShadows: 自分の反応の結果を期限のあいだだけ引き直した投稿に重ねる', () => {
	const panel = makePanel();
	panel.actions.sessionDid = 'did:plc:me';
	const postUri = POST_URI;
	const state = {liked: true, likeUri: 'at://did:plc:me/app.bsky.feed.like/1', reposted: false, repostUri: null,
		bookmarked: false, counts: {reply: 0, repost: 0, like: 4, quote: 0}};
	panel.shadows.set(buildPendingKey(postUri, 'like', EXT_CONFIG.postActions), {kind: 'like', state, did: 'did:plc:me', at: Date.now()});
	const post = {postUri, viewer: {like: undefined}, counts: {reply: 0, repost: 0, like: 3, quote: 0}, raw: {viewer: {}}};
	panel.applyShadows(post);
	assert.strictEqual(post.viewer.like, state.likeUri);
	assert.strictEqual(post.counts.like, 4);
	// 別のアカウントで付けた反応は重ねない
	panel.actions.sessionDid = 'did:plc:other';
	const other = {postUri, viewer: {}, counts: {reply: 0, repost: 0, like: 3, quote: 0}, raw: {viewer: {}}};
	panel.applyShadows(other);
	assert.strictEqual(other.viewer.like, undefined);
	panel.actions.sessionDid = 'did:plc:me';
	// 期限を過ぎたものは重ねずに捨てる
	panel.shadows.set(buildPendingKey(postUri, 'like', EXT_CONFIG.postActions), {
		kind: 'like', state, did: 'did:plc:me', at: Date.now() - EXT_CONFIG.lightboxPanel.actionShadowMs - 1
	});
	const fresh = {postUri, viewer: {}, counts: {reply: 0, repost: 0, like: 3, quote: 0}, raw: {viewer: {}}};
	panel.applyShadows(fresh);
	assert.strictEqual(fresh.viewer.like, undefined);
	assert.strictEqual(panel.shadows.size, 0);
});

test('confirmLeave: 書きかけがあれば 1 回目は止め、同じ先をもう一度押すと通す', () => {
	const panel = makePanel();
	const shown = [];
	panel.showActionError = (message) => shown.push(message);
	panel.repliesEnabled = true;
	panel.replies.readKeyState = () => ({hasDraft: true, confirming: false});
	assert.strictEqual(panel.confirmLeave('a'), false);
	assert.deepStrictEqual(shown, [EXT_CONFIG.lightboxPanel.text.leaveDraft]);
	assert.strictEqual(panel.confirmLeave('b'), false);
	assert.strictEqual(panel.confirmLeave('b'), true);
	panel.replies.readKeyState = () => ({hasDraft: false, confirming: false});
	assert.strictEqual(panel.confirmLeave('c'), true);
});

test('takeSeed: postUri が合うときだけ使い、どちらでも消す', () => {
	const panel = makePanel();
	panel.seed = {postUri: 'a', view: {}, thread: null};
	assert.strictEqual(panel.takeSeed('b'), null);
	assert.strictEqual(panel.seed, null);
	panel.seed = {postUri: 'a', view: {}, thread: null};
	assert.ok(panel.takeSeed('a'));
});

test('loadPost: 投稿と返信の一覧を getPostThread の 1 回で読み、返信欄が OFF なら depth 0', async () => {
	const panel = makePanel();
	const calls = [];
	const view = {
		uri: POST_URI, cid: 'c', author: {did: 'did:plc:op', handle: 'op.example.com'},
		record: {text: '本文'}, viewer: {}
	};
	panel.replies.fetchThread = async (uri, depth) => {
		calls.push(depth);
		return {json: {thread: {$type: THREAD_TYPE, post: view, replies: []}}, fromPublic: false, notFound: false};
	};
	panel.fetchPost = async () => {
		throw new Error('getPosts に落ちてはいけない');
	};
	panel.repliesEnabled = true;
	const loaded = await panel.loadPost(POST_URI);
	assert.strictEqual(loaded.post.postUri, POST_URI);
	assert.ok(loaded.thread);
	panel.repliesEnabled = false;
	const postOnly = await panel.loadPost(POST_URI);
	assert.strictEqual(postOnly.thread, null);
	assert.deepStrictEqual(calls, [EXT_CONFIG.lightboxReplies.depth.root, 0]);
});

test('loadPost: スレッドとして読めなければ getPosts に落ち、見つからないと分かれば落ちない', async () => {
	const panel = makePanel();
	let fallbacks = 0;
	panel.fetchPost = async () => {
		fallbacks += 1;
		return null;
	};
	panel.replies.fetchThread = async () => ({json: {thread: {$type: 'app.bsky.feed.defs#blockedPost'}}, fromPublic: false, notFound: false});
	assert.strictEqual(await panel.loadPost(POST_URI), null);
	assert.strictEqual(fallbacks, 1);
	panel.replies.fetchThread = async () => ({json: null, fromPublic: false, notFound: true});
	assert.strictEqual(await panel.loadPost(POST_URI), null);
	assert.strictEqual(fallbacks, 1);
});

test('actionOwnerDid: いいね・リポストはレコードの持ち主、ブックマークは押した時点の DID', () => {
	const empty = {likeUri: null, repostUri: null};
	assert.strictEqual(actionOwnerDid('like', empty, {likeUri: 'at://did:plc:new/app.bsky.feed.like/1'}, 'did:plc:old'), 'did:plc:new');
	assert.strictEqual(actionOwnerDid('repost', {likeUri: null, repostUri: 'at://did:plc:a/app.bsky.feed.repost/1'}, empty, 'did:plc:b'), 'did:plc:a');
	assert.strictEqual(actionOwnerDid('like', empty, empty, 'did:plc:p'), 'did:plc:p');
	assert.strictEqual(actionOwnerDid('bookmark', empty, empty, 'did:plc:p'), 'did:plc:p');
});

test('loadPost: 公開 API のスレッドに落ちたら、viewer だけ認証付きの getPosts で取り直す', async () => {
	const panel = makePanel();
	const view = {uri: POST_URI, cid: 'c', author: {did: 'did:plc:op', handle: 'op.example.com'}, record: {text: 'x'}};
	panel.replies.fetchThread = async () => ({json: {thread: {$type: THREAD_TYPE, post: view, replies: []}}, fromPublic: true, notFound: false});
	panel.actions.fetchPost = async () => ({posts: [{...view, viewer: {like: null}}]});
	panel.repliesEnabled = true;
	const loaded = await panel.loadPost(POST_URI);
	assert.ok(loaded.post.viewer, 'viewer を取り直していない');
	assert.ok(loaded.thread);
});
