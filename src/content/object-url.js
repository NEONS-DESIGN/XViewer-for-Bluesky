/**
 * Blob の object URL を作る・捨てる。作れない環境 (Blob でない値・URL の API が無い) でも例外を投げない。
 * 入力欄のプレビュー (画像・動画・リンクカードのサムネイル) と、画像を読み込むための一時の URL に使う。
 *
 * 依存: なし
 */

/**
 * object URL を作る。作れなければ空文字。
 * @param {Blob|null|undefined} blob
 * @returns {string}
 */
export function createObjectUrl(blob) {
	if (!blob) return '';
	try {
		return URL.createObjectURL(blob) || '';
	} catch (error) {
		return '';
	}
}

/**
 * object URL を捨てる。空・null なら何もしない。
 * @param {string|null|undefined} url
 * @returns {void}
 */
export function revokeObjectUrl(url) {
	if (!url) return;
	try {
		URL.revokeObjectURL(url);
	} catch (error) {
		// 捨てられなくても表示と送信には影響させない
	}
}
