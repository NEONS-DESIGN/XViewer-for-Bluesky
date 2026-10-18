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
	ReplyComposer, pickPastedMedia, hasMediaItems, uploadAll, runSubmit, defaultLanguages
} from '../src/content/reply-composer.js';

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
	composer.textarea.dispatchEvent(paste);
	composer.textarea.value = value;
	composer.textarea.dispatchEvent(new FakeEvent('input'));
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
		videoUploads: [], videoCancels: [], videoJobs: []
	};
	const deps = {
		actions: {createReply: async (record) => {
			calls.created.push(record);
			return {ok: true, uri: 'at://did:plc:me/app.bsky.feed.post/r1', cid: 'cid-r1', reason: null};
		}},
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
		getSessionDid: () => 'did:plc:me',
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
		await composer.addFiles([{name: 'a.png', type: 'image/png'}]);
		assert.strictEqual(composer.hasDraft(), true);
		await composer.submit();
		assert.strictEqual(calls.created.length, 1);
		assert.strictEqual(calls.created[0].embed.$type, 'app.bsky.embed.images');
		assert.deepStrictEqual(calls.created[0].langs, ['ja']);
		assert.strictEqual(calls.posted.length, 1);
		assert.strictEqual(calls.posted[0][3].$type, 'app.bsky.embed.images#view');
		assert.strictEqual(composer.attachments.length, 0);
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
		await composer.addFiles([{name: 'a.png', type: 'image/png'}]);
		composer.textarea.value = '本文';
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
		await composer.addFiles([{name: 'a.png', type: 'image/png'}, {name: 'b.png', type: 'image/png'}]);
		composer.textarea.value = '本文';
		await composer.submit();
		assert.deepStrictEqual(calls.posted, []);
		assert.strictEqual(composer.textarea.value, '本文');
		assert.strictEqual(composer.attachments.length, 2);
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
		composer.onPaste(textPaste);
		assert.strictEqual(textPaste.defaultPrevented, false);
		const imagePaste = new FakeEvent('paste');
		imagePaste.clipboardData = {items: itemList([item('file', 'image/png', {name: 'p.png', type: 'image/png'})])};
		composer.onPaste(imagePaste);
		assert.strictEqual(imagePaste.defaultPrevented, true);
		await new Promise((resolve) => setImmediate(resolve));
		assert.strictEqual(composer.attachments.length, 1);
	} finally {
		restore();
	}
});

test('ReplyComposer: 11 枚目と対応しない形式は取り込まず 1 行で知らせる', async () => {
	const {composer, restore} = makeComposer({});
	try {
		const files = Array.from({length: 11}, (unused, i) => ({name: `${i}.png`, type: 'image/png'}));
		await composer.addFiles(files.concat({name: 'd.pdf', type: 'application/pdf'}));
		assert.strictEqual(composer.attachments.length, EXT_CONFIG.lightboxReplies.compose.maxImages);
		const text = EXT_CONFIG.lightboxReplies.compose.text;
		assert.ok(composer.noticeEl.textContent.includes(text.tooManyImages));
		assert.ok(composer.noticeEl.textContent.includes(text.unsupportedImage));
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
		composer.textarea.value = '本文';
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
		await composer.addFiles([{name: 'a.png', type: 'image/png'}]);
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
		composer.labels = {adult: 'porn', graphic: true};
		composer.textarea.value = 'テスト https://bsky.app #test';
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
		await composer.addFiles([{name: 'a.png', type: 'image/png'}, {name: 'b.png', type: 'image/png'}]);
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
		composer.textarea.value = '本文';
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
		composer.textarea.value = '本文';
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
		await composer.addFiles(files);
		assert.strictEqual(composer.attachments.length, 9);
		const original = composer.deps.prepareImage;
		composer.deps.prepareImage = (file, crop, rules) => (crop
			? new Promise((resolve) => {
				release = () => resolve(original(file, crop, rules));
			})
			: original(file, crop, rules));
		const recropping = composer.recrop(composer.attachments[0], {x: 0, y: 0, width: 10, height: 10});
		assert.strictEqual(composer.submitButton.disabled, true);
		await composer.addFiles([{name: '9.png', type: 'image/png'}]);
		assert.strictEqual(composer.attachments.length, 10);
		assert.strictEqual(composer.noticeEl, null);
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
		composer.onDragOver(over);
		assert.strictEqual(over.defaultPrevented, true);
		assert.strictEqual(transfer.dropEffect, EXT_CONFIG.lightboxReplies.compose.noDropEffect);
		const drop = new FakeEvent('drop');
		drop.dataTransfer = transfer;
		composer.onDrop(drop);
		assert.strictEqual(drop.defaultPrevented, true);
		await new Promise((resolve) => setImmediate(resolve));
		assert.strictEqual(composer.attachments.length, 0);
		const text = new FakeEvent('dragover');
		text.dataTransfer = {items: itemList([item('string', 'text/plain', null)])};
		composer.onDragOver(text);
		assert.strictEqual(text.defaultPrevented, false);
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
		await composer.addFiles([{name: 'a.png', type: 'image/png'}]);
		const attachment = composer.attachments[0];
		click(attachment.cell.altButton);
		assert.strictEqual(host.isOpen(), true);
		composer.renderAttachments();
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
		await composer.addFiles([{name: 'a.png', type: 'image/png'}]);
		const attachment = composer.attachments[0];
		const before = attachment.cell.altButton;
		click(before);
		composer.renderAttachments();
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
		composer.textarea.value = `見て ${url} です`;
		composer.textarea.dispatchEvent(new FakeEvent('input'));
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
		composer.extras.setGif(gifItem());
		click(composer.imageTool);
		assert.strictEqual(composer.noticeEl.textContent, text.gifExclusive);
		composer.extras.removeGif();
		assert.strictEqual(composer.noticeEl, null);
		// 別の知らせは GIF を外しても消さない
		composer.extras.setGif(gifItem());
		composer.showNotice([text.imageLoadFailed]);
		composer.extras.removeGif();
		assert.strictEqual(composer.noticeEl.textContent, text.imageLoadFailed);
		// 送った後の初期化でも排他の 1 行は残らない
		composer.extras.setGif(gifItem());
		click(composer.imageTool);
		composer.resetAfterPost();
		assert.strictEqual(composer.noticeEl, null);
	} finally {
		restore();
	}
});

test('ReplyComposer: 本文の末尾の空白は送らず、link facet は正しい範囲を指す', async () => {
	const {composer, calls, restore} = makeComposer({});
	try {
		composer.textarea.value = 'テスト https://example.com ';
		composer.textarea.dispatchEvent(new FakeEvent('input'));
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
		await composer.addFiles([{name: 'a.png', type: 'image/png'}]);
		assert.strictEqual(composer.gifTool.disabled, true);
		composer.removeAttachment(composer.attachments[0]);
		assert.strictEqual(composer.gifTool.disabled, false);
		composer.extras.setGif(gifItem());
		assert.strictEqual(composer.embedEl.hidden, false);
		// GIF があるあいだは画像のボタン・取り込み・貼り付けで画像を足さない
		click(composer.imageTool);
		assert.strictEqual(composer.noticeEl.textContent, text.gifExclusive);
		await composer.addFiles([{name: 'b.png', type: 'image/png'}]);
		const imagePaste = new FakeEvent('paste');
		imagePaste.clipboardData = {items: itemList([item('file', 'image/png', {name: 'p.png', type: 'image/png'})])};
		composer.onPaste(imagePaste);
		assert.strictEqual(imagePaste.defaultPrevented, true);
		await flush();
		assert.strictEqual(composer.attachments.length, 0);
		assert.strictEqual(composer.importing, 0);
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
		assert.strictEqual(composer.extras.gif, null);
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
		assert.strictEqual(only.composer.extras.quote.status, 'ready');
		assert.deepStrictEqual(only.calls.fetchPost, [QUOTED_URI]);
		assert.strictEqual(only.composer.labelsButton.hidden, true);
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
		await withImage.composer.addFiles([{name: 'a.png', type: 'image/png'}]);
		assert.strictEqual(withImage.composer.labelsButton.hidden, false);
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
		assert.ok(composer.embedEl.querySelector(cardSelector), 'カードが出ていない');
		await composer.addFiles([{name: 'a.png', type: 'image/png'}]);
		assert.strictEqual(composer.embedEl.querySelector(cardSelector), null);
		composer.removeAttachment(composer.attachments[0]);
		assert.ok(composer.embedEl.querySelector(cardSelector), '画像を外してもカードが戻らない');
		await composer.addFiles([{name: 'b.png', type: 'image/png'}]);
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
		assert.strictEqual(composer.labelsButton.hidden, false);
		composer.labels = {adult: 'porn', graphic: true};
		composer.renderLabels();
		composer.extras.removeCard();
		assert.strictEqual(composer.labelsButton.hidden, true);
		assert.deepStrictEqual(composer.labels, {adult: null, graphic: false});
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
		composer.extras.setGif(gifItem());
		assert.strictEqual(composer.hasDraft(), true);
		composer.extras.removeGif();
		assert.strictEqual(composer.hasDraft(), false);
	} finally {
		restore();
	}
});

test('ReplyComposer: GIF・カード・引用の × で外した後は本文の欄にフォーカスがある', async () => {
	const classes = EXT_CONFIG.lightboxReplies.cards.classes;
	const removeButton = (composer) => composer.embedEl.querySelector(`.${classes.remove}`);
	const gif = makeComposer({});
	try {
		gif.composer.extras.setGif(gifItem());
		const button = removeButton(gif.composer);
		button.focus();
		click(button);
		assert.strictEqual(gif.composer.extras.gif, null);
		assert.ok(globalThis.document.activeElement === gif.composer.textarea, 'GIF の × の後に本文の欄へ移らない');
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
		assert.strictEqual(card.composer.extras.card, null);
		assert.ok(globalThis.document.activeElement === card.composer.textarea, 'カードの × の後に本文の欄へ移らない');
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
		assert.strictEqual(quote.composer.extras.quote, null);
		assert.ok(globalThis.document.activeElement === quote.composer.textarea, '引用の × の後に本文の欄へ移らない');
	} finally {
		quote.restore();
	}
});

test('ReplyComposer: GIF の ALT を保存した後は、描き直した ALT ボタンにフォーカスがある', () => {
	const {composer, panel, restore} = makeComposerWithSheets();
	const altSelector = `.${EXT_CONFIG.lightboxReplies.cards.classes.gifAlt}`;
	try {
		composer.extras.setGif(gifItem());
		const before = composer.embedEl.querySelector(altSelector);
		click(before);
		click(panel.querySelector(`[data-role="${EXT_CONFIG.lightboxReplies.compose.sheetRoles.done}"]`));
		const after = composer.embedEl.querySelector(altSelector);
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
		composer.extras.setGif(gifItem());
		click(composer.embedEl.querySelector(`.${EXT_CONFIG.lightboxReplies.cards.classes.gifAlt}`));
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
		assert.strictEqual(composer.extras.gif.alt, 'a'.repeat(maxAlt));
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
	await made.composer.addFiles([videoFile()]);
	await flush();
	const job = made.calls.videoJobs[made.calls.videoJobs.length - 1];
	job.finish({ok: true, blob: VIDEO_BLOB, reason: null, message: null});
	await flush();
}

test('ReplyComposer: 動画を付けると処理が終わるまで送信できず、終わると動画だけで送れる', async () => {
	const made = makeComposer({});
	const {composer, calls, restore} = made;
	try {
		await composer.addFiles([videoFile()]);
		await flush();
		assert.strictEqual(calls.videoUploads.length, 1);
		assert.strictEqual(composer.video.isPending(), true);
		assert.strictEqual(composer.submitButton.disabled, true);
		assert.strictEqual(composer.videoEl.hidden, false);
		await composer.submit();
		assert.deepStrictEqual(calls.created, []);
		calls.videoJobs[0].finish({ok: true, blob: VIDEO_BLOB, reason: null, message: null});
		await flush();
		assert.strictEqual(composer.video.isReady(), true);
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
		assert.strictEqual(composer.video.isActive(), false);
		assert.strictEqual(composer.videoEl.hidden, true);
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
		composer.video.setAlt('動画の説明');
		composer.video.setCaption({blob: captionBlob, name: 'c.vtt', lang: 'ja'});
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
		composer.textarea.value = '本文';
		composer.video.setCaption({blob: {size: 10}, name: 'c.vtt', lang: 'ja'});
		await composer.submit();
		assert.deepStrictEqual(calls.created, []);
		assert.strictEqual(composer.noticeEl.textContent, EXT_CONFIG.lightboxReplies.compose.text.captionUploadFailed);
		assert.strictEqual(composer.video.isReady(), true);
		assert.ok(composer.video.state.caption, '字幕が消えた');
		assert.strictEqual(composer.textarea.value, '本文');
		assert.strictEqual(composer.submitButton.disabled, false);
	} finally {
		restore();
	}
});

test('ReplyComposer: 動画と画像を同じ回に渡すと動画は取り込まず排他の 1 行を出し、画像は取り込む', async () => {
	const {composer, calls, restore} = makeComposer({});
	const text = EXT_CONFIG.lightboxReplies.compose.text;
	try {
		await composer.addFiles([{name: 'a.png', type: 'image/png'}, videoFile()]);
		await flush();
		assert.strictEqual(composer.attachments.length, 1);
		assert.strictEqual(composer.video.isActive(), false);
		assert.deepStrictEqual(calls.videoUploads, []);
		assert.ok(composer.noticeEl.textContent.includes(text.videoExclusive));
		// 画像があるあいだに動画だけを渡しても取り込まない
		await composer.addFiles([videoFile()]);
		assert.strictEqual(composer.video.isActive(), false);
		assert.strictEqual(composer.noticeEl.textContent, text.videoExclusive);
		composer.removeAttachment(composer.attachments[0]);
		// 2 本は取り込まない
		await composer.addFiles([videoFile('a.mp4'), videoFile('b.mp4')]);
		assert.strictEqual(composer.video.isActive(), false);
		assert.strictEqual(composer.noticeEl.textContent, text.tooManyVideos);
		await composer.addFiles([videoFile('a.mp4')]);
		assert.strictEqual(composer.video.isActive(), true);
		await composer.addFiles([videoFile('b.mp4')]);
		assert.strictEqual(composer.noticeEl.textContent, text.tooManyVideos);
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
		await composer.addFiles([{name: 'a.mkv', type: 'video/x-matroska', size: 1000}]);
		await flush();
		assert.strictEqual(composer.noticeEl.textContent, text.videoUnsupported);
		assert.strictEqual(composer.attachments.length, 0);
		assert.strictEqual(composer.video.isActive(), false);
		assert.ok(!composer.noticeEl.textContent.includes(text.unsupportedImage));
		// 画像の知らせは今までどおり
		await composer.addFiles([{name: 'a.bmp', type: 'image/bmp', size: 1000}]);
		await flush();
		assert.strictEqual(composer.noticeEl.textContent, text.unsupportedImage);
		// 受け付ける画像と一緒なら、画像は取り込んで動画の形式だけを知らせる
		await composer.addFiles([{name: 'a.avi', type: 'video/x-msvideo', size: 1000}, {name: 'a.png', type: 'image/png'}]);
		await flush();
		assert.strictEqual(composer.attachments.length, 1);
		assert.strictEqual(composer.noticeEl.textContent, text.videoUnsupported);
		composer.removeAttachment(composer.attachments[0]);
		// 受け付ける動画と一緒なら、動画は取り込み、形式の知らせを残す
		await composer.addFiles([{name: 'a.m4v', type: 'video/x-m4v', size: 1000}, videoFile()]);
		await flush();
		assert.strictEqual(composer.video.isActive(), true);
		assert.strictEqual(calls.videoUploads.length, 1);
		assert.strictEqual(composer.noticeEl.textContent, text.videoUnsupported);
	} finally {
		restore();
	}
});

test('ReplyComposer: 動画があるあいだ GIF ボタンが止まり、画像は取り込まない', async () => {
	const made = makeComposer({});
	const {composer, restore} = made;
	const text = EXT_CONFIG.lightboxReplies.compose.text;
	try {
		assert.strictEqual(composer.gifTool.disabled, false);
		await addReadyVideo(made);
		assert.strictEqual(composer.mediaCount(), 1);
		assert.strictEqual(composer.gifTool.disabled, true);
		await composer.addFiles([{name: 'a.png', type: 'image/png'}]);
		await flush();
		assert.strictEqual(composer.attachments.length, 0);
		assert.strictEqual(composer.importing, 0);
		assert.strictEqual(composer.noticeEl.textContent, text.videoExclusive);
		// 画像の貼り付けも取り込まない
		const imagePaste = new FakeEvent('paste');
		imagePaste.clipboardData = {items: itemList([item('file', 'image/png', {name: 'p.png', type: 'image/png'})])};
		composer.onPaste(imagePaste);
		await flush();
		assert.strictEqual(composer.attachments.length, 0);
		// 動画を外すと GIF ボタンが戻る
		composer.video.remove();
		assert.strictEqual(composer.gifTool.disabled, false);
		// GIF があるあいだは動画を取り込まない
		composer.extras.setGif(gifItem());
		await composer.addFiles([videoFile()]);
		assert.strictEqual(composer.video.isActive(), false);
		assert.strictEqual(composer.noticeEl.textContent, text.videoExclusive);
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
		assert.ok(composer.embedEl.querySelector(cardSelector), 'カードが出ていない');
		await addReadyVideo(made);
		assert.strictEqual(composer.embedEl.querySelector(cardSelector), null);
		// 動画もラベルの対象
		assert.strictEqual(composer.labelsButton.hidden, false);
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
		await composer.addFiles([videoFile()]);
		assert.strictEqual(composer.hasDraft(), true);
		made.calls.videoJobs[0].finish({ok: true, blob: VIDEO_BLOB, reason: null, message: null});
		await flush();
		assert.strictEqual(composer.video.isReady(), true);
		assert.strictEqual(composer.hasDraft(), true);
		composer.video.remove();
		assert.strictEqual(composer.hasDraft(), false);
	} finally {
		restore();
	}
});

test('ReplyComposer: 処理中に destroy すると cancelVideoUpload を送る', async () => {
	const {composer, calls, restore} = makeComposer({});
	try {
		await composer.addFiles([videoFile()]);
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
		await composer.addFiles([new File(['x'], 'v.mp4', {type: 'video/mp4'})]);
		await flush();
		made.calls.videoJobs[0].finish({ok: true, blob: VIDEO_BLOB, reason: null, message: null});
		await flush();
		const altButton = composer.videoEl.querySelector(`.${EXT_CONFIG.lightboxReplies.cards.classes.gifAlt}`);
		assert.ok(altButton, '動画の ALT ボタンが無い');
		click(altButton);
		const field = panel.querySelector(`.${compose.classes.altInput}`);
		assert.ok(field, '字幕と ALT の画面が開かない');
		field.value = '動画の説明';
		click(panel.querySelector(`[data-role="${compose.sheetRoles.done}"]`));
		assert.strictEqual(composer.video.state.alt, '動画の説明');
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
		click(composer.imageTool);
		assert.strictEqual(composer.noticeEl.textContent, text.videoExclusive);
		composer.video.remove();
		assert.strictEqual(composer.noticeEl, null);
		// 画像を渡して断られた場合も同じ
		await addReadyVideo(made);
		await composer.addFiles([{name: 'a.png', type: 'image/png'}]);
		assert.strictEqual(composer.noticeEl.textContent, text.videoExclusive);
		composer.video.remove();
		assert.strictEqual(composer.noticeEl, null);
		// 排他でない知らせは動画を外しても消さない
		await addReadyVideo(made);
		await composer.addFiles([videoFile('b.mp4')]);
		assert.strictEqual(composer.noticeEl.textContent, text.tooManyVideos);
		composer.video.remove();
		assert.strictEqual(composer.noticeEl.textContent, text.tooManyVideos);
	} finally {
		restore();
	}
});

test('ReplyComposer: GIF・画像が原因で動画を断った 1 行は、その GIF・画像を外すと消える', async () => {
	const {composer, restore} = makeComposer({});
	const text = EXT_CONFIG.lightboxReplies.compose.text;
	try {
		composer.extras.setGif(gifItem());
		await composer.addFiles([videoFile()]);
		assert.strictEqual(composer.noticeEl.textContent, text.videoExclusive);
		composer.extras.removeGif();
		assert.strictEqual(composer.noticeEl, null);
		await composer.addFiles([{name: 'a.png', type: 'image/png'}]);
		await composer.addFiles([videoFile()]);
		assert.strictEqual(composer.noticeEl.textContent, text.videoExclusive);
		// 画像が原因の知らせは、本文の入力などで extras が変わっても消えない
		pasteText(composer, 'https://example.com/article');
		await flush();
		assert.strictEqual(composer.noticeEl.textContent, text.videoExclusive);
		composer.removeAttachment(composer.attachments[0]);
		assert.strictEqual(composer.noticeEl, null);
	} finally {
		restore();
	}
});
