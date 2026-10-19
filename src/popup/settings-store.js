/**
 * ポップアップの設定の読み書き。
 * 保存領域 (chrome.storage.sync 互換の get / set / remove) は引数で受け、テストで差し替えられるようにする。
 * どの関数も投げない。失敗は戻り値で返し、画面の構築を途中で落とさない。
 */
import {EXT_CONFIG} from '../common/config.js';
import {ALL_FIELDS} from './sections.js';

/**
 * chrome.storage.sync 互換の保存領域。
 * @typedef {Object} SettingsStorage
 * @property {(keys: string[]) => Promise<Object<string, unknown>>} get
 * @property {(items: Object<string, unknown>) => Promise<void>} set
 * @property {(keys: string[]) => Promise<void>} remove
 */

/**
 * 読み込んだ設定。
 * @typedef {Object} PopupSettings
 * @property {string} theme 配色の保存値 (EXT_CONFIG.popup.themes のどれか)
 * @property {Object<string, boolean>} values 保存キーごとの値
 * @property {boolean} failed 読み込みに失敗して既定値で埋めたか
 */

/** ポップアップが扱う保存キー (設定の各項目 + 配色)。初期化で消すのはこれだけ */
export const MANAGED_KEYS = Object.freeze([
	...ALL_FIELDS.map((field) => field.key),
	EXT_CONFIG.popup.themeStorageKey
]);

/** ログの接頭辞 */
const LOG_PREFIX = '[XViewer]';

/**
 * すべての項目を既定値で埋める。
 * @returns {Object<string, boolean>} 保存キーごとの既定値
 */
function defaultValues() {
	return Object.fromEntries(ALL_FIELDS.map((field) => [field.key, field.defaultValue]));
}

/**
 * 保存済みの設定をまとめて読む。保存値が壊れている前提で読み、型や値が違えば既定へ倒す。
 * @param {SettingsStorage|null|undefined} storage 保存領域
 * @returns {Promise<PopupSettings>} 設定
 */
export async function loadSettings(storage) {
	const {themeStorageKey, defaultTheme, themes} = EXT_CONFIG.popup;
	try {
		const stored = await storage.get([...MANAGED_KEYS]);
		const values = {};
		for (const field of ALL_FIELDS) {
			const saved = stored?.[field.key];
			values[field.key] = typeof saved === 'boolean' ? saved : field.defaultValue;
		}
		const savedTheme = stored?.[themeStorageKey];
		const theme = Object.values(themes).includes(savedTheme) ? savedTheme : defaultTheme;
		return {theme, values, failed: false};
	} catch (error) {
		console.error(`${LOG_PREFIX} ポップアップ設定の読み込みに失敗しました`, error);
		return {theme: defaultTheme, values: defaultValues(), failed: true};
	}
}

/**
 * 1 件の設定を保存する。保存ボタンは作らず、変更のたびに書く。
 * @param {SettingsStorage|null|undefined} storage 保存領域
 * @param {string} key 保存キー
 * @param {boolean|string} value 値
 * @returns {Promise<boolean>} 保存できたか
 */
export async function saveSetting(storage, key, value) {
	try {
		await storage.set({[key]: value});
		return true;
	} catch (error) {
		console.error(`${LOG_PREFIX} ポップアップ設定の保存に失敗しました`, key, error);
		return false;
	}
}

/**
 * ポップアップが扱うキーだけを消して既定へ戻す。clear() は使わない
 * (パネルの畳み状態のように、ポップアップの外で書くキーまで消してしまうため)。
 * キーを消すと content script の storage.onChanged には newValue が undefined で届き、
 * 各リスナーはそれを既定値として扱う。
 * @param {SettingsStorage|null|undefined} storage 保存領域
 * @returns {Promise<boolean>} 消せたか
 */
export async function resetSettings(storage) {
	try {
		await storage.remove([...MANAGED_KEYS]);
		return true;
	} catch (error) {
		console.error(`${LOG_PREFIX} ポップアップ設定の初期化に失敗しました`, error);
		return false;
	}
}
