/**
 * ポップアップの定義表と文言。
 * 画面の中身はすべてここから組み立てる。設定項目を足すときは SECTIONS に 1 件足すだけで済む。
 *
 * 保存キーと既定値は config.js の EXT_CONFIG を共有し、ここでは二重に持たない。
 */
import {EXT_CONFIG} from '../common/config.js';

/**
 * 設定項目 1 件の定義。
 * @typedef {Object} Field
 * @property {string} role data-role に入れる目印 (項目の入れ物に付ける)
 * @property {string} key chrome.storage.sync の保存キー (スイッチの data-role にも使う)
 * @property {boolean} defaultValue 保存値が無いときの既定
 * @property {string} label 見出し (h3)。セクション名と重なる語は削ってある
 * @property {string} description 1 行の説明
 * @property {string} [requires] 親の項目の key。親が OFF の間はこの項目を操作できない
 * @property {readonly Field[]} [children] 子の項目。親の下に字下げして並べる
 */

/**
 * セクション 1 つの定義。
 * @typedef {Object} Section
 * @property {string} id 要素の id の元
 * @property {string} title 見出し (h2)
 * @property {readonly Field[]} fields 並べる項目 (子は親の children に入れる)
 */

/**
 * タブ 1 枚の定義。
 * @typedef {Object} Tab
 * @property {'settings'|'license'} id タブの id
 * @property {string} label 見出し
 */

/** ポップアップの文言。描画側に文字列を直書きしない */
export const POPUP_TEXT = Object.freeze({
	title: 'XViewer for Bluesky',
	tabsLabel: '表示するものの切り替え',
	loadFailed: '設定を読み込めませんでした。表示は既定値です。',
	saveFailed: '設定を保存できませんでした。もう一度お試しください。',
	resetFailed: '設定を初期化できませんでした。もう一度お試しください。',
	disclaimerBrief: 'Bluesky 公式の拡張機能ではありません。',
	/** 取り返しの付かない操作の確認の行 (data-role は role を接頭辞にする) */
	reset: Object.freeze({
		role: 'reset',
		label: '設定を初期化',
		description: 'すべての設定を既定に戻します。',
		cancel: 'やめる',
		confirm: '初期化する'
	})
});

/**
 * 親が OFF の子を押したときの警告。
 * @param {string} parentLabel 親の項目の見出し
 * @returns {string} 警告
 */
export function lockMessage(parentLabel) {
	return `先に『${parentLabel}』をオンにしてください`;
}

/**
 * 配色の切り替えボタンの定義。**キーは今の配色、値は押した結果**。
 * 今の状態は画面の配色そのものが伝えているので、ボタンは結果を示す。
 */
export const THEME_TOGGLE = Object.freeze({
	[EXT_CONFIG.popup.themes.dark]: Object.freeze({
		next: EXT_CONFIG.popup.themes.light,
		icon: 'lightMode',
		label: 'ライトモードに切り替える'
	}),
	[EXT_CONFIG.popup.themes.light]: Object.freeze({
		next: EXT_CONFIG.popup.themes.dark,
		icon: 'darkMode',
		label: 'ダークモードに切り替える'
	})
});

/** @type {readonly Tab[]} 並び順がそのまま表示順。先頭が最初に開くタブ */
export const TABS = Object.freeze([
	Object.freeze({id: 'settings', label: '設定'}),
	Object.freeze({id: 'license', label: 'ライセンス'})
]);

/** @type {Field} */
const NSFW_UNBLUR = Object.freeze({
	role: 'nsfw-unblur',
	key: EXT_CONFIG.mediaGrid.unblur.storageKey,
	defaultValue: EXT_CONFIG.mediaGrid.unblur.defaultEnabled,
	label: 'NSFWのぼかしを解除',
	description: 'グリッドのタイルに掛かるぼかしと警告文を外し、1 回の押下で開けるようにします。'
		+ 'Bluesky 本体が出す警告には触れません。',
	// ぼかしを解除するのはグリッドのタイルだけなので、グリッドが無ければ意味を持たない
	requires: EXT_CONFIG.mediaGrid.storageKey
});

/** @type {Field} */
const POST_ACTIONS = Object.freeze({
	role: 'post-actions',
	key: EXT_CONFIG.postActions.storageKey,
	defaultValue: EXT_CONFIG.postActions.defaultEnabled,
	label: '返信・いいね',
	description: '画像を開いたまま、返信・リポスト・引用・いいね・ブックマークを'
		+ '行えるようにします。認証は Bluesky 本体のものをそのまま使います。',
	// 操作ボタンは投稿情報パネルの中に出る
	requires: EXT_CONFIG.lightboxPanel.storageKey
});

/** @type {Field} */
const LIGHTBOX_REPLIES = Object.freeze({
	role: 'lightbox-replies',
	key: EXT_CONFIG.lightboxReplies.storageKey,
	defaultValue: EXT_CONFIG.lightboxReplies.defaultEnabled,
	label: '返信の一覧',
	description: '画像を開いたとき、パネルの下に返信の一覧を出します。'
		+ '『返信・いいね』が有効なら、その場で返信を書いたり、自分の返信を消したりできます。',
	// 返信の一覧は投稿情報パネルの中に出る
	requires: EXT_CONFIG.lightboxPanel.storageKey
});

/** @type {readonly Section[]} 並び順がそのまま表示順 */
export const SECTIONS = Object.freeze([
	Object.freeze({
		id: 'media-grid',
		title: 'メディアグリッド',
		fields: Object.freeze([
			Object.freeze({
				role: 'media-grid',
				key: EXT_CONFIG.mediaGrid.storageKey,
				defaultValue: EXT_CONFIG.mediaGrid.defaultEnabled,
				label: 'メディアグリッド表示',
				description: 'プロフィールのメディアタブを、正方形のサムネイル格子に置き換えます。'
					+ '1 投稿につき 1 枚を並べ、動画はビデオタブに任せて除きます。',
				children: Object.freeze([NSFW_UNBLUR])
			})
		])
	}),
	Object.freeze({
		id: 'lightbox',
		title: 'ライトボックス',
		fields: Object.freeze([
			Object.freeze({
				role: 'lightbox-panel',
				key: EXT_CONFIG.lightboxPanel.storageKey,
				defaultValue: EXT_CONFIG.lightboxPanel.defaultEnabled,
				label: '投稿情報を表示',
				description: '画像を開いたとき、右側に本文・投稿日時・反応数を並べます。'
					+ 'メディアグリッド以外の画像でも動きます。',
				children: Object.freeze([POST_ACTIONS, LIGHTBOX_REPLIES])
			}),
			Object.freeze({
				role: 'lightbox-guard',
				key: EXT_CONFIG.lightboxGuard.storageKey,
				defaultValue: EXT_CONFIG.lightboxGuard.defaultEnabled,
				label: '画像のクリックで閉じない',
				description: '開いた画像そのものを押しても閉じないようにし、'
					+ '押せるボタンだけにカーソルの形を残します。周りの暗い部分を押せば閉じます。'
					+ '閉じるボタンは左上に移し、画像オプションをその右に並べます。'
			})
		])
	}),
	Object.freeze({
		id: 'developer',
		title: '開発者向け',
		fields: Object.freeze([
			Object.freeze({
				role: 'debug',
				key: EXT_CONFIG.debug.storageKey,
				defaultValue: EXT_CONFIG.debug.defaultEnabled,
				label: 'デバッグモード',
				description: 'タブの判定・グリッドの起動と撤去・取得の状況をコンソールに出し、'
					+ '内部状態を html 要素の属性に書き出します。不具合を報告するときに使います。'
			})
		])
	})
]);

/**
 * 項目を親の直後に子が来る順で平らにする。
 * @param {readonly Field[]} fields 項目
 * @returns {Field[]} 平らにした項目
 */
function flatten(fields) {
	return fields.flatMap((field) => [field, ...flatten(field.children ?? [])]);
}

/** @type {readonly Field[]} 子も含めて平らにした全項目。保存キーの一覧と読み込みに使う */
export const ALL_FIELDS = Object.freeze(flatten(SECTIONS.flatMap((section) => section.fields)));
