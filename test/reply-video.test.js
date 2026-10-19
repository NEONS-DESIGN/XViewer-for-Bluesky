/**
 * reply-video.js (入力欄の動画 1 本の状態) と video-sheet.js (字幕と ALT の画面) を確かめる。
 * アップロードは偽の deps で置き換え、テストから進み具合と結果を撃つ。
 */

import test from 'node:test';
import assert from 'node:assert';

import {EXT_CONFIG} from '../src/common/config.js';
import {FakeDocument, FakeEvent, click} from './helpers/fake-dom.js';
import {SheetHost} from '../src/content/reply-sheets.js';
import {ComposerVideo, readVideoMeta, readCaptionFile, isVisibleProgressChange} from '../src/content/reply-video.js';
import {openVideoSheet} from '../src/content/video-sheet.js';

const CONFIG = EXT_CONFIG.lightboxReplies;
const COMPOSE = CONFIG.compose;
const TEXT = COMPOSE.text;
const RULE = COMPOSE.video;

/** 読める動画の寸法と長さ (秒) */
const GOOD_META = {width: 1280, height: 720, duration: 12.5};

/**
 * URL.createObjectURL / revokeObjectURL を差し替え、テストの終わりに戻す。
 * @param {import('node:test').TestContext} t
 * @returns {{created: string[], revoked: string[]}}
 */
function stubUrls(t) {
	const original = {create: URL.createObjectURL, revoke: URL.revokeObjectURL};
	const log = {created: [], revoked: []};
	URL.createObjectURL = () => {
		const url = `blob:fake-${log.created.length + 1}`;
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

/**
 * 呼ばれ方を記録する偽の deps を作る。
 * @param {*} meta readVideoMeta が返すもの
 * @returns {{deps: Object, uploads: Array<{id: string, blob: *, onProgress: Function, resolve: Function}>, calls: {cancels: string[], changes: number}}}
 */
function makeDeps(meta = GOOD_META) {
	const uploads = [];
	const calls = {cancels: [], changes: 0};
	const deps = {
		uploadVideo: (blob, onProgress) => {
			const id = `up-${uploads.length + 1}`;
			let resolve = null;
			const done = new Promise((r) => {
				resolve = r;
			});
			uploads.push({id, blob, onProgress, resolve});
			return {id, done};
		},
		cancelVideoUpload: (id) => calls.cancels.push(id),
		readVideoMeta: async () => meta,
		onChange: () => {
			calls.changes += 1;
		}
	};
	return {deps, uploads, calls};
}

/**
 * 偽の動画ファイル。
 * @param {Object} [overrides]
 * @returns {{name: string, type: string, size: number}}
 */
function videoFile(overrides) {
	return {name: 'clip.mp4', type: 'video/mp4', size: 1000, ...overrides};
}

/** 待っている Promise の続きを流す */
function flush() {
	return new Promise((resolve) => setImmediate(resolve));
}

test('setFile: 読める動画は upload に進み、進み具合で状態の 1 行が変わり、完了で ready になる', async (t) => {
	stubUrls(t);
	const {deps, uploads, calls} = makeDeps();
	const video = new ComposerVideo(CONFIG, deps, deps.onChange);
	const file = videoFile();
	const result = await video.setFile(file);
	assert.deepStrictEqual(result, {ok: true});
	assert.strictEqual(uploads.length, 1);
	assert.strictEqual(uploads[0].blob, file);
	assert.strictEqual(video.state.phase, 'upload');
	assert.strictEqual(video.state.uploadId, 'up-1');
	assert.strictEqual(video.state.width, 1280);
	assert.strictEqual(video.state.height, 720);
	assert.strictEqual(video.state.durationMs, 12500);
	assert.ok(video.isActive());
	assert.ok(video.isPending());
	assert.ok(!video.isReady());

	uploads[0].onProgress({phase: 'upload', progress: 0.5});
	assert.strictEqual(video.state.phase, 'upload');
	assert.strictEqual(video.state.progress, 0.5);
	uploads[0].onProgress({phase: 'processing', progress: 0.7});
	assert.strictEqual(video.state.phase, 'processing');
	assert.strictEqual(video.state.progress, 0.7);

	const before = calls.changes;
	const blob = {$type: 'blob', ref: {$link: 'bafy-video'}, mimeType: 'video/mp4', size: 1000};
	uploads[0].resolve({ok: true, blob, reason: null, message: null});
	await flush();
	assert.ok(video.isReady());
	assert.ok(!video.isPending());
	assert.strictEqual(video.state.blob, blob);
	assert.ok(calls.changes > before, 'onChange が呼ばれない');
});

test('setFile: 大きすぎる・長すぎる・読めない動画は取り込まず notice を返す', async (t) => {
	const urls = stubUrls(t);
	const cases = [
		{file: videoFile({size: RULE.maxBytes + 1}), meta: GOOD_META, notice: TEXT.videoTooLarge},
		{file: videoFile({type: 'video/x-msvideo'}), meta: GOOD_META, notice: TEXT.videoUnreadable},
		{file: videoFile(), meta: {width: 640, height: 360, duration: RULE.maxDurationMs / 1000 + 1}, notice: TEXT.videoTooLong},
		{file: videoFile(), meta: null, notice: TEXT.videoUnreadable}
	];
	for (const one of cases) {
		const {deps, uploads} = makeDeps(one.meta);
		const video = new ComposerVideo(CONFIG, deps, deps.onChange);
		const result = await video.setFile(one.file);
		assert.deepStrictEqual(result, {ok: false, notice: one.notice});
		assert.strictEqual(uploads.length, 0);
		assert.strictEqual(video.state, null);
		assert.ok(!video.isActive());
	}
	// 作った URL はすべて破棄している
	assert.deepStrictEqual([...urls.revoked].sort(), [...urls.created].sort());
});

test('setFile: 2 本目は tooManyVideos', async (t) => {
	stubUrls(t);
	const {deps, uploads} = makeDeps();
	const video = new ComposerVideo(CONFIG, deps, deps.onChange);
	await video.setFile(videoFile());
	const second = await video.setFile(videoFile({name: 'second.mp4'}));
	assert.deepStrictEqual(second, {ok: false, notice: TEXT.tooManyVideos});
	assert.strictEqual(uploads.length, 1);
	assert.strictEqual(video.state.file.name, 'clip.mp4');
});

test('失敗すると error と文言を持ち、retry で同じファイルを送り直す', async (t) => {
	stubUrls(t);
	const {deps, uploads} = makeDeps();
	const video = new ComposerVideo(CONFIG, deps, deps.onChange);
	const file = videoFile();
	await video.setFile(file);
	uploads[0].resolve({ok: false, blob: null, reason: 'upload-forbidden', message: 'Confirm your email address to upload videos'});
	await flush();
	assert.strictEqual(video.state.phase, 'error');
	assert.strictEqual(video.state.error, '動画をアップロードするにはメールアドレスの確認が必要です');
	assert.ok(video.isPending());

	video.retry();
	assert.strictEqual(uploads.length, 2);
	assert.strictEqual(uploads[1].blob, file);
	assert.strictEqual(video.state.phase, 'upload');
	assert.strictEqual(video.state.error, null);
	assert.strictEqual(video.state.uploadId, 'up-2');
	// error 以外では送り直さない
	video.retry();
	assert.strictEqual(uploads.length, 2);
});

test('remove: 走っているアップロードを取り消し、URL を破棄する', async (t) => {
	const urls = stubUrls(t);
	const {deps, calls} = makeDeps();
	const video = new ComposerVideo(CONFIG, deps, deps.onChange);
	await video.setFile(videoFile());
	const url = video.state.url;
	const before = calls.changes;
	video.remove();
	assert.deepStrictEqual(calls.cancels, ['up-1']);
	assert.ok(urls.revoked.includes(url));
	assert.strictEqual(video.state, null);
	assert.ok(calls.changes > before);
});

test('古い uploadId の結果を捨てる', async (t) => {
	stubUrls(t);
	const {deps, uploads} = makeDeps();
	const video = new ComposerVideo(CONFIG, deps, deps.onChange);
	await video.setFile(videoFile({name: 'first.mp4'}));
	video.remove();
	await video.setFile(videoFile({name: 'second.mp4'}));
	assert.strictEqual(video.state.uploadId, 'up-2');

	uploads[0].onProgress({phase: 'processing', progress: 0.9});
	uploads[0].resolve({ok: true, blob: {ref: {$link: 'old'}}, reason: null, message: null});
	await flush();
	assert.strictEqual(video.state.file.name, 'second.mp4');
	assert.strictEqual(video.state.phase, 'upload');
	assert.strictEqual(video.state.blob, null);
	assert.ok(!video.isReady());

	// 送り直した後も、前の回の進み具合は捨てる
	uploads[1].resolve({ok: false, blob: null, reason: 'upload-failed', message: null});
	await flush();
	video.retry();
	uploads[1].onProgress({phase: 'processing', progress: 0.5});
	assert.strictEqual(video.state.phase, 'upload');
	uploads[2].onProgress({phase: 'processing', progress: 0.3});
	assert.strictEqual(video.state.phase, 'processing');
});

test('destroy: 処理中なら取り消し、後から届いた結果で例外を出さず onChange も呼ばない', async (t) => {
	stubUrls(t);
	const {deps, uploads, calls} = makeDeps();
	const video = new ComposerVideo(CONFIG, deps, deps.onChange);
	await video.setFile(videoFile());
	uploads[0].onProgress({phase: 'processing', progress: 0.4});
	video.destroy();
	assert.deepStrictEqual(calls.cancels, ['up-1']);
	assert.strictEqual(video.state, null);
	const after = calls.changes;
	uploads[0].onProgress({phase: 'processing', progress: 0.8});
	uploads[0].resolve({ok: true, blob: {ref: {$link: 'late'}}, reason: null, message: null});
	await flush();
	assert.strictEqual(calls.changes, after);
	assert.strictEqual(video.state, null);
	const again = await video.setFile(videoFile());
	assert.strictEqual(again.ok, false);
	assert.strictEqual(uploads.length, 1);
});

test('destroy: 寸法を読んでいる途中でも、読み終えた後に何もしない', async (t) => {
	stubUrls(t);
	const {deps, uploads, calls} = makeDeps();
	let release = null;
	deps.readVideoMeta = () => new Promise((resolve) => {
		release = resolve;
	});
	const video = new ComposerVideo(CONFIG, deps, deps.onChange);
	const pending = video.setFile(videoFile());
	assert.strictEqual(video.state.phase, 'reading');
	assert.ok(video.isPending());
	video.destroy();
	assert.deepStrictEqual(calls.cancels, []);
	const after = calls.changes;
	release(GOOD_META);
	const result = await pending;
	assert.strictEqual(result.ok, false);
	assert.strictEqual(uploads.length, 0);
	assert.strictEqual(calls.changes, after);
});

test('reset: 取り消しを送らない', async (t) => {
	const urls = stubUrls(t);
	const {deps, uploads, calls} = makeDeps();
	const video = new ComposerVideo(CONFIG, deps, deps.onChange);
	await video.setFile(videoFile());
	uploads[0].resolve({ok: true, blob: {ref: {$link: 'sent'}}, reason: null, message: null});
	await flush();
	const url = video.state.url;
	video.reset();
	assert.deepStrictEqual(calls.cancels, []);
	assert.ok(urls.revoked.includes(url));
	assert.strictEqual(video.state, null);
	assert.ok(!video.isActive());
});

test('toUploaded: ALT・縦横比・字幕の BlobRef を UploadedVideo にする', async (t) => {
	stubUrls(t);
	const {deps, uploads} = makeDeps();
	const video = new ComposerVideo(CONFIG, deps, deps.onChange);
	await video.setFile(videoFile());
	const blob = {ref: {$link: 'bafy-video'}};
	uploads[0].resolve({ok: true, blob, reason: null, message: null});
	await flush();
	const captionBlob = new Blob(['WEBVTT'], {type: 'text/vtt'});
	video.setAlt('猫が走る');
	video.setCaption({blob: captionBlob, name: 'sub.vtt', lang: 'ja'});
	const captionRef = {ref: {$link: 'bafy-caption'}};
	assert.deepStrictEqual(video.toUploaded(captionRef), {
		blob, alt: '猫が走る', width: 1280, height: 720, captions: [{lang: 'ja', file: captionRef}]
	});
	assert.deepStrictEqual(video.toUploaded(null), {
		blob, alt: '猫が走る', width: 1280, height: 720, captions: []
	});
	video.setCaption(null);
	assert.strictEqual(video.state.caption, null);
	assert.deepStrictEqual(video.toUploaded(captionRef).captions, []);
});

test('readCaptionFile: 型が octet-stream の .vtt を text/vtt の Blob にする', async () => {
	const file = new File(['WEBVTT\n\n00:00.000 --> 00:01.000\nこんにちは\n'], 'sub.vtt', {type: 'application/octet-stream'});
	const result = await readCaptionFile(file, RULE.caption);
	assert.strictEqual(result.ok, true);
	assert.strictEqual(result.name, 'sub.vtt');
	assert.strictEqual(result.blob.type, 'text/vtt');
	assert.strictEqual(result.blob.size, file.size);

	const bom = new File(['﻿WEBVTT\n'], 'bom.vtt', {type: ''});
	assert.strictEqual((await readCaptionFile(bom, RULE.caption)).ok, true);
	const notVtt = new File(['1\n00:00:00,000 --> 00:00:01,000\n'], 'sub.srt', {type: 'application/x-subrip'});
	assert.deepStrictEqual(await readCaptionFile(notVtt, RULE.caption), {ok: false, notice: 'notVtt'});
	const large = new File(['WEBVTT\n' + 'a'.repeat(RULE.caption.maxBytes)], 'big.vtt', {type: 'text/vtt'});
	assert.deepStrictEqual(await readCaptionFile(large, RULE.caption), {ok: false, notice: 'tooLarge'});
});

test('readVideoMeta: loadedmetadata で寸法と長さを返し、URL を破棄する。error なら null', async (t) => {
	const urls = stubUrls(t);
	const doc = new FakeDocument();
	const created = [];
	const original = doc.createElement.bind(doc);
	doc.createElement = (tag) => {
		const element = original(tag);
		if (tag === 'video') created.push(element);
		return element;
	};
	const reading = readVideoMeta(videoFile(), doc);
	const element = created[0];
	element.videoWidth = 640;
	element.videoHeight = 480;
	element.duration = 3.25;
	element.dispatchEvent(new FakeEvent('loadedmetadata'));
	assert.deepStrictEqual(await reading, {width: 640, height: 480, duration: 3.25});
	assert.deepStrictEqual(urls.revoked, urls.created);

	const failing = readVideoMeta(videoFile(), doc);
	created[1].dispatchEvent(new FakeEvent('error'));
	assert.strictEqual(await failing, null);
	assert.deepStrictEqual(urls.revoked, urls.created);
});

test('render: 状態の 1 行を書き換え、進み具合では動画を作り直さず、失敗で再試行を出す', async (t) => {
	stubUrls(t);
	const {deps, uploads} = makeDeps();
	const video = new ComposerVideo(CONFIG, deps, deps.onChange);
	const doc = new FakeDocument();
	const container = doc.createElement('div');
	doc.body.append(container);
	await video.setFile(videoFile());
	const handlers = {onAlt: () => {}, onRemoved: () => {}};
	video.render(container, handlers, false);
	const status = container.querySelector(`.${COMPOSE.classes.videoStatus}`);
	assert.strictEqual(status.getAttribute('aria-live'), 'polite');
	assert.strictEqual(status.textContent, '動画を送信中 0%');
	const player = container.querySelector('video');
	assert.ok(player);

	uploads[0].onProgress({phase: 'upload', progress: 0.42});
	video.render(container, handlers, false);
	assert.strictEqual(container.querySelector('video'), player, '進み具合で動画を作り直した');
	assert.strictEqual(container.querySelector(`.${COMPOSE.classes.videoStatus}`).textContent, '動画を送信中 42%');
	assert.strictEqual(container.querySelector(`.${COMPOSE.classes.videoRetry}`), null);

	uploads[0].resolve({ok: false, blob: null, reason: 'upload-failed', message: null});
	await flush();
	video.render(container, handlers, false);
	assert.strictEqual(container.querySelector(`.${COMPOSE.classes.videoStatus}`).textContent, TEXT.videoFailed);
	const retry = container.querySelector(`.${COMPOSE.classes.videoRetry}`);
	assert.strictEqual(retry.textContent, TEXT.videoRetry);
	click(retry);
	assert.strictEqual(uploads.length, 2);

	video.setCaption({blob: new Blob(['WEBVTT']), name: 'a.vtt', lang: 'ja'});
	video.render(container, handlers, false);
	assert.strictEqual(container.querySelector(`.${COMPOSE.classes.videoBadge}`).textContent, TEXT.videoCaptionBadge);

	let removed = 0;
	video.render(container, {onAlt: () => {}, onRemoved: () => { removed += 1; }}, false);
	click(container.querySelector(`.${CONFIG.cards.classes.remove}`));
	assert.strictEqual(video.state, null);
	assert.strictEqual(removed, 1);
	video.render(container, handlers, false);
	assert.ok(container.hidden);
	assert.strictEqual(container.querySelector('video'), null);
});

test('render: 読み取りから失敗まで、状態の 1 行の要素は同じで文字だけが変わる', async (t) => {
	stubUrls(t);
	const {deps, uploads} = makeDeps();
	let release = null;
	deps.readVideoMeta = () => new Promise((resolve) => {
		release = resolve;
	});
	const video = new ComposerVideo(CONFIG, deps, deps.onChange);
	const doc = new FakeDocument();
	const container = doc.createElement('div');
	doc.body.append(container);
	const handlers = {onAlt: () => {}, onRemoved: () => {}};
	const pending = video.setFile(videoFile());
	video.render(container, handlers, false);
	const status = container.querySelector(`.${COMPOSE.classes.videoStatus}`);
	assert.ok(status);
	assert.strictEqual(container.querySelector('video'), null);

	release(GOOD_META);
	await pending;
	video.render(container, handlers, false);
	assert.strictEqual(container.querySelector(`.${COMPOSE.classes.videoStatus}`), status, '動画が付いて作り直した');
	assert.ok(container.querySelector('video'));
	assert.strictEqual(status.textContent, '動画を送信中 0%');

	uploads[0].resolve({ok: false, blob: null, reason: 'upload-forbidden', message: 'Confirm your email address to upload videos'});
	await flush();
	video.render(container, handlers, false);
	assert.strictEqual(container.querySelector(`.${COMPOSE.classes.videoStatus}`), status, '失敗で作り直した');
	assert.strictEqual(status.textContent, '動画をアップロードするにはメールアドレスの確認が必要です');
	assert.strictEqual(status.getAttribute('aria-live'), 'polite');
	assert.ok(container.querySelector(`.${COMPOSE.classes.videoRetry}`));
});

test('render: 寸法を読んでいる間は「動画を読み込み中…」と × を出し、× で外す', async (t) => {
	stubUrls(t);
	const {deps, uploads, calls} = makeDeps();
	let release = null;
	deps.readVideoMeta = () => new Promise((resolve) => {
		release = resolve;
	});
	const video = new ComposerVideo(CONFIG, deps, deps.onChange);
	const doc = new FakeDocument();
	const container = doc.createElement('div');
	doc.body.append(container);
	let removed = 0;
	const handlers = {onAlt: () => {}, onRemoved: () => { removed += 1; }};
	const pending = video.setFile(videoFile());
	video.render(container, handlers, false);
	assert.strictEqual(container.querySelector(`.${COMPOSE.classes.videoStatus}`).textContent, TEXT.videoReading);
	const remove = container.querySelector(`.${COMPOSE.classes.videoRemove}`);
	assert.ok(remove, '読み取り中に × が無い');
	assert.strictEqual(remove.getAttribute('aria-label'), TEXT.removeVideo);
	assert.strictEqual(container.querySelector(`.${COMPOSE.classes.videoRetry}`), null);
	click(remove);
	assert.strictEqual(video.state, null);
	assert.strictEqual(removed, 1);
	video.render(container, handlers, false);
	assert.ok(container.hidden);
	// 外した後に読み終えても取り込まない
	release(GOOD_META);
	assert.deepStrictEqual(await pending, {ok: false, notice: ''});
	assert.strictEqual(uploads.length, 0);
	assert.deepStrictEqual(calls.cancels, []);
});

test('render: 読み終えて送り始めたら × の枠は消え、プレビューの × に替わる', async (t) => {
	stubUrls(t);
	const {deps} = makeDeps();
	let release = null;
	deps.readVideoMeta = () => new Promise((resolve) => {
		release = resolve;
	});
	const video = new ComposerVideo(CONFIG, deps, deps.onChange);
	const doc = new FakeDocument();
	const container = doc.createElement('div');
	doc.body.append(container);
	const pending = video.setFile(videoFile());
	video.render(container, {}, false);
	assert.ok(container.querySelector(`.${COMPOSE.classes.videoRemove}`));
	release(GOOD_META);
	await pending;
	video.render(container, {}, false);
	assert.strictEqual(container.querySelector(`.${COMPOSE.classes.videoRemove}`), null);
	assert.ok(container.querySelector(`.${CONFIG.cards.classes.remove}`));
});

test('render: 再試行の後は ALT のボタン (無ければ状態の 1 行) へフォーカスを移す', async (t) => {
	stubUrls(t);
	for (const withAlt of [true, false]) {
		const {deps, uploads} = makeDeps();
		const doc = new FakeDocument();
		const container = doc.createElement('div');
		doc.body.append(container);
		const handlers = withAlt ? {onAlt: () => {}, onRemoved: () => {}} : {};
		let video = null;
		// 入力欄と同じく、状態が変わるたびにその場で描き直す
		deps.onChange = () => video.render(container, handlers, false);
		video = new ComposerVideo(CONFIG, deps, deps.onChange);
		await video.setFile(videoFile());
		uploads[0].resolve({ok: false, blob: null, reason: 'upload-failed', message: null});
		await flush();
		const status = container.querySelector(`.${COMPOSE.classes.videoStatus}`);
		assert.strictEqual(status.getAttribute('tabindex'), '-1');
		const retry = container.querySelector(`.${COMPOSE.classes.videoRetry}`);
		retry.focus();
		click(retry);
		assert.strictEqual(uploads.length, 2);
		assert.strictEqual(container.querySelector(`.${COMPOSE.classes.videoRetry}`), null);
		if (withAlt) {
			const alt = container.querySelector(`.${CONFIG.cards.classes.gifAlt}`);
			assert.ok(alt);
			assert.strictEqual(doc.activeElement, alt);
		} else {
			assert.strictEqual(doc.activeElement, status);
		}
	}
});

test('render: 手元の動画の source に type を書かない (.mov を飛ばさせない)', async (t) => {
	stubUrls(t);
	const {deps} = makeDeps();
	const video = new ComposerVideo(CONFIG, deps, deps.onChange);
	const doc = new FakeDocument();
	const container = doc.createElement('div');
	await video.setFile(videoFile({name: 'clip.mov', type: 'video/quicktime'}));
	video.render(container, {}, false);
	const sources = container.querySelectorAll('source');
	assert.strictEqual(sources.length, 1);
	assert.strictEqual(sources[0].getAttribute('src'), video.state.url);
	assert.strictEqual(sources[0].hasAttribute('type'), false);
});

/**
 * 重ねる画面を開く偽のパネルを作る。
 * @returns {{doc: FakeDocument, panel: Object, opener: Object, host: SheetHost}}
 */
function sheetSetup() {
	const doc = new FakeDocument();
	const panel = doc.createElement('aside');
	const opener = doc.createElement('button');
	panel.append(opener);
	doc.body.append(panel);
	opener.focus();
	return {doc, panel, opener, host: new SheetHost(panel, COMPOSE)};
}

/**
 * 画面の入力を作る。
 * @param {Object} overrides
 * @returns {Object}
 */
function sheetInput(overrides) {
	return {
		previewUrl: 'blob:fake-video',
		alt: '',
		caption: null,
		maxAltGraphemes: COMPOSE.maxAltGraphemes,
		languageCodes: ['ja', 'en'],
		defaultLang: 'ja',
		locale: 'ja',
		readCaption: async (file) => ({ok: true, blob: new Blob(['WEBVTT'], {type: 'text/vtt'}), name: file.name}),
		...overrides
	};
}

test('openVideoSheet: 字幕を選ぶと名前と言語が出て、完了で ALT と字幕を渡す', async () => {
	const {panel, opener, host} = sheetSetup();
	const saved = [];
	openVideoSheet(host, sheetInput(), opener, (value) => saved.push(value));
	const title = panel.querySelector('[data-role="sheet-title"]');
	assert.strictEqual(title.textContent, TEXT.videoSheetTitle);
	const fileInput = panel.querySelector('input');
	assert.strictEqual(fileInput.type, 'file');
	assert.strictEqual(fileInput.getAttribute('accept'), '.vtt,text/vtt');
	assert.ok(panel.querySelector(`.${COMPOSE.classes.captionRow}`).hidden);

	panel.querySelector('textarea').value = '  海の動画  ';
	fileInput.files = [{name: 'sub.vtt'}];
	fileInput.dispatchEvent(new FakeEvent('change'));
	await flush();
	assert.ok(!panel.querySelector(`.${COMPOSE.classes.captionRow}`).hidden);
	assert.strictEqual(panel.querySelector(`.${COMPOSE.classes.captionName}`).textContent, 'sub.vtt');
	const select = panel.querySelector('select');
	assert.strictEqual(select.value, 'ja');
	assert.strictEqual(select.querySelectorAll('option').length, 2);
	select.value = 'en';
	select.dispatchEvent(new FakeEvent('change'));

	click(panel.querySelector('[data-role="sheet-done"]'));
	assert.strictEqual(saved.length, 1);
	assert.strictEqual(saved[0].alt, '海の動画');
	assert.strictEqual(saved[0].caption.name, 'sub.vtt');
	assert.strictEqual(saved[0].caption.lang, 'en');
	assert.ok(!host.isOpen());
});

test('openVideoSheet: .vtt でないと画面の中に 1 行出し、字幕を外すと渡さない', async () => {
	const {panel, opener, host} = sheetSetup();
	const saved = [];
	let answer = {ok: false, notice: 'notVtt'};
	const existing = {blob: new Blob(['WEBVTT']), name: 'old.vtt', lang: 'en'};
	openVideoSheet(host, sheetInput({caption: existing, readCaption: async () => answer}), opener,
		(value) => saved.push(value));
	assert.strictEqual(panel.querySelector(`.${COMPOSE.classes.captionName}`).textContent, 'old.vtt');
	assert.strictEqual(panel.querySelector('select').value, 'en');

	const fileInput = panel.querySelector('input');
	fileInput.files = [{name: 'sub.srt'}];
	fileInput.dispatchEvent(new FakeEvent('change'));
	await flush();
	const error = panel.querySelector('[role="alert"]');
	assert.ok(!error.hidden);
	assert.strictEqual(error.textContent, TEXT.captionNotVtt);
	answer = {ok: false, notice: 'tooLarge'};
	fileInput.files = [{name: 'big.vtt'}];
	fileInput.dispatchEvent(new FakeEvent('change'));
	await flush();
	assert.strictEqual(error.textContent, TEXT.captionTooLarge);
	// 断った字幕では前の字幕を残す
	assert.strictEqual(panel.querySelector(`.${COMPOSE.classes.captionName}`).textContent, 'old.vtt');

	const removeButton = panel.querySelectorAll('button').find((button) => button.textContent === TEXT.captionRemove);
	click(removeButton);
	assert.ok(panel.querySelector(`.${COMPOSE.classes.captionRow}`).hidden);
	click(panel.querySelector('[data-role="sheet-done"]'));
	assert.deepStrictEqual(saved, [{alt: '', caption: null}]);
});

test('openVideoSheet: キャンセルでは何も渡さない', () => {
	const {panel, opener, host} = sheetSetup();
	const saved = [];
	openVideoSheet(host, sheetInput(), opener, (value) => saved.push(value));
	click(panel.querySelector('[data-role="sheet-cancel"]'));
	assert.deepStrictEqual(saved, []);
	assert.ok(!host.isOpen());
});

test('openVideoSheet: 既定の言語が空なら選択肢の先頭を保存し、選べる言語が無ければ字幕を渡さない', async () => {
	for (const [codes, expected] of [[['ja', 'en'], 'ja'], [[], null]]) {
		const {panel, opener, host} = sheetSetup();
		const saved = [];
		openVideoSheet(host, sheetInput({defaultLang: '', languageCodes: codes}), opener, (value) => saved.push(value));
		const fileInput = panel.querySelector('input');
		fileInput.files = [{name: 'sub.vtt'}];
		fileInput.dispatchEvent(new FakeEvent('change'));
		await flush();
		const select = panel.querySelector('select');
		click(panel.querySelector('[data-role="sheet-done"]'));
		if (expected === null) {
			assert.strictEqual(saved[0].caption, null);
		} else {
			assert.strictEqual(select.value, expected);
			assert.strictEqual(saved[0].caption.lang, expected);
		}
	}
});

test('openVideoSheet: 字幕の読み取りが重なったら最後に選んだものだけを使い、外すと読み取り中の結果を捨てる', async () => {
	const {panel, opener, host} = sheetSetup();
	const saved = [];
	const reads = [];
	const readCaption = (file) => new Promise((resolve) => {
		reads.push({
			resolve: () => resolve({ok: true, blob: new Blob(['WEBVTT'], {type: 'text/vtt'}), name: file.name})
		});
	});
	openVideoSheet(host, sheetInput({readCaption}), opener, (value) => saved.push(value));
	const fileInput = panel.querySelector('input');
	const choose = (fileName) => {
		fileInput.files = [{name: fileName}];
		fileInput.dispatchEvent(new FakeEvent('change'));
	};
	const nameEl = () => panel.querySelector(`.${COMPOSE.classes.captionName}`);
	choose('a.vtt');
	choose('b.vtt');
	reads[1].resolve();
	await flush();
	reads[0].resolve();
	await flush();
	assert.strictEqual(nameEl().textContent, 'b.vtt');

	choose('c.vtt');
	const removeButton = panel.querySelectorAll('button').find((button) => button.textContent === TEXT.captionRemove);
	click(removeButton);
	reads[2].resolve();
	await flush();
	assert.ok(panel.querySelector(`.${COMPOSE.classes.captionRow}`).hidden);
	click(panel.querySelector('[data-role="sheet-done"]'));
	assert.deepStrictEqual(saved, [{alt: '', caption: null}]);
});

test('readVideoMeta: 読み終えたら src を外し、load() で読み込みを止める', async (t) => {
	stubUrls(t);
	const doc = new FakeDocument();
	const created = [];
	const original = doc.createElement.bind(doc);
	doc.createElement = (tag) => {
		const element = original(tag);
		if (tag === 'video') {
			element.loads = 0;
			element.load = () => {
				element.loads += 1;
			};
			created.push(element);
		}
		return element;
	};
	const reading = readVideoMeta(videoFile(), doc, 1000);
	const element = created[0];
	element.videoWidth = 10;
	element.videoHeight = 10;
	element.duration = 1;
	element.dispatchEvent(new FakeEvent('loadedmetadata'));
	await reading;
	assert.strictEqual(element.hasAttribute('src'), false);
	assert.strictEqual(element.loads, 1);
});

test('isVisibleProgressChange: 段階か、状態の 1 行に出す百分率が変わったときだけ真', () => {
	assert.strictEqual(isVisibleProgressChange({phase: 'upload', progress: 0.421}, {phase: 'upload', progress: 0.428}), false);
	assert.strictEqual(isVisibleProgressChange({phase: 'upload', progress: 0.42}, {phase: 'upload', progress: 0.43}), true);
	assert.strictEqual(isVisibleProgressChange({phase: 'upload', progress: 1}, {phase: 'processing', progress: 0}), true);
	assert.strictEqual(isVisibleProgressChange({phase: 'processing', progress: null}, {phase: 'processing', progress: null}), false);
	assert.strictEqual(isVisibleProgressChange({phase: 'processing', progress: null}, {phase: 'processing', progress: 0}), true);
});

test('applyProgress: 百分率の整数が変わらない進み具合では onChange を呼ばない', async (t) => {
	stubUrls(t);
	const {deps, uploads, calls} = makeDeps();
	const video = new ComposerVideo(CONFIG, deps, deps.onChange);
	await video.setFile(videoFile());
	const before = calls.changes;
	uploads[0].onProgress({phase: 'upload', progress: 0.101});
	assert.strictEqual(calls.changes, before + 1);
	uploads[0].onProgress({phase: 'upload', progress: 0.105});
	assert.strictEqual(calls.changes, before + 1, '同じ 10% で知らせた');
	assert.strictEqual(video.state.progress, 0.105, '値そのものは更新する');
	uploads[0].onProgress({phase: 'processing', progress: 0.105});
	assert.strictEqual(calls.changes, before + 2, '段階の変化を知らせない');
});

test('render: 送信の始まりと終わりで動画を作り直さず、ボタンの押せる / 押せないだけを変える', async (t) => {
	stubUrls(t);
	const {deps, uploads} = makeDeps();
	const video = new ComposerVideo(CONFIG, deps, deps.onChange);
	const doc = new FakeDocument();
	const container = doc.createElement('div');
	doc.body.append(container);
	await video.setFile(videoFile());
	uploads[0].resolve({ok: true, blob: {$type: 'blob', ref: {$link: 'bafy'}}, reason: null, message: null});
	await flush();
	const handlers = {onAlt: () => {}, onRemoved: () => {}};
	video.render(container, handlers, false);
	const player = container.querySelector('video');
	const toolButtons = () => container.querySelector(`.${CONFIG.cards.classes.gifTools}`).querySelectorAll('button');
	assert.ok(toolButtons().length > 0);
	assert.ok(toolButtons().every((button) => button.disabled === false));
	video.render(container, handlers, true);
	assert.strictEqual(container.querySelector('video'), player, '送信の始まりで動画を作り直した');
	assert.ok(toolButtons().every((button) => button.disabled === true));
	video.render(container, handlers, false);
	assert.strictEqual(container.querySelector('video'), player, '送信の終わりで動画を作り直した');
	assert.ok(toolButtons().every((button) => button.disabled === false));
});
