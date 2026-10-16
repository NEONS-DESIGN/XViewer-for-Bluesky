/**
 * MAIN ワールドの橋渡し (inject/page-bridge.js) へ要求を出す共通クライアント。
 */
import {EXT_CONFIG} from '../common/config.js';

/** 要求と結果を対応付ける通し番号。モジュールの中だけで持つ */
let sequence = 0;

/**
 * MAIN ワールドの page-bridge.js へ要求を出し、結果を待つ。
 * 解決時・タイムアウト時のどちらでも購読を外し、タイマーを消す。
 * @param {string} action EXT_CONFIG.mediaGrid.bridge.actions のいずれか
 * @param {Object} payload
 * @returns {Promise<{ok: boolean, reason: string|null}>} reject はしない
 */
export function callBridge(action, payload) {
	const bridge = EXT_CONFIG.mediaGrid.bridge;
	sequence += 1;
	const id = sequence;

	return new Promise((resolve) => {
		let timer = null;

		const onResult = (event) => {
			let detail = null;
			try {
				detail = JSON.parse(event.detail);
			} catch (error) {
				return;
			}
			if (!detail || detail.id !== id) {
				return;
			}
			cleanup();
			resolve(detail);
		};

		const cleanup = () => {
			document.removeEventListener(bridge.resultEvent, onResult);
			if (timer !== null) {
				clearTimeout(timer);
				timer = null;
			}
		};

		document.addEventListener(bridge.resultEvent, onResult);
		timer = setTimeout(() => {
			cleanup();
			resolve({ok: false, reason: 'timeout'});
		}, bridge.timeoutMs);

		try {
			document.dispatchEvent(new CustomEvent(bridge.requestEvent, {
				detail: JSON.stringify({id, action, payload})
			}));
		} catch (error) {
			cleanup();
			resolve({ok: false, reason: 'dispatch'});
		}
	});
}
