/**
 * 動きを減らす設定 (prefers-reduced-motion) の判定。
 * GIF・動画の自動再生とスクロールの滑らかさを、この 1 か所で決める。
 *
 * 依存: なし
 */

/** 動きを減らす設定の問い合わせ */
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * 動きを減らす設定か。読めなければ偽。
 * @param {Window|null} [win] 省けば window
 * @returns {boolean}
 */
export function prefersReducedMotion(win) {
	try {
		const view = win || (typeof window !== 'undefined' ? window : null);
		return !!view && typeof view.matchMedia === 'function' && view.matchMedia(REDUCED_MOTION_QUERY).matches === true;
	} catch (error) {
		return false;
	}
}

/**
 * scrollIntoView などに渡す behavior。動きを減らす設定なら即座に送る。
 * @param {Window|null} [win]
 * @returns {'auto'|'smooth'}
 */
export function scrollBehavior(win) {
	return prefersReducedMotion(win) ? 'auto' : 'smooth';
}
