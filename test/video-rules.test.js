import test from 'node:test';
import assert from 'node:assert';
import {EXT_CONFIG} from '../src/common/config.js';
import {
	isVideoFile,
	checkVideoFile,
	checkVideoMeta,
	checkCaptionFile,
	videoStatusText,
	videoErrorText
} from '../src/content/video-rules.js';

const compose = EXT_CONFIG.lightboxReplies.compose;
const rule = compose.video;
const text = compose.text;

test('isVideoFile は許可した動画の MIME だけ真', () => {
	assert.strictEqual(isVideoFile({type: 'video/mp4'}, rule.acceptTypes), true);
	assert.strictEqual(isVideoFile({type: 'image/gif'}, rule.acceptTypes), false);
});

test('checkVideoFile は大きさと MIME を見る', () => {
	assert.deepStrictEqual(checkVideoFile({type: 'video/mp4', size: 300000000}, rule), {ok: true});
	assert.deepStrictEqual(checkVideoFile({type: 'video/mp4', size: 300000001}, rule), {ok: false, notice: 'tooLarge'});
	assert.deepStrictEqual(checkVideoFile({type: 'video/x-msvideo', size: 10}, rule), {ok: false, notice: 'unreadable'});
	assert.deepStrictEqual(checkVideoFile({type: 'video/mp4', size: 0}, rule), {ok: false, notice: 'unreadable'});
});

test('checkVideoMeta は長さと寸法を見る', () => {
	assert.deepStrictEqual(checkVideoMeta({width: 640, height: 360, duration: 5.0}, rule),
		{ok: true, width: 640, height: 360, durationMs: 5000});
	assert.strictEqual(checkVideoMeta({width: 640, height: 360, duration: 600}, rule).ok, true);
	assert.deepStrictEqual(checkVideoMeta({width: 640, height: 360, duration: 600.001}, rule), {ok: false, notice: 'tooLong'});
	for (const meta of [null, {width: 640, height: 360, duration: NaN}, {width: 640, height: 360, duration: Infinity},
		{width: 640, height: 360, duration: 0}, {width: 0, height: 360, duration: 5}, {width: 640, height: 0, duration: 5}]) {
		assert.deepStrictEqual(checkVideoMeta(meta, rule), {ok: false, notice: 'unreadable'});
	}
});

test('checkCaptionFile は拡張子か型と先頭の WEBVTT を見る', () => {
	const head = 'WEBVTT\r\n\r\n';
	assert.deepStrictEqual(checkCaptionFile({name: 'a.VTT', type: 'application/octet-stream', size: 100}, head, rule), {ok: true});
	assert.deepStrictEqual(checkCaptionFile({name: 'a.vtt', type: '', size: 100}, '\uFEFFWEBVTT', rule), {ok: true});
	assert.deepStrictEqual(checkCaptionFile({name: 'a.txt', type: 'text/vtt', size: 100}, head, rule), {ok: true});
	assert.deepStrictEqual(checkCaptionFile({name: 'a.vtt', type: '', size: 100}, '1\n00:00', rule), {ok: false, notice: 'notVtt'});
	assert.deepStrictEqual(checkCaptionFile({name: 'a.srt', type: '', size: 100}, head, rule), {ok: false, notice: 'notVtt'});
	assert.deepStrictEqual(checkCaptionFile({name: 'a.vtt', type: '', size: 20001}, head, rule), {ok: false, notice: 'tooLarge'});
	assert.deepStrictEqual(checkCaptionFile({name: 'a.vtt', type: '', size: 20000}, head, rule), {ok: true});
});

test('videoStatusText は段階ごとの文言を返す', () => {
	assert.strictEqual(videoStatusText({phase: 'upload', progress: 0.424}, text), '動画を送信中 42%');
	assert.strictEqual(videoStatusText({phase: 'processing', progress: null}, text), '動画を処理中…');
	assert.strictEqual(videoStatusText({phase: 'processing', progress: 0.7}, text), '動画を処理中 70%');
	assert.strictEqual(videoStatusText({phase: 'ready', progress: null}, text), '動画の準備ができました');
	assert.strictEqual(videoStatusText({phase: 'reading', progress: null}, text), '動画を読み込み中…');
	assert.strictEqual(videoStatusText({phase: 'error', progress: null, message: 'だめ'}, text), 'だめ');
	assert.strictEqual(videoStatusText({phase: 'error', progress: null}, text), '動画を送れませんでした');
});

test('videoErrorText はサーバの文言を日本語にする', () => {
	assert.strictEqual(videoErrorText({reason: 'x', message: 'Confirm your email address to upload videos'}, rule, text),
		'動画をアップロードするにはメールアドレスの確認が必要です');
	assert.strictEqual(videoErrorText({reason: 'video-failed', message: 'unsupported_codec'}, rule, text), 'この形式の動画は使えません');
	assert.strictEqual(videoErrorText({reason: 'video-failed', message: 'unknown'}, rule, text), '動画を処理できませんでした');
	assert.strictEqual(videoErrorText({reason: 'video-failed', message: null}, rule, text), '動画を処理できませんでした');
	assert.strictEqual(videoErrorText({reason: 'other', message: 'Something odd'}, rule, text), '動画を送れませんでした');
});
