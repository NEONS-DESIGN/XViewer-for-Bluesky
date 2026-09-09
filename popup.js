/**
 * ポップアップ (設定画面) の組み立てと保存。
 *
 * 保存キーと既定値は config.js の EXT_CONFIG を共有し、ここでは二重に持たない。
 * ポップアップ固有の値 (要素 ID・文言・項目の並び) だけをこのファイルの定数にまとめ、
 * 描画はその定数を回すだけにする (UI_DESIGN_KIT 7 節)。項目を足すときは
 * SETTING_ITEMS に 1 件足すだけで済む状態を保つこと。
 *
 * 依存: config.js (EXT_CONFIG) / icon-shapes.js (ICON_SHAPES) / icons.js (createIcon)
 */

const POPUP_CONFIG = Object.freeze({
    rootId: 'ext-popup-root',
    /** 要素の目印は data-role で持つ。クラス名は見た目のためのもので、配線が依存しない */
    roles: Object.freeze({
        themeToggle: 'theme-toggle',
        alert: 'alert',
        fields: 'fields'
    })
});

const POPUP_TEXT = Object.freeze({
    title: 'Blueskyカスタム拡張機能',
    loadError: '設定を読み込めませんでした。表示は既定値です。',
    saveError: '設定を保存できませんでした。もう一度お試しください。',
    note: '設定は Bluesky のタブを開いたまま反映されます。'
        + 'デバッグモードの出力はブラウザの開発者ツール (F12) のコンソールで確認できます。'
});

/** 配色の値。保存値が壊れていたときはここに無いものを弾いて既定へ倒す */
const POPUP_THEMES = Object.freeze({dark: 'dark', light: 'light'});

/**
 * 配色の切り替えボタンの定義。**キーは今の配色、値は押した結果**。
 * 今の状態は画面の配色そのものが伝えているので、ボタンは結果を示す。
 */
const POPUP_THEME_TOGGLE = Object.freeze({
    dark: Object.freeze({next: POPUP_THEMES.light, icon: 'lightMode', label: 'ライトモードに切り替える'}),
    light: Object.freeze({next: POPUP_THEMES.dark, icon: 'darkMode', label: 'ダークモードに切り替える'})
});

/**
 * 設定項目の定義。配列順がそのまま表示順になる。
 * 関連する項目 (グリッド表示とぼかし解除) は隣に置く。片方だけ見ても
 * 振る舞いが分からないため。
 * @typedef {Object} SettingItem
 * @property {string} role data-role に入れる目印
 * @property {string} icon ICON_SHAPES のキー
 * @property {string} label 見出し
 * @property {string} description 1 行の説明。ラベルだけで意味が伝わる項目はほぼ無い
 * @property {string} storageKey chrome.storage.sync の保存キー
 * @property {boolean} defaultValue 保存値が無いときの既定
 */
const SETTING_ITEMS = Object.freeze([
    Object.freeze({
        role: 'media-grid',
        icon: 'gridView',
        label: 'メディアグリッド表示',
        description: 'プロフィールのメディアタブを、正方形のサムネイル格子に置き換えます。'
            + '1 投稿につき 1 枚を並べ、動画はビデオタブに任せて除きます。',
        storageKey: EXT_CONFIG.mediaGrid.storageKey,
        defaultValue: EXT_CONFIG.mediaGrid.defaultEnabled
    }),
    Object.freeze({
        role: 'nsfw-unblur',
        icon: 'visibility',
        label: 'NSFWのぼかしを解除',
        description: 'グリッドのタイルに掛かるぼかしと警告文を外し、1 回の押下で開けるようにします。'
            + 'Bluesky 本体が出す警告には触れません。',
        storageKey: EXT_CONFIG.mediaGrid.unblur.storageKey,
        defaultValue: EXT_CONFIG.mediaGrid.unblur.defaultEnabled
    }),
    Object.freeze({
        role: 'debug',
        icon: 'bugReport',
        label: 'デバッグモードを有効化',
        description: 'タブの判定・グリッドの起動と撤去・取得の状況をコンソールに出し、'
            + '内部状態を html 要素の属性に書き出します。不具合を報告するときに使います。',
        storageKey: EXT_CONFIG.debug.storageKey,
        defaultValue: EXT_CONFIG.debug.defaultEnabled
    }),
    Object.freeze({
        role: 'lightbox-panel',
        icon: 'viewSidebar',
        label: 'ライトボックスに投稿情報を表示',
        description: '画像を開いたとき、右側に本文・投稿日時・反応数を並べます。'
            + 'メディアグリッド以外の画像でも動きます。',
        storageKey: EXT_CONFIG.lightboxPanel.storageKey,
        defaultValue: EXT_CONFIG.lightboxPanel.defaultEnabled
    }),
    Object.freeze({
        role: 'lightbox-guard',
        icon: 'lock',
        label: '画像のクリックで閉じない',
        description: '開いた画像そのものを押しても閉じないようにし、'
            + '押せるボタンだけにカーソルの形を残します。周りの暗い部分を押せば閉じます。',
        storageKey: EXT_CONFIG.lightboxGuard.storageKey,
        defaultValue: EXT_CONFIG.lightboxGuard.defaultEnabled
    }),
    Object.freeze({
        role: 'post-actions',
        icon: 'favorite',
        label: 'ライトボックスから返信・いいね',
        description: '画像を開いたまま、返信・リポスト・引用・いいね・ブックマークを'
            + '行えるようにします。認証は Bluesky 本体のものをそのまま使います。',
        storageKey: EXT_CONFIG.postActions.storageKey,
        defaultValue: EXT_CONFIG.postActions.defaultEnabled
    })
]);

/**
 * 配色を html 要素へ反映する。CSS は html[data-theme] を選択子にして上書きする。
 * @param {Document} doc 対象のドキュメント
 * @param {string} theme POPUP_THEMES のいずれか
 * @returns {void}
 */
function applyTheme(doc, theme) {
    doc.documentElement.dataset.theme = theme;
}

/**
 * 保存済みの設定をまとめて読み込む。
 * 保存値が壊れている前提で読み、配色は既知の値でなければ既定へ倒す。
 * @returns {Promise<{theme: string, values: Object<string, boolean>, failed: boolean}>}
 */
async function loadSettings() {
    const keys = SETTING_ITEMS.map((item) => item.storageKey);
    keys.push(EXT_CONFIG.popup.themeStorageKey);

    const values = {};
    let theme = EXT_CONFIG.popup.defaultTheme;
    let failed = false;
    try {
        const stored = await chrome.storage.sync.get(keys);
        SETTING_ITEMS.forEach((item) => {
            // 壊れた値 (boolean 以外) は配色と同じく既定へ倒す
            const saved = stored[item.storageKey];
            values[item.storageKey] = typeof saved === 'boolean' ? saved : item.defaultValue;
        });
        const savedTheme = stored[EXT_CONFIG.popup.themeStorageKey];
        theme = Object.values(POPUP_THEMES).includes(savedTheme)
            ? savedTheme
            : EXT_CONFIG.popup.defaultTheme;
    } catch (error) {
        console.error('[Bluesky拡張] ポップアップ設定の読み込みに失敗しました', error);
        failed = true;
        SETTING_ITEMS.forEach((item) => {
            values[item.storageKey] = item.defaultValue;
        });
    }
    return {theme, values, failed};
}

/**
 * 1 件の設定を保存する。保存ボタンは作らず、変更のたびに書く。
 * @param {string} key 保存キー
 * @param {boolean|string} value
 * @returns {Promise<boolean>} 保存できたか
 */
async function saveSetting(key, value) {
    try {
        await chrome.storage.sync.set({[key]: value});
        return true;
    } catch (error) {
        console.error('[Bluesky拡張] ポップアップ設定の保存に失敗しました', error);
        return false;
    }
}

/**
 * 失敗の一言を出す。次の操作が成功したら消す。
 * @param {HTMLElement} root 描画済みのポップアップ
 * @param {string} text 空文字なら消す
 * @returns {void}
 */
function showAlert(root, text) {
    const alertEl = root.querySelector(`[data-role="${POPUP_CONFIG.roles.alert}"]`);
    if (!alertEl) {
        return;
    }
    alertEl.textContent = text;
    alertEl.hidden = text === '';
}

/**
 * 設定項目 1 件を組み立てる。
 * @param {Document} doc 対象のドキュメント
 * @param {SettingItem} item 項目の定義
 * @param {boolean} checked 現在の値
 * @param {(item: SettingItem, checked: boolean, input: HTMLInputElement) => void} onChange
 *   変更時の処理。保存に失敗したとき、その input だけを保存済みの値へ戻すために渡す
 * @returns {HTMLElement} 項目の要素
 */
function createField(doc, item, checked, onChange) {
    const field = doc.createElement('div');
    field.className = 'ext-popup-field';
    field.dataset.role = item.role;

    const label = doc.createElement('label');
    label.className = 'ext-popup-field-label';

    const input = doc.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.addEventListener('change', () => onChange(item, input.checked, input));

    const text = doc.createElement('span');
    text.textContent = item.label;

    label.append(input, createIcon(doc, item.icon), text);

    const description = doc.createElement('p');
    description.className = 'ext-popup-description';
    description.textContent = item.description;

    field.append(label, description);
    return field;
}

/**
 * ポップアップ全体を組み立てる。
 * 再描画は全部作り直す。現在地として復元するのはキーボードのフォーカスだけ
 * (配色の切り替えボタンを Enter / Space で押したとき、作り直しで消えた
 * ボタンからフォーカスが body へ落ちないよう、呼び出し側が戻す)。
 * @param {Object} options 設定
 * @param {Document} options.doc 対象のドキュメント
 * @param {HTMLElement} options.root マウント先
 * @param {string} options.theme 現在の配色
 * @param {Object<string, boolean>} options.values 現在の設定値
 * @param {(item: SettingItem, checked: boolean, input: HTMLInputElement) => void} options.onChangeSetting 設定の変更
 * @param {(next: string) => void} options.onChangeTheme 配色の変更
 * @returns {{dispose: Function}} 組み立てた画面
 */
function renderPopup({doc, root, theme, values, onChangeSetting, onChangeTheme}) {
    const container = doc.createElement('div');
    container.className = 'ext-popup';

    const header = doc.createElement('header');
    header.className = 'ext-popup-header';

    const title = doc.createElement('h1');
    title.className = 'ext-popup-title';
    title.textContent = POPUP_TEXT.title;

    const toggle = POPUP_THEME_TOGGLE[theme] ?? POPUP_THEME_TOGGLE[EXT_CONFIG.popup.defaultTheme];
    const themeButton = doc.createElement('button');
    themeButton.type = 'button';
    themeButton.className = 'ext-popup-icon-button';
    themeButton.dataset.role = POPUP_CONFIG.roles.themeToggle;
    // アイコンだけのボタンなので、読み上げ用の aria-label とマウス利用者向けの
    // title を両方付ける
    themeButton.setAttribute('aria-label', toggle.label);
    themeButton.title = toggle.label;
    themeButton.appendChild(createIcon(doc, toggle.icon));
    themeButton.addEventListener('click', () => onChangeTheme(toggle.next));

    header.append(title, themeButton);

    const alertEl = doc.createElement('p');
    alertEl.className = 'ext-popup-alert';
    alertEl.dataset.role = POPUP_CONFIG.roles.alert;
    alertEl.setAttribute('role', 'alert');
    alertEl.hidden = true;

    const fields = doc.createElement('div');
    fields.className = 'ext-popup-fields';
    fields.dataset.role = POPUP_CONFIG.roles.fields;
    SETTING_ITEMS.forEach((item) => {
        fields.appendChild(createField(doc, item, values[item.storageKey] === true, onChangeSetting));
    });

    const note = doc.createElement('p');
    note.className = 'ext-popup-note';
    note.textContent = POPUP_TEXT.note;

    container.append(header, alertEl, fields, note);

    root.textContent = '';
    root.appendChild(container);

    return {
        /**
         * 描画内容を取り除く。
         * @returns {void}
         */
        dispose() {
            container.remove();
        }
    };
}

/**
 * ポップアップを起動する。
 * 読み込みに失敗しても画面の構築は落とさず、既定値で描いたうえで失敗を画面に出す。
 * @returns {Promise<void>}
 */
async function initPopup() {
    const root = document.getElementById(POPUP_CONFIG.rootId);
    if (!root) {
        console.error('[Bluesky拡張] ポップアップの受け皿が見つかりません');
        return;
    }

    const state = await loadSettings();
    applyTheme(document, state.theme);

    /**
     * 画面を描き直す。保存の成否によらず、常に「保存済みの値」を映す
     * (画面が嘘をつかないようにするため)。
     * @returns {void}
     */
    const draw = () => {
        renderPopup({
            doc: document,
            root,
            theme: state.theme,
            values: state.values,
            onChangeSetting: async (item, checked, input) => {
                const saved = await saveSetting(item.storageKey, checked);
                if (!saved) {
                    // 保存できなかったので、その項目だけを保存済みの値へ戻して
                    // 食い違いを消す。全部作り直すと、同時に飛行中だった別の項目の
                    // 保存結果が画面に反映されないまま残る
                    input.checked = state.values[item.storageKey] === true;
                    showAlert(root, POPUP_TEXT.saveError);
                    return;
                }
                state.values[item.storageKey] = checked;
                showAlert(root, '');
            },
            onChangeTheme: async (next) => {
                // 見た目の反映は保存の完了を待たない。待つと押した手応えが遅れる。
                // 保存に失敗しても次に開いたとき元に戻るだけで、壊れた状態にはならない
                state.theme = next;
                applyTheme(document, next);
                draw();
                // 作り直しで消えた切り替えボタンへフォーカスを戻す (キーボード操作の現在地)
                const themeButton = root.querySelector(
                    `[data-role="${POPUP_CONFIG.roles.themeToggle}"]`
                );
                if (themeButton) {
                    themeButton.focus();
                }
                const saved = await saveSetting(EXT_CONFIG.popup.themeStorageKey, next);
                if (!saved) {
                    showAlert(root, POPUP_TEXT.saveError);
                }
            }
        });
    };

    draw();
    if (state.failed) {
        showAlert(root, POPUP_TEXT.loadError);
    }
}

// tests から require するためだけの分岐。ブラウザでは module が未定義のため何もしない
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {POPUP_CONFIG, POPUP_TEXT, POPUP_THEMES, POPUP_THEME_TOGGLE, SETTING_ITEMS};
}

// ポップアップとしての起動。Node のテストからは document が無いため実行されない
if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
        // 描画で例外が出ても unhandled rejection で黙って空白にしない
        initPopup().catch((error) => {
            console.error('[Bluesky拡張] ポップアップの起動に失敗しました', error);
        });
    });
}
