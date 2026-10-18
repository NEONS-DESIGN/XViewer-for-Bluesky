/**
 * 分離ワールドの Blob を MAIN ワールドの橋渡しへ渡し、PDS へアップロードさせる。
 * Blob は構造化複製できる postMessage で先に預け、upload-blob の要求は id だけを運ぶ
 * (要求のイベントは JSON 文字列のため Blob を載せられない)。
 */
import {EXT_CONFIG} from '../common/config.js';
import {BRIDGE_PROTOCOL} from '../common/bridge-protocol.js';
import {callBridge} from './bridge-client.js';

/** callBridge が待ちを打ち切ったときの reason */
const TIMEOUT_REASON = 'timeout';

/**
 * Blob を預けて upload-blob を呼び、PDS が返した BlobRef を受け取る。
 * @param {Blob} blob アップロードする画像
 * @returns {Promise<{ok: boolean, blob: Object|null, reason: string|null}>}
 *   blob は成功時の BlobRef。reject はしない
 */
export async function uploadBlob(blob) {
	try {
		const id = crypto.randomUUID();
		window.postMessage(
			{type: BRIDGE_PROTOCOL.blobMessageType, id, blob},
			window.location.origin
		);
		const bridge = EXT_CONFIG.mediaGrid.bridge;
		const result = await callBridge(
			bridge.actions.uploadBlob,
			{blobId: id},
			{timeoutMs: bridge.uploadTimeoutMs}
		);
		if (result && result.ok === true && result.blob) {
			return {ok: true, blob: result.blob, reason: null};
		}
		return {ok: false, blob: null, reason: (result && result.reason) || BRIDGE_PROTOCOL.reasons.uploadFailed};
	} catch (error) {
		return {ok: false, blob: null, reason: BRIDGE_PROTOCOL.reasons.uploadFailed};
	}
}

/**
 * 動画を預け、upload-video で動画サービスへ送らせる。進み具合は onProgress に届く。
 * 待ち時間は進み具合が止まってからの上限 (videoIdleTimeoutMs) で決め、打ち切ったら取り消しも送る。
 * @param {Blob} blob アップロードする動画
 * @param {function({phase: string, progress: (number|null)}): void} onProgress
 * @returns {{id: string, done: Promise<{ok: boolean, blob: Object|null, reason: string|null, message: string|null}>}}
 *   id は取り消しに使う。done は reject しない。message はサーバが返した文言
 */
export function uploadVideo(blob, onProgress) {
	const id = crypto.randomUUID();
	const bridge = EXT_CONFIG.mediaGrid.bridge;
	const failed = (reason, message = null) => ({ok: false, blob: null, reason, message});
	const done = (async () => {
		try {
			window.postMessage(
				{type: BRIDGE_PROTOCOL.blobMessageType, id, blob},
				window.location.origin
			);
			const result = await callBridge(
				bridge.actions.uploadVideo,
				{blobId: id},
				{idleTimeoutMs: bridge.videoIdleTimeoutMs, onProgress}
			);
			if (result && result.ok === true && result.blob) {
				return {ok: true, blob: result.blob, reason: null, message: null};
			}
			// 待ちを打ち切ったときは MAIN ワールドの送信も止めさせる (結果は待たない)
			if (result && result.reason === TIMEOUT_REASON) cancelVideoUpload(id);
			return failed(
				(result && result.reason) || BRIDGE_PROTOCOL.reasons.uploadFailed,
				(result && typeof result.message === 'string') ? result.message : null
			);
		} catch (error) {
			return failed(BRIDGE_PROTOCOL.reasons.uploadFailed);
		}
	})();
	return {id, done};
}

/**
 * 送信中の動画のアップロードを取り消す。結果は待たない。
 * @param {string} id uploadVideo が返した id
 * @returns {void}
 */
export function cancelVideoUpload(id) {
	try {
		callBridge(EXT_CONFIG.mediaGrid.bridge.actions.cancelUploadVideo, {blobId: id});
	} catch (error) {
		// 取り消しの失敗は呼び出し側に影響させない
	}
}
