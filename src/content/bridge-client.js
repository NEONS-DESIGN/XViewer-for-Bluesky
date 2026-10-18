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
 * @param {{timeoutMs?: number, idleTimeoutMs?: number, onProgress?: function({phase: string, progress: (number|null)}): void}} [options]
 *   timeoutMs はこの 1 回だけの待ち時間の上限。正の数でなければ EXT_CONFIG.mediaGrid.bridge.timeoutMs を使う。
 *   idleTimeoutMs が正の数のときは timeoutMs より優先し、同じ id の進み具合が届くたびに
 *   その時間で待ち直す (長い送信を、止まったときだけ打ち切るため)。onProgress は進み具合のたびに呼ぶ
 * @returns {Promise<{ok: boolean, reason: string|null}>} reject はしない
 */
export function callBridge(action, payload, options = {}) {
	const bridge = EXT_CONFIG.mediaGrid.bridge;
	const requested = options && options.timeoutMs;
	const idle = options && options.idleTimeoutMs;
	const useIdle = Number.isFinite(idle) && idle > 0;
	const timeoutMs = useIdle
		? idle
		: (Number.isFinite(requested) && requested > 0 ? requested : bridge.timeoutMs);
	const onProgress = options && typeof options.onProgress === 'function' ? options.onProgress : null;
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

		const onProgressEvent = (event) => {
			let detail = null;
			try {
				detail = JSON.parse(event.detail);
			} catch (error) {
				return;
			}
			if (!detail || detail.id !== id) {
				return;
			}
			if (useIdle) {
				clearTimeout(timer);
				timer = setTimeout(onTimeout, timeoutMs);
			}
			if (onProgress) {
				try {
					onProgress({phase: detail.phase, progress: detail.progress});
				} catch (error) {
					// 呼び出し側の表示の失敗で橋渡しを止めない
				}
			}
		};

		const onTimeout = () => {
			cleanup();
			resolve({ok: false, reason: 'timeout'});
		};

		const cleanup = () => {
			document.removeEventListener(bridge.resultEvent, onResult);
			document.removeEventListener(bridge.progressEvent, onProgressEvent);
			if (timer !== null) {
				clearTimeout(timer);
				timer = null;
			}
		};

		document.addEventListener(bridge.resultEvent, onResult);
		if (useIdle || onProgress) {
			document.addEventListener(bridge.progressEvent, onProgressEvent);
		}
		timer = setTimeout(onTimeout, timeoutMs);

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
