/**
 * タイムアウト付きの fetch と、その上の JSON・Blob の読み出し。
 * 公開 API・cardyb・Klipy など、認証の要らない通信の共通の入口。
 *
 * **打ち切りは本文の読み込みまで含む** (signal は応答の本文の読み出しにも効く)。
 * 外から signal を渡すと、タイムアウトとどちらか早いほうで打ち切る。
 *
 * MAIN ワールド (inject/) からは使わない (import してよいのは bridge-protocol.js だけ)。
 *
 * 依存: なし
 */

/**
 * @typedef {Object} FetchOptions
 * @property {AbortSignal} [signal] 呼び出し側の打ち切り (閉じた・差し替えた)
 * @property {RequestInit} [init] fetch に渡す残りの設定 (signal は上書きする)
 * @property {typeof fetch} [fetchImpl] 差し替え用 (テスト)。省けば globalThis.fetch
 */

/**
 * タイムアウトと呼び出し側の signal を 1 つにする。
 * @param {number} timeoutMs
 * @param {AbortSignal} [signal]
 * @returns {AbortSignal}
 */
export function timeoutSignal(timeoutMs, signal) {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

/**
 * URL を 1 回引く。失敗・打ち切りは例外のまま投げる (呼び出し側が理由を見分けたいとき用)。
 * @param {string} url
 * @param {number} timeoutMs
 * @param {FetchOptions} [options]
 * @returns {Promise<Response>}
 */
export function fetchWithTimeout(url, timeoutMs, options = {}) {
	const fetchImpl = options.fetchImpl || ((...args) => globalThis.fetch(...args));
	return fetchImpl(url, {...(options.init || {}), signal: timeoutSignal(timeoutMs, options.signal)});
}

/**
 * origin・パス・問い合わせから URL を組む。値は文字列に直す。配列は同じキーを繰り返す。
 * @param {string} origin
 * @param {string} path
 * @param {Object<string, *>} [params] undefined / null の値は付けない
 * @returns {string}
 */
export function buildUrl(origin, path, params) {
	const url = new URL(path, origin);
	for (const [key, value] of Object.entries(params || {})) {
		if (value === undefined || value === null) {
			continue;
		}
		for (const one of Array.isArray(value) ? value : [value]) {
			url.searchParams.append(key, String(one));
		}
	}
	return url.toString();
}

/**
 * JSON を引く。中身を読めなければ json は null。
 * @param {string} url
 * @param {number} timeoutMs
 * @param {AbortSignal} [signal]
 * @returns {Promise<{status: number, json: any}|null>} 通信の失敗・打ち切りは null
 */
export async function fetchJson(url, timeoutMs, signal) {
	try {
		const response = await fetchWithTimeout(url, timeoutMs, {signal});
		let json = null;
		try {
			json = await response.json();
		} catch (error) {
			json = null;
		}
		return {status: response.status, json};
	} catch (error) {
		return null;
	}
}

/**
 * 2xx の JSON だけを引く。
 * @param {string} url
 * @param {number} timeoutMs
 * @param {AbortSignal} [signal]
 * @returns {Promise<any|null>} 失敗・打ち切り・2xx 以外・読めない中身は null
 */
export async function fetchOkJson(url, timeoutMs, signal) {
	const result = await fetchJson(url, timeoutMs, signal);
	return result && result.status >= 200 && result.status < 300 ? result.json : null;
}

/**
 * 画像などを Blob で引く。
 * @param {string} url
 * @param {number} timeoutMs
 * @param {AbortSignal} [signal]
 * @returns {Promise<Blob|null>} 失敗・打ち切り・2xx 以外は null
 */
export async function fetchBlob(url, timeoutMs, signal) {
	try {
		const response = await fetchWithTimeout(url, timeoutMs, {signal});
		return response.ok ? await response.blob() : null;
	} catch (error) {
		return null;
	}
}
