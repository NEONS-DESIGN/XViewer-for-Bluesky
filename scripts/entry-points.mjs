/**
 * esbuild に渡す入口の表。副作用を持たせない (build.mjs は読み込むとビルドを始めるため、
 * テストはここから読む)。キーは出力先からの相対パスで、`<キー>.js` が出力名になる。
 */

/** content script の入口。MV3 の content script は ESM を読めないので IIFE 1 本にまとめる。 */
export const CONTENT_ENTRY_POINTS = Object.freeze({
	content: 'src/content/main.js',
});

/** page world (MAIN) へ注入する入口。world が違うので content.js とは別の束にする。 */
export const INJECT_ENTRY_POINTS = Object.freeze({
	inject: 'src/inject/page-bridge.js',
});

/** popup だけの束ねる入口。popup は拡張のページなので ESM で束ねる。 */
export const POPUP_ENTRY_POINTS = Object.freeze({ 'popup/popup': 'src/popup/popup.js' });

/** 絵文字ピッカーのページの入口。popup と同じく拡張のページなので ESM で束ねる。 */
export const EMOJI_ENTRY_POINTS = Object.freeze({ 'emoji/emoji': 'src/emoji/emoji.js' });

/** 動画の再生 (hls.js) の入口。必要になったときだけ content script が import() で読むので ESM で束ねる。 */
export const VIDEO_ENTRY_POINTS = Object.freeze({ 'video/hls-player': 'src/video/hls-player.js' });

/**
 * 入口の表から出力ファイル名 (出力先からの相対) を作る。
 * @param {Readonly<Record<string, string>>} entryPoints 入口の表
 * @returns {string[]} 例: ['content.js']
 */
export function outputNamesOf(entryPoints) {
	return Object.keys(entryPoints).map((key) => `${key}.js`);
}
