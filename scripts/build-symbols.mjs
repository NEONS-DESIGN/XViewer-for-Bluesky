/**
 * Material Symbols (npm の @material-symbols/svg-400) から必要な図形だけを抜き出し、
 * src/common/icon-shapes.js を生成する。
 * 生成物はコミットする。src/ を素の import で読めるようにするため。
 * 図形は {viewBox, path} の組で持つ。使う Rounded / FILL 1 の図形はどれも path 1 本である。
 */
import { readFile, writeFile } from 'node:fs/promises';

/**
 * 抜き出す図形。コード側の名前ごとに、原本のファイル名 (拡張子なし) と、
 * この拡張機能での用途の説明 (生成物のコメントになる) を持つ。
 * @type {Record<string, {file: string, label: string}>}
 */
const ICON_SOURCES = {
	lightMode: { file: 'light_mode-fill', label: 'ライトモードへの切り替え (太陽)' },
	darkMode: { file: 'dark_mode-fill', label: 'ダークモードへの切り替え (月)' },
	gridView: { file: 'grid_view-fill', label: 'メディアグリッド表示 (格子)' },
	visibility: { file: 'visibility-fill', label: 'NSFW のぼかし解除 (目)' },
	bugReport: { file: 'bug_report-fill', label: 'デバッグモード (虫)' },
	chatBubble: { file: 'chat_bubble-fill', label: '返信数 (吹き出し)' },
	repeat: { file: 'repeat-fill', label: 'リポスト数 (循環する矢印)' },
	favorite: { file: 'favorite-fill', label: 'いいね数 (ハート)' },
	formatQuote: { file: 'format_quote-fill', label: '引用数 (引用符)' },
	chevronRight: { file: 'chevron_right-fill', label: 'パネルを畳む' },
	chevronLeft: { file: 'chevron_left-fill', label: 'パネルを開く' },
	openInNew: { file: 'open_in_new-fill', label: '投稿を開く' },
	viewSidebar: { file: 'view_sidebar-fill', label: 'ポップアップの設定項目 (右側のサイドパネル)' },
	lock: { file: 'lock-fill', label: '誤操作の防止 (画像のクリックで閉じない)' },
	bookmark: { file: 'bookmark-fill', label: 'ブックマーク (しおり)' },
	error: { file: 'error-fill', label: 'エラーの通知 (感嘆符つきの丸)' },
	image: { file: 'image-fill', label: '返信に画像を添付 (写真)' },
	mood: { file: 'mood-fill', label: '絵文字を入れる (笑顔)' },
	crop: { file: 'crop-fill', label: '添付した画像の切り抜き' },
	close: { file: 'close-fill', label: '添付した画像を外す・提案を閉じる (バツ印)' },
	translate: { file: 'translate-fill', label: '投稿言語の選択 (文字と翻訳)' },
	warning: { file: 'warning-fill', label: 'コンテンツの警告ラベル (三角の感嘆符)' },
	check: { file: 'check-fill', label: 'ALT テキストを付けた印 (チェック)' },
	gifBox: { file: 'gif_box-fill', label: '返信に GIF を添付' },
	playArrow: { file: 'play_arrow-fill', label: 'GIF を再生' },
	closedCaption: { file: 'closed_caption-fill', label: '字幕' },
	add: { file: 'add-fill', label: 'スレッドに投稿を追加 (プラス)' },
};

/** 原本の置き場。 */
const SOURCE_DIR = 'node_modules/@material-symbols/svg-400/rounded';

/** 原本パッケージの package.json。出典の見出しに版を書くために読む。 */
const SOURCE_PACKAGE_JSON = 'node_modules/@material-symbols/svg-400/package.json';

/** 生成先。 */
const OUTPUT_PATH = 'src/common/icon-shapes.js';

/** 生成物の字下げ (リポジトリはタブ字下げ)。 */
const INDENT = '\t';

/**
 * 原本の SVG から viewBox と path を取り出す。
 * @param {string} svg SVG の中身
 * @param {string} source 読み込み元 (エラー表示用)
 * @returns {{viewBox: string, path: string}} 図形
 * @throws {Error} viewBox が無い、または path がちょうど 1 本でないとき (パッケージの更新で形式が変わった等)
 */
function extract(svg, source) {
	const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1];
	if (!viewBox) {
		throw new Error(`${source} に viewBox がありません (パッケージの更新で形式が変わっていないか)`);
	}
	const paths = [...svg.matchAll(/<path\b[^>]*?\sd="([^"]+)"/g)];
	const elementCount = (svg.match(/<(?!svg\b|\/|\?|!)[a-zA-Z]/g) ?? []).length;
	if (paths.length !== 1 || elementCount !== 1) {
		throw new Error(`${source} の path が 1 本ではありません (path ${paths.length} 本、svg 以外の要素 ${elementCount} 個)`);
	}
	return { viewBox, path: paths[0][1] };
}

/**
 * 1 つの図形を生成物の断片にする。
 * @param {string} name コード側の名前
 * @param {string} label 用途の説明
 * @param {{viewBox: string, path: string}} shape 図形
 * @returns {string} 断片
 */
function renderShape(name, label, shape) {
	return [
		`${INDENT}/** ${label} */`,
		`${INDENT}${name}: Object.freeze({`,
		`${INDENT}${INDENT}viewBox: '${shape.viewBox}',`,
		`${INDENT}${INDENT}path: '${shape.path}'`,
		`${INDENT}})`,
	].join('\n');
}

/**
 * 生成物の先頭に付ける注意書きと出典。
 * @param {string} version 原本パッケージの版
 * @returns {string} 先頭のコメント
 */
function header(version) {
	return [
		'/**',
		' * アイコンの図形データ。生成物のため手で編集しない。scripts/build-symbols.mjs で作り直す。',
		' *',
		' * 出典: Material Symbols (Rounded / weight 400 / FILL 1)',
		' *   https://github.com/google/material-design-icons',
		' *   ライセンス: Apache License 2.0 (帰属は NOTICE にある)',
		` *   原本: @material-symbols/svg-400 ${version} の rounded/<name>-fill.svg`,
		' *',
		' * viewBox は Material Symbols の値 (0 -960 960 960) をそのまま使う。',
		' * 24x24 に読み替えないこと。大きさは CSS 側が決める。',
		' */',
		'',
	].join('\n');
}

/**
 * icon-shapes.js を生成する。
 * @returns {Promise<number>} 生成した図形の数
 * @throws {Error} 原本が読めない・形式が違うとき
 */
async function build() {
	const fragments = [];
	for (const [name, { file, label }] of Object.entries(ICON_SOURCES)) {
		const path = `${SOURCE_DIR}/${file}.svg`;
		let svg;
		try {
			svg = await readFile(path, 'utf8');
		} catch (error) {
			throw new Error(`${path} を読めません (npm install 済みか、パッケージの更新で名前が変わっていないか): ${error.message}`);
		}
		fragments.push(renderShape(name, label, extract(svg, path)));
	}
	const { version } = JSON.parse(await readFile(SOURCE_PACKAGE_JSON, 'utf8'));
	const source = `${header(version)}\nexport const ICON_SHAPES = Object.freeze({\n${fragments.join(',\n\n')}\n});\n`;
	await writeFile(OUTPUT_PATH, source, 'utf8');
	return fragments.length;
}

try {
	const count = await build();
	console.log(`generated ${OUTPUT_PATH} (${count} icons)`);
} catch (error) {
	// 素の例外のまま落とすとスタックトレースだけが出て、どの原本が無いのか読み取りにくい
	console.error(`[build-symbols] ${error?.message ?? error}`);
	process.exit(1);
}
