/**
 * page-bridge.js の白名簿の検査。
 * **この検査が橋渡しの唯一の関門である。** ext:bridge-request は document 上の
 * CustomEvent で、bsky.app 上で動く誰でも撃てるため、ここが緩むと
 * 「本体のセッションで任意の XRPC を呼べる穴」になる。
 * React fiber の走査・実通信・DOM は対象外 (実機で確認する)。
 */

import test from 'node:test';
import assert from 'node:assert';

import {EXT_CONFIG} from '../src/common/config.js';
import {BRIDGE_PROTOCOL} from '../src/common/bridge-protocol.js';
import {
	EXT_BRIDGE, checkXrpcRequest, checkThreadWrites, checkPostRecord, checkPostEmbed, checkSelfLabels, isReplyPostResponse, buildQuery,
	waitForLightboxHistory, toBlobRef, checkUploadBlob, checkUploadVideo, isBlobRef, BlobInbox, readBlobMessage, toProgressDetail, truncateMessage,
	createVideoDeps, uploadVideoAction, cancelUploadVideo, setBlobInboxForTest
} from '../src/inject/page-bridge.js';
import {VIDEO_UPLOAD} from '../src/inject/video-upload.js';
import {buildPostEmbed} from '../src/content/reply-embed.js';
import {buildReplyRecord} from '../src/content/reply-text.js';
import {buildGifExternal} from '../src/content/klipy.js';

/** 検査に使う自分の DID */
const SELF_DID = 'did:plc:self0000000000000000000';

test('checkXrpcRequest: 白名簿の読み取りは通る', () => {
	const result = checkXrpcRequest(
		{nsid: 'app.bsky.feed.getPosts', params: {uris: ['at://x']}},
		SELF_DID
	);
	assert.strictEqual(result.ok, true);
	assert.strictEqual(result.rule.target, 'appview');
	assert.strictEqual(result.rule.method, 'GET');
});

test('checkXrpcRequest: 白名簿に無い NSID は落ちる', () => {
	const result = checkXrpcRequest({nsid: 'com.atproto.repo.putRecord'}, SELF_DID);
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.reason, 'nsid-not-allowed');
});

test('checkXrpcRequest: フォローの作成は NSID が通っても collection で落ちる', () => {
	const result = checkXrpcRequest({
		nsid: 'com.atproto.repo.createRecord',
		body: {repo: SELF_DID, collection: 'app.bsky.graph.follow', record: {}}
	}, SELF_DID);
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.reason, 'collection-not-allowed');
});

/** 返信の作成に使う、検査を通る形の record を作る */
function replyRecord(overrides) {
	return Object.assign({
		$type: 'app.bsky.feed.post',
		text: 'a',
		createdAt: '2026-10-18T00:00:00.000Z',
		reply: {
			root: {uri: 'at://did:plc:a/app.bsky.feed.post/1', cid: 'c1'},
			parent: {uri: 'at://did:plc:a/app.bsky.feed.post/2', cid: 'c2'}
		}
	}, overrides);
}

/** 投稿の作成を検査にかける */
function checkPostCreate(record, did) {
	return checkXrpcRequest({
		nsid: 'com.atproto.repo.createRecord',
		body: {repo: did === undefined ? SELF_DID : did, collection: 'app.bsky.feed.post', record}
	}, SELF_DID);
}

test('checkXrpcRequest: 返信でない投稿の作成は落ちる', () => {
	const result = checkPostCreate({
		$type: 'app.bsky.feed.post', text: 'a', createdAt: '2026-10-18T00:00:00.000Z'
	});
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.reason, 'post-not-reply');
});

test('checkXrpcRequest: 返信の作成は通り、record はそのまま写される', () => {
	const record = replyRecord({langs: ['ja'], facets: []});
	const result = checkPostCreate(record);
	assert.strictEqual(result.ok, true);
	assert.strictEqual(result.rule.target, 'pds');
	assert.deepStrictEqual(result.body.record, record);
	assert.strictEqual(result.needsReplyCheck, false);
});

test('checkXrpcRequest: 形の欠けた embed (external の中身が無い) を持つ投稿は落ちる', () => {
	const result = checkPostCreate(replyRecord({embed: {$type: 'app.bsky.embed.external'}}));
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.reason, 'post-record-not-allowed');
});

/** 検査を通る BlobRef を作る */
function blobRef(overrides) {
	return Object.assign({
		$type: 'blob', ref: {$link: 'bafkreiabc'}, mimeType: 'image/jpeg', size: 1234
	}, overrides);
}

/** 検査を通る images の embed を count 枚で作る */
function imagesEmbed(count) {
	const images = [];
	for (let i = 0; i < count; i += 1) {
		images.push({image: blobRef(), alt: 'alt'});
	}
	return {$type: 'app.bsky.embed.images', images};
}

/** 検査を通る gallery の embed を count 件で作る */
function galleryEmbed(count) {
	const items = [];
	for (let i = 0; i < count; i += 1) {
		items.push({
			$type: 'app.bsky.embed.gallery#image',
			image: blobRef(), alt: 'alt', aspectRatio: {width: 4, height: 3}
		});
	}
	return {$type: 'app.bsky.embed.gallery', items};
}

test('checkPostEmbed: 画像 1〜4 枚の images は通り、5 枚は落ちる', () => {
	for (let i = 1; i <= 4; i += 1) {
		assert.strictEqual(checkPostEmbed(imagesEmbed(i)), true);
	}
	assert.strictEqual(checkPostEmbed(imagesEmbed(5)), false);
	assert.strictEqual(checkPostEmbed(imagesEmbed(0)), false);
	const withRatio = imagesEmbed(1);
	withRatio.images[0].aspectRatio = {width: 1, height: 1};
	assert.strictEqual(checkPostEmbed(withRatio), true);
	withRatio.images[0].aspectRatio = {width: 0, height: 1};
	assert.strictEqual(checkPostEmbed(withRatio), false);
});

test('checkPostEmbed: gallery は 1〜10 件で通り、11 件・aspectRatio 無し・item の $type 違いは落ちる', () => {
	assert.strictEqual(checkPostEmbed(galleryEmbed(1)), true);
	assert.strictEqual(checkPostEmbed(galleryEmbed(10)), true);
	assert.strictEqual(checkPostEmbed(galleryEmbed(11)), false);
	assert.strictEqual(checkPostEmbed(galleryEmbed(0)), false);
	const noRatio = galleryEmbed(1);
	delete noRatio.items[0].aspectRatio;
	assert.strictEqual(checkPostEmbed(noRatio), false);
	const badType = galleryEmbed(1);
	badType.items[0].$type = 'app.bsky.embed.images#image';
	assert.strictEqual(checkPostEmbed(badType), false);
});

test('checkPostEmbed: ALT 文はちょうど 2000 書記素で通り、2001 で落ちる', () => {
	const embed = imagesEmbed(1);
	embed.images[0].alt = '👍'.repeat(2000);
	assert.strictEqual(checkPostEmbed(embed), true);
	embed.images[0].alt = '👍'.repeat(2001);
	assert.strictEqual(checkPostEmbed(embed), false);
	embed.images[0].alt = 123;
	assert.strictEqual(checkPostEmbed(embed), false);
});

test('checkPostEmbed: blob の参照が崩れたもの・mimeType が text/vtt のもの・余分なキーは落ちる', () => {
	const broken = imagesEmbed(1);
	broken.images[0].image = blobRef({ref: {}});
	assert.strictEqual(checkPostEmbed(broken), false);
	const vtt = imagesEmbed(1);
	vtt.images[0].image = blobRef({mimeType: 'text/vtt'});
	assert.strictEqual(checkPostEmbed(vtt), false);
	const extraEmbed = imagesEmbed(1);
	extraEmbed.extra = 1;
	assert.strictEqual(checkPostEmbed(extraEmbed), false);
	const extraImage = imagesEmbed(1);
	extraImage.images[0].extra = 1;
	assert.strictEqual(checkPostEmbed(extraImage), false);
	const extraItem = galleryEmbed(1);
	extraItem.items[0].extra = 1;
	assert.strictEqual(checkPostEmbed(extraItem), false);
	assert.strictEqual(checkPostEmbed(null), false);
	assert.strictEqual(checkPostEmbed('x'), false);
});

test('checkPostEmbed: blob の余分なキー (blob 直下・ref の中) は落ち、size は 2000000 までが通る', () => {
	const top = imagesEmbed(1);
	top.images[0].image = blobRef({extra: 'x'});
	assert.strictEqual(checkPostEmbed(top), false);
	const inner = imagesEmbed(1);
	inner.images[0].image = blobRef({ref: {$link: 'x', junk: {}}});
	assert.strictEqual(checkPostEmbed(inner), false);
	const edge = imagesEmbed(1);
	edge.images[0].image = blobRef({size: 2000000});
	assert.strictEqual(checkPostEmbed(edge), true);
	edge.images[0].image = blobRef({size: 2000001});
	assert.strictEqual(checkPostEmbed(edge), false);
});

test('checkPostEmbed: 複数コードポイントの書記素も 1 つと数える', () => {
	for (const unit of ['👍🏽', '👨‍👩‍👧']) {
		const embed = imagesEmbed(1);
		embed.images[0].alt = unit.repeat(2000);
		assert.strictEqual(checkPostEmbed(embed), true);
		embed.images[0].alt = unit.repeat(2001);
		assert.strictEqual(checkPostEmbed(embed), false);
	}
});

test('checkPostEmbed: gallery 直下の余分なキーと小数の aspectRatio は落ちる', () => {
	const extra = galleryEmbed(1);
	extra.extra = 1;
	assert.strictEqual(checkPostEmbed(extra), false);
	const fraction = galleryEmbed(1);
	fraction.items[0].aspectRatio = {width: 1.5, height: 1};
	assert.strictEqual(checkPostEmbed(fraction), false);
});

test('checkSelfLabels: 重複・labels 直下の余分なキーは落ち、nudity 単独は通る', () => {
	const type = 'com.atproto.label.defs#selfLabels';
	assert.strictEqual(checkSelfLabels({$type: type, values: [{val: 'porn'}, {val: 'porn'}]}), false);
	assert.strictEqual(checkSelfLabels({$type: type, values: [{val: 'nudity'}]}), true);
	assert.strictEqual(checkSelfLabels({$type: type, values: [{val: 'porn'}], extra: 1}), false);
});

test('checkSelfLabels: 成人向け 1 つ + graphic-media は通り、成人向け 2 つ・未知の値・3 つ・$type 違いは落ちる', () => {
	const make = (vals, type) => ({
		$type: type || 'com.atproto.label.defs#selfLabels',
		values: vals.map((val) => ({val}))
	});
	assert.strictEqual(checkSelfLabels(make(['porn'])), true);
	assert.strictEqual(checkSelfLabels(make(['graphic-media'])), true);
	assert.strictEqual(checkSelfLabels(make(['sexual', 'graphic-media'])), true);
	assert.strictEqual(checkSelfLabels(make(['sexual', 'porn'])), false);
	assert.strictEqual(checkSelfLabels(make(['spam'])), false);
	assert.strictEqual(checkSelfLabels(make(['sexual', 'graphic-media', 'nudity'])), false);
	assert.strictEqual(checkSelfLabels(make(['porn'], 'x#y')), false);
	assert.strictEqual(checkSelfLabels(make([])), false);
	assert.strictEqual(checkSelfLabels({
		$type: 'com.atproto.label.defs#selfLabels', values: [{val: 'porn', extra: 1}]
	}), false);
});

test('checkXrpcRequest: 画像とラベル付きの返信は通り、record がそのまま写される', () => {
	const record = replyRecord({
		embed: imagesEmbed(2),
		labels: {$type: 'com.atproto.label.defs#selfLabels', values: [{val: 'porn'}]}
	});
	const result = checkPostCreate(record);
	assert.strictEqual(result.ok, true);
	assert.deepStrictEqual(result.body.record, record);
});

test('checkXrpcRequest: 画像付きでも reply の無い投稿は落ちる', () => {
	const result = checkPostCreate({
		$type: 'app.bsky.feed.post', text: 'a', createdAt: '2026-10-18T00:00:00.000Z',
		embed: imagesEmbed(1)
	});
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.reason, 'post-not-reply');
});

test('checkXrpcRequest: 本文が 3000 バイトを超える投稿は落ち、ちょうど 3000 バイトは通る', () => {
	const over = checkPostCreate(replyRecord({text: 'あ'.repeat(1001)}));
	assert.strictEqual(over.ok, false);
	assert.strictEqual(over.reason, 'post-record-not-allowed');
	assert.strictEqual(checkPostCreate(replyRecord({text: 'a'.repeat(3000)})).ok, true);
});

test('checkXrpcRequest: reply の形が崩れた投稿は落ちる', () => {
	const root = {uri: 'at://did:plc:a/app.bsky.feed.post/1', cid: 'c1'};
	const parent = {uri: 'at://did:plc:a/app.bsky.feed.post/2', cid: 'c2'};
	const broken = [
		{root, parent: {uri: 'https://bsky.app/profile/a/post/2', cid: 'c2'}},
		{root: {uri: root.uri, cid: 1}, parent},
		{root},
		{root, parent: {uri: 'at://did:plc:a/app.bsky.feed.like/2', cid: 'c2'}},
		'x'
	];
	for (const reply of broken) {
		const result = checkPostCreate(replyRecord({reply}));
		assert.strictEqual(result.ok, false, JSON.stringify(reply));
		assert.strictEqual(result.reason, 'post-not-reply');
	}
});

test('checkXrpcRequest: langs と facets の形が崩れた投稿は落ちる', () => {
	const cases = [
		{langs: ['ja', 'en', 'fr', 'de']},
		{langs: ['ja', 1]},
		{langs: 'ja'},
		{facets: {}},
		{text: 1},
		{createdAt: 1}
	];
	for (const overrides of cases) {
		const result = checkPostCreate(replyRecord(overrides));
		assert.strictEqual(result.ok, false, JSON.stringify(overrides));
		assert.strictEqual(result.reason, 'post-record-not-allowed');
	}
});

test('checkXrpcRequest: 他人の repo への返信の作成は落ちる', () => {
	const result = checkPostCreate(replyRecord(), 'did:plc:someoneelse');
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.reason, 'repo-not-self');
});

test('checkXrpcRequest: 投稿の削除は返信であるかの事前確認を求め、いいねの削除は求めない', () => {
	const post = checkXrpcRequest({
		nsid: 'com.atproto.repo.deleteRecord',
		body: {repo: SELF_DID, collection: 'app.bsky.feed.post', rkey: 'abc'}
	}, SELF_DID);
	assert.strictEqual(post.ok, true);
	assert.strictEqual(post.needsReplyCheck, true);
	const like = checkXrpcRequest({
		nsid: 'com.atproto.repo.deleteRecord',
		body: {repo: SELF_DID, collection: 'app.bsky.feed.like', rkey: 'abc'}
	}, SELF_DID);
	assert.strictEqual(like.ok, true);
	assert.strictEqual(like.needsReplyCheck, false);
});

test('checkXrpcRequest: getPostThread の読み取りは appview へ通る', () => {
	const result = checkXrpcRequest({
		nsid: 'app.bsky.feed.getPostThread',
		params: {uri: 'at://x', depth: 1, parentHeight: 0}
	}, SELF_DID);
	assert.strictEqual(result.ok, true);
	assert.strictEqual(result.rule.target, 'appview');
	assert.strictEqual(result.rule.method, 'GET');
});

test('checkPostRecord: 返信の record だけを通す', () => {
	assert.deepStrictEqual(checkPostRecord(replyRecord()), {ok: true});
	assert.strictEqual(checkPostRecord(null).ok, false);
	assert.strictEqual(checkPostRecord(replyRecord({reply: undefined})).reason, 'post-not-reply');
});

test('isReplyPostResponse: 指定の URI の投稿が返信であるときだけ真', () => {
	const uri = 'at://did:plc:self/app.bsky.feed.post/abc';
	const reply = {root: {uri: 'at://r', cid: 'r'}, parent: {uri: 'at://p', cid: 'p'}};
	assert.strictEqual(isReplyPostResponse({posts: [{uri, record: {reply}}]}, uri), true);
	assert.strictEqual(isReplyPostResponse({posts: [{uri, record: {text: 'x'}}]}, uri), false);
	assert.strictEqual(isReplyPostResponse({posts: []}, uri), false);
	assert.strictEqual(
		isReplyPostResponse({posts: [{uri: 'at://did:plc:self/app.bsky.feed.post/other', record: {reply}}]}, uri),
		false
	);
	assert.strictEqual(isReplyPostResponse(null, uri), false);
	assert.strictEqual(isReplyPostResponse({posts: [{uri, record: {reply: 'x'}}]}, uri), false);
});

test('checkXrpcRequest: 他人の repo への書き込みは落ちる', () => {
	const result = checkXrpcRequest({
		nsid: 'com.atproto.repo.createRecord',
		body: {repo: 'did:plc:someoneelse', collection: 'app.bsky.feed.like', record: {}}
	}, SELF_DID);
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.reason, 'repo-not-self');
});

test('checkXrpcRequest: 自分の repo へのいいねは通り、body は白名簿のキーだけに組み直される', () => {
	const record = {$type: 'app.bsky.feed.like', subject: {uri: 'at://x', cid: 'c'}};
	const result = checkXrpcRequest({
		nsid: 'com.atproto.repo.createRecord',
		body: {repo: SELF_DID, collection: 'app.bsky.feed.like', record, validate: false}
	}, SELF_DID);
	assert.strictEqual(result.ok, true);
	assert.strictEqual(result.rule.target, 'pds');
	assert.strictEqual(result.rule.method, 'POST');
	assert.deepStrictEqual(result.body, {repo: SELF_DID, collection: 'app.bsky.feed.like', record});
});

test('checkXrpcRequest: record.$type が collection と違えば落ちる ($type 無しも同じ)', () => {
	const mismatch = checkXrpcRequest({
		nsid: 'com.atproto.repo.createRecord',
		body: {repo: SELF_DID, collection: 'app.bsky.feed.like',
			record: {$type: 'app.bsky.feed.post', text: 'x'}}
	}, SELF_DID);
	assert.strictEqual(mismatch.ok, false);
	assert.strictEqual(mismatch.reason, 'record-type-mismatch');
	const untyped = checkXrpcRequest({
		nsid: 'com.atproto.repo.createRecord',
		body: {repo: SELF_DID, collection: 'app.bsky.feed.like', record: {}}
	}, SELF_DID);
	assert.strictEqual(untyped.ok, false);
	assert.strictEqual(untyped.reason, 'record-type-mismatch');
});

test('checkXrpcRequest: deleteRecord は rkey が文字列でなければ落ち、通れば rkey まで写す', () => {
	const missing = checkXrpcRequest({
		nsid: 'com.atproto.repo.deleteRecord',
		body: {repo: SELF_DID, collection: 'app.bsky.feed.like'}
	}, SELF_DID);
	assert.strictEqual(missing.ok, false);
	assert.strictEqual(missing.reason, 'invalid-rkey');
	const ok = checkXrpcRequest({
		nsid: 'com.atproto.repo.deleteRecord',
		body: {repo: SELF_DID, collection: 'app.bsky.feed.like', rkey: 'abc', swapRecord: 'x'}
	}, SELF_DID);
	assert.strictEqual(ok.ok, true);
	assert.deepStrictEqual(ok.body, {repo: SELF_DID, collection: 'app.bsky.feed.like', rkey: 'abc'});
});

test('checkXrpcRequest: ブックマークは body が白名簿のキーだけになり、GET は body を持たない', () => {
	const bookmark = checkXrpcRequest({
		nsid: 'app.bsky.bookmark.createBookmark',
		body: {uri: 'at://x', cid: 'c', extra: 1}
	}, SELF_DID);
	assert.strictEqual(bookmark.ok, true);
	assert.deepStrictEqual(bookmark.body, {uri: 'at://x', cid: 'c'});
	const get = checkXrpcRequest({nsid: 'app.bsky.feed.getPosts', params: {uris: []}}, SELF_DID);
	assert.strictEqual(get.ok, true);
	assert.strictEqual(get.body, null);
});

test('checkXrpcRequest: 自分のリポストの削除も通る', () => {
	const result = checkXrpcRequest({
		nsid: 'com.atproto.repo.deleteRecord',
		body: {repo: SELF_DID, collection: 'app.bsky.feed.repost', rkey: 'abc'}
	}, SELF_DID);
	assert.strictEqual(result.ok, true);
});

test('checkXrpcRequest: セッションが無いときの書き込みは落ちる', () => {
	const result = checkXrpcRequest({
		nsid: 'com.atproto.repo.createRecord',
		body: {repo: SELF_DID, collection: 'app.bsky.feed.like', record: {}}
	}, null);
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.reason, 'repo-not-self');
});

test('checkXrpcRequest: payload が壊れていても落ちない', () => {
	assert.strictEqual(checkXrpcRequest(null, SELF_DID).ok, false);
	assert.strictEqual(checkXrpcRequest({}, SELF_DID).ok, false);
	assert.strictEqual(
		checkXrpcRequest({nsid: 'com.atproto.repo.createRecord'}, SELF_DID).reason,
		'invalid-body'
	);
});

/**
 * 修正ラウンド 1 (レビュー C1) の回帰テスト。
 * hasOwnProperty はプロパティキーの ToString 変換で照合するため、nsid に
 * 配列 (入れ子含む) を渡すと白名簿には hit しつつ、旧実装の isRecordWrite
 * (=== の厳密比較) は false になり collection / repo の検査を丸ごと飛ばして
 * いた。型の門番 (typeof payload.nsid !== 'string') で塞いだことを確認する
 */
test('checkXrpcRequest: nsid が文字列でないものは通らない', () => {
	assert.strictEqual(checkXrpcRequest({
		nsid: ['com.atproto.repo.createRecord'],
		body: {repo: SELF_DID, collection: 'app.bsky.feed.post', record: {}}
	}, SELF_DID).ok, false);
	assert.strictEqual(checkXrpcRequest({
		nsid: [['com.atproto.repo.deleteRecord']],
		body: {repo: SELF_DID, collection: 'app.bsky.graph.follow', rkey: 'a'}
	}, SELF_DID).ok, false);
});

/**
 * 修正ラウンド 1 (レビュー I2) の回帰テスト。
 * isRecordWrite を文字列リテラル 2 個の直書きに戻すと、EXT_BRIDGE.xrpc に
 * recordWrite: true な NSID を新しく足しても検査が追随せず、collection /
 * repo の検査を受けずに通ってしまう。rule.recordWrite から導くことで、
 * 白名簿に無い NSID (テスト用に一時追加したもの) でも検査が効くことを確認する
 */
test('checkXrpcRequest: 白名簿に recordWrite な NSID を追加すると自動で collection 検査を受ける', () => {
	const fakeNsid = 'com.atproto.repo.testWrite';
	EXT_BRIDGE.xrpc[fakeNsid] = {target: 'pds', method: 'POST', recordWrite: true};
	try {
		const result = checkXrpcRequest({
			nsid: fakeNsid,
			body: {repo: SELF_DID, collection: 'app.bsky.graph.follow', record: {}}
		}, SELF_DID);
		assert.strictEqual(result.ok, false);
		assert.strictEqual(result.reason, 'collection-not-allowed');
	} finally {
		delete EXT_BRIDGE.xrpc[fakeNsid];
	}
});

/**
 * 橋渡しの名前・白名簿の値は common/bridge-protocol.js の BRIDGE_PROTOCOL に 1 つだけ書き、
 * config.js (content 側) と page-bridge.js (MAIN 側) の両方がそれを参照する。
 * どちらかがリテラルを書き直して二重持ちに戻ると、参照が別物になってここで落ちる
 */
test('橋渡しの値は config.js と page-bridge.js が同じ BRIDGE_PROTOCOL を参照している', () => {
	// content 側 (config.js) はオブジェクトをそのまま参照する
	assert.strictEqual(EXT_CONFIG.mediaGrid.bridge.actions, BRIDGE_PROTOCOL.actions);
	assert.strictEqual(EXT_CONFIG.mediaGrid.bridge.routes, BRIDGE_PROTOCOL.routes);
	assert.strictEqual(EXT_CONFIG.mediaGrid.bridge.requestEvent, BRIDGE_PROTOCOL.requestEvent);
	assert.strictEqual(EXT_CONFIG.mediaGrid.bridge.resultEvent, BRIDGE_PROTOCOL.resultEvent);
	assert.strictEqual(EXT_CONFIG.selectors.tabPrefix, BRIDGE_PROTOCOL.tabTestIdPrefix);
	assert.strictEqual(EXT_CONFIG.postActions.nsid, BRIDGE_PROTOCOL.nsid);
	assert.strictEqual(EXT_CONFIG.postActions.collections, BRIDGE_PROTOCOL.collections);
	assert.strictEqual(EXT_CONFIG.postActions.composerModes, BRIDGE_PROTOCOL.composerModes);
	assert.strictEqual(EXT_CONFIG.postActions.reasons, BRIDGE_PROTOCOL.reasons);
	// MAIN 側 (page-bridge.js) も同じオブジェクトを参照する
	assert.strictEqual(EXT_BRIDGE.actions, BRIDGE_PROTOCOL.actions);
	assert.strictEqual(EXT_BRIDGE.requestEvent, BRIDGE_PROTOCOL.requestEvent);
	assert.strictEqual(EXT_BRIDGE.resultEvent, BRIDGE_PROTOCOL.resultEvent);
	assert.strictEqual(EXT_BRIDGE.tabTestIdPrefix, BRIDGE_PROTOCOL.tabTestIdPrefix);
	// 検査に使う一覧は BRIDGE_PROTOCOL から作ったもの (値の並びも同じ)
	assert.deepStrictEqual(EXT_BRIDGE.routeNames, Object.values(BRIDGE_PROTOCOL.routes));
	assert.deepStrictEqual(EXT_BRIDGE.recordCollections, Object.values(BRIDGE_PROTOCOL.collections));
	assert.deepStrictEqual(EXT_BRIDGE.composerModes, Object.values(BRIDGE_PROTOCOL.composerModes));
	// call-xrpc の白名簿は nsid の全部。ただし uploadBlob は upload-blob 専用で、call-xrpc には通さない
	const xrpcNsids = Object.values(BRIDGE_PROTOCOL.nsid)
		.filter((nsid) => nsid !== BRIDGE_PROTOCOL.nsid.uploadBlob);
	assert.deepStrictEqual(Object.keys(EXT_BRIDGE.xrpc).sort(), xrpcNsids.sort());
	assert.strictEqual(
		checkXrpcRequest({nsid: BRIDGE_PROTOCOL.nsid.uploadBlob, body: {}}, SELF_DID).ok,
		false
	);
	// 呼び出し側が分岐に使う失敗理由も、検査が返す値と同じもの
	assert.strictEqual(
		checkXrpcRequest({
			nsid: BRIDGE_PROTOCOL.nsid.createRecord,
			body: {repo: 'did:plc:other', collection: BRIDGE_PROTOCOL.collections.like, record: {}}
		}, SELF_DID).reason,
		BRIDGE_PROTOCOL.reasons.repoNotSelf
	);
});

test('BRIDGE_PROTOCOL は入れ子まで凍結されている', () => {
	assert.ok(Object.isFrozen(BRIDGE_PROTOCOL));
	for (const value of Object.values(BRIDGE_PROTOCOL)) {
		if (value && typeof value === 'object') {
			assert.ok(Object.isFrozen(value));
		}
	}
});

test('buildQuery: 配列は同じ名前を繰り返し、null / undefined は落とす', () => {
	assert.strictEqual(
		buildQuery({uris: ['at://a', 'at://b'], cursor: null, limit: 1, skip: undefined}),
		'?uris=at%3A%2F%2Fa&uris=at%3A%2F%2Fb&limit=1'
	);
});

test('buildQuery: params が無い・オブジェクトでない・空なら空文字', () => {
	assert.strictEqual(buildQuery(undefined), '');
	assert.strictEqual(buildQuery('uris=a'), '');
	assert.strictEqual(buildQuery({}), '');
	assert.strictEqual(buildQuery({cursor: null}), '');
});

test('checkXrpcRequest: facets は形・範囲・種別・行き先が正しいものだけを通す', () => {
	const text = 'see https://e.com #tag @a.bsky.social';
	const link = {index: {byteStart: 4, byteEnd: 17}, features: [{$type: 'app.bsky.richtext.facet#link', uri: 'https://e.com'}]};
	const tag = {index: {byteStart: 18, byteEnd: 22}, features: [{$type: 'app.bsky.richtext.facet#tag', tag: 'tag'}]};
	const mention = {index: {byteStart: 23, byteEnd: 37}, features: [{$type: 'app.bsky.richtext.facet#mention', did: 'did:plc:a'}]};
	assert.strictEqual(checkPostCreate(replyRecord({text, facets: [link, tag, mention]})).ok, true);
	const bad = [
		[{index: {byteStart: 4, byteEnd: 17}, features: [{$type: 'app.bsky.richtext.facet#link', uri: 'javascript:alert(1)'}]}],
		[{index: {byteStart: 0, byteEnd: 999}, features: tag.features}],
		[{index: {byteStart: 5, byteEnd: 5}, features: tag.features}],
		[{index: {byteStart: -1, byteEnd: 3}, features: tag.features}],
		[{index: {byteStart: 0, byteEnd: 3}, features: [{$type: 'app.bsky.richtext.facet#unknown'}]}],
		[{index: {byteStart: 0, byteEnd: 3}, features: [{$type: 'app.bsky.richtext.facet#mention', did: 'plc:a'}]}],
		[{index: {byteStart: 0, byteEnd: 3}, features: []}],
		[{index: {byteStart: 0, byteEnd: 3}, features: [{$type: 'app.bsky.richtext.facet#tag', tag: ''}]}],
		['x'],
		Array.from({length: 51}, () => tag)
	];
	for (const facets of bad) {
		const result = checkPostCreate(replyRecord({text, facets}));
		assert.strictEqual(result.ok, false, JSON.stringify(facets).slice(0, 80));
		assert.strictEqual(result.reason, 'post-record-not-allowed');
	}
});

/** history と popstate だけを持つ偽の window */
function fakeWindow(state) {
	const listeners = new Set();
	return {
		history: {state},
		addEventListener(type, listener) {
			if (type === 'popstate') {
				listeners.add(listener);
			}
		},
		removeEventListener(type, listener) {
			if (type === 'popstate') {
				listeners.delete(listener);
			}
		},
		firePopstate() {
			for (const listener of Array.from(listeners)) {
				listener({});
			}
		},
		get listenerCount() {
			return listeners.size;
		}
	};
}

test('waitForLightboxHistory: ライトボックスの履歴が無ければ待たずに false', async () => {
	const win = fakeWindow({foo: 1});
	assert.strictEqual(await waitForLightboxHistory(win, false, 1000), false);
	assert.strictEqual(win.listenerCount, 0);
});

test('waitForLightboxHistory: 閉じる前に履歴があれば、本体の popstate (戻りの完了) を待つ', async () => {
	const win = fakeWindow({lightbox: true});
	let settled = false;
	const waiting = waitForLightboxHistory(win, true, 1000).then((value) => {
		settled = true;
		return value;
	});
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.strictEqual(settled, false);
	win.firePopstate();
	assert.strictEqual(await waiting, true);
	assert.strictEqual(win.listenerCount, 0);
});

test('waitForLightboxHistory: popstate が来なくても上限で諦めて false', async () => {
	const win = fakeWindow({lightbox: true});
	assert.strictEqual(await waitForLightboxHistory(win, true, 30), false);
	assert.strictEqual(win.listenerCount, 0);
});

/** upload-blob の検査で使う値 */
const UPLOAD = BRIDGE_PROTOCOL.upload;

test('checkUploadBlob: 許した MIME で上限以下なら通る', () => {
	assert.deepStrictEqual(checkUploadBlob({type: 'image/jpeg', size: 2000000}), {ok: true});
	assert.deepStrictEqual(checkUploadBlob({type: 'image/gif', size: 1}), {ok: true});
});

test('checkUploadBlob: 上限を 1 バイト超えると落ちる', () => {
	const expected = {ok: false, reason: 'blob-not-allowed'};
	assert.deepStrictEqual(checkUploadBlob({type: 'image/jpeg', size: 2000001}), expected);
	assert.deepStrictEqual(checkUploadBlob({type: 'image/webp', size: 2000001}), expected);
});

test('checkUploadBlob: 許していない MIME・0 バイト・数でない size は落ちる', () => {
	for (const info of [
		{type: 'video/mp4', size: 10},
		{type: 'image/svg+xml', size: 10},
		{type: 'application/octet-stream', size: 10},
		{type: 'image/png', size: 0},
		{type: 'image/png', size: '1'},
		{type: 'image/png', size: NaN},
		null
	]) {
		assert.strictEqual(checkUploadBlob(info).ok, false);
	}
});

test('isBlobRef: 正しい形だけ真', () => {
	const good = {$type: 'blob', ref: {$link: 'bafk'}, mimeType: 'image/png', size: 10};
	const types = UPLOAD.mimeTypes;
	assert.strictEqual(isBlobRef(good, types), true);
	assert.strictEqual(isBlobRef({...good, $type: 'x'}, types), false);
	assert.strictEqual(isBlobRef({...good, ref: {$link: ''}}, types), false);
	assert.strictEqual(isBlobRef({...good, ref: null}, types), false);
	assert.strictEqual(isBlobRef({...good, mimeType: 'video/mp4'}, types), false);
	assert.strictEqual(isBlobRef({...good, size: -1}, types), false);
	assert.strictEqual(isBlobRef({...good, size: 1.5}, types), false);
	assert.strictEqual(isBlobRef(null, types), false);
});

/**
 * 偽のタイマー。発火は fire() で手動に行う
 * @returns {{setTimer: Function, clearTimer: Function, fire: Function}}
 */
function makeFakeTimers() {
	const timers = new Map();
	let next = 1;
	return {
		setTimer: (fn) => {
			timers.set(next, fn);
			return next++;
		},
		clearTimer: (handle) => timers.delete(handle),
		fire: () => {
			for (const [handle, fn] of [...timers]) {
				timers.delete(handle);
				fn();
			}
		}
	};
}

test('BlobInbox: put した Blob を take で 1 回だけ取り出せる', () => {
	const timers = makeFakeTimers();
	const inbox = new BlobInbox({ttlMs: 1000, maxEntries: 3, ...timers});
	const blob = new Blob(['a']);
	assert.strictEqual(inbox.put('id-00000001', blob), true);
	assert.strictEqual(inbox.take('id-00000001'), blob);
	assert.strictEqual(inbox.take('id-00000001'), null);
});

test('BlobInbox: ttl を過ぎたら消える', () => {
	const timers = makeFakeTimers();
	const inbox = new BlobInbox({ttlMs: 1000, maxEntries: 3, ...timers});
	inbox.put('id-00000001', new Blob(['a']));
	timers.fire();
	assert.strictEqual(inbox.take('id-00000001'), null);
});

test('BlobInbox: 上限を超えたら古いものから消える', () => {
	const timers = makeFakeTimers();
	const inbox = new BlobInbox({ttlMs: 1000, maxEntries: 2, ...timers});
	inbox.put('id-00000001', new Blob(['a']));
	inbox.put('id-00000002', new Blob(['b']));
	inbox.put('id-00000003', new Blob(['c']));
	assert.strictEqual(inbox.take('id-00000001'), null);
	assert.notStrictEqual(inbox.take('id-00000002'), null);
	assert.notStrictEqual(inbox.take('id-00000003'), null);
	inbox.put('id-00000004', new Blob(['d']));
	inbox.clear();
	assert.strictEqual(inbox.take('id-00000004'), null);
});

test('readBlobMessage: 条件を満たすものだけ読める', () => {
	const win = {location: {origin: 'https://bsky.app'}};
	const blob = new Blob(['a']);
	const make = (override) => ({
		source: win,
		origin: 'https://bsky.app',
		data: {type: BRIDGE_PROTOCOL.blobMessageType, id: 'abcd-1234-efgh', blob},
		...override
	});
	const ok = readBlobMessage(make({}), win);
	assert.strictEqual(ok.id, 'abcd-1234-efgh');
	assert.strictEqual(ok.blob, blob);
	assert.strictEqual(readBlobMessage(make({source: {}}), win), null);
	assert.strictEqual(readBlobMessage(make({origin: 'https://evil.example'}), win), null);
	assert.strictEqual(readBlobMessage(make({data: {type: 'x', id: 'abcd-1234', blob}}), win), null);
	assert.strictEqual(readBlobMessage(make({data: {type: BRIDGE_PROTOCOL.blobMessageType, id: 'ABC!', blob}}), win), null);
	assert.strictEqual(readBlobMessage(make({data: {type: BRIDGE_PROTOCOL.blobMessageType, id: 'abcd-1234', blob: 'x'}}), win), null);
	assert.strictEqual(readBlobMessage(make({data: null}), win), null);
});

test('BlobInbox: 同じ id の put は最初のものを守る', () => {
	const inbox = new BlobInbox({ttlMs: 1000, maxEntries: 3, ...makeFakeTimers()});
	const first = new Blob(['a']);
	assert.strictEqual(inbox.put('id-00000001', first), true);
	assert.strictEqual(inbox.put('id-00000001', new Blob(['evil'])), false);
	assert.strictEqual(inbox.take('id-00000001'), first);
});

test('BlobInbox.waitFor: 要求が先に着いても、後から put された Blob を受け取れる', async () => {
	const inbox = new BlobInbox({ttlMs: 1000, maxEntries: 3, ...makeFakeTimers()});
	const pending = inbox.waitFor('id-00000001', 5000);
	const blob = new Blob(['a']);
	inbox.put('id-00000001', blob);
	assert.strictEqual(await pending, blob);
	assert.strictEqual(inbox.take('id-00000001'), null);
});

test('BlobInbox.waitFor: 既にあれば直ちに取り出し、届かなければ上限で null', async () => {
	const timers = makeFakeTimers();
	const inbox = new BlobInbox({ttlMs: 1000, maxEntries: 3, ...timers});
	const blob = new Blob(['a']);
	inbox.put('id-00000001', blob);
	assert.strictEqual(await inbox.waitFor('id-00000001', 5000), blob);
	const pending = inbox.waitFor('id-00000002', 5000);
	timers.fire();
	assert.strictEqual(await pending, null);
	// 時間切れの後に届いた Blob は箱に残る (ttl で捨てられる)
	const late = new Blob(['b']);
	inbox.put('id-00000002', late);
	assert.strictEqual(inbox.take('id-00000002'), late);
});

test('toBlobRef: 想定したキーだけで組み直す', () => {
	const ref = toBlobRef({
		$type: 'blob', ref: {$link: 'bafk', extra: 1}, mimeType: 'image/png', size: 10, evil: true
	});
	assert.deepStrictEqual(ref, {$type: 'blob', ref: {$link: 'bafk'}, mimeType: 'image/png', size: 10});
});

const THUMB = {$type: 'blob', ref: {$link: 'bafthumb'}, mimeType: 'image/jpeg', size: 1000};
const POST_REF = {uri: 'at://did:plc:x/app.bsky.feed.post/abc', cid: 'bafypost'};

/** 検査を通る external の embed を作る。over に undefined を渡したキーは消す */
function externalEmbed(over = {}) {
	const external = {uri: 'https://example.com/a', title: 't', description: 'd', thumb: THUMB, ...over};
	for (const key of Object.keys(external)) {
		if (external[key] === undefined) {
			delete external[key];
		}
	}
	return {$type: 'app.bsky.embed.external', external};
}

test('checkPostEmbed: external は http(s) の uri と画像の thumb だけを通す', () => {
	assert.strictEqual(checkPostEmbed(externalEmbed()), true);
	assert.strictEqual(checkPostEmbed(externalEmbed({thumb: undefined})), true);
	assert.strictEqual(checkPostEmbed(externalEmbed({uri: 'javascript:alert(1)'})), false);
	assert.strictEqual(checkPostEmbed(externalEmbed({uri: 'https://e.com/' + 'a'.repeat(3000)})), false);
	for (const uri of [' https://a', 'https://a b', 'https://a\tb', 'https:a.com', 'https://a\n']) {
		assert.strictEqual(checkPostEmbed(externalEmbed({uri})), false, JSON.stringify(uri));
	}
	assert.strictEqual(checkPostEmbed(externalEmbed({title: 'あ'.repeat(301)})), false);
	assert.strictEqual(checkPostEmbed(externalEmbed({description: 'あ'.repeat(1001)})), false);
	assert.strictEqual(checkPostEmbed(externalEmbed({thumb: {...THUMB, mimeType: 'text/plain'}})), false);
	assert.strictEqual(checkPostEmbed(externalEmbed({thumb: {...THUMB, size: 1000001}})), false);
	assert.strictEqual(checkPostEmbed(externalEmbed({extra: 1})), false);
	assert.strictEqual(checkPostEmbed({...externalEmbed(), extra: 1}), false);
});

test('checkPostEmbed: record は投稿の AT URI と CID だけを通す', () => {
	assert.strictEqual(checkPostEmbed({$type: 'app.bsky.embed.record', record: POST_REF}), true);
	assert.strictEqual(checkPostEmbed({$type: 'app.bsky.embed.record',
		record: {uri: 'at://did:plc:x/app.bsky.feed.generator/f', cid: 'c'}}), false);
	assert.strictEqual(checkPostEmbed({$type: 'app.bsky.embed.record', record: {...POST_REF, extra: 1}}), false);
	assert.strictEqual(checkPostEmbed({$type: 'app.bsky.embed.record', record: {uri: POST_REF.uri, cid: ''}}), false);
});

test('checkPostEmbed: recordWithMedia は record と images / gallery / external の media だけを通す', () => {
	const rec = {$type: 'app.bsky.embed.record', record: POST_REF};
	const withMedia = (media, record = rec) => ({$type: 'app.bsky.embed.recordWithMedia', record, media});
	assert.strictEqual(checkPostEmbed(withMedia(imagesEmbed(2))), true);
	assert.strictEqual(checkPostEmbed(withMedia(galleryEmbed(2))), true);
	assert.strictEqual(checkPostEmbed(withMedia(externalEmbed())), true);
	assert.strictEqual(checkPostEmbed(withMedia(rec)), false);
	assert.strictEqual(checkPostEmbed(withMedia(imagesEmbed(1), POST_REF)), false);
	assert.strictEqual(checkPostEmbed(withMedia(withMedia(imagesEmbed(1)))), false);
});

test('checkPostRecord: external 付きでも返信でなければ通さない', () => {
	const result = checkPostCreate({
		$type: 'app.bsky.feed.post', text: 'a', createdAt: '2026-10-18T00:00:00.000Z',
		embed: externalEmbed()
	});
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.reason, BRIDGE_PROTOCOL.reasons.postNotReply);
});

test('入力欄と橋渡しのつなぎ目: buildPostEmbed の 5 通りを buildReplyRecord で record にすると checkPostRecord を通る', () => {
	const RULES = BRIDGE_PROTOCOL.postRecord;
	const uploaded = (count) => Array.from({length: count}, () => ({blob: blobRef(), alt: 'alt', width: 800, height: 600}));
	const gifItem = {
		id: '1', title: '長'.repeat(RULES.external.maxTitleGraphemes + 50),
		gifUrl: 'https://static.klipy.com/ii/a/b/x.gif', width: 200, height: 100,
		previewUrl: 'https://static.klipy.com/ii/a/b/x.jpg', tinyUrl: '', tinyWidth: 0, tinyHeight: 0,
		playerUrl: null, mp4Slug: 'm', webmSlug: 'w'
	};
	const gifAlt = 'あ'.repeat(RULES.external.maxDescriptionGraphemes + 50);
	const limits = {
		maxTitleGraphemes: RULES.external.maxTitleGraphemes,
		maxDescriptionGraphemes: RULES.external.maxDescriptionGraphemes
	};
	const gif = buildGifExternal(gifItem, gifAlt, blobRef(), limits);
	const card = {
		$type: RULES.embedTypes.external,
		external: {uri: 'https://example.com/a', title: 'T', description: 'D', thumb: blobRef()}
	};
	const quote = {uri: 'at://did:plc:q/app.bsky.feed.post/3kq', cid: 'bafyreiq'};
	const cases = [
		{name: '画像', parts: {images: uploaded(2), external: null, quote: null}, type: RULES.embedTypes.images},
		{name: 'GIF', parts: {images: [], external: gif, quote: null}, type: RULES.embedTypes.external},
		{name: 'カード', parts: {images: [], external: card, quote: null}, type: RULES.embedTypes.external},
		{name: '引用だけ', parts: {images: [], external: null, quote}, type: RULES.embedTypes.record},
		{name: '引用 + gallery 6 枚', parts: {images: uploaded(6), external: null, quote}, type: RULES.embedTypes.recordWithMedia}
	];
	for (const one of cases) {
		const record = buildReplyRecord({
			text: 'a',
			reply: {
				root: {uri: 'at://did:plc:a/app.bsky.feed.post/1', cid: 'c1'},
				parent: {uri: 'at://did:plc:a/app.bsky.feed.post/2', cid: 'c2'}
			},
			createdAt: '2026-10-19T00:00:00.000Z',
			langs: ['ja'],
			facets: [],
			embed: buildPostEmbed(one.parts, RULES.maxImages),
			labels: null
		});
		assert.strictEqual(record.embed.$type, one.type, one.name);
		assert.deepStrictEqual(checkPostRecord(record), {ok: true}, one.name);
	}
	const withMedia = buildPostEmbed(cases[4].parts, RULES.maxImages);
	assert.strictEqual(withMedia.media.$type, RULES.embedTypes.gallery);

	// 上限を付けずに組んだ GIF は橋渡しに拒まれる (上限が要ることの確認)
	const unlimited = buildReplyRecord({
		text: 'a', reply: replyRecord().reply, createdAt: '2026-10-19T00:00:00.000Z', langs: null, facets: [],
		embed: buildPostEmbed({images: [], external: buildGifExternal(gifItem, gifAlt, blobRef()), quote: null}, RULES.maxImages)
	});
	assert.strictEqual(checkPostRecord(unlimited).ok, false);
});

/** 検査に使う動画の BlobRef */
const VIDEO_BLOB = {$type: 'blob', ref: {$link: 'bafkreivideo'}, mimeType: 'video/mp4', size: 131831};
/** 検査に使う字幕の BlobRef */
const VTT_BLOB = {$type: 'blob', ref: {$link: 'bafkreivtt'}, mimeType: 'text/vtt', size: 111};

test('checkUploadVideo: 動画の MIME で 1〜300,000,000 バイトだけを通す', () => {
	assert.deepStrictEqual(checkUploadVideo({type: 'video/mp4', size: 1}), {ok: true});
	assert.deepStrictEqual(checkUploadVideo({type: 'video/quicktime', size: 300000000}), {ok: true});
	assert.strictEqual(checkUploadVideo({type: 'video/webm', size: 300000001}).ok, false);
	assert.strictEqual(checkUploadVideo({type: 'video/mp4', size: 0}).ok, false);
	assert.strictEqual(checkUploadVideo({type: 'image/gif', size: 10}).ok, false);
	assert.strictEqual(checkUploadVideo({type: 'text/vtt', size: 10}).ok, false);
});

test('checkUploadBlob: 字幕 (text/vtt) は 20,000 バイトまで通し、動画は通さない', () => {
	assert.deepStrictEqual(checkUploadBlob({type: 'text/vtt', size: 20000}), {ok: true});
	assert.strictEqual(checkUploadBlob({type: 'text/vtt', size: 20001}).ok, false);
	assert.strictEqual(checkUploadBlob({type: 'video/mp4', size: 10}).ok, false);
});

test('checkPostEmbed: app.bsky.embed.video の正しい形を通す', () => {
	assert.strictEqual(checkPostEmbed({$type: 'app.bsky.embed.video', video: VIDEO_BLOB}), true);
	assert.strictEqual(checkPostEmbed({
		$type: 'app.bsky.embed.video', video: VIDEO_BLOB, alt: '説明',
		captions: [{lang: 'ja', file: VTT_BLOB}], aspectRatio: {width: 640, height: 360}, presentation: 'default'
	}), true);
	assert.strictEqual(checkPostEmbed({
		$type: 'app.bsky.embed.recordWithMedia',
		record: {$type: 'app.bsky.embed.record', record: {uri: 'at://did:plc:a/app.bsky.feed.post/1', cid: 'bafy'}},
		media: {$type: 'app.bsky.embed.video', video: VIDEO_BLOB}
	}), true);
});

test('checkPostEmbed: app.bsky.embed.video の崩れた形を拒む', () => {
	const base = {$type: 'app.bsky.embed.video', video: VIDEO_BLOB};
	const bad = [
		{...base, video: {...VIDEO_BLOB, mimeType: 'video/webm'}},
		{...base, video: {...VIDEO_BLOB, size: 300000001}},
		{...base, video: {...VIDEO_BLOB, extra: 1}},
		{$type: 'app.bsky.embed.video'},
		{...base, extra: 1},
		{...base, alt: 'あ'.repeat(2001)},
		{...base, captions: []},
		{...base, captions: [{lang: 'ja', file: VTT_BLOB}, {lang: 'en', file: VTT_BLOB}]},
		{...base, captions: [{lang: 'ja!', file: VTT_BLOB}]},
		{...base, captions: [{lang: 'ja', file: {...VTT_BLOB, mimeType: 'text/plain'}}]},
		{...base, captions: [{lang: 'ja', file: {...VTT_BLOB, size: 20001}}]},
		{...base, captions: [{lang: 'ja', file: VTT_BLOB, extra: 1}]},
		{...base, presentation: 'gif'},
		{...base, aspectRatio: {width: 0, height: 360}}
	];
	for (const embed of bad) assert.strictEqual(checkPostEmbed(embed), false, JSON.stringify(embed));
});

test('checkPostEmbed: 画像の BlobRef に動画の MIME を入れた images は拒む', () => {
	assert.strictEqual(checkPostEmbed({$type: 'app.bsky.embed.images', images: [{image: VIDEO_BLOB, alt: ''}]}), false);
});

test('入力欄が組む動画の embed は checkPostRecord を通る', () => {
	const RULES = BRIDGE_PROTOCOL.postRecord;
	const video = {blob: VIDEO_BLOB, alt: '説明', width: 640.6, height: 360, captions: [{lang: 'ja', file: VTT_BLOB}]};
	const quote = {uri: 'at://did:plc:q/app.bsky.feed.post/3kq', cid: 'bafyreiq'};
	const cases = [
		{name: '動画だけ', parts: {images: [], video, external: null, quote: null}, type: RULES.embedTypes.video},
		{name: '引用 + 動画', parts: {images: [], video, external: null, quote}, type: RULES.embedTypes.recordWithMedia}
	];
	for (const one of cases) {
		const record = buildReplyRecord({
			text: 'a', reply: replyRecord().reply, createdAt: '2026-10-19T00:00:00.000Z',
			langs: ['ja'], facets: [], embed: buildPostEmbed(one.parts, RULES.maxImages), labels: null
		});
		assert.strictEqual(record.embed.$type, one.type, one.name);
		assert.deepStrictEqual(checkPostRecord(record), {ok: true}, one.name);
	}
});

test('toProgressDetail: 段階と 0〜1 の数だけを運ぶ', () => {
	assert.deepStrictEqual(toProgressDetail(7, {phase: 'upload', progress: 0.42}), {id: 7, phase: 'upload', progress: 0.42});
	assert.deepStrictEqual(toProgressDetail(7, {phase: 'processing', progress: null}), {id: 7, phase: 'processing', progress: null});
	assert.deepStrictEqual(toProgressDetail(7, {phase: 'upload', progress: 1.5}), {id: 7, phase: 'upload', progress: 1});
	assert.deepStrictEqual(toProgressDetail(7, {phase: 'upload', progress: -1}), {id: 7, phase: 'upload', progress: 0});
	assert.deepStrictEqual(toProgressDetail(7, {phase: 'upload', progress: NaN}), {id: 7, phase: 'upload', progress: null});
	assert.strictEqual(toProgressDetail(7, {phase: 'token', progress: 0.1}), null);
	assert.strictEqual(toProgressDetail(7, null), null);
	assert.deepStrictEqual(Object.keys(toProgressDetail(7, {phase: 'upload', progress: 0.1, token: 'x'})).sort(), ['id', 'phase', 'progress']);
});

test('truncateMessage: 文字列だけを 300 文字で切る', () => {
	assert.strictEqual(truncateMessage('abc'), 'abc');
	assert.strictEqual(truncateMessage('a'.repeat(500)).length, 300);
	assert.strictEqual(truncateMessage(42), undefined);
	assert.strictEqual(truncateMessage(''), undefined);
	assert.strictEqual(truncateMessage(undefined), undefined);
});

test('checkXrpcRequest: 動画サービスの NSID は call-xrpc では通らない', () => {
	for (const nsid of ['app.bsky.video.startUpload', 'com.atproto.server.getServiceAuth', 'com.atproto.server.getSession']) {
		assert.strictEqual(checkXrpcRequest({nsid, params: {}}, SELF_DID).ok, false, nsid);
	}
});

test('createVideoDeps: abortUpload は鳴った signal を渡さずに送る', async () => {
	const original = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push({url, init});
		return {status: 200, json: async () => ({})};
	};
	try {
		const controller = new AbortController();
		controller.abort();
		const deps = createVideoDeps({}, controller.signal, () => {});
		await deps.requestJson('POST', VIDEO_UPLOAD.nsid.abortUpload, {token: 't', body: {jobId: 'j'}});
		assert.strictEqual(calls.length, 1);
		assert.ok(String(calls[0].url).endsWith('/xrpc/app.bsky.video.abortUpload'));
		assert.notStrictEqual(calls[0].init.signal, controller.signal);
		assert.strictEqual(calls[0].init.signal.aborted, false);
		await deps.requestJson('GET', VIDEO_UPLOAD.nsid.getUploadLimits, {token: 't'});
		// 取り消しの signal に 1 回ごとの打ち切りを合わせたもの
		assert.ok(calls[1].init.signal instanceof AbortSignal);
		assert.strictEqual(calls[1].init.signal.aborted, true);
	} finally {
		globalThis.fetch = original;
	}
});

test('createVideoDeps: requestJson・getSession・getServiceAuth は取り消しと 1 回ごとの打ち切りを合わせた signal を渡す', async () => {
	const originalFetch = globalThis.fetch;
	const originalTimeout = AbortSignal.timeout;
	const timeouts = [];
	const fetches = [];
	const handlerCalls = [];
	AbortSignal.timeout = (ms) => {
		const timeout = new AbortController();
		timeouts.push({ms, controller: timeout});
		return timeout.signal;
	};
	globalThis.fetch = async (url, init) => {
		fetches.push({url, init});
		return {status: 200, json: async () => ({})};
	};
	try {
		const controller = new AbortController();
		const clients = {
			pdsClient: {
				agent: {
					fetchHandler: async (url, init) => {
						handlerCalls.push({url, init});
						return {ok: true, json: async () => ({token: 'tok', did: 'did:plc:x'})};
					}
				}
			}
		};
		const deps = createVideoDeps(clients, controller.signal, () => {});
		await deps.requestJson('GET', VIDEO_UPLOAD.nsid.getUploadLimits, {token: 't'});
		await deps.getSession();
		assert.strictEqual(await deps.getServiceAuth('did:web:video.bsky.app', VIDEO_UPLOAD.nsid.getUploadLimits), 'tok');
		assert.deepStrictEqual(timeouts.map((t) => t.ms), Array(3).fill(VIDEO_UPLOAD.requestTimeoutMs));
		const signals = [fetches[0].init.signal, handlerCalls[0].init.signal, handlerCalls[1].init.signal];
		for (const signal of signals) {
			assert.ok(signal instanceof AbortSignal);
			assert.strictEqual(signal.aborted, false);
		}
		// 1 回ごとの打ち切りが鳴ると、その要求の signal だけが鳴る
		timeouts[0].controller.abort();
		assert.strictEqual(signals[0].aborted, true);
		assert.strictEqual(signals[1].aborted, false);
		// 取り消しは全部に届く
		controller.abort();
		assert.ok(signals.every((signal) => signal.aborted));
	} finally {
		globalThis.fetch = originalFetch;
		AbortSignal.timeout = originalTimeout;
	}
});

test('createVideoDeps: sendPart は args.signal が鳴っても XHR を止める', async () => {
	const original = globalThis.XMLHttpRequest;
	const xhrs = [];
	globalThis.XMLHttpRequest = class {
		constructor() {
			this.upload = {};
			this.aborted = false;
			xhrs.push(this);
		}
		open() {}
		setRequestHeader() {}
		send() {}
		abort() {
			this.aborted = true;
			if (this.onabort) this.onabort();
		}
	};
	try {
		const controller = new AbortController();
		const deps = createVideoDeps({}, controller.signal, () => {});
		const stop = new AbortController();
		const pending = deps.sendPart({
			jobId: 'j', partNumber: 2, chunk: new Blob(['x']), token: 't', onBytes: () => {}, signal: stop.signal
		});
		assert.strictEqual(xhrs.length, 1);
		assert.strictEqual(xhrs[0].aborted, false);
		stop.abort();
		await assert.rejects(pending);
		assert.strictEqual(xhrs[0].aborted, true);
		assert.strictEqual(controller.signal.aborted, false);

		// 取り消しの signal でも止まる
		const other = deps.sendPart({
			jobId: 'j', partNumber: 3, chunk: new Blob(['x']), token: 't', onBytes: () => {}, signal: new AbortController().signal
		});
		controller.abort();
		await assert.rejects(other);
		assert.strictEqual(xhrs[1].aborted, true);
	} finally {
		globalThis.XMLHttpRequest = original;
	}
});

test('uploadVideoAction: 動画の到着を待つあいだの取り消しを拾う', async () => {
	let release = null;
	const blob = new Blob([new Uint8Array(4)], {type: 'video/mp4'});
	setBlobInboxForTest({waitFor: () => new Promise((resolve) => { release = () => resolve(blob); })});
	try {
		const blobId = 'a'.repeat(16);
		const pending = uploadVideoAction({blobId}, 1);
		assert.deepStrictEqual(cancelUploadVideo({blobId}), {ok: true});
		release();
		assert.deepStrictEqual(await pending, {ok: false, reason: BRIDGE_PROTOCOL.reasons.canceled});
		assert.deepStrictEqual(cancelUploadVideo({blobId}), {ok: false});
	} finally {
		setBlobInboxForTest(null);
	}
});

const ME = 'did:plc:me';
/** 返信の連なりを n 件作る (1 件目は他人の投稿への返信) */
function threadWrites(n) {
	const root = {uri: 'at://did:plc:other/app.bsky.feed.post/3aaaaaaaaaaa2', cid: 'bafyroot'};
	const rkeys = ['3m2aaaaaaaaa2', '3m2aaaaaaaaa3', '3m2aaaaaaaaa4', '3m2aaaaaaaaa5', '3m2aaaaaaaaa6',
		'3m2aaaaaaaaa7', '3m2aaaaaaaaaa', '3m2aaaaaaaaab', '3m2aaaaaaaaac', '3m2aaaaaaaaad', '3m2aaaaaaaaae'];
	return Array.from({length: n}, (unused, i) => ({
		$type: 'com.atproto.repo.applyWrites#create',
		collection: 'app.bsky.feed.post',
		rkey: rkeys[i],
		value: {
			$type: 'app.bsky.feed.post', text: `本文${i}`, createdAt: '2026-10-19T00:00:00.000Z',
			reply: {root, parent: i === 0 ? root : {uri: `at://${ME}/app.bsky.feed.post/${rkeys[i - 1]}`, cid: `bafy${i - 1}`}}
		}
	}));
}

test('checkThreadWrites: 2 件と 10 件の返信の連なりを通し、キーを 4 つだけ写す', () => {
	for (const n of [2, 10]) {
		const writes = threadWrites(n);
		writes[0].extra = 1;
		const result = checkThreadWrites(writes, ME);
		assert.strictEqual(result.ok, false); // 余分なキーは拒む
		delete writes[0].extra;
		const ok = checkThreadWrites(writes, ME);
		assert.strictEqual(ok.ok, true);
		assert.strictEqual(ok.writes.length, n);
		assert.deepStrictEqual(Object.keys(ok.writes[0]).sort(), ['$type', 'collection', 'rkey', 'value']);
	}
});
test('checkThreadWrites: 件数・種類・コレクション・rkey を拒む', () => {
	const reason = (writes) => checkThreadWrites(writes, ME).reason;
	assert.strictEqual(reason(threadWrites(1)), 'thread-not-allowed');
	assert.strictEqual(reason(threadWrites(11)), 'thread-not-allowed');
	assert.strictEqual(reason('x'), 'thread-not-allowed');
	for (const patch of [
		(w) => { w[1].$type = 'com.atproto.repo.applyWrites#update'; },
		(w) => { w[1].$type = 'com.atproto.repo.applyWrites#delete'; },
		(w) => { w[1].collection = 'app.bsky.feed.like'; w[1].value.$type = 'app.bsky.feed.like'; },
		(w) => { w[1].rkey = 'self'; },
		(w) => { w[1].rkey = w[0].rkey; },
		(w) => { w[1].value.$type = 'app.bsky.feed.like'; }
	]) {
		const writes = threadWrites(3);
		patch(writes);
		assert.strictEqual(checkThreadWrites(writes, ME).ok, false);
	}
});
test('checkThreadWrites: 返信でない・embed の規則違反は今の返信の検査の理由で拒む', () => {
	const notReply = threadWrites(2);
	delete notReply[1].value.reply;
	assert.strictEqual(checkThreadWrites(notReply, ME).reason, 'post-not-reply');
	const badEmbed = threadWrites(2);
	badEmbed[1].value.embed = {$type: 'app.bsky.embed.video', video: 'x'};
	assert.strictEqual(checkThreadWrites(badEmbed, ME).ok, false);
});
test('checkThreadWrites: 連なりが切れていたら拒む', () => {
	for (const patch of [
		(w) => { w[2].value.reply.parent = w[0].value.reply.root; },
		(w) => { w[2].value.reply.parent.uri = `at://did:plc:other/app.bsky.feed.post/${w[1].rkey}`; },
		(w) => { w[1].value.reply.root = {uri: 'at://did:plc:x/app.bsky.feed.post/3zzzzzzzzzzz2', cid: 'c'}; },
		(w) => { w[1].value.reply.root = {...w[0].value.reply.root, cid: 'other'}; }
	]) {
		const writes = threadWrites(3);
		patch(writes);
		assert.strictEqual(checkThreadWrites(writes, ME).reason, 'thread-not-allowed');
	}
});
test('checkXrpcRequest: applyWrites は本人の repo だけ、validate は常に true、swapCommit を落とす', () => {
	const payload = (repo, extra) => ({nsid: 'com.atproto.repo.applyWrites', body: {repo, writes: threadWrites(2), ...extra}});
	assert.strictEqual(checkXrpcRequest(payload('did:plc:other'), ME).reason, 'repo-not-self');
	const ok = checkXrpcRequest(payload(ME, {validate: false, swapCommit: 'bafy'}), ME);
	assert.strictEqual(ok.ok, true);
	assert.deepStrictEqual(Object.keys(ok.body).sort(), ['repo', 'validate', 'writes']);
	assert.strictEqual(ok.body.validate, true);
	assert.strictEqual(ok.needsReplyCheck, false);
	assert.strictEqual(checkXrpcRequest(payload(ME), null).reason, 'repo-not-self');
});
