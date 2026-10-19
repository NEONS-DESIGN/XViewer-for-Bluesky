/**
 * MAIN ワールドの橋渡し (inject/page-bridge.js) へ要求を出す共通クライアント。
 * 結果と進み具合のイベントはモジュールで 1 本ずつ受け、id で待っている要求へ振り分ける
 * (要求ごとにリスナーを足すと、待っている数だけ同じ応答を JSON.parse することになる)。
 */
import {EXT_CONFIG} from '../common/config.js';
import {BRIDGE_PROTOCOL} from '../common/bridge-protocol.js';

/** 応答を待ちきれなかったときの理由 (MAIN ワールドが先に打ち切ったときと同じ値) */
export const BRIDGE_TIMEOUT_REASON = BRIDGE_PROTOCOL.reasons.timeout;

/** 要求を橋渡しへ送れなかったときの理由 */
const BRIDGE_DISPATCH_REASON = 'dispatch';

/**
 * 通し番号の始まり。拡張機能を読み直してタブを再読み込みしないと古い content script と並んで動くため、
 * 0 から数えると番号がぶつかり結果を取り違える。乱数で始めて避ける
 */
const SEQUENCE_START_RANGE = 1e9;

/** 要求と結果を対応付ける通し番号。モジュールの中だけで持つ */
let sequence = Math.floor(Math.random() * SEQUENCE_START_RANGE);

/**
 * 待っている要求。
 * @type {Map<number, {resolve: (detail: Object) => void, onProgress: ((detail: Object) => void)|null}>}
 */
const waiting = new Map();

/** 共有のリスナーを付けた document (読み込み直しやテストの差し替えで変わったら付け直す) */
let listenedDocument = null;

/**
 * イベントの detail を読む。読めなければ null。
 * @param {Event} event
 * @returns {Object|null}
 */
function readDetail(event) {
	try {
		const detail = JSON.parse(event.detail);
		return detail && typeof detail === 'object' ? detail : null;
	} catch (error) {
		return null;
	}
}

/** 結果と進み具合の共有のリスナーを 1 回だけ付ける。 */
function ensureListening() {
	if (listenedDocument === document) {
		return;
	}
	const bridge = EXT_CONFIG.mediaGrid.bridge;
	document.addEventListener(bridge.resultEvent, (event) => {
		const detail = readDetail(event);
		const entry = detail ? waiting.get(detail.id) : null;
		if (entry) {
			entry.resolve(detail);
		}
	});
	document.addEventListener(bridge.progressEvent, (event) => {
		const detail = readDetail(event);
		const entry = detail ? waiting.get(detail.id) : null;
		if (entry && entry.onProgress) {
			entry.onProgress(detail);
		}
	});
	listenedDocument = document;
}

/**
 * MAIN ワールドの page-bridge.js へ要求を出し、結果を待つ。
 * 解決時・タイムアウト時のどちらでも待ちの記録を外し、タイマーを消す。
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

		const finish = (detail) => {
			waiting.delete(id);
			if (timer !== null) {
				clearTimeout(timer);
				timer = null;
			}
			resolve(detail);
		};

		const onTimeout = () => finish({ok: false, reason: BRIDGE_TIMEOUT_REASON});

		waiting.set(id, {
			resolve: finish,
			onProgress: (useIdle || onProgress)
				? (detail) => {
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
				}
				: null
		});
		timer = setTimeout(onTimeout, timeoutMs);

		try {
			ensureListening();
			document.dispatchEvent(new CustomEvent(bridge.requestEvent, {
				detail: JSON.stringify({id, action, payload})
			}));
		} catch (error) {
			finish({ok: false, reason: BRIDGE_DISPATCH_REASON});
		}
	});
}
