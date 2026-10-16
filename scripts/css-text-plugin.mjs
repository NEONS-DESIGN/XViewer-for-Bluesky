/**
 * .css を圧縮してから文字列として取り込む esbuild のプラグイン。
 * CSS を text として読むと、そのままではコメント・改行・字下げが束へ残るため。
 */
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

/** 対象にするファイル。 */
const CSS_FILTER = /\.css$/;

/**
 * CSS を圧縮する。
 * @param {string} source CSS の本文
 * @param {string|string[]} target esbuild の target (ブラウザの下限)
 * @returns {Promise<string>} 圧縮した CSS (末尾の改行は落とす)
 */
export async function minifyCssText(source, target) {
	const { code } = await transform(source, { loader: 'css', minify: true, target });
	return code.trimEnd();
}

/**
 * プラグインを作る。
 * @param {string|string[]} target esbuild の target
 * @returns {import('esbuild').Plugin} プラグイン
 */
export function cssTextPlugin(target) {
	return {
		name: 'css-text',
		setup(build) {
			build.onLoad({ filter: CSS_FILTER }, async ({ path }) => ({
				contents: await minifyCssText(await readFile(path, 'utf8'), target),
				loader: 'text',
			}));
		},
	};
}
