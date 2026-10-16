/**
 * ポップアップの組み立てと保存の橋渡し。
 * 設定を読んで popup-ui に描かせ、変更をそのまま保存する。
 * 依存は引数で受け取り、テストで差し替えられるようにする。
 */
import {loadSettings, resetSettings, saveSetting} from './settings-store.js';
import {renderPopup as renderPopupImpl} from './popup-ui.js';
import {POPUP_TEXT, TABS} from './sections.js';

/** 描き先の要素の id (popup.html) */
const ROOT_ID = 'app';

/** 初期化の後にフォーカスを戻す先 (初期化ボタンの data-role) */
const RESET_ROLE = POPUP_TEXT.reset.role;

/** 初期化の後に開いておくタブ (初期化ボタンのある「設定」) */
const SETTINGS_TAB = TABS[0].id;

/**
 * 失敗をログへ残す既定の記録先。
 * @param {string} message 何に失敗したか
 * @param {...unknown} details 例外など
 * @returns {void}
 */
function logError(message, ...details) {
	console.error(`[XViewer] ${message}`, ...details);
}

/**
 * ポップアップを起動する。読み込みに失敗しても既定値で描き、失敗を画面に出す。
 * @param {Object} deps 依存
 * @param {Document} deps.doc 対象のドキュメント
 * @param {import('./settings-store.js').SettingsStorage|null} deps.storage 保存領域 (chrome.storage.sync)
 * @param {typeof renderPopupImpl} [deps.renderPopup] 画面の描画
 * @param {(message: string, ...details: unknown[]) => void} [deps.report] 失敗の記録
 * @returns {Promise<void>} 最初の描画の完了
 */
export async function main({doc, storage, renderPopup = renderPopupImpl, report = logError}) {
	const root = doc.getElementById(ROOT_ID);
	if (!root) {
		report('ポップアップの受け皿が見つかりません');
		return;
	}

	/** 直近に描いた画面。描き直す前に片付ける */
	let screen = null;

	/**
	 * 画面を描き直す。描画の例外はここで受けて記録する (呼び出し側は結果を待たない)。
	 * @param {import('./settings-store.js').PopupSettings} settings 描く設定
	 * @param {{notice?: string|null, initialTab?: string|null, focusRole?: string|null}} [options]
	 *   通知・開いておくタブ・描き直した後にフォーカスを戻す要素の data-role
	 * @returns {void}
	 */
	function draw(settings, {notice = null, initialTab = null, focusRole = null} = {}) {
		try {
			screen?.dispose();
			screen = renderPopup({doc, root, settings, notice, initialTab, onChange, onReset});
			if (focusRole) {
				root.querySelector(`[data-role="${focusRole}"]`)?.focus();
			}
		} catch (error) {
			report('ポップアップの描画に失敗しました', error);
		}
	}

	/**
	 * 1 項目を保存する。失敗しても投げず false を返す (画面側がその項目だけを戻す)。
	 * @param {string} key 保存キー
	 * @param {boolean|string} value 値
	 * @returns {Promise<boolean>} 保存できたか
	 */
	function onChange(key, value) {
		return saveSetting(storage, key, value);
	}

	/**
	 * 扱うキーを消して既定へ戻し、保存済みの値で描き直す。
	 * タブは「設定」のまま、フォーカスは初期化ボタンへ戻す
	 * (確定ボタンごと確認の行が消えると、キーボード操作の現在地が失われる)。
	 * @returns {Promise<void>} 描き直しの完了
	 */
	async function onReset() {
		try {
			const done = await resetSettings(storage);
			const settings = await loadSettings(storage);
			let notice = null;
			if (!done) {
				notice = POPUP_TEXT.resetFailed;
			} else if (settings.failed) {
				notice = POPUP_TEXT.loadFailed;
			}
			draw(settings, {notice, initialTab: SETTINGS_TAB, focusRole: RESET_ROLE});
		} catch (error) {
			report('ポップアップ設定の初期化に失敗しました', error);
		}
	}

	const initial = await loadSettings(storage);
	draw(initial, {notice: initial.failed ? POPUP_TEXT.loadFailed : null});
}
