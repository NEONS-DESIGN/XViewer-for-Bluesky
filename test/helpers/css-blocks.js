/**
 * CSS の文字列から宣言のブロックを読むテスト用の小道具。
 * tokens.css と popup.css のライトの宣言 2 か所 (data-theme と prefers-color-scheme) の突き合わせに使う。
 */
import assert from 'node:assert';

/**
 * CSS から指定の選択子のブロックを取り出し、宣言を { 名前: 値 } にして返す。
 * @param {string} css CSS 全文
 * @param {string} selector ブロックの選択子 (正規表現の文字列ではなく、そのままの文字)
 * @returns {Record<string, string> | null} 見つからなければ null
 */
export function readBlock(css, selector) {
	const start = css.indexOf(selector + ' {');
	if (start < 0) return null;
	const open = css.indexOf('{', start);
	const close = css.indexOf('}', open);
	const body = css.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, '');
	const declarations = {};
	for (const line of body.split(';')) {
		const colon = line.indexOf(':');
		if (colon < 0) continue;
		declarations[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
	}
	return declarations;
}

/**
 * ライトの宣言が 2 か所 (data-theme と prefers-color-scheme) で一致するかを検査する。
 * @param {string} css CSS 全文
 * @param {string} dataThemeSelector data-theme 側の選択子
 * @returns {void}
 */
export function assertLightBlocksMatch(css, dataThemeSelector) {
	const byAttribute = readBlock(css, dataThemeSelector);
	const mediaStart = css.indexOf('@media (prefers-color-scheme: light)');
	assert.ok(mediaStart >= 0, 'prefers-color-scheme: light の規則が無い');
	const byMedia = readBlock(css.slice(mediaStart), ':root:not([data-theme])');
	assert.ok(byAttribute && Object.keys(byAttribute).length > 0, 'data-theme 側のブロックが無い');
	assert.ok(byMedia && Object.keys(byMedia).length > 0, 'prefers-color-scheme 側のブロックが無い');
	assert.deepStrictEqual(byMedia, byAttribute);
}
