/**
 * ビルドが出力先へ置く静的ファイルの表。(.css は build.mjs が圧縮してから書き、ほかはそのままコピーする)
 * テストからも読むので副作用を持たせない。
 *
 * 出力先はブラウザごとに分かれる。(scripts/browsers.mjs) コピーする中身は同じで、置き場所だけが違う。
 */

/** Chrome 系の出力先。Chrome に「パッケージ化されていない拡張機能」として読ませる場所。 */
export const OUT_DIR = 'dist';

/** Firefox の出力先。Chrome 系の dist とは混ぜない。 */
export const FIREFOX_OUT_DIR = 'dist-firefox';

/** 拡張機能アイコンの寸法 (px)。manifest の icons / action.default_icon と生成スクリプトの出どころ。 */
export const ICON_SIZES = Object.freeze([16, 32, 48, 128]);

/**
 * アイコンのファイル名。
 * @param {number} size 一辺の寸法 (px)
 * @returns {string} 例: icon-16.png
 */
export function iconFileName(size) {
	return `icon-${size}.png`;
}

/**
 * 出力先へ置く静的ファイルの表を作る。[コピー元, コピー先] の順。
 * アイコンは build-icons.mjs が作った生成物で、サイズの出どころは ICON_SIZES 1 か所。
 * manifest は version を差し込むのでここには入れない。(build.mjs の writeManifest)
 * @param {string} outDir 出力先
 * @returns {ReadonlyArray<readonly [string, string]>} [コピー元, コピー先] の表
 */
export function staticFilesFor(outDir) {
	return Object.freeze([
		['src/content/content.css', `${outDir}/content.css`],
		['src/popup/popup.html', `${outDir}/popup/popup.html`],
		['src/popup/popup.css', `${outDir}/popup/popup.css`],
		// 配色トークン。popup.html が ../common/tokens.css で読むので、src と同じ相対配置で置く
		['src/common/tokens.css', `${outDir}/common/tokens.css`],
		...ICON_SIZES.map((size) => [
			`src/icons/${iconFileName(size)}`,
			`${outDir}/icons/${iconFileName(size)}`,
		]),
		// ライセンス文。配布する zip は出力先をそのまま固めるので、ここに無いと受け取った人に届かない。
		// Apache-2.0 はライセンス本文の写しを渡すことを求める。(Material Symbols の図形を同梱している)
		['LICENSE', `${outDir}/LICENSE`],
		['NOTICE', `${outDir}/NOTICE`],
		['LICENSES/Apache-2.0.txt', `${outDir}/LICENSES/Apache-2.0.txt`],
	].map((pair) => Object.freeze(pair)));
}

/** Chrome 系 (dist) へコピーする静的ファイル。 */
export const STATIC_FILES = staticFilesFor(OUT_DIR);
