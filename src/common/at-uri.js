/**
 * AT URI (at://<repo>/<collection>/<rkey>) の分解。
 * パネル・返信欄・投稿操作・グリッド・カードが同じ規則で読む。
 *
 * 依存: なし
 */

/** 投稿の collection */
export const POST_COLLECTION = 'app.bsky.feed.post';

/** レコードの AT URI。collection を問わない */
const RECORD_URI_PATTERN = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/;

/**
 * レコードの AT URI を分解する。
 * @param {*} uri
 * @returns {{did: string, collection: string, rkey: string}|null} 形が違えば null
 */
export function parseAtUri(uri) {
	if (typeof uri !== 'string') {
		return null;
	}
	const matched = RECORD_URI_PATTERN.exec(uri);
	return matched ? {did: matched[1], collection: matched[2], rkey: matched[3]} : null;
}

/**
 * 投稿の AT URI を分解する。投稿以外の collection は弾く。
 * @param {*} uri
 * @returns {{did: string, rkey: string}|null}
 */
export function parsePostAtUri(uri) {
	const parsed = parseAtUri(uri);
	return parsed && parsed.collection === POST_COLLECTION ? {did: parsed.did, rkey: parsed.rkey} : null;
}

/**
 * 投稿の AT URI から rkey を取り出す。
 * @param {*} uri
 * @returns {string|null}
 */
export function postRkey(uri) {
	const parsed = parsePostAtUri(uri);
	return parsed ? parsed.rkey : null;
}
