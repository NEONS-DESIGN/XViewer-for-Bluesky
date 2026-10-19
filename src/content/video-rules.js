import {formatText} from './sheet-dom.js';

/**
 * @typedef {Object} VideoStatus
 * @property {'reading'|'upload'|'processing'|'ready'|'error'} phase 段階
 * @property {number|null} progress 進み具合 (0〜1。不明は null)
 * @property {string|null} [message] error のときに出す文言
 */

/**
 * 0〜1 の進み具合を 0〜100 の整数にする。読めない値は 0。
 * @param {number|null} progress
 * @returns {number}
 */
export function toPercent(progress) {
	const value = Number(progress);
	if (!Number.isFinite(value)) return 0;
	return Math.min(100, Math.max(0, Math.floor(value * 100)));
}

/**
 * 動画として受け付ける MIME タイプか。
 * @param {{type: string}} file
 * @param {string[]} acceptTypes
 * @returns {boolean}
 */
export function isVideoFile(file, acceptTypes) {
	return !!file && acceptTypes.includes(file.type);
}

/**
 * 動画ファイルの形式と大きさを確かめる。
 * @param {{type: string, size: number}} file
 * @param {{acceptTypes: string[], maxBytes: number}} rule
 * @returns {{ok: true}|{ok: false, notice: 'unreadable'|'tooLarge'}}
 */
export function checkVideoFile(file, rule) {
	if (!isVideoFile(file, rule.acceptTypes) || !(file.size > 0)) return {ok: false, notice: 'unreadable'};
	if (file.size > rule.maxBytes) return {ok: false, notice: 'tooLarge'};
	return {ok: true};
}

/**
 * 動画の寸法と長さ (秒) を確かめ、ミリ秒に直す。
 * @param {{width: number, height: number, duration: number}|null} meta
 * @param {{maxDurationMs: number}} rule
 * @returns {{ok: true, width: number, height: number, durationMs: number}|{ok: false, notice: 'unreadable'|'tooLong'}}
 */
export function checkVideoMeta(meta, rule) {
	if (!meta) return {ok: false, notice: 'unreadable'};
	const {width, height, duration} = meta;
	if (!Number.isFinite(duration) || !(duration > 0) || !(width > 0) || !(height > 0)) {
		return {ok: false, notice: 'unreadable'};
	}
	const durationMs = Math.round(duration * 1000);
	if (durationMs > rule.maxDurationMs) return {ok: false, notice: 'tooLong'};
	return {ok: true, width, height, durationMs};
}

/**
 * 字幕ファイルが WebVTT として送れるかを確かめる。head は先頭を読んだ文字列。
 * @param {{name: string, type: string, size: number}} file
 * @param {string} head
 * @param {{caption: {extension: string, mimeType: string, maxBytes: number, signature: string}}} rule
 * @returns {{ok: true}|{ok: false, notice: 'notVtt'|'tooLarge'}}
 */
export function checkCaptionFile(file, head, rule) {
	const caption = rule.caption;
	const byName = String(file.name || '').toLowerCase().endsWith(caption.extension);
	const byType = file.type === caption.mimeType;
	const body = String(head || '').replace(/^\uFEFF/, '');
	if ((!byName && !byType) || !body.startsWith(caption.signature)) return {ok: false, notice: 'notVtt'};
	if (file.size > caption.maxBytes) return {ok: false, notice: 'tooLarge'};
	return {ok: true};
}

/**
 * 動画の送信・処理の状態を 1 行の文言にする。
 * @param {VideoStatus} status
 * @param {Object<string, string>} text compose.text
 * @returns {string}
 */
export function videoStatusText(status, text) {
	switch (status && status.phase) {
		case 'reading':
			return text.videoReading;
		case 'upload':
			return formatText(text.videoUploading, {percent: toPercent(status.progress)});
		case 'processing':
			return status.progress == null
				? text.videoProcessingPending
				: formatText(text.videoProcessing, {percent: toPercent(status.progress)});
		case 'ready':
			return text.videoReady;
		case 'error':
			return status.message || text.videoFailed;
		default:
			return '';
	}
}

/**
 * 橋渡しの失敗を利用者向けの日本語にする。
 * @param {{reason: string, message: string|null}} result
 * @param {{serverMessages: Object<string, string>, failureTexts: Object<string, string>}} rule
 * @param {Object<string, string>} text compose.text
 * @returns {string}
 */
export function videoErrorText(result, rule, text) {
	const message = result && result.message;
	if (message && Object.hasOwn(rule.serverMessages, message)) return rule.serverMessages[message];
	if (result && result.reason === 'video-failed') {
		return (message && Object.hasOwn(rule.failureTexts, message)) ? rule.failureTexts[message] : text.videoProcessFailed;
	}
	return text.videoFailed;
}
