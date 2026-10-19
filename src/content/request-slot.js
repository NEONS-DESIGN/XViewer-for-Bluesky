/**
 * 「最後に始めた 1 本だけを生かす」要求の枠。始めるたびに印 (token) を配り、前の要求は打ち切る。
 * 届いた応答は、配った印が今も最後のものかを isCurrent で照らしてから使う
 * (外した・取り直した・撤去した後に届いた応答を黙って捨てるため)。
 *
 * 依存: なし
 */

/**
 * 要求 1 本の印。signal を fetch などに渡すと、差し替え・取り消しのときに通信も止まる。
 * @typedef {Object} RequestToken
 * @property {AbortSignal|null} signal 打ち切りの合図 (AbortController の無い環境では null)
 */

/**
 * @typedef {Object} RequestSlot
 * @property {() => RequestToken} begin 新しい要求を始める。前の要求は打ち切る
 * @property {(token: RequestToken|null|undefined) => boolean} isCurrent その印が最後に配ったもので、打ち切られていないか
 * @property {() => void} cancel 走っている要求を打ち切り、どの印も今のものでなくする
 */

/**
 * AbortController を作る。作れなければ null。
 * @returns {AbortController|null}
 */
function createController() {
	try {
		return typeof AbortController === 'function' ? new AbortController() : null;
	} catch (error) {
		return null;
	}
}

/**
 * AbortController を打ち切る。失敗しても何もしない。
 * @param {AbortController|null} controller
 * @returns {void}
 */
function abortQuietly(controller) {
	if (!controller) return;
	try {
		controller.abort();
	} catch (error) {
		// 打ち切れなくても印の照合で古い応答は捨てられる
	}
}

/**
 * 要求の枠を作る。
 * @returns {RequestSlot}
 */
export function createRequestSlot() {
	/** @type {{token: RequestToken, controller: AbortController|null}|null} */
	let current = null;
	return {
		begin() {
			if (current) abortQuietly(current.controller);
			const controller = createController();
			const token = {signal: controller ? controller.signal : null};
			current = {token, controller};
			return token;
		},
		isCurrent(token) {
			return !!token && !!current && current.token === token && !(token.signal && token.signal.aborted);
		},
		cancel() {
			if (!current) return;
			abortQuietly(current.controller);
			current = null;
		}
	};
}
