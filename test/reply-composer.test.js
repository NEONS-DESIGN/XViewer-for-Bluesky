/**
 * reply-composer.js のうち DOM に触れない部分。貼り付けの取り出し・画像の順次アップロード・
 * 送信の手順 (世代が変わったとき・失敗したときに何を呼ぶか) を確かめる。
 */

import test from 'node:test';
import assert from 'node:assert';

import {EXT_CONFIG} from '../src/common/config.js';
import {FakeDocument, FakeEvent} from './helpers/fake-dom.js';
import {
	ReplyComposer, pickPastedImages, hasImageItems, uploadAll, runSubmit, defaultLanguages
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

test('pickPastedImages: 文字だけなら空、画像と文字が混じれば画像だけ', () => {
	assert.deepStrictEqual(pickPastedImages(itemList([item('string', 'text/plain', null)])), []);
	const png = {name: 'a.png'};
	const picked = pickPastedImages(itemList([
		item('string', 'text/html', null),
		item('file', 'image/png', png),
		item('file', 'application/pdf', {name: 'x.pdf'}),
		item('string', 'text/plain', null)
	]));
	assert.deepStrictEqual(picked, [png]);
});

test('pickPastedImages: getAsFile が null や例外なら除き、items が無ければ空', () => {
	const broken = {kind: 'file', type: 'image/png', getAsFile: () => {
		throw new Error('x');
	}};
	assert.deepStrictEqual(pickPastedImages(itemList([item('file', 'image/png', null), broken])), []);
	assert.deepStrictEqual(pickPastedImages(null), []);
	assert.deepStrictEqual(pickPastedImages(undefined), []);
});

test('hasImageItems: 画像のファイルを含むときだけ真 (ドロップを受けるか)', () => {
	assert.strictEqual(hasImageItems(itemList([item('string', 'text/plain', null)])), false);
	assert.strictEqual(hasImageItems(itemList([item('file', 'text/plain', null)])), false);
	assert.strictEqual(hasImageItems(itemList([item('file', 'image/jpeg', null)])), true);
	assert.strictEqual(hasImageItems(null), false);
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
	const calls = {posted: [], created: [], uploads: 0};
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
		await composer.addFiles(files.concat({name: 'v.mp4', type: 'video/mp4'}));
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
		assert.strictEqual(record.text, 'テスト https://bsky.app #test');
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
