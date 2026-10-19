import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
	isEmptyPost, splitEmptyPosts, canAddPost, canSubmitThread, chainThreadRecords, chainTargets
} from '../src/content/reply-thread.js';
import {checkThreadWrites} from '../src/inject/page-bridge.js';

const S = (text, contentCount = 0, preparing = false) => ({text, contentCount, preparing});

test('isEmptyPost / splitEmptyPosts: 末尾だけ空・途中に空・全部空', () => {
	assert.strictEqual(isEmptyPost(S('  ')), true);
	assert.strictEqual(isEmptyPost(S('', 1)), false);
	assert.strictEqual(isEmptyPost(S('', 0, true)), false);
	assert.deepStrictEqual(splitEmptyPosts([S('a'), S('b'), S('')]), {indexes: [0, 1], skippedMiddle: false});
	assert.deepStrictEqual(splitEmptyPosts([S('a'), S(' '), S('b')]), {indexes: [0, 2], skippedMiddle: true});
	assert.deepStrictEqual(splitEmptyPosts([S(''), S('a')]), {indexes: [1], skippedMiddle: false});
	assert.deepStrictEqual(splitEmptyPosts([S(''), S('')]), {indexes: [], skippedMiddle: false});
});

test('canAddPost: アクティブが空でなく、次が無いか空でなく、上限未満', () => {
	assert.strictEqual(canAddPost([S('a')], 0, 10), true);
	assert.strictEqual(canAddPost([S('')], 0, 10), false);
	assert.strictEqual(canAddPost([S('a'), S('')], 0, 10), false);
	assert.strictEqual(canAddPost([S('a'), S('b')], 0, 10), true);
	assert.strictEqual(canAddPost(Array.from({length: 10}, () => S('a')), 9, 10), false);
});

test('canSubmitThread: 空でない投稿がすべて ok のときだけ', () => {
	assert.strictEqual(canSubmitThread([{empty: false, ok: true}, {empty: true, ok: false}]), true);
	assert.strictEqual(canSubmitThread([{empty: false, ok: true}, {empty: false, ok: false}]), false);
	assert.strictEqual(canSubmitThread([{empty: true, ok: false}]), false);
});

test('chainThreadRecords: rkey・createdAt・root・parent を連ね、橋渡しの検査を通る', async () => {
	const root = {uri: 'at://did:plc:other/app.bsky.feed.post/3aaaaaaaaaaa2', cid: 'bafyroot'};
	const records = [0, 1, 2].map((i) => ({$type: 'app.bsky.feed.post', text: `t${i}`, createdAt: 'x', langs: ['ja'],
		reply: {root, parent: root}}));
	const rkeys = ['3m2aaaaaaaaa2', '3m2aaaaaaaaa3', '3m2aaaaaaaaa4'];
	const result = await chainThreadRecords(records, {
		repo: 'did:plc:me', collection: 'app.bsky.feed.post', createType: 'com.atproto.repo.applyWrites#create',
		nowMs: Date.UTC(2026, 9, 19), rkeys, computeCid: async (record) => `cid-${record.text}`
	});
	assert.deepStrictEqual(result.refs.map((ref) => ref.uri), rkeys.map((rk) => `at://did:plc:me/app.bsky.feed.post/${rk}`));
	assert.deepStrictEqual(result.writes[2].value.reply, {root, parent: {uri: result.refs[1].uri, cid: 'cid-t1'}});
	assert.deepStrictEqual(result.writes.map((w) => w.value.createdAt),
		['2026-10-19T00:00:00.000Z', '2026-10-19T00:00:00.001Z', '2026-10-19T00:00:00.002Z']);
	assert.strictEqual(records[1].createdAt, 'x');
	assert.strictEqual(records[1].reply.parent, root);
	assert.strictEqual(checkThreadWrites(result.writes, 'did:plc:me').ok, true);
});

test('chainTargets: 投稿への返信は 1 件目が 1 段目、以降はその中。返信への返信は同じ anchor', () => {
	const results = [{uri: 'at://me/p/1', cid: 'c1'}, {uri: 'at://me/p/2', cid: 'c2'}, {uri: 'at://me/p/3', cid: 'c3'}];
	const records = results.map((r, i) => ({reply: {root: {uri: 'R'}, parent: {uri: `P${i}`}}}));
	const toPost = chainTargets({uri: 'R', cid: 'r', replyRef: null, isPost: true, anchorUri: null, handle: 'a'}, results, records, 'me.bsky');
	assert.deepStrictEqual(toPost.map((t) => [t.uri, t.isPost, t.anchorUri, t.handle]),
		[['R', true, null, 'a'], ['at://me/p/1', false, 'at://me/p/1', 'me.bsky'], ['at://me/p/2', false, 'at://me/p/1', 'me.bsky']]);
	assert.strictEqual(toPost[1].replyRef, records[0].reply);
	const toReply = chainTargets({uri: 'X', cid: 'x', replyRef: {}, isPost: false, anchorUri: 'A', handle: 'b'}, results, records, null);
	assert.deepStrictEqual(toReply.map((t) => t.anchorUri), ['A', 'A', 'A']);
});
