/**
 * reply-composer.js のうち DOM に触れない部分。貼り付けの取り出し・画像の順次アップロード・
 * 送信の手順 (世代が変わったとき・失敗したときに何を呼ぶか) を確かめる。
 */

import test from 'node:test';
import assert from 'node:assert';

import {EXT_CONFIG} from '../src/common/config.js';
import {FakeDocument, FakeEvent, click} from './helpers/fake-dom.js';
import {SheetHost} from '../src/content/reply-sheets.js';
import {BRIDGE_PROTOCOL} from '../src/common/bridge-protocol.js';
import {GIF_ALT_PREFIX} from '../src/content/klipy.js';
import {
	ReplyComposer, pickPastedMedia, hasMediaItems, uploadAll, runSubmit, runThreadSubmit, defaultLanguages,
	createThreadProgress
} from '../src/content/reply-composer.js';
import {computeRecordCid} from '../src/content/record-cid.js';
import {checkThreadWrites} from '../src/inject/page-bridge.js';
import {installPanelFocusGuard} from '../src/content/panel-focus-guard.js';
import {ExtDebug} from '../src/common/debug.js';

/** ログイン中の自分の DID */
const SELF_DID = 'did:plc:me';

/**
 * 偽の DataTransferItem。
 * @param {'file'|'string'} kind 種類
 * @param {string} type MIME タイプ
 * @param {*} file getAsFile が返すもの
 * @returns {{kind: string, type: string, getAsFile: () => *}}
 */
function item(kind, type, file) {
	return {kind, type, getAsFile: () => file};
}

/**
 * 偽の DataTransferItemList (配列ではなく length と添字だけを持つ)。
 * @param {Array<Object>} items 中身
 * @returns {Object}
 */
function itemList(items) {
	const list = {length: items.length};
	items.forEach((entry, index) => {
		list[index] = entry;
	});
	return list;
}

/**
 * 偽の画像を n 枚作る。
 * @param {number} n 枚数
 * @returns {Array<{blob: {name: string}}>}
 */
function preparedImages(n) {
	return Array.from({length: n}, (unused, i) => ({blob: {name: `b${i}`}}));
}

/**
 * 送信の手順を記録しながら動かす偽の段取りを作る。
 * @param {Object} overrides 差し替える段
 * @returns {{steps: Object, calls: Object}}
 */
function makeSteps(overrides) {
	const calls = {uploads: [], progress: [], created: [], posted: [], failed: []};
	const steps = {
		images: preparedImages(2),
		upload: async (blob) => {
			calls.uploads.push(blob.name);
			return {ok: true, blob: {ref: {$link: `cid-${blob.name}`}}, reason: null};
		},
		onProgress: (done, total) => calls.progress.push(`${done}/${total}`),
		isCurrent: () => true,
		buildRecord: async (blobs) => ({text: 'hi', blobs}),
		createReply: async (record) => {
			calls.created.push(record);
			return {ok: true, uri: 'at://did:plc:me/app.bsky.feed.post/1', cid: 'c1', reason: null};
		},
		onPosted: (result, record, blobs) => calls.posted.push({result, record, blobs}),
		onFailed: (kind, reason) => calls.failed.push({kind, reason}),
		...overrides
	};
	return {steps, calls};
}

test('pickPastedMedia: 文字だけなら空、画像と文字が混じれば画像だけ', () => {
	assert.deepStrictEqual(pickPastedMedia(itemList([item('string', 'text/plain', null)])), []);
	const png = {name: 'a.png'};
	const picked = pickPastedMedia(itemList([
		item('string', 'text/html', null),
		item('file', 'image/png', png),
		item('file', 'application/pdf', {name: 'x.pdf'}),
		item('string', 'text/plain', null)
	]));
	assert.deepStrictEqual(picked, [png]);
});

test('pickPastedMedia: getAsFile が null や例外なら除き、items が無ければ空', () => {
	const broken = {kind: 'file', type: 'image/png', getAsFile: () => {
		throw new Error('x');
	}};
	assert.deepStrictEqual(pickPastedMedia(itemList([item('file', 'image/png', null), broken])), []);
	assert.deepStrictEqual(pickPastedMedia(null), []);
	assert.deepStrictEqual(pickPastedMedia(undefined), []);
});

test('hasMediaItems: 画像か動画のファイルを含むときだけ真 (ドロップを受けるか)', () => {
	assert.strictEqual(hasMediaItems(itemList([item('string', 'text/plain', null)])), false);
	assert.strictEqual(hasMediaItems(itemList([item('file', 'text/plain', null)])), false);
	assert.strictEqual(hasMediaItems(itemList([item('file', 'image/jpeg', null)])), true);
	assert.strictEqual(hasMediaItems(null), false);
});

test('pickPastedMedia / hasMediaItems: 画像と動画を拾い、文字は拾わない', () => {
	const png = {name: 'a.png'};
	const mp4 = {name: 'v.mp4'};
	const items = itemList([
		item('string', 'text/plain', null),
		item('file', 'image/png', png),
		item('file', 'video/mp4', mp4),
		item('file', 'application/pdf', {name: 'x.pdf'})
	]);
	assert.deepStrictEqual(pickPastedMedia(items), [png, mp4]);
	assert.strictEqual(hasMediaItems(itemList([item('file', 'video/webm', null)])), true);
	assert.strictEqual(hasMediaItems(itemList([item('string', 'text/plain', null)])), false);
	assert.deepStrictEqual(pickPastedMedia(itemList([item('string', 'text/uri-list', null)])), []);
});

test('uploadAll: 3 枚のうち 2 枚目で失敗すると止まり、3 枚目を送らない', async () => {
	const sent = [];
	const upload = async (blob) => {
		sent.push(blob.name);
		return blob.name === 'b1'
			? {ok: false, blob: null, reason: 'upload-failed'}
			: {ok: true, blob: {ref: {$link: blob.name}}, reason: null};
	};
	const progress = [];
	const result = await uploadAll(preparedImages(3), upload, (current, total) => progress.push(`${current}/${total}`));
	assert.deepStrictEqual(sent, ['b0', 'b1']);
	assert.deepStrictEqual(progress, ['1/3', '2/3']);
	assert.deepStrictEqual(result, {ok: false, reason: 'upload-failed'});
});

test('uploadAll: 送り始める前に、いま送っている枚目を 1/3・2/3・3/3 と知らせ、BlobRef を順に返す', async () => {
	const events = [];
	const upload = async (blob) => {
		events.push(`up:${blob.name}`);
		return {ok: true, blob: {ref: {$link: blob.name}}, reason: null};
	};
	const result = await uploadAll(preparedImages(3), upload, (current, total) => events.push(`${current}/${total}`));
	assert.deepStrictEqual(events, ['1/3', 'up:b0', '2/3', 'up:b1', '3/3', 'up:b2']);
	assert.strictEqual(result.ok, true);
	assert.deepStrictEqual(result.blobs.map((blob) => blob.ref.$link), ['b0', 'b1', 'b2']);
});

test('uploadAll: アップロードが例外を投げても失敗として返し、0 枚なら何も送らない', async () => {
	const thrown = await uploadAll(preparedImages(1), async () => {
		throw new Error('boom');
	}, () => {});
	assert.strictEqual(thrown.ok, false);
	assert.strictEqual(typeof thrown.reason, 'string');
	const empty = await uploadAll([], async () => assert.fail('送らない'), () => {});
	assert.deepStrictEqual(empty, {ok: true, blobs: []});
});

test('runSubmit: 送れたら onPosted に応答・record・BlobRef を渡す', async () => {
	const {steps, calls} = makeSteps({});
	const status = await runSubmit(steps);
	assert.strictEqual(status, 'posted');
	assert.deepStrictEqual(calls.uploads, ['b0', 'b1']);
	assert.deepStrictEqual(calls.progress, ['1/2', '2/2']);
	assert.strictEqual(calls.posted.length, 1);
	assert.strictEqual(calls.posted[0].result.cid, 'c1');
	assert.strictEqual(calls.posted[0].blobs.length, 2);
	assert.deepStrictEqual(calls.failed, []);
});

test('runSubmit: 送信中に世代が変わると onPosted を呼ばず、返信も作らない', async () => {
	let current = true;
	const {steps, calls} = makeSteps({
		upload: async (blob) => {
			calls.uploads.push(blob.name);
			// 1 枚目を送っているあいだに別の画像へ移った
			current = false;
			return {ok: true, blob: {ref: {$link: blob.name}}, reason: null};
		},
		isCurrent: () => current
	});
	const status = await runSubmit(steps);
	assert.strictEqual(status, 'stale');
	assert.deepStrictEqual(calls.created, []);
	assert.deepStrictEqual(calls.posted, []);
	assert.deepStrictEqual(calls.failed, []);
});

test('runSubmit: 返信の作成の応答を待つあいだに世代が変わっても onPosted を呼ばない', async () => {
	let current = true;
	const {steps, calls} = makeSteps({
		createReply: async () => {
			current = false;
			return {ok: true, uri: 'at://x/app.bsky.feed.post/1', cid: 'c', reason: null};
		},
		isCurrent: () => current
	});
	assert.strictEqual(await runSubmit(steps), 'stale');
	assert.deepStrictEqual(calls.posted, []);
});

test('runSubmit: createReply が repo-not-self で失敗したら本文と添付が残る', async () => {
	const state = {text: '本文', attachments: ['a', 'b']};
	const {steps, calls} = makeSteps({
		createReply: async () => ({ok: false, uri: null, cid: null, reason: 'repo-not-self'}),
		onPosted: () => {
			state.text = '';
			state.attachments = [];
		}
	});
	const status = await runSubmit(steps);
	assert.strictEqual(status, 'post-failed');
	assert.deepStrictEqual(calls.failed, [{kind: 'post', reason: 'repo-not-self'}]);
	assert.deepStrictEqual(state, {text: '本文', attachments: ['a', 'b']});
});

test('runSubmit: アップロードが失敗したら返信を作らず upload の失敗を知らせる', async () => {
	const {steps, calls} = makeSteps({
		upload: async () => ({ok: false, blob: null, reason: 'blob-not-found'})
	});
	assert.strictEqual(await runSubmit(steps), 'upload-failed');
	assert.deepStrictEqual(calls.created, []);
	assert.deepStrictEqual(calls.failed, [{kind: 'upload', reason: 'blob-not-found'}]);
});

test('runSubmit: record の組み立てが例外を投げたら post の失敗にする', async () => {
	const {steps, calls} = makeSteps({
		images: [],
		buildRecord: async () => {
			throw new Error('boom');
		}
	});
	assert.strictEqual(await runSubmit(steps), 'post-failed');
	assert.strictEqual(calls.failed.length, 1);
	assert.strictEqual(calls.failed[0].kind, 'post');
	assert.deepStrictEqual(calls.posted, []);
});

test('defaultLanguages: ブラウザの言語の主タグを、選べる一覧にあるときだけ使う', () => {
	const compose = {maxLanguages: 3, languageCodes: ['ja', 'en']};
	assert.deepStrictEqual(defaultLanguages('ja-JP', compose), ['ja']);
	assert.deepStrictEqual(defaultLanguages('fil-PH', compose), []);
	assert.deepStrictEqual(defaultLanguages(undefined, compose), []);
});

/** 投稿への返信の宛先 */
const TARGET = {
	uri: 'at://did:plc:op/app.bsky.feed.post/p1', cid: 'cid-p1', replyRef: null,
	isPost: true, anchorUri: null, handle: 'op.example.com'
};

/** 引用される投稿の AT URI */
const QUOTED_URI = 'at://did:plc:quoted/app.bsky.feed.post/q1';

/**
 * getPosts が返す引用元の PostView。
 * @returns {Object}
 */
function quotedPost() {
	return {
		uri: QUOTED_URI,
		cid: 'cid-q1',
		author: {did: 'did:plc:quoted', handle: 'quoted.example.com', displayName: '引用元の人'},
		record: {$type: 'app.bsky.feed.post', text: '引用元の本文', createdAt: '2026-10-01T00:00:00.000Z'},
		indexedAt: '2026-10-01T00:00:00.000Z',
		labels: [],
		viewer: {}
	};
}

/**
 * Klipy の GIF 1 件。
 * @returns {Object} GifItem
 */
function gifItem() {
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
		webmSlug: 'cat'
	};
}

/**
 * 本文の欄に文字を貼り付けたことにする (paste の後に input が届く)。
 * @param {ReplyComposer} composer
 * @param {string} value 貼り付けた後の本文
 * @returns {void}
 */
function pasteText(composer, value) {
	const paste = new FakeEvent('paste');
	paste.clipboardData = {items: itemList([item('string', 'text/plain', null)])};
	composer.active.textarea.dispatchEvent(paste);
	composer.active.textarea.value = value;
	composer.active.textarea.dispatchEvent(new FakeEvent('input'));
}

/**
 * 待っている Promise を進める。
 * @returns {Promise<void>}
 */
async function flush() {
	for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * 偽の DOM の上で入力欄を作る。document は作っている間だけ差し替える。
 * @param {Object} overrides 差し替える口
 * @returns {{composer: ReplyComposer, calls: Object, state: {generation: number, posting: boolean}, restore: () => void}}
 */
function makeComposer(overrides) {
	const previous = globalThis.document;
	const doc = new FakeDocument();
	globalThis.document = doc;
	const state = {generation: 1, posting: false};
	const calls = {
		posted: [], created: [], uploads: 0, fetchJson: [], fetchBlob: [], fetchPost: [],
		videoUploads: [], videoCancels: [], videoJobs: [], threads: [], reloads: 0
	};
	const deps = {
		actions: {
			createReply: async (record) => {
				calls.created.push(record);
				return {ok: true, uri: 'at://did:plc:me/app.bsky.feed.post/r1', cid: 'cid-r1', reason: null};
			},
			// PostActions と同じく DID を渡して writes を組ませ、組んだ writes を記録して書けたことにする
			createReplyThread: async (build) => {
				const writes = await build(SELF_DID);
				calls.threads.push(writes);
				const results = [];
				for (const write of writes) {
					results.push({uri: `at://${SELF_DID}/${write.collection}/${write.rkey}`, cid: await computeRecordCid(write.value)});
				}
				return {ok: true, results, writes, reason: null};
			}
		},
		reload: () => {
			calls.reloads += 1;
		},
		sheets: null,
		uploadBlob: async () => {
			calls.uploads += 1;
			return {ok: true, blob: {$type: 'blob', ref: {$link: `cid${calls.uploads}`}, mimeType: 'image/jpeg', size: 1}, reason: null};
		},
		prepareImage: async (file) => ({
			blob: {size: 1}, width: 40, height: 30, previewUrl: `blob:test/${file.name}`, source: file, crop: null,
			natural: {width: 400, height: 300}
		}),
		getSelfProfile: () => null,
		getSessionDid: () => SELF_DID,
		isCurrent: (generation) => generation === state.generation,
		getGeneration: () => state.generation,
		isPosting: () => state.posting,
		setPosting: (posting) => {
			state.posting = posting;
		},
		onPosted: (...args) => calls.posted.push(args),
		resolveHandle: async () => null,
		parentLangs: null,
		loadLanguages: async () => ['ja'],
		saveLanguages: () => {},
		fetchJson: async (url, timeoutMs) => {
			calls.fetchJson.push({url, timeoutMs});
			return {status: 200, json: {error: '', title: '題名', description: '説明', image: 'https://cardyb.bsky.app/v1/image?url=x'}};
		},
		fetchBlob: async (url) => {
			calls.fetchBlob.push(url);
			return {name: 'thumb.jpg', size: 10, type: 'image/jpeg'};
		},
		fetchPost: async (uri) => {
			calls.fetchPost.push(uri);
			return {posts: [quotedPost()]};
		},
		safeHref: (uri) => uri,
		formatDate: (iso) => iso,
		gifLocale: null,
		// 動画のアップロードは結果を返さないまま待つ。テストが calls.videoJobs の finish で終わらせる
		uploadVideo: (blob, onProgress) => {
			const id = `v${calls.videoUploads.length + 1}`;
			calls.videoUploads.push(blob);
			let finish = null;
			const done = new Promise((resolve) => {
				finish = resolve;
			});
			calls.videoJobs.push({id, onProgress, finish});
			return {id, done};
		},
		cancelVideoUpload: (id) => calls.videoCancels.push(id),
		readVideoMeta: async () => ({width: 640, height: 360, duration: 5}),
		...overrides
	};
	const composer = new ReplyComposer(EXT_CONFIG.lightboxReplies, deps, TARGET, 'placeholder');
	composer.el.isConnected = true;
	doc.body.append(composer.el);
	return {composer, calls, state, restore: () => {
		globalThis.document = previous;
	}};
}

test('ReplyComposer: 添付だけでも書きかけになり、画像付きで送ると embed と embed view を渡して空に戻す', async () => {
	const {composer, calls, state, restore} = makeComposer({});
	try {
		assert.strictEqual(composer.hasDraft(), false);
		await composer.active.addFiles([{name: 'a.png', type: 'image/png'}]);
		assert.strictEqual(composer.hasDraft(), true);
		await composer.submit();
		assert.strictEqual(calls.created.length, 1);
		assert.strictEqual(calls.created[0].embed.$type, 'app.bsky.embed.images');
		assert.deepStrictEqual(calls.created[0].langs, ['ja']);
		assert.strictEqual(calls.posted.length, 1);
		assert.strictEqual(calls.posted[0][3].$type, 'app.bsky.embed.images#view');
		assert.strictEqual(composer.active.attachments.length, 0);
		assert.strictEqual(composer.hasDraft(), false);
		assert.strictEqual(state.posting, false);
	} finally {
		restore();
	}
});

test('ReplyComposer: 送信中に世代が変わると onPosted を呼ばない', async () => {
	let made = null;
	made = makeComposer({
		uploadBlob: async () => {
			// アップロードの最中に別の画像へ移った
			made.state.generation += 1;
			return {ok: true, blob: {$type: 'blob', ref: {$link: 'cid'}, mimeType: 'image/jpeg', size: 1}, reason: null};
		}
	});
	const {composer, calls, restore} = made;
	try {
		await composer.active.addFiles([{name: 'a.png', type: 'image/png'}]);
		composer.active.textarea.value = '本文';
		await composer.submit();
		assert.deepStrictEqual(calls.created, []);
		assert.deepStrictEqual(calls.posted, []);
	} finally {
		restore();
	}
});

test('ReplyComposer: createReply が repo-not-self で失敗したら本文と添付が残る', async () => {
	const {composer, calls, restore} = makeComposer({
		actions: {createReply: async () => ({ok: false, uri: null, cid: null, reason: 'repo-not-self'})}
	});
	try {
		await composer.active.addFiles([{name: 'a.png', type: 'image/png'}, {name: 'b.png', type: 'image/png'}]);
		composer.active.textarea.value = '本文';
		await composer.submit();
		assert.deepStrictEqual(calls.posted, []);
		assert.strictEqual(composer.active.textarea.value, '本文');
		assert.strictEqual(composer.active.attachments.length, 2);
		assert.ok(composer.noticeEl, '失敗の 1 行が出ていない');
		assert.strictEqual(composer.noticeEl.textContent, EXT_CONFIG.lightboxReplies.text.postFailed);
		assert.strictEqual(composer.submitButton.disabled, false);
	} finally {
		restore();
	}
});

test('ReplyComposer: 文字だけの貼り付けは止めず、画像の貼り付けは止めて取り込む', async () => {
	const {composer, restore} = makeComposer({});
	try {
		const textPaste = new FakeEvent('paste');
		textPaste.clipboardData = {items: itemList([item('string', 'text/plain', null)])};
		composer.active.onPaste(textPaste);
		assert.strictEqual(textPaste.defaultPrevented, false);
		const imagePaste = new FakeEvent('paste');
		imagePaste.clipboardData = {items: itemList([item('file', 'image/png', {name: 'p.png', type: 'image/png'})])};
		composer.active.onPaste(imagePaste);
		assert.strictEqual(imagePaste.defaultPrevented, true);
		await new Promise((resolve) => setImmediate(resolve));
		assert.strictEqual(composer.active.attachments.length, 1);
	} finally {
		restore();
	}
});

test('ReplyComposer: 11 枚目と対応しない形式は取り込まず 1 行で知らせる', async () => {
	const {composer, restore} = makeComposer({});
	try {
		const files = Array.from({length: 11}, (unused, i) => ({name: `${i}.png`, type: 'image/png'}));
		await composer.active.addFiles(files.concat({name: 'd.pdf', type: 'application/pdf'}));
		assert.strictEqual(composer.active.attachments.length, EXT_CONFIG.lightboxReplies.compose.maxImages);
		const text = EXT_CONFIG.lightboxReplies.compose.text;
		assert.ok(composer.active.noticeEl.textContent.includes(text.tooManyImages));
		assert.ok(composer.active.noticeEl.textContent.includes(text.unsupportedImage));
	} finally {
		restore();
	}
});

test('ReplyComposer: 送信中に入力欄が外されても、同じ世代なら送れた返信を onPosted に渡す', async () => {
	let made = null;
	made = makeComposer({
		actions: {createReply: async (record) => {
			made.calls.created.push(record);
			// 返信の作成を待つあいだに描き直しで入力欄が外された
			made.composer.destroy();
			return {ok: true, uri: 'at://did:plc:me/app.bsky.feed.post/r1', cid: 'cid-r1', reason: null};
		}}
	});
	const {composer, calls, state, restore} = made;
	try {
		composer.active.textarea.value = '本文';
		await composer.submit();
		assert.strictEqual(calls.created.length, 1);
		assert.strictEqual(calls.posted.length, 1);
		assert.strictEqual(calls.posted[0][0].cid, 'cid-r1');
		assert.strictEqual(state.posting, false);
	} finally {
		restore();
	}
});

test('ReplyComposer: アップロード中に外されても、同じ世代なら返信を作る', async () => {
	let made = null;
	made = makeComposer({
		uploadBlob: async () => {
			made.composer.destroy();
			return {ok: true, blob: {$type: 'blob', ref: {$link: 'cid'}, mimeType: 'image/jpeg', size: 1}, reason: null};
		}
	});
	const {composer, calls, restore} = made;
	try {
		await composer.active.addFiles([{name: 'a.png', type: 'image/png'}]);
		await composer.submit();
		assert.strictEqual(calls.created.length, 1);
		assert.strictEqual(calls.posted.length, 1);
	} finally {
		restore();
	}
});

test('ReplyComposer: 本文だけの返信は embed も labels も付けず、facets を付け、embed view は null', async () => {
	const {composer, calls, restore} = makeComposer({});
	try {
		composer.active.labels = {adult: 'porn', graphic: true};
		composer.active.textarea.value = 'テスト https://bsky.app #test';
		await composer.submit();
		const record = calls.created[0];
		assert.strictEqual('embed' in record, false);
		assert.strictEqual('labels' in record, false);
		assert.ok(Array.isArray(record.facets) && record.facets.length === 2, 'リンクとタグの facets が無い');
		// リンクはスキームを除いた短い形で保存し、facet の uri は元のまま
		assert.strictEqual(record.text, 'テスト bsky.app #test');
		assert.strictEqual(record.facets[0].features[0].uri, 'https://bsky.app');
		assert.strictEqual(calls.posted[0][3], null);
	} finally {
		restore();
	}
});

test('ReplyComposer: 送信ボタンにいま送っている枚目を出す (1 枚目の最中は 1/2)', async () => {
	const seen = [];
	let made = null;
	made = makeComposer({
		uploadBlob: async () => {
			seen.push(made.composer.submitButton.textContent);
			return {ok: true, blob: {$type: 'blob', ref: {$link: `c${seen.length}`}, mimeType: 'image/jpeg', size: 1}, reason: null};
		}
	});
	const {composer, restore} = made;
	try {
		await composer.active.addFiles([{name: 'a.png', type: 'image/png'}, {name: 'b.png', type: 'image/png'}]);
		await composer.submit();
		assert.deepStrictEqual(seen, ['送信中 1/2', '送信中 2/2']);
		assert.strictEqual(composer.submitButton.textContent, EXT_CONFIG.lightboxReplies.text.submit);
	} finally {
		restore();
	}
});

test('ReplyComposer: 言語の提案を閉じたら、送った後も出さない', async () => {
	const {composer, restore} = makeComposer({parentLangs: ['en']});
	try {
		await new Promise((resolve) => setImmediate(resolve));
		assert.strictEqual(composer.suggestEl.hidden, false);
		composer.suggestDismissed = true;
		composer.renderSuggest();
		composer.active.textarea.value = '本文';
		await composer.submit();
		await new Promise((resolve) => setImmediate(resolve));
		assert.strictEqual(composer.suggestEl.hidden, true);
	} finally {
		restore();
	}
});

test('ReplyComposer: 提案で切り替えた言語は、覚えた言語が空でも送った後に持ち越さない', async () => {
	const {composer, calls, restore} = makeComposer({parentLangs: ['en'], loadLanguages: async () => []});
	try {
		await new Promise((resolve) => setImmediate(resolve));
		composer.acceptSuggestion();
		assert.deepStrictEqual(composer.languages, ['en']);
		composer.active.textarea.value = '本文';
		await composer.submit();
		assert.deepStrictEqual(calls.created[0].langs, ['en']);
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepStrictEqual(composer.languages, []);
	} finally {
		restore();
	}
});

test('ReplyComposer: 切り抜き直しの最中でも 10 枚目を取り込める (枚数に数えない)', async () => {
	let release = null;
	let made = null;
	made = makeComposer({});
	const {composer, restore} = made;
	try {
		const files = Array.from({length: 9}, (unused, i) => ({name: `${i}.png`, type: 'image/png'}));
		await composer.active.addFiles(files);
		assert.strictEqual(composer.active.attachments.length, 9);
		const original = composer.deps.prepareImage;
		composer.deps.prepareImage = (file, crop, rules) => (crop
			? new Promise((resolve) => {
				release = () => resolve(original(file, crop, rules));
			})
			: original(file, crop, rules));
		const recropping = composer.active.recrop(composer.active.attachments[0], {x: 0, y: 0, width: 10, height: 10});
		assert.strictEqual(composer.submitButton.disabled, true);
		await composer.active.addFiles([{name: '9.png', type: 'image/png'}]);
		assert.strictEqual(composer.active.attachments.length, 10);
		assert.strictEqual(composer.active.noticeEl, null);
		release();
		await recropping;
	} finally {
		restore();
	}
});

test('ReplyComposer: 送信中も画像のドラッグの既定の動作を止め、取り込まない', async () => {
	const {composer, restore} = makeComposer({});
	try {
		composer.busy = true;
		const transfer = {items: itemList([item('file', 'image/png', null)]), files: [{name: 'x.png', type: 'image/png'}]};
		const over = new FakeEvent('dragover');
		over.dataTransfer = transfer;
		composer.active.onDragOver(over);
		assert.strictEqual(over.defaultPrevented, true);
		assert.strictEqual(transfer.dropEffect, EXT_CONFIG.lightboxReplies.compose.noDropEffect);
		const drop = new FakeEvent('drop');
		drop.dataTransfer = transfer;
		composer.active.onDrop(drop);
		assert.strictEqual(drop.defaultPrevented, true);
		await new Promise((resolve) => setImmediate(resolve));
		assert.strictEqual(composer.active.attachments.length, 0);
		const text = new FakeEvent('dragover');
		text.dataTransfer = {items: itemList([item('string', 'text/plain', null)])};
		composer.active.onDragOver(text);
		assert.strictEqual(text.defaultPrevented, false);
	} finally {
		restore();
	}
});

test('ComposerPost: 共通の行を外して付け直しても投稿の要素は外れず、並びは画像・GIF・絵文字・言語・残り・送信', () => {
	const {composer, restore} = makeComposer({});
	try {
		const post = composer.active;
		const textareaParent = post.textarea.parentNode;
		const imageParent = post.imageTool.parentNode;
		const own = [post.textarea, textareaParent, textareaParent.parentNode, post.fileInput, post.imageTool,
			post.gifTool, post.emojiTool, post.toolbarEl];
		const removed = [];
		for (const parent of [post.el, post.toolbarEl, textareaParent, textareaParent.parentNode]) {
			const original = parent.removeChild.bind(parent);
			parent.removeChild = (node) => {
				removed.push(node);
				original(node);
			};
		}
		const shared = [composer.languageButton, composer.remaining, composer.submitButton];
		const expectToolbar = [post.fileInput, post.imageTool, post.gifTool, post.emojiTool].concat(shared);
		// 要素どうしを deepStrictEqual で比べると、失敗の差分が偽の DOM の木全体を辿るため同一性で比べる
		const sameNodes = (actual, expected) => actual.length === expected.length && actual.every((node, i) => node === expected[i]);
		const assertMounted = () => {
			assert.ok(sameNodes(post.toolbarEl.children, expectToolbar), 'ツールバーの並びが違う');
			const children = post.el.children;
			assert.strictEqual(children.indexOf(composer.suggestEl), children.indexOf(post.toolbarEl) - 1);
		};
		assertMounted();
		post.mountShared([]);
		assert.ok(sameNodes(post.toolbarEl.children, [post.fileInput, post.imageTool, post.gifTool, post.emojiTool]),
			'外した後のツールバーが投稿の要素だけでない');
		assert.strictEqual(post.el.contains(composer.suggestEl), false);
		composer.mountShared(post);
		assertMounted();
		// 付けたままもう一度付けても並びは変わらない
		composer.mountShared(post);
		assertMounted();
		assert.ok(post.textarea.parentNode === textareaParent, '本文の欄の親が変わった');
		assert.ok(post.imageTool.parentNode === imageParent, '画像ボタンの親が変わった');
		assert.strictEqual(removed.filter((node) => own.includes(node)).length, 0, '投稿の要素が外された');
	} finally {
		restore();
	}
});

test('ComposerPost: 画像の送信が失敗したら送る中身の控えを残さない', async () => {
	const {composer, calls, restore} = makeComposer({
		uploadBlob: async () => ({ok: false, blob: null, reason: 'upload-failed'})
	});
	try {
		await composer.active.addFiles([{name: 'a.png', type: 'image/png'}]);
		await composer.submit();
		assert.deepStrictEqual(calls.created, []);
		assert.strictEqual(composer.active.noticeEl.textContent, EXT_CONFIG.lightboxReplies.compose.text.uploadFailed);
		assert.ok(composer.active.sending === null, '送る中身の控えが残っている');
		assert.strictEqual(composer.active.attachments.length, 1);
	} finally {
		restore();
	}
});

/**
 * 本物の SheetHost を持つパネルの中に入力欄を作る。
 * @returns {{composer: ReplyComposer, host: SheetHost, panel: Object, restore: () => void}}
 */
function makeComposerWithSheets() {
	const made = makeComposer({});
	const doc = globalThis.document;
	const panel = doc.createElement('aside');
	doc.body.append(panel);
	const host = new SheetHost(panel, EXT_CONFIG.lightboxReplies.compose);
	made.composer.deps.sheets = host;
	panel.append(made.composer.el);
	return {composer: made.composer, calls: made.calls, host, panel, restore: made.restore};
}

test('ReplyComposer: ALT の画面を開いた後に添付を描き直しても、入力欄を外せば画面も閉じる', async () => {
	const {composer, host, restore} = makeComposerWithSheets();
	try {
		await composer.active.addFiles([{name: 'a.png', type: 'image/png'}]);
		const attachment = composer.active.attachments[0];
		click(attachment.cell.altButton);
		assert.strictEqual(host.isOpen(), true);
		composer.active.renderAttachments();
		assert.strictEqual(host.isOpenedFrom(composer.el), true);
		composer.destroy();
		assert.strictEqual(host.isOpen(), false);
	} finally {
		restore();
	}
});

test('ReplyComposer: ALT の画面を閉じたとき、描き直したマスの ALT ボタンへフォーカスを戻す', async () => {
	const {composer, host, panel, restore} = makeComposerWithSheets();
	try {
		await composer.active.addFiles([{name: 'a.png', type: 'image/png'}]);
		const attachment = composer.active.attachments[0];
		const before = attachment.cell.altButton;
		click(before);
		composer.active.renderAttachments();
		const after = attachment.cell.altButton;
		assert.ok(after !== before, '描き直してもボタンが同じ');
		click(panel.querySelector(`[data-role="${EXT_CONFIG.lightboxReplies.compose.sheetRoles.done}"]`));
		assert.strictEqual(host.isOpen(), false);
		assert.ok(globalThis.document.activeElement === after, '描き直した ALT ボタンへ戻らない');
	} finally {
		restore();
	}
});

test('ReplyComposer: 長いリンクは短い形で送り、facet の uri は元のまま', async () => {
	const {composer, calls, restore} = makeComposer({});
	try {
		const url = `https://example.com/${'a'.repeat(400)}`;
		composer.active.textarea.value = `見て ${url} です`;
		composer.active.textarea.dispatchEvent(new FakeEvent('input'));
		// 元の本文は 300 字を超えるが、短くした本文で数えるので送れる
		assert.strictEqual(composer.submitButton.disabled, false);
		const short = 'example.com/aaaaaaaaaaaa...';
		const remaining = EXT_CONFIG.lightboxReplies.limits.maxGraphemes - (3 + short.length + 3);
		assert.strictEqual(composer.remaining.textContent, `${EXT_CONFIG.lightboxReplies.text.remaining} ${remaining}`);
		await composer.submit();
		const record = calls.created[0];
		assert.strictEqual(record.text, `見て ${short} です`);
		assert.strictEqual(record.facets.length, 1);
		assert.deepStrictEqual(record.facets[0].index, {byteStart: 7, byteEnd: 7 + short.length});
		assert.strictEqual(record.facets[0].features[0].uri, url);
		// 打っただけ (貼り付けでも打ち終わりでもない) のリンクはカードを引かない
		assert.deepStrictEqual(calls.fetchJson, []);
	} finally {
		restore();
	}
});

test('ReplyComposer: GIF と画像の排他の 1 行は GIF を外すと消え、送信失敗の 1 行は残る', async () => {
	const {composer, restore} = makeComposer({});
	const text = EXT_CONFIG.lightboxReplies.compose.text;
	try {
		composer.active.extras.setGif(gifItem());
		click(composer.active.imageTool);
		assert.strictEqual(composer.active.noticeEl.textContent, text.gifExclusive);
		composer.active.extras.removeGif();
		assert.strictEqual(composer.active.noticeEl, null);
		// 別の知らせは GIF を外しても消さない
		composer.active.extras.setGif(gifItem());
		composer.active.showNotice([text.imageLoadFailed]);
		composer.active.extras.removeGif();
		assert.strictEqual(composer.active.noticeEl.textContent, text.imageLoadFailed);
		// 送った後の初期化でも排他の 1 行は残らない
		composer.active.extras.setGif(gifItem());
		click(composer.active.imageTool);
		composer.resetAfterPost();
		assert.strictEqual(composer.active.noticeEl, null);
	} finally {
		restore();
	}
});

test('ReplyComposer: 本文の末尾の空白は送らず、link facet は正しい範囲を指す', async () => {
	const {composer, calls, restore} = makeComposer({});
	try {
		composer.active.textarea.value = 'テスト https://example.com ';
		composer.active.textarea.dispatchEvent(new FakeEvent('input'));
		await composer.submit();
		assert.strictEqual(calls.created.length, 1);
		const record = calls.created[0];
		assert.strictEqual(record.text, record.text.trimEnd());
		const facet = record.facets.find((f) => f.features[0].$type === 'app.bsky.richtext.facet#link');
		const bytes = new TextEncoder().encode(record.text);
		assert.strictEqual(new TextDecoder().decode(bytes.slice(facet.index.byteStart, facet.index.byteEnd)), 'example.com');
		assert.strictEqual(facet.index.byteEnd, bytes.length);
	} finally {
		restore();
	}
});

test('ReplyComposer: GIF を付けると画像ボタンが止まり、送ると external (hh・ww 付き) と ALT: <title>', async () => {
	const seen = [];
	let made = null;
	made = makeComposer({
		uploadBlob: async () => {
			seen.push(made.composer.submitButton.textContent);
			return {ok: true, blob: {$type: 'blob', ref: {$link: 'bafythumb'}, mimeType: 'image/jpeg', size: 1}, reason: null};
		}
	});
	const {composer, calls, restore} = made;
	const text = EXT_CONFIG.lightboxReplies.compose.text;
	try {
		// 画像があるあいだは GIF のボタンを止める
		await composer.active.addFiles([{name: 'a.png', type: 'image/png'}]);
		assert.strictEqual(composer.active.gifTool.disabled, true);
		composer.active.removeAttachment(composer.active.attachments[0]);
		assert.strictEqual(composer.active.gifTool.disabled, false);
		composer.active.extras.setGif(gifItem());
		assert.strictEqual(composer.active.embedEl.hidden, false);
		// GIF があるあいだは画像のボタン・取り込み・貼り付けで画像を足さない
		click(composer.active.imageTool);
		assert.strictEqual(composer.active.noticeEl.textContent, text.gifExclusive);
		await composer.active.addFiles([{name: 'b.png', type: 'image/png'}]);
		const imagePaste = new FakeEvent('paste');
		imagePaste.clipboardData = {items: itemList([item('file', 'image/png', {name: 'p.png', type: 'image/png'})])};
		composer.active.onPaste(imagePaste);
		assert.strictEqual(imagePaste.defaultPrevented, true);
		await flush();
		assert.strictEqual(composer.active.attachments.length, 0);
		assert.strictEqual(composer.active.importing, 0);
		assert.strictEqual(composer.submitButton.disabled, false);
		await composer.submit();
		const embed = calls.created[0].embed;
		assert.strictEqual(embed.$type, 'app.bsky.embed.external');
		const uri = new URL(embed.external.uri);
		assert.strictEqual(uri.searchParams.get('hh'), '240');
		assert.strictEqual(uri.searchParams.get('ww'), '320');
		assert.strictEqual(embed.external.description, 'ALT: 踊る猫');
		assert.strictEqual(embed.external.thumb.ref.$link, 'bafythumb');
		assert.deepStrictEqual(calls.fetchBlob, [gifItem().previewUrl]);
		assert.deepStrictEqual(seen, ['送信中 1/1']);
		assert.strictEqual(calls.posted[0][3].$type, 'app.bsky.embed.external#view');
		assert.strictEqual(composer.active.extras.gif, null);
		assert.strictEqual(composer.hasDraft(), false);
	} finally {
		restore();
	}
});

test('ReplyComposer: 引用だけなら record、引用 + 画像なら recordWithMedia で、ラベルのボタンは引用だけでは出ない', async () => {
	const postUrl = 'https://bsky.app/profile/did:plc:quoted/post/q1';
	const only = makeComposer({});
	try {
		pasteText(only.composer, `これ ${postUrl}`);
		await flush();
		assert.strictEqual(only.composer.active.extras.quote.status, 'ready');
		assert.deepStrictEqual(only.calls.fetchPost, [QUOTED_URI]);
		assert.strictEqual(only.composer.active.labelsButton.hidden, true);
		await only.composer.submit();
		assert.deepStrictEqual(only.calls.created[0].embed, {
			$type: 'app.bsky.embed.record', record: {uri: QUOTED_URI, cid: 'cid-q1'}
		});
		assert.strictEqual(only.calls.posted[0][3].$type, 'app.bsky.embed.record#view');
	} finally {
		only.restore();
	}
	const withImage = makeComposer({});
	try {
		pasteText(withImage.composer, postUrl);
		await flush();
		await withImage.composer.active.addFiles([{name: 'a.png', type: 'image/png'}]);
		assert.strictEqual(withImage.composer.active.labelsButton.hidden, false);
		await withImage.composer.submit();
		const embed = withImage.calls.created[0].embed;
		assert.strictEqual(embed.$type, 'app.bsky.embed.recordWithMedia');
		assert.strictEqual(embed.media.$type, 'app.bsky.embed.images');
		assert.deepStrictEqual(embed.record, {$type: 'app.bsky.embed.record', record: {uri: QUOTED_URI, cid: 'cid-q1'}});
		assert.strictEqual(withImage.calls.posted[0][3].$type, 'app.bsky.embed.recordWithMedia#view');
	} finally {
		withImage.restore();
	}
});

test('ReplyComposer: カードを出した後に画像を足すとカードを送らず、画像を外すとカードが戻る', async () => {
	const {composer, calls, restore} = makeComposer({});
	const cardSelector = `.${EXT_CONFIG.lightboxReplies.cards.classes.linkCard}`;
	try {
		pasteText(composer, 'https://example.com/article');
		await flush();
		assert.strictEqual(calls.fetchJson.length, 1);
		assert.ok(composer.active.embedEl.querySelector(cardSelector), 'カードが出ていない');
		await composer.active.addFiles([{name: 'a.png', type: 'image/png'}]);
		assert.strictEqual(composer.active.embedEl.querySelector(cardSelector), null);
		composer.active.removeAttachment(composer.active.attachments[0]);
		assert.ok(composer.active.embedEl.querySelector(cardSelector), '画像を外してもカードが戻らない');
		await composer.active.addFiles([{name: 'b.png', type: 'image/png'}]);
		await composer.submit();
		const embed = calls.created[0].embed;
		assert.strictEqual(embed.$type, 'app.bsky.embed.images');
		assert.deepStrictEqual(calls.fetchBlob, []);
	} finally {
		restore();
	}
});

test('ReplyComposer: カードを外してメディアも無くなったらラベルの選択を空に戻す', async () => {
	const {composer, calls, restore} = makeComposer({});
	try {
		pasteText(composer, 'https://example.com/article');
		await flush();
		assert.strictEqual(composer.active.labelsButton.hidden, false);
		composer.active.labels = {adult: 'porn', graphic: true};
		composer.active.renderLabels();
		composer.active.extras.removeCard();
		assert.strictEqual(composer.active.labelsButton.hidden, true);
		assert.deepStrictEqual(composer.active.labels, {adult: null, graphic: false});
		await composer.submit();
		assert.strictEqual('labels' in calls.created[0], false);
	} finally {
		restore();
	}
});

test('ReplyComposer: GIF だけでも書きかけになり Escape で閉じない (hasDraft が真)', () => {
	const {composer, restore} = makeComposer({});
	try {
		assert.strictEqual(composer.hasDraft(), false);
		composer.active.extras.setGif(gifItem());
		assert.strictEqual(composer.hasDraft(), true);
		composer.active.extras.removeGif();
		assert.strictEqual(composer.hasDraft(), false);
	} finally {
		restore();
	}
});

test('ReplyComposer: GIF・カード・引用の × で外した後は本文の欄にフォーカスがある', async () => {
	const classes = EXT_CONFIG.lightboxReplies.cards.classes;
	const removeButton = (composer) => composer.active.embedEl.querySelector(`.${classes.remove}`);
	const gif = makeComposer({});
	try {
		gif.composer.active.extras.setGif(gifItem());
		const button = removeButton(gif.composer);
		button.focus();
		click(button);
		assert.strictEqual(gif.composer.active.extras.gif, null);
		assert.ok(globalThis.document.activeElement === gif.composer.active.textarea, 'GIF の × の後に本文の欄へ移らない');
	} finally {
		gif.restore();
	}
	const card = makeComposer({});
	try {
		pasteText(card.composer, 'https://example.com/article');
		await flush();
		const button = removeButton(card.composer);
		button.focus();
		click(button);
		assert.strictEqual(card.composer.active.extras.card, null);
		assert.ok(globalThis.document.activeElement === card.composer.active.textarea, 'カードの × の後に本文の欄へ移らない');
	} finally {
		card.restore();
	}
	const quote = makeComposer({});
	try {
		pasteText(quote.composer, 'https://bsky.app/profile/did:plc:quoted/post/q1');
		await flush();
		// 引用の URL はカードにしないため、× は引用のものだけ
		const button = removeButton(quote.composer);
		button.focus();
		click(button);
		assert.strictEqual(quote.composer.active.extras.quote, null);
		assert.ok(globalThis.document.activeElement === quote.composer.active.textarea, '引用の × の後に本文の欄へ移らない');
	} finally {
		quote.restore();
	}
});

test('ReplyComposer: GIF の ALT を保存した後は、描き直した ALT ボタンにフォーカスがある', () => {
	const {composer, panel, restore} = makeComposerWithSheets();
	const altSelector = `.${EXT_CONFIG.lightboxReplies.cards.classes.gifAlt}`;
	try {
		composer.active.extras.setGif(gifItem());
		const before = composer.active.embedEl.querySelector(altSelector);
		click(before);
		click(panel.querySelector(`[data-role="${EXT_CONFIG.lightboxReplies.compose.sheetRoles.done}"]`));
		const after = composer.active.embedEl.querySelector(altSelector);
		assert.ok(after && after !== before, 'ALT ボタンが描き直されていない');
		assert.ok(globalThis.document.activeElement === after, '描き直した ALT ボタンへ移らない');
	} finally {
		restore();
	}
});

test('ReplyComposer: GIF の ALT の画面は題名から始まり、external の説明に収まる長さまでしか保存できない', async () => {
	const {composer, calls, panel, restore} = makeComposerWithSheets();
	const compose = EXT_CONFIG.lightboxReplies.compose;
	const maxDescription = BRIDGE_PROTOCOL.postRecord.external.maxDescriptionGraphemes;
	const maxAlt = maxDescription - GIF_ALT_PREFIX.length;
	try {
		composer.active.extras.setGif(gifItem());
		click(composer.active.embedEl.querySelector(`.${EXT_CONFIG.lightboxReplies.cards.classes.gifAlt}`));
		const field = panel.querySelector(`.${compose.classes.altInput}`);
		const done = panel.querySelector(`[data-role="${compose.sheetRoles.done}"]`);
		assert.strictEqual(field.value, gifItem().title);
		// 画像の ALT の上限 (2000) より短い
		assert.ok(maxAlt < compose.maxAltGraphemes);
		field.value = 'a'.repeat(maxAlt + 1);
		field.dispatchEvent(new FakeEvent('input'));
		assert.strictEqual(done.disabled, true);
		field.value = 'a'.repeat(maxAlt);
		field.dispatchEvent(new FakeEvent('input'));
		assert.strictEqual(done.disabled, false);
		click(done);
		assert.strictEqual(composer.active.extras.gif.alt, 'a'.repeat(maxAlt));
		await composer.submit();
		const description = calls.created[0].embed.external.description;
		assert.strictEqual(description, GIF_ALT_PREFIX + 'a'.repeat(maxAlt));
		assert.strictEqual(description.length, maxDescription);
	} finally {
		restore();
	}
});

/** 処理を終えた動画の BlobRef */
const VIDEO_BLOB = {$type: 'blob', ref: {$link: 'bafyvideo'}, mimeType: 'video/mp4', size: 100};

/**
 * 偽の動画のファイル。
 * @param {string} [name] ファイル名
 * @returns {{name: string, type: string, size: number}}
 */
function videoFile(name = 'v.mp4') {
	return {name, type: 'video/mp4', size: 1000};
}

/**
 * 動画を取り込み、アップロードと処理を終えたことにする。
 * @param {{composer: ReplyComposer, calls: Object}} made
 * @returns {Promise<void>}
 */
async function addReadyVideo(made) {
	await made.composer.active.addFiles([videoFile()]);
	await flush();
	const job = made.calls.videoJobs[made.calls.videoJobs.length - 1];
	job.finish({ok: true, blob: VIDEO_BLOB, reason: null, message: null});
	await flush();
}

test('ReplyComposer: 動画を付けると処理が終わるまで送信できず、終わると動画だけで送れる', async () => {
	const made = makeComposer({});
	const {composer, calls, restore} = made;
	try {
		await composer.active.addFiles([videoFile()]);
		await flush();
		assert.strictEqual(calls.videoUploads.length, 1);
		assert.strictEqual(composer.active.video.isPending(), true);
		assert.strictEqual(composer.submitButton.disabled, true);
		assert.strictEqual(composer.active.videoEl.hidden, false);
		await composer.submit();
		assert.deepStrictEqual(calls.created, []);
		calls.videoJobs[0].finish({ok: true, blob: VIDEO_BLOB, reason: null, message: null});
		await flush();
		assert.strictEqual(composer.active.video.isReady(), true);
		// 本文が空でも動画だけで送れる
		assert.strictEqual(composer.submitButton.disabled, false);
		await composer.submit();
		assert.strictEqual(calls.created.length, 1);
		const embed = calls.created[0].embed;
		assert.strictEqual(embed.$type, 'app.bsky.embed.video');
		assert.deepStrictEqual(embed.video, VIDEO_BLOB);
		assert.deepStrictEqual(embed.aspectRatio, {width: 640, height: 360});
		assert.strictEqual('captions' in embed, false);
		// 字幕が無ければ upload-blob は呼ばない
		assert.strictEqual(calls.uploads, 0);
		assert.strictEqual(calls.posted[0][3].$type, 'app.bsky.embed.video#view');
		assert.strictEqual(composer.active.video.isActive(), false);
		assert.strictEqual(composer.active.videoEl.hidden, true);
		assert.strictEqual(composer.hasDraft(), false);
	} finally {
		restore();
	}
});

test('ReplyComposer: 字幕付きで送ると字幕を upload-blob で先に送り、captions に入れる', async () => {
	const seen = [];
	let made = null;
	made = makeComposer({
		uploadBlob: async (blob) => {
			seen.push({blob, label: made.composer.submitButton.textContent});
			return {ok: true, blob: {$type: 'blob', ref: {$link: 'bafycaption'}, mimeType: 'text/vtt', size: 10}, reason: null};
		}
	});
	const {composer, calls, restore} = made;
	try {
		await addReadyVideo(made);
		const captionBlob = {size: 10, type: 'text/vtt'};
		composer.active.video.setAlt('動画の説明');
		composer.active.video.setCaption({blob: captionBlob, name: 'c.vtt', lang: 'ja'});
		await composer.submit();
		assert.strictEqual(seen.length, 1);
		assert.ok(seen[0].blob === captionBlob, '字幕の Blob を送っていない');
		assert.strictEqual(seen[0].label, '送信中 1/1');
		const embed = calls.created[0].embed;
		assert.strictEqual(embed.$type, 'app.bsky.embed.video');
		assert.strictEqual(embed.alt, '動画の説明');
		assert.deepStrictEqual(embed.captions, [{
			lang: 'ja', file: {$type: 'blob', ref: {$link: 'bafycaption'}, mimeType: 'text/vtt', size: 10}
		}]);
		assert.strictEqual(calls.posted[0][3].alt, '動画の説明');
	} finally {
		restore();
	}
});

test('ReplyComposer: 字幕の送信が失敗すると返信を作らず、字幕を送れませんでしたを出して動画を残す', async () => {
	const made = makeComposer({
		uploadBlob: async () => ({ok: false, blob: null, reason: 'upload-failed'})
	});
	const {composer, calls, restore} = made;
	try {
		await addReadyVideo(made);
		composer.active.textarea.value = '本文';
		composer.active.video.setCaption({blob: {size: 10}, name: 'c.vtt', lang: 'ja'});
		await composer.submit();
		assert.deepStrictEqual(calls.created, []);
		assert.strictEqual(composer.active.noticeEl.textContent, EXT_CONFIG.lightboxReplies.compose.text.captionUploadFailed);
		assert.strictEqual(composer.active.video.isReady(), true);
		assert.ok(composer.active.video.state.caption, '字幕が消えた');
		assert.strictEqual(composer.active.textarea.value, '本文');
		assert.strictEqual(composer.submitButton.disabled, false);
	} finally {
		restore();
	}
});

test('ReplyComposer: 動画と画像を同じ回に渡すと動画は取り込まず排他の 1 行を出し、画像は取り込む', async () => {
	const {composer, calls, restore} = makeComposer({});
	const text = EXT_CONFIG.lightboxReplies.compose.text;
	try {
		await composer.active.addFiles([{name: 'a.png', type: 'image/png'}, videoFile()]);
		await flush();
		assert.strictEqual(composer.active.attachments.length, 1);
		assert.strictEqual(composer.active.video.isActive(), false);
		assert.deepStrictEqual(calls.videoUploads, []);
		assert.ok(composer.active.noticeEl.textContent.includes(text.videoExclusive));
		// 画像があるあいだに動画だけを渡しても取り込まない
		await composer.active.addFiles([videoFile()]);
		assert.strictEqual(composer.active.video.isActive(), false);
		assert.strictEqual(composer.active.noticeEl.textContent, text.videoExclusive);
		composer.active.removeAttachment(composer.active.attachments[0]);
		// 2 本は取り込まない
		await composer.active.addFiles([videoFile('a.mp4'), videoFile('b.mp4')]);
		assert.strictEqual(composer.active.video.isActive(), false);
		assert.strictEqual(composer.active.noticeEl.textContent, text.tooManyVideos);
		await composer.active.addFiles([videoFile('a.mp4')]);
		assert.strictEqual(composer.active.video.isActive(), true);
		await composer.active.addFiles([videoFile('b.mp4')]);
		assert.strictEqual(composer.active.noticeEl.textContent, text.tooManyVideos);
		assert.strictEqual(calls.videoUploads.length, 1);
	} finally {
		restore();
	}
});

test('ReplyComposer: 受け付けない形式の動画は画像として扱わず、動画の形式の知らせを出す', async () => {
	const made = makeComposer({});
	const {composer, calls, restore} = made;
	const text = EXT_CONFIG.lightboxReplies.compose.text;
	try {
		await composer.active.addFiles([{name: 'a.mkv', type: 'video/x-matroska', size: 1000}]);
		await flush();
		assert.strictEqual(composer.active.noticeEl.textContent, text.videoUnsupported);
		assert.strictEqual(composer.active.attachments.length, 0);
		assert.strictEqual(composer.active.video.isActive(), false);
		assert.ok(!composer.active.noticeEl.textContent.includes(text.unsupportedImage));
		// 画像の知らせは今までどおり
		await composer.active.addFiles([{name: 'a.bmp', type: 'image/bmp', size: 1000}]);
		await flush();
		assert.strictEqual(composer.active.noticeEl.textContent, text.unsupportedImage);
		// 受け付ける画像と一緒なら、画像は取り込んで動画の形式だけを知らせる
		await composer.active.addFiles([{name: 'a.avi', type: 'video/x-msvideo', size: 1000}, {name: 'a.png', type: 'image/png'}]);
		await flush();
		assert.strictEqual(composer.active.attachments.length, 1);
		assert.strictEqual(composer.active.noticeEl.textContent, text.videoUnsupported);
		composer.active.removeAttachment(composer.active.attachments[0]);
		// 受け付ける動画と一緒なら、動画は取り込み、形式の知らせを残す
		await composer.active.addFiles([{name: 'a.m4v', type: 'video/x-m4v', size: 1000}, videoFile()]);
		await flush();
		assert.strictEqual(composer.active.video.isActive(), true);
		assert.strictEqual(calls.videoUploads.length, 1);
		assert.strictEqual(composer.active.noticeEl.textContent, text.videoUnsupported);
	} finally {
		restore();
	}
});

test('ReplyComposer: 動画があるあいだ GIF ボタンが止まり、画像は取り込まない', async () => {
	const made = makeComposer({});
	const {composer, restore} = made;
	const text = EXT_CONFIG.lightboxReplies.compose.text;
	try {
		assert.strictEqual(composer.active.gifTool.disabled, false);
		await addReadyVideo(made);
		assert.strictEqual(composer.active.mediaCount(), 1);
		assert.strictEqual(composer.active.gifTool.disabled, true);
		await composer.active.addFiles([{name: 'a.png', type: 'image/png'}]);
		await flush();
		assert.strictEqual(composer.active.attachments.length, 0);
		assert.strictEqual(composer.active.importing, 0);
		assert.strictEqual(composer.active.noticeEl.textContent, text.videoExclusive);
		// 画像の貼り付けも取り込まない
		const imagePaste = new FakeEvent('paste');
		imagePaste.clipboardData = {items: itemList([item('file', 'image/png', {name: 'p.png', type: 'image/png'})])};
		composer.active.onPaste(imagePaste);
		await flush();
		assert.strictEqual(composer.active.attachments.length, 0);
		// 動画を外すと GIF ボタンが戻る
		composer.active.video.remove();
		assert.strictEqual(composer.active.gifTool.disabled, false);
		// GIF があるあいだは動画を取り込まない
		composer.active.extras.setGif(gifItem());
		await composer.active.addFiles([videoFile()]);
		assert.strictEqual(composer.active.video.isActive(), false);
		assert.strictEqual(composer.active.noticeEl.textContent, text.videoExclusive);
	} finally {
		restore();
	}
});

test('ReplyComposer: 動画があるあいだリンクカードを送らない', async () => {
	const made = makeComposer({});
	const {composer, calls, restore} = made;
	const cardSelector = `.${EXT_CONFIG.lightboxReplies.cards.classes.linkCard}`;
	try {
		pasteText(composer, 'https://example.com/article');
		await flush();
		assert.ok(composer.active.embedEl.querySelector(cardSelector), 'カードが出ていない');
		await addReadyVideo(made);
		assert.strictEqual(composer.active.embedEl.querySelector(cardSelector), null);
		// 動画もラベルの対象
		assert.strictEqual(composer.active.labelsButton.hidden, false);
		await composer.submit();
		const embed = calls.created[0].embed;
		assert.strictEqual(embed.$type, 'app.bsky.embed.video');
		assert.deepStrictEqual(calls.fetchBlob, []);
	} finally {
		restore();
	}
});

test('ReplyComposer: 動画だけでも書きかけになる (hasDraft)', async () => {
	const made = makeComposer({});
	const {composer, restore} = made;
	try {
		assert.strictEqual(composer.hasDraft(), false);
		await composer.active.addFiles([videoFile()]);
		assert.strictEqual(composer.hasDraft(), true);
		made.calls.videoJobs[0].finish({ok: true, blob: VIDEO_BLOB, reason: null, message: null});
		await flush();
		assert.strictEqual(composer.active.video.isReady(), true);
		assert.strictEqual(composer.hasDraft(), true);
		composer.active.video.remove();
		assert.strictEqual(composer.hasDraft(), false);
	} finally {
		restore();
	}
});

test('ReplyComposer: 処理中に destroy すると cancelVideoUpload を送る', async () => {
	const {composer, calls, restore} = makeComposer({});
	try {
		await composer.active.addFiles([videoFile()]);
		await flush();
		assert.strictEqual(calls.videoJobs.length, 1);
		calls.videoJobs[0].onProgress({phase: 'processing', progress: 0.5});
		composer.destroy();
		assert.deepStrictEqual(calls.videoCancels, [calls.videoJobs[0].id]);
	} finally {
		restore();
	}
});

test('ReplyComposer: 動画の ALT ボタンで字幕と ALT の画面が開き、保存した ALT が動画に付く', async () => {
	const made = makeComposerWithSheets();
	const {composer, panel, restore} = made;
	const compose = EXT_CONFIG.lightboxReplies.compose;
	try {
		// プレビューを描くにはオブジェクト URL が要るため、本物の File を渡す
		await composer.active.addFiles([new File(['x'], 'v.mp4', {type: 'video/mp4'})]);
		await flush();
		made.calls.videoJobs[0].finish({ok: true, blob: VIDEO_BLOB, reason: null, message: null});
		await flush();
		const altButton = composer.active.videoEl.querySelector(`.${EXT_CONFIG.lightboxReplies.cards.classes.gifAlt}`);
		assert.ok(altButton, '動画の ALT ボタンが無い');
		click(altButton);
		const field = panel.querySelector(`.${compose.classes.altInput}`);
		assert.ok(field, '字幕と ALT の画面が開かない');
		field.value = '動画の説明';
		click(panel.querySelector(`[data-role="${compose.sheetRoles.done}"]`));
		assert.strictEqual(composer.active.video.state.alt, '動画の説明');
	} finally {
		composer.destroy();
		restore();
	}
});

test('ReplyComposer: 動画が原因の排他の 1 行は動画を外すと消え、動画 1 本までの知らせは残る', async () => {
	const made = makeComposer({});
	const {composer, restore} = made;
	const text = EXT_CONFIG.lightboxReplies.compose.text;
	try {
		await addReadyVideo(made);
		click(composer.active.imageTool);
		assert.strictEqual(composer.active.noticeEl.textContent, text.videoExclusive);
		composer.active.video.remove();
		assert.strictEqual(composer.active.noticeEl, null);
		// 画像を渡して断られた場合も同じ
		await addReadyVideo(made);
		await composer.active.addFiles([{name: 'a.png', type: 'image/png'}]);
		assert.strictEqual(composer.active.noticeEl.textContent, text.videoExclusive);
		composer.active.video.remove();
		assert.strictEqual(composer.active.noticeEl, null);
		// 排他でない知らせは動画を外しても消さない
		await addReadyVideo(made);
		await composer.active.addFiles([videoFile('b.mp4')]);
		assert.strictEqual(composer.active.noticeEl.textContent, text.tooManyVideos);
		composer.active.video.remove();
		assert.strictEqual(composer.active.noticeEl.textContent, text.tooManyVideos);
	} finally {
		restore();
	}
});

test('ReplyComposer: GIF・画像が原因で動画を断った 1 行は、その GIF・画像を外すと消える', async () => {
	const {composer, restore} = makeComposer({});
	const text = EXT_CONFIG.lightboxReplies.compose.text;
	try {
		composer.active.extras.setGif(gifItem());
		await composer.active.addFiles([videoFile()]);
		assert.strictEqual(composer.active.noticeEl.textContent, text.videoExclusive);
		composer.active.extras.removeGif();
		assert.strictEqual(composer.active.noticeEl, null);
		await composer.active.addFiles([{name: 'a.png', type: 'image/png'}]);
		await composer.active.addFiles([videoFile()]);
		assert.strictEqual(composer.active.noticeEl.textContent, text.videoExclusive);
		// 画像が原因の知らせは、本文の入力などで extras が変わっても消えない
		pasteText(composer, 'https://example.com/article');
		await flush();
		assert.strictEqual(composer.active.noticeEl.textContent, text.videoExclusive);
		composer.active.removeAttachment(composer.active.attachments[0]);
		assert.strictEqual(composer.active.noticeEl, null);
	} finally {
		restore();
	}
});

/**
 * 2 件以上の送信の偽の段取りを作る。
 * @param {Object} overrides 差し替える段
 * @returns {{steps: Object, calls: Object}}
 */
function makeThreadSteps(overrides) {
	const calls = {uploads: [], progress: [], built: [], sent: [], posted: [], failed: [], uploadFailed: []};
	const posts = [2, 1].map((count, index) => ({
		images: preparedImages(count).map((image, n) => ({blob: {name: `p${index}-${n}`}})),
		buildRecord: async (blobs) => {
			calls.built.push(index);
			return {text: `post${index}`, blobs};
		},
		onUploadFailed: (reason) => calls.uploadFailed.push({index, reason})
	}));
	const steps = {
		posts,
		upload: async (blob) => {
			calls.uploads.push(blob.name);
			return {ok: true, blob: {ref: {$link: `cid-${blob.name}`}}, reason: null};
		},
		onProgress: (current, total) => calls.progress.push([current, total]),
		isCurrent: () => true,
		send: async (records) => {
			calls.sent.push(records);
			return {
				ok: true,
				results: records.map((r, i) => ({uri: `at://x/${i}`, cid: `c${i}`})),
				writes: records.map((r) => ({value: {...r, chained: true}})),
				reason: null
			};
		},
		onPosted: (results, records, blobsByPost) => calls.posted.push({results, records, blobsByPost}),
		onFailed: (kind, reason) => calls.failed.push({kind, reason}),
		...overrides
	};
	return {steps, calls};
}

test('runThreadSubmit: 全体で通した進み具合で送り、送った value と BlobRef を onPosted に渡す', async () => {
	const {steps, calls} = makeThreadSteps({});
	assert.strictEqual(await runThreadSubmit(steps), 'posted');
	assert.deepStrictEqual(calls.progress, [[1, 3], [2, 3], [3, 3]]);
	assert.strictEqual(calls.sent.length, 1);
	assert.strictEqual(calls.sent[0].length, 2);
	assert.strictEqual(calls.posted.length, 1);
	assert.strictEqual(calls.posted[0].results.length, 2);
	assert.strictEqual(calls.posted[0].records[0].chained, true);
	assert.strictEqual(calls.posted[0].blobsByPost.length, 2);
	assert.strictEqual(calls.posted[0].blobsByPost[0].length, 2);
	assert.strictEqual(calls.posted[0].blobsByPost[1].length, 1);
	assert.deepStrictEqual(calls.failed, []);
});

test('runThreadSubmit: 2 件目の画像が失敗したらその投稿だけに知らせ、record も送信も作らない', async () => {
	const {steps, calls} = makeThreadSteps({
		upload: async (blob) => blob.name === 'p1-0'
			? {ok: false, blob: null, reason: 'boom'}
			: {ok: true, blob: {ref: {$link: blob.name}}, reason: null}
	});
	assert.strictEqual(await runThreadSubmit(steps), 'upload-failed');
	assert.deepStrictEqual(calls.uploadFailed, [{index: 1, reason: 'boom'}]);
	assert.deepStrictEqual(calls.built, []);
	assert.deepStrictEqual(calls.sent, []);
	assert.deepStrictEqual(calls.failed, []);
});

test('runThreadSubmit: send の応答を待つあいだに世代が変わると何も呼ばない', async () => {
	let current = true;
	const {steps, calls} = makeThreadSteps({
		isCurrent: () => current,
		send: async () => {
			current = false;
			return {ok: true, results: [], writes: [], reason: null};
		}
	});
	assert.strictEqual(await runThreadSubmit(steps), 'stale');
	assert.deepStrictEqual(calls.posted, []);
	assert.deepStrictEqual(calls.failed, []);
});

test('runThreadSubmit: thread-unconfirmed は unconfirmed、ほかの理由は post', async () => {
	const unconfirmed = makeThreadSteps({
		send: async () => ({ok: false, results: null, writes: null, reason: 'thread-unconfirmed'})
	});
	assert.strictEqual(await runThreadSubmit(unconfirmed.steps), 'unconfirmed');
	assert.deepStrictEqual(unconfirmed.calls.failed, [{kind: 'unconfirmed', reason: 'thread-unconfirmed'}]);
	const other = makeThreadSteps({
		send: async () => ({ok: false, results: null, writes: null, reason: 'x'})
	});
	assert.strictEqual(await runThreadSubmit(other.steps), 'post-failed');
	assert.deepStrictEqual(other.calls.failed, [{kind: 'post', reason: 'x'}]);
	assert.deepStrictEqual(other.calls.posted, []);
});

test('runThreadSubmit: buildRecord が例外を投げたら post の失敗にし、送信しない', async () => {
	const {steps, calls} = makeThreadSteps({});
	steps.posts[1].buildRecord = async () => {
		throw new Error('bad');
	};
	assert.strictEqual(await runThreadSubmit(steps), 'post-failed');
	assert.strictEqual(calls.failed.length, 1);
	assert.strictEqual(calls.failed[0].kind, 'post');
	assert.deepStrictEqual(calls.sent, []);
});

/** スレッドの入力欄の文言とクラス */
const COMPOSE = EXT_CONFIG.lightboxReplies.compose;

/**
 * 投稿の本文を打ったことにする (値を入れて input を送る)。
 * @param {Object} post ComposerPost
 * @param {string} value 本文
 * @returns {void}
 */
function typeInto(post, value) {
	post.textarea.value = value;
	post.textarea.dispatchEvent(new FakeEvent('input'));
}

/**
 * 条件が満たされるまで待つ (上限を過ぎたら失敗にする)。
 * @param {() => boolean} condition
 * @returns {Promise<void>}
 */
async function waitUntil(condition) {
	const limitMs = 2000;
	const started = Date.now();
	while (!condition()) {
		if (Date.now() - started > limitMs) assert.fail('待っている条件が満たされない');
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

/**
 * 本文を入れた投稿を n 件並べる (1 件目は最初からある投稿)。
 * @param {ReplyComposer} composer
 * @param {string[]} texts 各投稿の本文
 * @returns {void}
 */
function fillPosts(composer, texts) {
	texts.forEach((text, index) => {
		if (index > 0) click(composer.addButton);
		typeInto(composer.posts[index], text);
	});
}

/**
 * 1 件目と同じ形の、検算できる BlobRef を返すアップロードの偽物を作る。
 * @returns {Promise<(blob: Object) => Promise<Object>>}
 */
async function cidUpload() {
	const link = await computeRecordCid({image: 1});
	return async () => ({ok: true, blob: {$type: 'blob', ref: {$link: link}, mimeType: 'image/jpeg', size: 1}, reason: null});
}

test('スレッド: 本文を入れると「＋」が出て、押すとアクティブの後ろに空の投稿が入り本文の欄にフォーカスが移る', () => {
	const {composer, restore} = makeComposer({});
	try {
		assert.strictEqual(composer.addButton.hidden, true);
		assert.strictEqual(composer.addButton.getAttribute('aria-label'), COMPOSE.text.addPost);
		assert.strictEqual(composer.addButton.title, COMPOSE.text.addPost);
		typeInto(composer.active, '1 件目');
		assert.strictEqual(composer.addButton.hidden, false);
		click(composer.addButton);
		assert.strictEqual(composer.posts.length, 2);
		assert.strictEqual(composer.activeIndex, 1);
		assert.ok(document.activeElement === composer.posts[1].textarea, '2 件目の本文の欄にフォーカスが無い');
		assert.strictEqual(composer.posts[1].textarea.placeholder, COMPOSE.text.addPlaceholder);
		assert.strictEqual(composer.posts[1].textarea.getAttribute('aria-label'), COMPOSE.text.addPlaceholder);
		// 2 件目が空のあいだは足せない
		assert.strictEqual(composer.addButton.hidden, true);
		typeInto(composer.posts[1], '2 件目');
		assert.strictEqual(composer.addButton.hidden, false);
		// 1 件目に戻って足すと、1 件目のすぐ後ろに入る
		composer.posts[0].textarea.dispatchEvent(new FakeEvent('focusin'));
		click(composer.addButton);
		assert.strictEqual(composer.posts.length, 3);
		assert.strictEqual(composer.activeIndex, 1);
		assert.strictEqual(composer.posts[2].textarea.value, '2 件目');
		const order = composer.el.children.filter((child) => composer.posts.some((post) => post.el === child));
		assert.ok(order.every((child, i) => child === composer.posts[i].el), '投稿の要素の並びが投稿の並びと違う');
	} finally {
		restore();
	}
});

test('スレッド: 投稿が上限の 10 件になると「＋」が隠れる', () => {
	const {composer, restore} = makeComposer({});
	try {
		const max = COMPOSE.thread.maxPosts;
		fillPosts(composer, Array.from({length: max}, (unused, i) => `本文${i}`));
		assert.strictEqual(composer.posts.length, max);
		assert.strictEqual(composer.addButton.hidden, true);
		composer.addPost();
		assert.strictEqual(composer.posts.length, max);
	} finally {
		restore();
	}
});

test('スレッド: フォーカスの入った投稿がアクティブになり、ほかは薄くツールバーを隠し、共通の行はアクティブに付く', () => {
	const {composer, restore} = makeComposer({});
	const inactive = COMPOSE.classes.postInactive;
	try {
		fillPosts(composer, ['1 件目', '2 件目']);
		const [first, second] = composer.posts;
		assert.ok(first.el.classList.contains(COMPOSE.classes.post), '投稿のクラスが無い');
		first.textarea.dispatchEvent(new FakeEvent('focusin'));
		assert.strictEqual(composer.activeIndex, 0);
		assert.strictEqual(second.el.classList.contains(inactive), true);
		assert.strictEqual(second.toolbarEl.hidden, true);
		assert.strictEqual(first.el.classList.contains(inactive), false);
		second.textarea.dispatchEvent(new FakeEvent('focusin'));
		assert.strictEqual(composer.activeIndex, 1);
		assert.strictEqual(first.el.classList.contains(inactive), true);
		assert.strictEqual(first.toolbarEl.hidden, true);
		assert.strictEqual(second.el.classList.contains(inactive), false);
		assert.strictEqual(second.toolbarEl.hidden, false);
		for (const node of [composer.addButton, composer.languageButton, composer.remaining, composer.submitButton]) {
			assert.ok(second.toolbarEl.contains(node), '共通の行が 2 件目のツールバーに無い');
			assert.strictEqual(first.toolbarEl.contains(node), false);
		}
		// 残りの文字数はアクティブな投稿のもの
		assert.ok(composer.remaining.textContent.endsWith(String(second.check().remaining)));
		// 「×」はアクティブな投稿にだけ出す
		assert.strictEqual(second.removeButton.hidden, false);
		assert.strictEqual(first.removeButton.hidden, true);
	} finally {
		restore();
	}
});

/**
 * 投稿の本文の欄の高さを、次の fitHeight で heights.value にする (偽の DOM は高さを測れないため)。
 * ツールバーの scrollIntoView に渡された引数を返り値の配列へ積む。
 * @param {Object} post ComposerPost
 * @returns {{heights: {value: number}, scrolls: Object[]}}
 */
function watchGrowth(post) {
	const heights = {value: 0};
	const scrolls = [];
	post.textarea.style = {height: ''};
	post.fitHeight = () => {
		post.textarea.style.height = heights.value > 0 ? `${heights.value}px` : '';
	};
	post.toolbarEl.scrollIntoView = (options) => scrolls.push(options);
	return {heights, scrolls};
}

test('スレッド: アクティブな投稿の本文の欄が高くなったときだけ、ツールバーを見える所まで送る', () => {
	const {composer, restore} = makeComposer({});
	try {
		fillPosts(composer, ['1 件目', '2 件目']);
		const second = composer.posts[1];
		const {heights, scrolls} = watchGrowth(second);
		heights.value = 35;
		typeInto(second, '2 件目\n');
		assert.deepStrictEqual(scrolls, [{block: 'nearest', behavior: 'smooth'}]);
		// 高さが変わらない打鍵・縮んだときは送らない
		typeInto(second, '2 件目\nあ');
		heights.value = 20;
		typeInto(second, '2');
		assert.strictEqual(scrolls.length, 1);
		heights.value = 57;
		typeInto(second, '2\n\n');
		assert.strictEqual(scrolls.length, 2);
		assert.ok(second.toolbarEl.contains(composer.submitButton), '送ったツールバーに送信ボタンが無い');
	} finally {
		restore();
	}
});

test('スレッド: 本文が伸びても、アクティブでない投稿・投稿が 1 件のときは送らず、動きを減らす設定なら一気に送る', () => {
	const {composer, restore} = makeComposer({});
	try {
		const first = composer.posts[0];
		const single = watchGrowth(first);
		single.heights.value = 35;
		typeInto(first, '1 件目\n');
		assert.strictEqual(single.scrolls.length, 0, '投稿が 1 件なのに送った');
		click(composer.addButton);
		// 2 件目がアクティブなあいだに 1 件目が伸びても送らない
		single.heights.value = 57;
		typeInto(first, '1 件目\n\n');
		assert.strictEqual(single.scrolls.length, 0, 'アクティブでない投稿で送った');
		const second = composer.posts[1];
		const {heights, scrolls} = watchGrowth(second);
		document.defaultView.matchMedia = (query) => ({matches: query === '(prefers-reduced-motion: reduce)'});
		heights.value = 35;
		typeInto(second, '2 件目\n');
		assert.deepStrictEqual(scrolls, [{block: 'nearest', behavior: 'auto'}]);
	} finally {
		restore();
	}
});

test('スレッド: 投稿が 1 件のあいだは薄くせず「×」も出さない (今までどおり)', () => {
	const {composer, restore} = makeComposer({});
	try {
		typeInto(composer.active, '本文');
		assert.strictEqual(composer.active.el.classList.contains(COMPOSE.classes.postInactive), false);
		assert.strictEqual(composer.active.removeButton.hidden, true);
		assert.strictEqual(composer.submitButton.hasAttribute('aria-label'), false);
	} finally {
		restore();
	}
});

test('スレッド: 空の投稿は「×」1 回で消え、フォーカスは前の投稿へ移る', () => {
	const {composer, restore} = makeComposer({});
	try {
		typeInto(composer.active, '1 件目');
		click(composer.addButton);
		const second = composer.posts[1];
		click(second.removeButton);
		assert.strictEqual(composer.posts.length, 1);
		assert.strictEqual(composer.activeIndex, 0);
		assert.strictEqual(second.el.parentNode, null);
		assert.ok(document.activeElement === composer.posts[0].textarea, '前の投稿にフォーカスが無い');
		assert.ok(composer.posts[0].toolbarEl.contains(composer.submitButton), '共通の行が残りの投稿に戻らない');
		assert.strictEqual(composer.posts[0].removeButton.hidden, true);
	} finally {
		restore();
	}
});

test('スレッド: 中身のある投稿は「×」1 回目で「本当に削除？」、フォーカスが外れる (blur) と戻り、2 回目で消える', () => {
	const {composer, restore} = makeComposer({});
	const confirming = EXT_CONFIG.lightboxReplies.classes.confirming;
	try {
		fillPosts(composer, ['1 件目', '2 件目']);
		// 先頭の投稿を消すと、フォーカスは次の投稿へ移る
		composer.posts[0].textarea.dispatchEvent(new FakeEvent('focusin'));
		const first = composer.posts[0];
		click(first.removeButton);
		assert.strictEqual(composer.posts.length, 2);
		assert.strictEqual(first.removeButton.textContent, COMPOSE.text.confirmRemovePost);
		assert.strictEqual(first.removeButton.classList.contains(confirming), true);
		first.removeButton.dispatchEvent(new FakeEvent('blur', {bubbles: false}));
		assert.strictEqual(first.removeButton.classList.contains(confirming), false);
		assert.strictEqual(first.removeButton.getAttribute('aria-label'), COMPOSE.text.removePost);
		click(first.removeButton);
		click(first.removeButton);
		assert.strictEqual(composer.posts.length, 1);
		assert.strictEqual(composer.posts[0].textarea.value, '2 件目');
		assert.ok(document.activeElement === composer.posts[0].textarea, '次の投稿にフォーカスが無い');
	} finally {
		restore();
	}
});

test('スレッド: 動画のアップロード中の投稿を消すと、その動画のアップロードを取り消す', async () => {
	const {composer, calls, restore} = makeComposer({});
	try {
		typeInto(composer.active, '1 件目');
		click(composer.addButton);
		const second = composer.posts[1];
		await second.addFiles([videoFile()]);
		await flush();
		assert.strictEqual(calls.videoJobs.length, 1);
		click(second.removeButton);
		click(second.removeButton);
		assert.strictEqual(composer.posts.length, 1);
		assert.deepStrictEqual(calls.videoCancels, [calls.videoJobs[0].id]);
	} finally {
		restore();
	}
});

test('スレッド: 2 件を 1 回の createReplyThread で送り、連なりは橋渡しの検査を通り、一覧へ順に入れて 1 件に戻す', async () => {
	const {composer, calls, restore} = makeComposer({getSelfProfile: () => ({handle: 'me.example.com', avatarUrl: null})});
	try {
		fillPosts(composer, ['1 件目', '2 件目']);
		assert.strictEqual(composer.submitButton.getAttribute('aria-label'),
			COMPOSE.text.submitThread.replace('{count}', '2'));
		await composer.submit();
		assert.deepStrictEqual(calls.created, []);
		assert.strictEqual(calls.threads.length, 1);
		const writes = calls.threads[0];
		assert.strictEqual(writes.length, 2);
		assert.deepStrictEqual(writes.map((write) => write.value.text), ['1 件目', '2 件目']);
		const parent = writes[1].value.reply.parent;
		assert.strictEqual(parent.uri, `at://${SELF_DID}/app.bsky.feed.post/${writes[0].rkey}`);
		assert.strictEqual(parent.cid, await computeRecordCid(writes[0].value));
		assert.deepStrictEqual(writes[0].value.reply, {
			root: {uri: TARGET.uri, cid: TARGET.cid}, parent: {uri: TARGET.uri, cid: TARGET.cid}
		});
		assert.ok(writes[0].rkey < writes[1].rkey, 'rkey が増えていない');
		assert.deepStrictEqual(writes.map((write) => write.value.langs), [['ja'], ['ja']]);
		assert.strictEqual(checkThreadWrites(writes, SELF_DID).ok, true);
		// 一覧へは送った順に、2 件目の宛先は 1 件目
		assert.strictEqual(calls.posted.length, 2);
		assert.strictEqual(calls.posted[0][2], TARGET);
		assert.strictEqual(calls.posted[1][2].anchorUri, calls.posted[0][0].uri);
		assert.strictEqual(calls.posted[1][2].uri, calls.posted[0][0].uri);
		assert.strictEqual(calls.posted[1][2].handle, 'me.example.com');
		assert.strictEqual(calls.posted[1][1], writes[1].value);
		// 送った後は空の 1 件に戻す
		assert.strictEqual(composer.posts.length, 1);
		assert.strictEqual(composer.activeIndex, 0);
		assert.strictEqual(composer.active.textarea.value, '');
		assert.strictEqual(composer.hasDraft(), false);
		assert.ok(composer.active.toolbarEl.contains(composer.submitButton), '共通の行が残りの投稿に無い');
		assert.strictEqual(composer.el.children.filter((child) => child.classList.contains(COMPOSE.classes.post)).length, 1);
	} finally {
		restore();
	}
});

test('スレッド: 1 件目に画像、2 件目に本文だけなら、1 件目の value にだけ embed と BlobRef が入る', async () => {
	const {composer, calls, restore} = makeComposer({uploadBlob: await cidUpload()});
	try {
		await composer.active.addFiles([{name: 'a.png', type: 'image/png'}]);
		click(composer.addButton);
		typeInto(composer.posts[1], '2 件目');
		await composer.submit();
		assert.strictEqual(calls.threads.length, 1);
		const [first, second] = calls.threads[0].map((write) => write.value);
		assert.strictEqual(first.embed.$type, 'app.bsky.embed.images');
		assert.strictEqual(first.embed.images[0].image.$type, 'blob');
		assert.strictEqual('embed' in second, false);
		assert.strictEqual(checkThreadWrites(calls.threads[0], SELF_DID).ok, true);
		assert.strictEqual(calls.posted[0][3].$type, 'app.bsky.embed.images#view');
		assert.strictEqual(calls.posted[1][3], null);
	} finally {
		restore();
	}
});

test('スレッド: 途中に空の投稿があると 1 回目は送らずに聞き、「飛ばして送信」で空を除いて送る', async () => {
	const {composer, calls, restore} = makeComposer({});
	try {
		fillPosts(composer, ['1 件目', '2 件目', '3 件目']);
		typeInto(composer.posts[1], '');
		await composer.submit();
		assert.strictEqual(calls.threads.length, 0);
		const prompt = composer.noticeEl;
		assert.ok(prompt && prompt.classList.contains(COMPOSE.classes.skipEmpty), '空の投稿の問い合わせが出ていない');
		assert.strictEqual(prompt.getAttribute('role'), 'alert');
		assert.ok(prompt.textContent.includes(COMPOSE.text.skipEmpty));
		const send = prompt.querySelector(`.${COMPOSE.classes.skipEmptySend}`);
		assert.strictEqual(send.textContent, COMPOSE.text.skipEmptySend);
		assert.ok(document.activeElement === send, '「飛ばして送信」にフォーカスが無い');
		click(send);
		// CID の計算 (WebCrypto) は別のスレッドで進むため、送り終えるまで待つ
		await waitUntil(() => !composer.busy && calls.threads.length > 0);
		assert.strictEqual(calls.threads.length, 1);
		assert.deepStrictEqual(calls.threads[0].map((write) => write.value.text), ['1 件目', '3 件目']);
		assert.strictEqual(composer.posts.length, 1);
	} finally {
		restore();
	}
});

test('スレッド: 「編集を続ける」・本文の変更で問い合わせを引っ込め、末尾だけが空なら聞かずに送る', async () => {
	const {composer, calls, restore} = makeComposer({});
	try {
		fillPosts(composer, ['1 件目', '2 件目', '3 件目']);
		typeInto(composer.posts[1], '');
		await composer.submit();
		click(composer.noticeEl.querySelector(`.${COMPOSE.classes.skipEmptyKeep}`));
		assert.strictEqual(composer.noticeEl, null);
		await composer.submit();
		assert.ok(composer.noticeEl, '2 回目の送信で問い合わせが出ない');
		typeInto(composer.posts[1], '2 件目');
		assert.strictEqual(composer.noticeEl, null);
		// 末尾に空の投稿を足しても聞かずに送る
		composer.posts[2].textarea.dispatchEvent(new FakeEvent('focusin'));
		click(composer.addButton);
		await composer.submit();
		assert.strictEqual(calls.threads.length, 1);
		assert.deepStrictEqual(calls.threads[0].map((write) => write.value.text), ['1 件目', '2 件目', '3 件目']);
	} finally {
		restore();
	}
});

test('スレッド: 本文があるのが 1 件だけなら今までどおり createReply で送り、空の投稿を落として 1 件に戻す', async () => {
	const {composer, calls, restore} = makeComposer({});
	try {
		typeInto(composer.active, '1 件目');
		click(composer.addButton);
		await composer.submit();
		assert.strictEqual(calls.threads.length, 0);
		assert.strictEqual(calls.created.length, 1);
		assert.strictEqual(calls.created[0].text, '1 件目');
		assert.strictEqual(calls.posted.length, 1);
		assert.strictEqual(composer.posts.length, 1);
		assert.strictEqual(composer.hasDraft(), false);
	} finally {
		restore();
	}
});

test('スレッド: 2 件目の画像を送れなければ返信を作らず、2 件目に 1 行を出して中身を残す', async () => {
	let count = 0;
	const good = await cidUpload();
	const {composer, calls, restore} = makeComposer({
		uploadBlob: async (blob) => {
			count += 1;
			return count === 1 ? good(blob) : {ok: false, blob: null, reason: 'upload-failed'};
		}
	});
	try {
		await composer.active.addFiles([{name: 'a.png', type: 'image/png'}]);
		click(composer.addButton);
		await composer.posts[1].addFiles([{name: 'b.png', type: 'image/png'}]);
		typeInto(composer.posts[1], '2 件目');
		await composer.submit();
		assert.strictEqual(calls.threads.length, 0);
		assert.strictEqual(calls.posted.length, 0);
		assert.strictEqual(composer.posts.length, 2);
		assert.strictEqual(composer.posts[1].noticeEl.textContent, COMPOSE.text.uploadFailed);
		assert.strictEqual(composer.posts[0].noticeEl, null);
		assert.strictEqual(composer.posts[1].textarea.value, '2 件目');
		assert.strictEqual(composer.posts[0].attachments.length, 1);
		assert.strictEqual(composer.posts[1].attachments.length, 1);
		assert.strictEqual(composer.submitButton.disabled, false);
	} finally {
		restore();
	}
});

test('スレッド: 作成が失敗したら全投稿を残して「返信できませんでした」', async () => {
	const {composer, calls, restore} = makeComposer({});
	composer.deps.actions = {
		createReplyThread: async () => ({ok: false, results: null, writes: null, reason: 'thread-not-allowed'})
	};
	try {
		fillPosts(composer, ['1 件目', '2 件目']);
		await composer.submit();
		assert.strictEqual(calls.posted.length, 0);
		assert.strictEqual(composer.posts.length, 2);
		assert.strictEqual(composer.noticeEl.textContent, EXT_CONFIG.lightboxReplies.text.postFailed);
		assert.strictEqual(calls.reloads, 0);
	} finally {
		restore();
	}
});

test('スレッド: 応答を確かめられなければ「返信を確かめられませんでした」を出し、空の 1 件に戻して一覧を取り直す', async () => {
	const {composer, calls, restore} = makeComposer({});
	composer.deps.actions = {
		createReplyThread: async () => ({ok: false, results: null, writes: [], reason: 'thread-unconfirmed'})
	};
	try {
		fillPosts(composer, ['1 件目', '2 件目']);
		await composer.submit();
		assert.strictEqual(calls.posted.length, 0);
		assert.strictEqual(composer.noticeEl.textContent, COMPOSE.text.threadUnconfirmed);
		assert.strictEqual(calls.reloads, 1);
		assert.strictEqual(composer.posts.length, 1);
		assert.strictEqual(composer.hasDraft(), false);
	} finally {
		restore();
	}
});

test('スレッド: 2 件目だけに本文があっても書きかけ、送信中は「＋」「×」と全投稿の欄を止める', async () => {
	let release = null;
	const {composer, restore} = makeComposer({});
	composer.deps.actions = {
		createReplyThread: () => new Promise((resolve) => {
			release = resolve;
		})
	};
	try {
		typeInto(composer.active, '1 件目');
		click(composer.addButton);
		typeInto(composer.posts[1], '2 件目');
		typeInto(composer.posts[0], '');
		assert.strictEqual(composer.hasDraft(), true);
		typeInto(composer.posts[0], '1 件目');
		const sending = composer.submit();
		await flush();
		assert.strictEqual(composer.addButton.disabled, true);
		assert.strictEqual(composer.posts[1].removeButton.disabled, true);
		assert.ok(composer.posts.every((post) => post.textarea.disabled), '送信中に本文の欄が止まっていない');
		const count = composer.posts.length;
		composer.addPost();
		composer.removePost(composer.posts[1]);
		assert.strictEqual(composer.posts.length, count);
		release({ok: false, results: null, writes: null, reason: 'x'});
		await sending;
		assert.strictEqual(composer.addButton.disabled, false);
	} finally {
		restore();
	}
});

test('スレッド: 薄く描いた投稿の欄の外を押すと、その投稿の本文の欄へフォーカスを移す', () => {
	const {composer, restore} = makeComposer({});
	try {
		fillPosts(composer, ['1 件目', '2 件目']);
		const first = composer.posts[0];
		assert.strictEqual(first.el.classList.contains(COMPOSE.classes.postInactive), true);
		click(first.avatar);
		assert.ok(document.activeElement === first.textarea, '薄い投稿を押しても本文の欄にフォーカスが移らない');
		// アクティブな投稿の欄の外を押してもフォーカスは動かさない
		document.activeElement = document.body;
		click(composer.posts[1].avatar);
		assert.ok(document.activeElement === document.body, 'アクティブな投稿でフォーカスが動いた');
	} finally {
		restore();
	}
});

test('スレッド: パネルのフォーカスの扱いが focusout を止めても、「×」の聞き返しはフォーカスが外れると戻る', () => {
	const made = makeComposerWithSheets();
	const {composer, panel, restore} = made;
	// パネルのフォーカスの扱いは window の capture で focusout を止める。偽の DOM では根 (html) がその位置
	const uninstall = installPanelFocusGuard(panel, () => ({hasDraft: composer.hasDraft(), confirming: false}),
		document.documentElement);
	const confirming = EXT_CONFIG.lightboxReplies.classes.confirming;
	try {
		fillPosts(composer, ['1 件目', '2 件目']);
		const second = composer.posts[1];
		click(second.removeButton);
		assert.strictEqual(second.removeButton.classList.contains(confirming), true);
		second.removeButton.dispatchEvent(new FakeEvent('focusout'));
		second.removeButton.dispatchEvent(new FakeEvent('blur', {bubbles: false}));
		assert.strictEqual(second.removeButton.classList.contains(confirming), false);
		assert.strictEqual(second.removeButton.getAttribute('aria-label'), COMPOSE.text.removePost);
		// 戻った後の 1 回目の押下では消さない
		typeInto(second, '2 件目の続き');
		click(second.removeButton);
		assert.strictEqual(composer.posts.length, 2);
	} finally {
		uninstall();
		composer.destroy();
		restore();
	}
});

test('スレッド: 送信ボタンで送った後は、残った投稿の本文の欄へフォーカスを移す', async () => {
	const {composer, calls, restore} = makeComposer({});
	try {
		fillPosts(composer, ['1 件目', '2 件目']);
		composer.submitButton.focus();
		click(composer.submitButton);
		await waitUntil(() => calls.threads.length > 0 && !composer.busy);
		assert.strictEqual(composer.posts.length, 1);
		assert.ok(document.activeElement === composer.posts[0].textarea, '残った投稿の本文の欄にフォーカスが無い');
	} finally {
		restore();
	}
});

test('スレッド: 手元で計算した CID が応答と違えばデバッグに記録し、一覧には応答の cid を渡す', async () => {
	const {composer, calls, restore} = makeComposer({});
	const logged = [];
	const originalLog = ExtDebug.log;
	ExtDebug.log = (message, data) => logged.push({message, data});
	composer.deps.actions = {
		createReplyThread: async (build) => {
			const writes = await build(SELF_DID);
			calls.threads.push(writes);
			const results = writes.map((write, i) => ({
				uri: `at://${SELF_DID}/${write.collection}/${write.rkey}`, cid: `bafyserver${i}`
			}));
			return {ok: true, results, writes, reason: null};
		}
	};
	try {
		fillPosts(composer, ['1 件目', '2 件目']);
		await composer.submit();
		const mismatches = logged.filter((entry) => entry.data && '手元' in entry.data);
		assert.strictEqual(mismatches.length, 2);
		assert.strictEqual(mismatches[0].data.応答, 'bafyserver0');
		assert.strictEqual(mismatches[0].data.手元, await computeRecordCid(calls.threads[0][0].value));
		assert.deepStrictEqual(calls.posted.map((args) => args[0].cid), ['bafyserver0', 'bafyserver1']);
	} finally {
		ExtDebug.log = originalLog;
		restore();
	}
});

test('スレッド: 送信ボタンの進み具合は画像とサムネイルを全投稿で通した 1 つの番号', async () => {
	const good = await cidUpload();
	let made = null;
	const labels = [];
	made = makeComposer({
		uploadBlob: async (blob) => {
			labels.push(made.composer.submitButton.textContent);
			return good(blob);
		}
	});
	const {composer, calls, restore} = made;
	try {
		await composer.active.addFiles([{name: 'a.png', type: 'image/png'}]);
		click(composer.addButton);
		composer.posts[1].extras.setGif(gifItem());
		await composer.submit();
		assert.strictEqual(calls.threads.length, 1);
		// 1 件目の画像が 1/1、2 件目の GIF のサムネイルは分かった時点で全体に足して 2/2
		const sending = COMPOSE.text.sending;
		assert.deepStrictEqual(labels, [
			sending.replace('{done}', '1').replace('{total}', '1'),
			sending.replace('{done}', '2').replace('{total}', '2')
		]);
	} finally {
		restore();
	}
});

test('createThreadProgress: 画像の番号の後にサムネイルを足し、分かった時点で全体を増やす', () => {
	const shown = [];
	const progress = createThreadProgress((current, total) => shown.push(`${current}/${total}`));
	progress.blob(1, 2);
	progress.blob(2, 2);
	// 2 件目のサムネイル (送る前・送った後)、続いて 3 件目のサムネイル
	progress.thumbnail(1, 0, 1);
	progress.thumbnail(1, 1, 1);
	progress.thumbnail(2, 0, 1);
	assert.deepStrictEqual(shown, ['1/2', '2/2', '3/3', '3/3', '4/4']);
	// 画像が無ければサムネイルだけで数える
	const only = [];
	const thumbs = createThreadProgress((current, total) => only.push(`${current}/${total}`));
	thumbs.thumbnail(0, 0, 1);
	assert.deepStrictEqual(only, ['1/1']);
});

test('スレッド: 送信中は送信ボタンの「{件数} 件の返信を送信」の読み上げを外し、終わったら戻す', async () => {
	let release = null;
	const {composer, restore} = makeComposer({});
	composer.deps.actions = {
		createReplyThread: () => new Promise((resolve) => {
			release = resolve;
		})
	};
	try {
		fillPosts(composer, ['1 件目', '2 件目']);
		const label = COMPOSE.text.submitThread.replace('{count}', '2');
		assert.strictEqual(composer.submitButton.getAttribute('aria-label'), label);
		const sending = composer.submit();
		await waitUntil(() => release !== null);
		assert.strictEqual(composer.submitButton.hasAttribute('aria-label'), false);
		// 送信中に中身が変わって sync が走っても付け直さない
		composer.sync();
		assert.strictEqual(composer.submitButton.hasAttribute('aria-label'), false);
		release({ok: false, results: null, writes: null, reason: 'x'});
		await sending;
		assert.strictEqual(composer.submitButton.getAttribute('aria-label'), label);
	} finally {
		restore();
	}
});

test('スレッド: 投稿が 2 件以上のあいだだけ入れ物を高さの上限付きにし、動いた先を入れ物の中で見せる', async () => {
	const {composer, restore} = makeComposer({});
	const multi = COMPOSE.classes.threadMulti;
	const proto = Object.getPrototypeOf(composer.el);
	const revealed = [];
	proto.scrollIntoView = function scrollIntoView(options) {
		revealed.push({el: this, options});
	};
	composer.deps.actions = {
		createReplyThread: async () => ({ok: false, results: null, writes: null, reason: 'x'})
	};
	try {
		typeInto(composer.active, '1 件目');
		assert.strictEqual(composer.el.classList.contains(multi), false);
		click(composer.addButton);
		assert.strictEqual(composer.el.classList.contains(multi), true);
		// 足した投稿
		assert.ok(revealed.some((entry) => entry.el === composer.posts[1].el), '足した投稿を見せていない');
		assert.deepStrictEqual(revealed[0].options, {block: 'nearest', behavior: 'smooth'});
		typeInto(composer.posts[1], '2 件目');
		// アクティブになった投稿
		revealed.length = 0;
		composer.posts[0].textarea.dispatchEvent(new FakeEvent('focusin'));
		assert.ok(revealed.some((entry) => entry.el === composer.posts[0].el), 'アクティブにした投稿を見せていない');
		// 空の投稿の問い合わせ
		composer.posts[1].textarea.dispatchEvent(new FakeEvent('focusin'));
		click(composer.addButton);
		typeInto(composer.posts[2], '3 件目');
		typeInto(composer.posts[1], '');
		revealed.length = 0;
		await composer.submit();
		assert.ok(revealed.some((entry) => entry.el === composer.noticeEl), '問い合わせを見せていない');
		// 入れ物の知らせ
		click(composer.noticeEl.querySelector(`.${COMPOSE.classes.skipEmptySend}`));
		await waitUntil(() => !composer.busy && composer.noticeEl !== null && !composer.skipPromptEl);
		assert.strictEqual(composer.noticeEl.textContent, EXT_CONFIG.lightboxReplies.text.postFailed);
		assert.ok(revealed.some((entry) => entry.el === composer.noticeEl), '失敗の 1 行を見せていない');
		// 1 件に戻すと上限を外す
		composer.removePost(composer.posts[2]);
		composer.posts[1].textarea.dispatchEvent(new FakeEvent('focusin'));
		composer.removePost(composer.posts[1]);
		assert.strictEqual(composer.posts.length, 1);
		assert.strictEqual(composer.el.classList.contains(multi), false);
		// 1 件のときの知らせでは動かさない (今までどおり)
		revealed.length = 0;
		composer.showNotice(['x']);
		assert.deepStrictEqual(revealed, []);
	} finally {
		delete proto.scrollIntoView;
		restore();
	}
});

test('スレッド: 2 件以上の送信中に入れ物が外されても同じ世代なら送り続けて全件を一覧へ入れ、送り終えてからメディアを片付ける', async () => {
	let made = null;
	made = makeComposer({uploadBlob: await cidUpload()});
	const {composer, calls, restore} = made;
	const original = composer.deps.actions.createReplyThread;
	composer.deps.actions = {
		createReplyThread: async (build) => {
			// 応答を待つあいだに描き直しで入れ物が外された
			composer.destroy();
			return original(build);
		}
	};
	try {
		typeInto(composer.active, '1 件目');
		click(composer.addButton);
		composer.posts[1].extras.setGif(gifItem());
		const second = composer.posts[1];
		await composer.submit();
		assert.strictEqual(calls.threads.length, 1);
		assert.strictEqual(calls.posted.length, 2);
		assert.deepStrictEqual(calls.posted.map((args) => args[1].text), ['1 件目', '']);
		assert.strictEqual(calls.posted[1][1].embed.$type, 'app.bsky.embed.external');
		// 外された入れ物の投稿のメディアは送り終えた後に片付けた
		assert.strictEqual(second.extras.destroyed, true);
		assert.strictEqual(made.state.posting, false);
	} finally {
		restore();
	}
});

test('スレッド: 投稿が 2 件以上ある入れ物を外すと、各投稿の動画のアップロードを取り消す', async () => {
	const {composer, calls, restore} = makeComposer({});
	try {
		await composer.active.addFiles([videoFile('a.mp4')]);
		await flush();
		click(composer.addButton);
		await composer.posts[1].addFiles([videoFile('b.mp4')]);
		await flush();
		assert.strictEqual(composer.posts.length, 2);
		assert.strictEqual(calls.videoJobs.length, 2);
		composer.destroy();
		assert.deepStrictEqual(calls.videoCancels.slice().sort(), calls.videoJobs.map((job) => job.id).sort());
	} finally {
		restore();
	}
});
