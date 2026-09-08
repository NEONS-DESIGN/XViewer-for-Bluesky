/**
 * デバッグモードの出力層。
 *
 * content script は分離ワールドで動くため、内部状態を外 (DevTools のコンソール、
 * MAIN ワールド、利用者の目視) から確かめる手段が無い。同じ箇所が繰り返し壊れる
 * プロジェクトなので、次に不具合が出たときに「拡張機能が今どう判断しているか」を
 * そのまま読めるようにしておく。
 *
 * 出力は 2 つ:
 * 1. コンソール — 時系列で「何が起きたか」を追う
 * 2. html 要素の data 属性 — 「今どうなっているか」を一目で読む
 *
 * 無効のあいだは何もしない。log() / publishState() は sync() のような極めて
 * 高頻度のコールバックから呼ばれるため、無効時に文字列の組み立てや JSON 化を
 * 走らせてはいけない (呼び出し側で if を書かずに済むよう、判定はここで持つ)。
 *
 * 依存: config.js (EXT_CONFIG.debug)。manifest.json の読み込み順で config.js の直後に置く。
 */

const ExtDebug = {
    /** 有効かどうか。chrome.storage の保存値と変更通知で更新する */
    enabled: EXT_CONFIG.debug.defaultEnabled,

    /**
     * publishState() に前回渡された内容 (JSON 文字列)。
     * 同じ内容の書き込みを繰り返して MutationObserver を無駄に叩かないための控え。
     * 属性の書き換えは document.body を監視しているコールバック
     * (NavigationObserver / MediaGridController.sync) を発火させうるため、
     * 変化が無いときは触らないことが特に重要
     */
    lastStateJson: null,

    /**
     * 保存済みの設定を読み込み、以後の変更を監視する。
     * 読み込みに失敗しても既定値 (無効) のまま動き続ける。
     * @returns {Promise<void>}
     */
    async init() {
        const cfg = EXT_CONFIG.debug;
        try {
            const stored = await chrome.storage.sync.get([cfg.storageKey]);
            this.setEnabled(stored[cfg.storageKey] ?? cfg.defaultEnabled);
        } catch (error) {
            console.error('[Bluesky拡張] デバッグ設定の読み込みに失敗しました', error);
        }
        try {
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area !== 'sync' || !changes[cfg.storageKey]) {
                    return;
                }
                this.setEnabled(changes[cfg.storageKey].newValue ?? cfg.defaultEnabled);
            });
        } catch (error) {
            console.error('[Bluesky拡張] デバッグ設定の監視開始に失敗しました', error);
        }
    },

    /**
     * 有効・無効を切り替える。無効にしたときは書き出し済みの状態も消す
     * (古い値が残っていると、次に見た人が現在の状態と読み違える)。
     * @param {boolean} value
     * @returns {void}
     */
    setEnabled(value) {
        this.enabled = value === true;
        if (this.enabled) {
            this.log('デバッグモード', {有効: true});
            return;
        }
        this.clearState();
    },

    /**
     * 1 件のできごとをコンソールに出す。
     * @param {string} tag 何についてのログか (例: 'sync')
     * @param {Object} [data] 付随する値。省略可
     * @returns {void}
     */
    log(tag, data) {
        if (!this.enabled) {
            return;
        }
        try {
            if (data === undefined) {
                console.log(`${EXT_CONFIG.debug.prefix} ${tag}`);
                return;
            }
            console.log(`${EXT_CONFIG.debug.prefix} ${tag}`, data);
        } catch (error) {
            // ここで投げると呼び出し元 (通常の処理) を巻き込むため握り潰す
        }
    },

    /**
     * 現在の内部状態を html 要素の data 属性に書き出す。
     * 内容が前回と同じなら何もしない (無駄な mutation を起こさないため)。
     * @param {Object} state 書き出す値。JSON 化できる形だけを渡すこと
     * @returns {void}
     */
    publishState(state) {
        if (!this.enabled) {
            return;
        }
        try {
            const json = JSON.stringify(state);
            if (json === this.lastStateJson) {
                return;
            }
            this.lastStateJson = json;
            document.documentElement.setAttribute(EXT_CONFIG.debug.stateAttribute, json);
        } catch (error) {
            // 状態の書き出しに失敗しても通常の処理は続ける
        }
    },

    /**
     * 書き出し済みの状態を消す。
     * @returns {void}
     */
    clearState() {
        try {
            this.lastStateJson = null;
            document.documentElement.removeAttribute(EXT_CONFIG.debug.stateAttribute);
        } catch (error) {
            // 消せなくても通常の処理は続ける
        }
    }
};

// tests から require するためだけの分岐。content script では module が未定義のため何もしない
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {ExtDebug};
}

// content script としての起動。Node のテストからは document が無いため実行されない
if (typeof document !== 'undefined') {
    ExtDebug.init();
}
