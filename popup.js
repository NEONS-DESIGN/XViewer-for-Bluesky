/**
 * ポップアップ (ON/OFF トグル) の挙動。
 * 保存キーと既定値は config.js の EXT_CONFIG を共有し、ここでは二重に持たない。
 * ポップアップ固有の値 (要素 ID・文言・待機時間) だけを POPUP_CONFIG にまとめる。
 */

const POPUP_CONFIG = {
    gridToggleId: 'ext-popup-grid-toggle',
    statusId: 'ext-popup-status',
    savedText: '保存しました',
    errorText: '保存に失敗しました',
    /** 一時メッセージを表示し続ける時間 (ms) */
    statusClearMs: 1500
};

/** showStatus() の setTimeout を使い回すための識別子。連続保存で前の消去を打ち消す */
let statusTimerId = null;

/**
 * chrome.storage.sync から現在の設定を読み込み、トグルに反映する。
 * 読み込みに失敗してもポップアップは壊さず、console.error のみ出して既定値のままにする。
 * @param {HTMLInputElement} gridToggle
 * @returns {Promise<void>}
 */
async function loadSettings(gridToggle) {
    try {
        const mediaGridCfg = EXT_CONFIG.mediaGrid;
        const stored = await chrome.storage.sync.get(mediaGridCfg.storageKey);
        gridToggle.checked = stored[mediaGridCfg.storageKey] ?? mediaGridCfg.defaultEnabled;
    } catch (error) {
        console.error('[Bluesky拡張] ポップアップ設定の読み込みに失敗しました', error);
    }
}

/**
 * 1 件の設定を chrome.storage.sync に保存し、結果を一時メッセージで知らせる。
 * 失敗しても console.error のみで、ポップアップは壊さない。
 * @param {string} key EXT_CONFIG 側の storageKey
 * @param {boolean} value
 * @param {HTMLElement|null} statusEl
 * @returns {Promise<void>}
 */
async function saveSetting(key, value, statusEl) {
    try {
        await chrome.storage.sync.set({[key]: value});
        showStatus(statusEl, POPUP_CONFIG.savedText);
    } catch (error) {
        console.error('[Bluesky拡張] ポップアップ設定の保存に失敗しました', error);
        showStatus(statusEl, POPUP_CONFIG.errorText);
    }
}

/**
 * 一時メッセージを表示し、statusClearMs 後に消す。
 * @param {HTMLElement|null} statusEl
 * @param {string} text
 * @returns {void}
 */
function showStatus(statusEl, text) {
    if (!statusEl) {
        return;
    }
    statusEl.textContent = text;
    if (statusTimerId !== null) {
        clearTimeout(statusTimerId);
    }
    statusTimerId = setTimeout(() => {
        statusEl.textContent = '';
        statusTimerId = null;
    }, POPUP_CONFIG.statusClearMs);
}

document.addEventListener('DOMContentLoaded', () => {
    const gridToggle = document.getElementById(POPUP_CONFIG.gridToggleId);
    const statusEl = document.getElementById(POPUP_CONFIG.statusId);

    if (!gridToggle) {
        console.error('[Bluesky拡張] ポップアップのトグル要素が見つかりません');
        return;
    }

    loadSettings(gridToggle);

    gridToggle.addEventListener('change', () => {
        saveSetting(EXT_CONFIG.mediaGrid.storageKey, gridToggle.checked, statusEl);
    });
});
