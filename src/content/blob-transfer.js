/**
 * 分離ワールドの Blob を MAIN ワールドの橋渡しへ渡し、PDS へアップロードさせる。
 * Blob は構造化複製できる postMessage で先に預け、upload-blob の要求は id だけを運ぶ
 * (要求のイベントは JSON 文字列のため Blob を載せられない)。
 */
import {EXT_CONFIG} from '../common/config.js';
import {BRIDGE_PROTOCOL} from '../common/bridge-protocol.js';
import {callBridge} from './bridge-client.js';

/**
 * Blob を預けて upload-blob を呼び、PDS が返した BlobRef を受け取る。
 * @param {Blob} blob アップロードする画像・字幕
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
		const result = await callBridge(EXT_CONFIG.mediaGrid.bridge.actions.uploadBlob, {blobId: id});
		if (result && result.ok === true && result.blob) {
			return {ok: true, blob: result.blob, reason: null};
		}
		return {ok: false, blob: null, reason: (result && result.reason) || BRIDGE_PROTOCOL.reasons.uploadFailed};
	} catch (error) {
		return {ok: false, blob: null, reason: BRIDGE_PROTOCOL.reasons.uploadFailed};
	}
}
