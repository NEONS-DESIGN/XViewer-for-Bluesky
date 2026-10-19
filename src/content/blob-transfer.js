/**
 * 分離ワールドの Blob を MAIN ワールドの橋渡しへ渡し、PDS へアップロードさせる。
 * Blob は構造化複製できる postMessage で先に預け、upload-blob の要求は id だけを運ぶ
 * (要求のイベントは JSON 文字列のため Blob を載せられない)。
 */
import {EXT_CONFIG} from '../common/config.js';
import {BRIDGE_PROTOCOL} from '../common/bridge-protocol.js';
import {callBridge, BRIDGE_TIMEOUT_REASON} from './bridge-client.js';

/**
 * Blob を MAIN ワールドの預かり箱へ postMessage で預ける。宛先は自分のページの origin だけ。
 * @param {string} id 要求に載せる id
 * @param {Blob} blob 預ける Blob
 * @returns {void}
 */
function depositBlob(id, blob) {
	window.postMessage(
		{type: BRIDGE_PROTOCOL.blobMessageType, id, blob},
		window.location.origin
	);
}

/**
 * 橋渡しの返事を、アップロードの結果の形に整える。
 * @param {*} result callBridge の結果
 * @returns {{ok: boolean, blob: Object|null, reason: string|null, message: string|null}}
 *   成功は blob が BlobRef、失敗は reason (無ければ upload-failed)。message はサーバが返した文言
 */
function toUploadResult(result) {
	if (result && result.ok === true && result.blob) {
		return {ok: true, blob: result.blob, reason: null, message: null};
	}
	return {
		ok: false,
		blob: null,
		reason: (result && result.reason) || BRIDGE_PROTOCOL.reasons.uploadFailed,
		message: (result && typeof result.message === 'string') ? result.message : null
	};
}

/**
 * Blob を預けて upload-blob を呼び、PDS が返した BlobRef を受け取る。
 * @param {Blob} blob アップロードする画像
 * @returns {Promise<{ok: boolean, blob: Object|null, reason: string|null}>}
 *   blob は成功時の BlobRef。reject はしない
 */
export async function uploadBlob(blob) {
	try {
		const id = crypto.randomUUID();
		depositBlob(id, blob);
		const bridge = EXT_CONFIG.mediaGrid.bridge;
		const result = await callBridge(
			bridge.actions.uploadBlob,
			{blobId: id},
			{timeoutMs: bridge.uploadTimeoutMs}
		);
		const {ok, blob: ref, reason} = toUploadResult(result);
		return {ok, blob: ref, reason};
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
	const done = (async () => {
		try {
			depositBlob(id, blob);
			const result = await callBridge(
				bridge.actions.uploadVideo,
				{blobId: id},
				{idleTimeoutMs: bridge.videoIdleTimeoutMs, onProgress}
			);
			// 待ちを打ち切ったときは MAIN ワールドの送信も止めさせる (結果は待たない)
			if (result && result.reason === BRIDGE_TIMEOUT_REASON) cancelVideoUpload(id);
			return toUploadResult(result);
		} catch (error) {
			return toUploadResult(null);
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
