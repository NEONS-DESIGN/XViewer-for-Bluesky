/**
 * 橋渡しへ渡す遷移先 ({route, params}) と、ライトボックスを開く依頼の組み立て。
 * グリッド・パネル・返信欄が同じ形で本体のルーターとライトボックスを呼ぶ。
 *
 * 依存: config.js (EXT_CONFIG)
 */
import {EXT_CONFIG} from '../common/config.js';

/**
 * @typedef {Object} RouteTarget
 * @property {string} route 本体のルート名
 * @property {Object} params
 */

/**
 * 投稿ページ。
 * @param {string} handle 作者のハンドル (DID でもよい)
 * @param {string} rkey
 * @returns {RouteTarget}
 */
export function postRoute(handle, rkey) {
	return {route: EXT_CONFIG.mediaGrid.bridge.routes.post, params: {name: handle, rkey}};
}

/**
 * プロフィール。
 * @param {string} name ハンドルまたは DID
 * @returns {RouteTarget}
 */
export function profileRoute(name) {
	return {route: EXT_CONFIG.mediaGrid.bridge.routes.profile, params: {name}};
}

/**
 * ハッシュタグのページ。
 * @param {string} tag # を除いたタグ
 * @returns {RouteTarget}
 */
export function hashtagRoute(tag) {
	return {route: EXT_CONFIG.mediaGrid.bridge.routes.hashtag, params: {tag}};
}

/**
 * openLightbox に渡す依頼。本体が自分でライトボックスを開くときと同じ形の metricsContext を添え、
 * 投稿情報パネルが postUri を読めるようにする (パネルはグリッド由来かどうかを知らずに済む)。
 * @param {{images: Object[], index: number, postUri: string, authorDid?: string|null}} request
 * @returns {{images: Object[], index: number, metricsContext: Object}}
 */
export function openLightboxPayload(request) {
	return {
		images: request.images,
		index: request.index,
		metricsContext: {
			postUri: request.postUri,
			// authorDid は欠けうる付加情報。無ければ本体と同じ「省略」の形に揃える
			postAuthorDid: request.authorDid || undefined,
			layout: EXT_CONFIG.mediaGrid.bridge.lightboxLayout
		}
	};
}
