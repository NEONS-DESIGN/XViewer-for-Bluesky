/**
 * 現在のページ情報。
 * @typedef {Object} PageInfo
 * @property {string} actor プロフィールの識別子 (ハンドルまたは did)
 * @property {string} view EXT_VIEWS のいずれか
 */

/** 現在の可視タブ列。resolveTabs の結果から組み立てる */
let currentTabs = [];
/** 選択中タブの index。DOM の下線バーから読めないときの控え */
let selectedTabIndex = 0;
/** getPageInfo の対象になっている actor。タブ列の使い回しを防ぐための照合キー */
let currentActor = null;
/**
 * currentActor に対する currentTabs が確定済みかどうか。
 * false の間は DOM (タブバー・左ナビ) がまだ準備できていない可能性があるため、
 * currentTabs を信用せず、機能を起動しない (Task 7 修正ラウンド 3)
 */
let tabsResolved = false;
/** ensureTabsResolved() の多重実行を防ぐ (同じ actor に getProfile を二重に投げない) */
let tabsResolving = false;

/** ナビゲーション監視から呼ばれる、画面更新をまとめて行う入り口 */
let navButtonManager = null;

/** タブバーの mutation を監視し、選択タブの変化を検知するための入り口 */
let tabObserver = null;

/**
 * タブ列を確定できなかったときの再試行タイマーの id。
 * 二重に予約しないための控えでもある (null なら予約なし)
 */
let tabsResolveRetryTimerId = null;

/**
 * プロフィールページのパスを解析する。2 段ちょうど (/profile/<actor>) だけを対象にする。
 * @param {string|null} pathname
 * @param {Object} config EXT_CONFIG
 * @returns {{actor: string}|null}
 */
function parseProfilePath(pathname, config) {
    try {
        if (typeof pathname !== 'string') {
            return null;
        }
        const parts = pathname.split('/').filter((part) => part.length > 0);
        if (parts.length !== 2) {
            return null;
        }
        if (parts[0] !== config.profilePathRoot) {
            return null;
        }
        return {actor: decodeURIComponent(parts[1])};
    } catch (error) {
        console.error('[Bluesky拡張] パスの解析に失敗しました', error);
        return null;
    }
}

/**
 * 左ナビのプロフィールリンクから、ログイン中の自分のハンドルを取り出す。
 * 実機で DOM を確認してから確定させる未確定項目 (設計文書 13 節)。
 * @returns {string|null} 見つからなければ null
 */
function getOwnHandle() {
    try {
        const link = document.querySelector(EXT_CONFIG.selectors.sideNavProfileLink);
        if (!link) {
            return null;
        }
        const href = link.getAttribute('href') || '';
        const parsed = parseProfilePath(href, EXT_CONFIG);
        return parsed ? parsed.actor : null;
    } catch (error) {
        console.error('[Bluesky拡張] 自分のハンドルの取得に失敗しました', error);
        return null;
    }
}

/**
 * 指定した actor が自分自身のプロフィールかどうかを判定する。
 * @param {string} actor
 * @returns {boolean}
 */
function isOwnProfile(actor) {
    const handle = getOwnHandle();
    return !!handle && handle === actor;
}

/**
 * ログイン中かどうかを判定する。左ナビにプロフィールリンクが無ければ未ログインとみなす。
 * @returns {boolean}
 */
function hasSession() {
    return getOwnHandle() !== null;
}

/**
 * ライトボックスの履歴フラグが積まれているかどうかを返す (安価な判定)。
 * 実機確認済み (Task 7 修正ラウンド 1): ライトボックスを開くとき
 * history.pushState で {lightbox: true} を積む。pushState は popstate を
 * 発火しないため、かつては NavigationObserver の高頻度コールバックで
 * この値の変化を「開閉があったかもしれない」合図として使っていた。
 * **この値を表示判定・起動判定の根拠にしてはいけない。** 分離ワールド
 * (content script) から見た history.state は、本体側 (MAIN ワールド) の
 * 履歴操作を取りこぼして古い値のまま残る。2.3.0 で実機確認した不具合が
 * まさにこれで、メディアグリッドの起動判定 (MediaGridController.sync) が
 * この値を論理和に含めていたため、投稿欄で画像を開いた後は
 * 「ライトボックスが開いたまま」と誤認し続け、メディアタブへ移っても
 * グリッドが二度と起動しなくなっていた (リロードでしか直らない)。
 * **2026-09-08 以降、Bluesky はこのフラグを立てなくなり常に false を返す**
 * (SITE_SPEC.md 2.3)。そのため NavigationObserver.checkNavigation() の
 * 合図としてもこの値は使っていない (2026-09-09 修正、body 直下の要素数に
 * 置き換えた)。この関数は判断にも合図にも使われておらず、デバッグモードの
 * 状態出力 (data-bsky-ext-state の「ライトボックス履歴フラグ」) にだけ
 * 残している
 * @returns {boolean}
 */
function isLightboxStatePushed() {
    try {
        return !!(history.state && history.state.lightbox === true);
    } catch (error) {
        console.error('[Bluesky拡張] ライトボックスの履歴フラグの判定に失敗しました', error);
        return false;
    }
}

/**
 * ライトボックス (モーダル) が実際に画面に出ているかを DOM から判定する。
 * 表示判定の根拠はこちら。履歴フラグと違って「閉じたのに開いたまま」に
 * ならないため、どの閉じ方をされてもナビボタンが復帰できる。
 * display:none で残っているだけの要素は開いているとみなさない
 * (恒久的に隠れたモーダルが 1 つでもあるとボタンが永久に出なくなるため)。
 * 失敗時は false (= ボタンを出す) に倒す。誤って隠し続けるより安全
 * @returns {boolean}
 */
function isLightboxVisible() {
    try {
        const nodes = document.querySelectorAll(EXT_CONFIG.lightbox.selector);
        for (let i = 0; i < nodes.length; i += 1) {
            if (nodes[i].getClientRects().length > 0) {
                return true;
            }
        }
        return false;
    } catch (error) {
        console.error('[Bluesky拡張] ライトボックスの表示判定に失敗しました', error);
        return false;
    }
}

/**
 * そのダイアログが画像ライトボックスかどうか。
 *
 * **ライトボックスと投稿作成モーダルは同時に開く** (2026-09-09 実測)。
 * 投稿作成モーダルは中に data-testid="composePostView" を持つので、
 * それを含まない方がライトボックスである。**aria-label はロケール依存の
 * ため使わない** (開発メモ)。
 * @param {Element|null} dialog 調べるダイアログ
 * @param {Object} config EXT_CONFIG.lightbox
 * @returns {boolean} 読めなければ false (掴まない側に倒す)
 */
function isLightboxDialog(dialog, config) {
    try {
        if (!dialog || typeof dialog.querySelector !== 'function') {
            return false;
        }
        return dialog.querySelector(config.composerSelector) === null;
    } catch (error) {
        console.error('[Bluesky拡張] ダイアログの判別に失敗しました', error);
        return false;
    }
}

/**
 * ライトボックスの表示状態が変わったときに呼ぶ購読者。
 * **新しい document.body 全体の監視を足さないための仕組み。**
 * NavButtonManager.update() は既に毎回 isLightboxVisible() を計算しており、
 * その値が前回と変わったときだけここから知らせる。追加コストは真偽値 1 個の
 * 比較だけで済む (設計文書 7 節)
 */
let lastLightboxVisible = null;
const lightboxVisibilitySubscribers = [];

/**
 * ライトボックスの表示状態の変化を購読する。
 * @param {(visible: boolean) => void} callback 表示状態が変わったときに呼ばれる
 * @returns {void}
 */
function subscribeLightboxVisibility(callback) {
    if (typeof callback === 'function') {
        lightboxVisibilitySubscribers.push(callback);
    }
}

/**
 * 表示状態を購読者へ伝える。**前回と同じ値なら何もしない。**
 * 極めて高頻度で呼ばれるため、ここに重い処理を足さないこと。
 * @param {boolean} visible
 * @returns {void}
 */
function notifyLightboxVisibility(visible) {
    if (visible === lastLightboxVisible) {
        return;
    }
    lastLightboxVisible = visible;
    for (const callback of lightboxVisibilitySubscribers) {
        try {
            callback(visible);
        } catch (error) {
            console.error('[Bluesky拡張] ライトボックス通知の購読者で失敗しました', error);
        }
    }
}

/**
 * タブ列を確定してよいだけ DOM が描画されているかを判定する。
 * 実機で観測された Critical (Task 7 修正ラウンド 3): ページ遷移直後は
 * プロフィールのタブバー・左ナビがまだ描画されておらず、この状態で
 * resolveTabs() を確定させると hasSession()/isOwnProfile() が左ナビを
 * 見つけられず誤って「未ログイン」判定になり、検算 (DOM のタブ数比較) も
 * タブ数 0 のためすり抜けてしまう。タブバー・左ナビの両方が描画される
 * までは「まだ判定できない」として扱う。
 * 左ナビは「コンテナ (nav) 自体」の有無で見る。プロフィールリンクの有無
 * (sideNavProfileLink) で見ると、未ログインで恒久的にリンクが存在しない
 * ケースと、単にまだ描画されていないケースを区別できないため
 * @returns {boolean}
 */
function isDomReadyForTabResolution() {
    try {
        const tabCount = document.querySelectorAll(EXT_CONFIG.selectors.tab).length;
        const navShell = document.querySelector(EXT_CONFIG.selectors.sideNav);
        return tabCount > 0 && !!navShell;
    } catch (error) {
        console.error('[Bluesky拡張] DOM 準備状態の判定に失敗しました', error);
        return false;
    }
}

/**
 * 選択中タブの index を返す。
 * EXT_CONFIG.selectors.tabUnderline が未確定 (null) の間は、
 * タブ押下を自前で追跡した値をそのまま使う。
 * @returns {number}
 */
function getSelectedTabIndex() {
    try {
        const underlineSelector = EXT_CONFIG.selectors.tabUnderline;
        if (!underlineSelector) {
            return selectedTabIndex;
        }
        const tabs = document.querySelectorAll(EXT_CONFIG.selectors.tab);
        for (let i = 0; i < tabs.length; i += 1) {
            if (tabs[i].querySelector(underlineSelector)) {
                return i;
            }
        }
    } catch (error) {
        console.error('[Bluesky拡張] 選択タブの判定に失敗しました', error);
    }
    return selectedTabIndex;
}

/**
 * タブ要素の click を capture フェーズで購読し、押されたタブの index を控える。
 * ユーザーの手動クリックだけでなく、callBridge('switch-tab') 経由の切替にも追随する
 * (Bluesky 本体がタブ切替時に対象タブ要素へ click イベントを発生させるため)。
 * index が実際に変わったときは、ナビボタンの表示状態もその場で更新する。
 * これを怠ると、URL が変わらない SPA 内のタブ切替でボタンの表示が古いまま残る
 * (Task 7 修正ラウンド 1: レビューで検出された Critical 不具合)
 */
function trackTabClicks() {
    try {
        document.addEventListener('click', (event) => {
            try {
                const tabs = document.querySelectorAll(EXT_CONFIG.selectors.tab);
                for (let i = 0; i < tabs.length; i += 1) {
                    if (tabs[i].contains(event.target)) {
                        if (i !== selectedTabIndex) {
                            // selectedTabIndex 自体はここで同期的に更新する
                            // (DOM 判定が使えないときのフォールバック値として
                            // 正しい値を即座に保つ必要があるため)
                            selectedTabIndex = i;

                            // このリスナーは capture フェーズで動くため、
                            // React 側のタブ切替ハンドラ (タブ要素自身に委譲された
                            // click リスナー) が発火するより前に同期的に実行される。
                            // そのため、この場で navButtonManager.update() を呼ぶと
                            // getSelectedTabIndex() が tabUnderline (下線バー) を
                            // DOM から再クエリした際、React がまだ再描画していない
                            // (下線バーが旧タブに残ったまま) 状態を読んでしまい、
                            // 更新したばかりの selectedTabIndex に到達できない。
                            // 暫定対応として、React の再描画をまたぐ確度を上げるため
                            // requestAnimationFrame を 2 回重ねてから update() を呼ぶ。
                            // これはあくまで暫定策であり、確実な検知は Task 9 で入る
                            // TabObserver (タブバーの mutation 監視で下線バーの
                            // 実際の移動を検知する) が担う予定 (Task 7 修正ラウンド 2)
                            if (navButtonManager) {
                                requestAnimationFrame(() => {
                                    requestAnimationFrame(() => {
                                        navButtonManager.update();
                                    });
                                });
                            }
                        }
                        break;
                    }
                }
            } catch (error) {
                console.error('[Bluesky拡張] タブ押下の追跡に失敗しました', error);
            }
        }, true);
    } catch (error) {
        console.error('[Bluesky拡張] タブ押下の購読に失敗しました', error);
    }
}

/**
 * 現在のページ情報を返す。対象外のページでは null。
 * @returns {PageInfo|null}
 */
function getPageInfo() {
    const parsed = parseProfilePath(location.pathname, EXT_CONFIG);
    if (!parsed) {
        return null;
    }
    const index = getSelectedTabIndex();
    const tab = currentTabs[index];
    return {
        actor: parsed.actor,
        view: (tab && tab.view) || EXT_VIEWS.OTHER
    };
}

/**
 * 対象アカウントのタブ列を解決する。
 * DOM (タブバー・左ナビ) がまだ準備できていないときは null を返し、
 * 呼び出し側 (ensureTabsResolved) に未確定のまま持ち越させる。
 * DOM のタブ数と算出結果が一致しない場合は空配列を返し、機能を無効化して確定させる。
 * @param {string} actor
 * @returns {Promise<Array<{name: string, view: string|undefined}>>|Promise<null>}
 */
async function resolveTabs(actor) {
    try {
        // DOM 未準備のうちは getProfile を叩かない (同じ actor に何度も
        // フェッチを投げないため。準備できたかどうかだけを見る軽い判定)
        if (!isDomReadyForTabResolution()) {
            ExtDebug.log('タブ列の解決を保留', {理由: 'DOM が未準備', actor});
            return null;
        }

        const api = EXT_CONFIG.mediaGrid.api;
        const url = new URL(api.origin + api.profilePath);
        url.searchParams.set('actor', actor);
        // 応答が返らないまま止まると tabsResolving が立ちっぱなしになり、
        // ensureTabsResolved() の再試行がすべて素通りしてタブ列が永久に未確定
        // (= ナビボタンが隠れたまま) になる。必ず時間で打ち切る
        // (Task 7 修正ラウンド 5。打ち切られた場合は catch で [] を返し、
        // 「確定した末に機能無効」として扱う。!response.ok のときと同じ扱い)
        const options = {credentials: 'omit'};
        if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
            options.signal = AbortSignal.timeout(api.timeoutMs);
        }
        const response = await fetch(url.toString(), options);
        if (!response.ok) {
            return [];
        }
        const profile = await response.json();
        const context = {
            isMe: isOwnProfile(actor),
            hasSession: hasSession()
        };
        const tabs = buildTabList(profile, context, EXT_CONFIG);

        // 検算: 算出したタブ数が DOM と食い違うなら、別のタブを乗っ取る危険があるので起動しない。
        // フェッチ待ちの間に DOM が変化した場合に備え、0 件はここでも「未確定」として扱う
        // (実機で観測された Critical。フェッチ完了後もタブバーが未描画のことがあった。
        // Task 7 修正ラウンド 3)
        const domCount = document.querySelectorAll(EXT_CONFIG.selectors.tab).length;
        if (domCount === 0) {
            return null;
        }
        if (domCount !== tabs.length) {
            console.error('[Bluesky拡張] タブ構成が想定と違うため機能を無効にします',
                {算出: tabs.length, 実際: domCount});
            return [];
        }
        return tabs;
    } catch (error) {
        console.error('[Bluesky拡張] タブ列の解決に失敗しました', error);
        return [];
    }
}

/**
 * タブ列の確定を後で再試行する予約を入れる。既に予約済みなら何もしない。
 * NavigationObserver / TabObserver の発火はどちらも DOM の変化が前提なので、
 * 「DOM が動かないまま未確定で止まる」経路が残る。時間の上限を設けない
 * 低頻度タイマーで最後の受け皿を用意し、未確定のまま放置されないようにする
 * (Task 7 修正ラウンド 4)
 */
function scheduleTabsResolveRetry() {
    if (tabsResolveRetryTimerId !== null) {
        return;
    }
    tabsResolveRetryTimerId = setTimeout(() => {
        tabsResolveRetryTimerId = null;
        ensureTabsResolved();
    }, EXT_CONFIG.tabResolution.retryIntervalMs);
}

/** タブ列の確定を再試行する予約を取り消す (確定済み・対象外ページになったとき)。 */
function cancelTabsResolveRetry() {
    if (tabsResolveRetryTimerId === null) {
        return;
    }
    clearTimeout(tabsResolveRetryTimerId);
    tabsResolveRetryTimerId = null;
}

/**
 * currentActor のタブ列がまだ確定していなければ解決を試みる。
 * 確定済み、または解決の途中であれば何もしない
 * (同じアカウントに getProfile を何度も投げないため)。
 * DOM が未準備で今回も確定できなければ tabsResolved は false のまま残り、
 * NavigationObserver / TabObserver の次の発火に加えて、
 * scheduleTabsResolveRetry() の低頻度タイマーからも再試行される
 * (実機で確認された Critical への対応。Task 7 修正ラウンド 3・4)
 * @returns {Promise<void>}
 */
async function ensureTabsResolved() {
    if (tabsResolved || tabsResolving || !currentActor) {
        return;
    }
    tabsResolving = true;
    const actor = currentActor;
    try {
        const tabs = await resolveTabs(actor);
        // フェッチ待ちの間に対象アカウントが変わっていたら、この結果はもう使えない
        if (actor !== currentActor) {
            return;
        }
        if (tabs === null) {
            // まだ DOM が準備できていない。確定させず、低頻度で再試行する
            scheduleTabsResolveRetry();
            return;
        }
        currentTabs = tabs;
        tabsResolved = true;
        cancelTabsResolveRetry();
        ExtDebug.log('タブ列を確定', {actor, tabs: tabs.map((tab) => tab.name)});
        if (navButtonManager) {
            navButtonManager.update();
        }
        if (typeof mediaGridController !== 'undefined' && mediaGridController) {
            mediaGridController.sync();
        }
    } finally {
        tabsResolving = false;
    }
}

/**
 * 右下固定のナビゲーションボタン群を管理する。
 * X (旧 Twitter) 版拡張と同じ構造 (コンテナ > 列 > ボタン) を踏襲する。
 */
class NavButtonManager {
    constructor() {
        /** @type {HTMLElement|null} */
        this.container = null;
        /** @type {HTMLElement|null} */
        this.scrollTopButton = null;
        /** @type {Map<string, HTMLElement>} view -> ボタン要素 */
        this.buttonsByView = new Map();
        /** 直前のページ先頭ボタンの表示状態。差分のあるときだけ触る */
        this.scrollTopVisible = null;
        /** ライトボックス表示中だけ動く、表示判定のやり直しタイマーの id */
        this.lightboxWatchTimerId = null;
    }

    /**
     * コンテナとボタン一式を組み立て、document.body に追加する。
     */
    initButtons() {
        try {
            const ui = EXT_CONFIG.ui;
            const container = document.createElement('div');
            container.id = ui.containerId;

            // 全ボタンの幅を最長ラベルに揃えるための文字数。
            // 「ページ先頭へ」はスクロール量で出入りするため、幅を内容任せにすると
            // 表示・非表示のたびに列の幅が変わってボタンの大きさがガタつく (style.css)
            const labels = [...ui.navButtons.map((def) => def.text), ui.scrollTopButton.text];
            const maxLabelChars = labels.reduce((max, text) => Math.max(max, text.length), 0);
            container.style.setProperty('--ext-nav-btn-label-chars', String(maxLabelChars));

            const column = document.createElement('div');
            column.className = ui.columnClass;

            this.scrollTopButton = this.createScrollTopButton();
            column.appendChild(this.scrollTopButton);

            ui.navButtons.forEach((def) => {
                const button = this.createButton(def);
                this.buttonsByView.set(def.view, button);
                column.appendChild(button);
            });

            container.appendChild(column);
            this.container = container;

            window.addEventListener('scroll', () => this.updateScrollTop(), {passive: true});

            this.update();
            document.body.appendChild(container);
        } catch (error) {
            console.error('[Bluesky拡張] ナビボタンの初期化に失敗しました', error);
        }
    }

    /**
     * タブ切替ボタンを 1 個作る。
     * @param {{id: string, text: string, view: string}} def EXT_CONFIG.ui.navButtons の要素
     * @returns {HTMLButtonElement}
     */
    createButton(def) {
        const button = document.createElement('button');
        button.id = def.id;
        button.className = EXT_CONFIG.ui.buttonClass;
        button.type = 'button';
        button.textContent = def.text;
        button.addEventListener('click', () => {
            const index = findTabIndex(currentTabs, def.view);
            if (index === -1) {
                return;
            }
            callBridge(EXT_CONFIG.mediaGrid.bridge.actions.switchTab, {index});
        });
        return button;
    }

    /**
     * ページ先頭へ戻るボタンを作る。
     * @returns {HTMLButtonElement}
     */
    createScrollTopButton() {
        const def = EXT_CONFIG.ui.scrollTopButton;
        const button = document.createElement('button');
        button.id = def.id;
        button.className = EXT_CONFIG.ui.buttonClass;
        button.type = 'button';
        button.textContent = def.text;
        button.addEventListener('click', () => {
            window.scrollTo({top: 0, behavior: 'smooth'});
        });
        return button;
    }

    /**
     * スクロール量に応じて「ページ先頭へ」の表示を切り替える。
     * 表示状態が前回と変わったときだけクラスを触る。
     */
    updateScrollTop() {
        try {
            if (!this.scrollTopButton) {
                return;
            }
            const shouldShow = window.scrollY > EXT_CONFIG.ui.scrollTopButton.showAfterPx;
            if (shouldShow === this.scrollTopVisible) {
                return;
            }
            this.scrollTopVisible = shouldShow;
            this.scrollTopButton.classList.toggle(EXT_CONFIG.styles.hiddenClass, !shouldShow);
        } catch (error) {
            console.error('[Bluesky拡張] ページ先頭ボタンの更新に失敗しました', error);
        }
    }

    /**
     * ライトボックスが閉じたことに気づくための再判定タイマーを動かす。
     * 既に動いていれば何もしない。
     * ライトボックスの閉じ方は Escape・閉じるボタン・ブラウザバック・背景クリックなど
     * 複数あり、そのすべてが NavigationObserver に届く保証は無い
     * (実機では popstate 経由で閉じた場合に取りこぼし、ボタンが隠れたまま
     * 復帰しなかった)。表示中だけ低頻度で表示判定をやり直し、どの閉じ方でも
     * 必ず復帰できるようにする最後の受け皿 (Task 7 修正ラウンド 5)
     */
    startLightboxWatch() {
        if (this.lightboxWatchTimerId !== null) {
            return;
        }
        this.lightboxWatchTimerId = setInterval(
            () => this.update(),
            EXT_CONFIG.lightbox.recheckIntervalMs
        );
    }

    /** 再判定タイマーを止める (ライトボックスが閉じたと分かった時点で呼ぶ)。 */
    stopLightboxWatch() {
        if (this.lightboxWatchTimerId === null) {
            return;
        }
        clearInterval(this.lightboxWatchTimerId);
        this.lightboxWatchTimerId = null;
    }

    /**
     * ページ情報とタブ列に応じて、コンテナ・各ボタンの表示状態をまとめて更新する。
     * 表示規則は「現在地に当たるボタンだけを隠す」の一本のみ。ページごとの条件分岐は書かない。
     * ただし Bluesky 本体のライトボックス表示中はコンテナごと隠す
     * (ナビボタンがライトボックスの手前に出てしまうため。Task 7 修正ラウンド 1)。
     * 開いているかどうかは DOM の実体で判定する (isLightboxVisible)。
     * 履歴フラグ (isLightboxStatePushed) は古い値のまま残ることがあり、
     * それを根拠にするとボタンが隠れたまま復帰しない (Task 7 修正ラウンド 5)。
     * タブ列がまだ確定していない (tabsResolved が false) 間もコンテナごと隠す。
     * 誤った現在地を表示するより、何も出さないほうが安全 (Task 7 修正ラウンド 3)
     */
    update() {
        try {
            if (!this.container) {
                return;
            }
            const lightboxVisible = isLightboxVisible();
            notifyLightboxVisibility(lightboxVisible);
            if (lightboxVisible) {
                this.container.classList.add(EXT_CONFIG.styles.hiddenClass);
                this.startLightboxWatch();
                return;
            }
            this.stopLightboxWatch();
            const info = getPageInfo();
            if (!info || !tabsResolved) {
                this.container.classList.add(EXT_CONFIG.styles.hiddenClass);
                return;
            }
            this.container.classList.remove(EXT_CONFIG.styles.hiddenClass);

            this.buttonsByView.forEach((button, view) => {
                const index = findTabIndex(currentTabs, view);
                const isCurrentView = view === info.view;
                const isMissingTab = index === -1;
                button.classList.toggle(EXT_CONFIG.styles.hiddenClass, isCurrentView || isMissingTab);
            });

            this.updateScrollTop();
        } catch (error) {
            console.error('[Bluesky拡張] ナビボタンの更新に失敗しました', error);
        }
    }
}

/**
 * SPA 内遷移を検知し、ページ更新のトリガーになる。
 * X (旧 Twitter) 版拡張と同じ方式: body の変化を MutationObserver で監視しつつ、
 * popstate も購読する。MutationObserver 側のコールバックは location.href と
 * body 直下の要素数の比較のみ行い、重い処理は requestAnimationFrame 側に
 * まとめる。ライトボックスを開くときは pushState が使われ popstate を
 * 発火しないため、href の比較だけでは検知できない (Task 7 修正ラウンド 1)。
 *
 * **かつては合図に history.state.lightbox の変化を使っていたが、Bluesky は
 * 2026-09-08 の実測でこのフラグを立てなくなり、常に false になった**
 * (SITE_SPEC.md 2.3)。ライトボックスを開いても URL は変わらないため、
 * このままでは門番が二度と開かず onNavigate が呼ばれなくなる
 * (ライトボックス表示中もナビボタンが隠れない既知の不具合の原因。
 * 2026-09-09 に投稿情報パネルが出ないという形で再発して特定した)。
 * 代わりに body 直下の要素数を見る。モーダルが開くと本体がフォーカス
 * トラップの番兵として空の span を 2 つ body 直下に足し、閉じると消す
 * (2026-09-09 実測。6 → 8 → 6)。**これは合図であって真偽ではない。**
 * 開いているかどうかの判断は従来どおり update() の isLightboxVisible()
 * (DOM の実体) が持つ
 */
class NavigationObserver {
    /**
     * @param {() => void} onNavigate 遷移が確定したときに 1 回だけ呼ばれる
     */
    constructor(onNavigate) {
        this.onNavigate = onNavigate;
        this.lastHref = location.href;
        this.lastBodyChildren = document.body.childElementCount;
        this.isNavigating = false;
        this.observer = null;
    }

    /** 監視を開始する。 */
    start() {
        try {
            this.observer = new MutationObserver(() => this.checkNavigation());
            this.observer.observe(document.body, {childList: true, subtree: true});
            window.addEventListener('popstate', () => this.handlePopState());
        } catch (error) {
            console.error('[Bluesky拡張] ナビゲーション監視の開始に失敗しました', error);
        }
    }

    /**
     * 戻る/進む操作を受け取る。popstate はユーザー操作でしか発火しない
     * 低頻度のイベントなので、差分を見ずに必ず onNavigate を予約する。
     * ブラウザバックでライトボックスを閉じたときのように、
     * href も body 直下の要素数も「変わっていない」ように見えるのに画面の
     * 実体だけが変わるケースを取りこぼさないため (Task 7 修正ラウンド 5)
     */
    handlePopState() {
        try {
            this.lastHref = location.href;
            this.lastBodyChildren = document.body.childElementCount;
            this.scheduleNavigate();
        } catch (error) {
            console.error('[Bluesky拡張] 戻る/進むの処理に失敗しました', error);
        }
    }

    /**
     * location.href か body の直下の要素数が前回と変わっていれば、
     * 1 回だけ onNavigate をスケジュールする。
     *
     * **かつては history.state.lightbox の変化を合図にしていたが、
     * Bluesky は 2026-09-08 の実測でこのフラグを立てなくなり、常に false になった**
     * (SITE_SPEC.md 2.3)。ライトボックスを開いても URL は変わらないため、
     * 門番が二度と開かず onNavigate が走らない状態になっていた
     * (ライトボックス表示中もナビボタンが隠れない既知の不具合の原因。
     * 2026-09-09 に投稿情報パネルが出ないという形で再発して特定した)。
     *
     * 代わりに body の直下の要素数を見る。モーダルが開くと本体が
     * フォーカストラップの番兵として空の span を 2 つ body 直下に足し、
     * 閉じると消す (2026-09-09 実測。6 → 8 → 6)。
     * **これは合図であって真偽ではない。** 開いているかどうかの判断は
     * 従来どおり update() の isLightboxVisible() (DOM の実体) が持つ。
     *
     * body 全体の mutation で極めて高頻度に呼ばれるため、
     * ここには文字列比較とプロパティ 1 個の読み取りより重い処理を置かない
     * (childElementCount はレイアウトを起こさない)
     */
    checkNavigation() {
        try {
            const bodyChildren = document.body.childElementCount;
            if (location.href === this.lastHref && bodyChildren === this.lastBodyChildren) {
                return;
            }
            this.lastHref = location.href;
            this.lastBodyChildren = bodyChildren;
            this.scheduleNavigate();
        } catch (error) {
            console.error('[Bluesky拡張] ナビゲーション検知に失敗しました', error);
        }
    }

    /** 次のフレームで onNavigate を 1 回だけ呼ぶ予約を入れる。 */
    scheduleNavigate() {
        if (this.isNavigating) {
            return;
        }
        this.isNavigating = true;
        requestAnimationFrame(() => {
            this.isNavigating = false;
            this.onNavigate();
        });
    }
}

/**
 * プロフィールのタブバーだけを監視し、選択タブの変化を通知する。
 * 恒久的に張る MutationObserver の対象は必ずタブバー (pager) の subtree に限る。
 * document.body 全体を監視し続けると、投稿の追加のたびに発火して重くなるため。
 * ただしタブバーの「出現を待つ」間だけは body を一時的に監視する
 * (見つけた時点で必ず disconnect する。startWaiting の説明を参照)
 */
class TabObserver {
    /**
     * @param {Function} onChange 選択タブが変わったときに呼ばれる
     */
    constructor(onChange) {
        this.onChange = onChange;
        this.observer = null;
        this.lastIndex = -1;
        this.pending = false;
        /** タブバーの出現を待つための body の一時監視。見つけ次第 disconnect する */
        this.waitObserver = null;
        /** 一時監視と併走し、それを畳んだ後も待ち続けるための低頻度ポーリングの id */
        this.waitIntervalId = null;
        /** 一時監視を畳むためのタイマーの id */
        this.waitTimeoutId = null;
        /** 一時監視の連続発火を 1 フレームに 1 回へまとめるための控え */
        this.waitPending = false;
    }

    /** タブバーに監視を張り直す。SPA 遷移で要素が差し替わるため何度でも呼べる */
    attach() {
        try {
            this.detach();
            this.tryAttach();
        } catch (error) {
            console.error('[Bluesky拡張] タブ監視の開始に失敗しました', error);
        }
    }

    /**
     * pager を探し、見つかればタブバーの subtree だけに監視を張る。
     * まだ描画されていなければ待機に入る (startWaiting)。
     * プロフィールページを離れているときは待たずに待機も畳む
     * (無駄な監視を残さないため。Task 7 修正ラウンド 3・4)
     */
    tryAttach() {
        try {
            if (this.observer) {
                return; // すでに監視中。二重に張らない
            }
            if (!parseProfilePath(location.pathname, EXT_CONFIG)) {
                this.stopWaiting();
                return;
            }
            const pager = document.querySelector(EXT_CONFIG.selectors.pager);
            if (!pager) {
                this.startWaiting();
                return;
            }
            this.stopWaiting();
            this.observer = new MutationObserver(() => this.check());
            this.observer.observe(pager, {
                childList: true,
                subtree: true,
                attributes: true
            });
            this.check();
        } catch (error) {
            console.error('[Bluesky拡張] タブ監視の開始に失敗しました', error);
        }
    }

    /**
     * タブバーが描画されるまで待つ。既に待機中なら何もしない。
     * 待ち方は 2 段構え:
     * 1. body の childList/subtree を「一時的に」監視し、描画され次第すぐ気づく。
     *    見つけた時点で必ず disconnect する (body を恒久的に監視し続けると、
     *    スクロールで投稿が増えるたびに発火して重くなるため)。
     *    保険として waitObserverMaxMs 経過時にも畳む
     * 2. それと併走する低頻度ポーリング (pollIntervalMs)。こちらには
     *    時間の上限を設けないため、タブバーの描画がどれだけ遅れても
     *    最終的に監視を張れる (回線・端末が遅いときに「諦めて二度と
     *    試さない」経路を無くすための受け皿。Task 7 修正ラウンド 4)
     */
    startWaiting() {
        if (this.waitIntervalId !== null) {
            return;
        }
        const wait = EXT_CONFIG.tabResolution;
        this.waitIntervalId = setInterval(() => this.tryAttach(), wait.pollIntervalMs);
        this.waitObserver = new MutationObserver(() => this.scheduleWaitCheck());
        this.waitObserver.observe(document.body, {childList: true, subtree: true});
        this.waitTimeoutId = setTimeout(() => {
            this.waitTimeoutId = null;
            this.disconnectWaitObserver();
        }, wait.waitObserverMaxMs);
    }

    /** 待機用の仕掛け (一時監視・ポーリング・畳むタイマー) をすべて片付ける。 */
    stopWaiting() {
        this.disconnectWaitObserver();
        if (this.waitIntervalId !== null) {
            clearInterval(this.waitIntervalId);
            this.waitIntervalId = null;
        }
        if (this.waitTimeoutId !== null) {
            clearTimeout(this.waitTimeoutId);
            this.waitTimeoutId = null;
        }
        this.waitPending = false;
    }

    /** body の一時監視だけを畳む (ポーリングは残す)。 */
    disconnectWaitObserver() {
        if (this.waitObserver) {
            this.waitObserver.disconnect();
            this.waitObserver = null;
        }
    }

    /**
     * 一時監視の発火をフレーム単位にまとめる。
     * 実際の処理は pager の querySelector 1 回だけに抑える
     */
    scheduleWaitCheck() {
        if (this.waitPending) {
            return;
        }
        this.waitPending = true;
        requestAnimationFrame(() => {
            this.waitPending = false;
            this.tryAttach();
        });
    }

    detach() {
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }
        this.stopWaiting();
        this.lastIndex = -1;
    }

    /** 同一フレーム内の連続発火を 1 回にまとめる */
    check() {
        if (this.pending) {
            return;
        }
        this.pending = true;
        requestAnimationFrame(() => {
            this.pending = false;
            const index = getSelectedTabIndex();
            if (index === this.lastIndex) {
                return;
            }
            this.lastIndex = index;
            try {
                this.onChange();
            } catch (error) {
                console.error('[Bluesky拡張] タブ変化の通知が失敗しました', error);
            }
        });
    }
}

/**
 * TabObserver の変化通知から呼ばれる。ナビボタンの表示更新と、
 * メディアグリッドの起動判定 (MediaGridController.sync()) の両方をまとめて行う。
 * どちらも生成タイミングの都合で未生成のことがあるため、呼ぶ前に存在を確認する。
 * mediaGridController は media-grid.js (content.js より後に読み込まれる) が持つ
 * module スコープの変数。typeof で確認するのは、読み込み順の都合上まだ
 * 宣言されていない場合に参照エラーにならないようにするため
 */
function handleTabChange() {
    ExtDebug.log('タブ変化', {タブ: getSelectedTabIndex()});
    if (navButtonManager) {
        navButtonManager.update();
    }
    if (typeof mediaGridController !== 'undefined' && mediaGridController) {
        mediaGridController.sync();
    }
    // タブバーの変化を検知できた = DOM がある程度描画された合図でもあるため、
    // タブ列がまだ未確定なら、ここでも再解決を試みる (確定済みなら即 no-op)。
    // 戻り値は待たない (呼び出し元は同期関数のまま)。解決できれば
    // ensureTabsResolved() 自身が update()/sync() を呼び直す (Task 7 修正ラウンド 3)
    ensureTabsResolved();
}

/**
 * 遷移のたびに呼ばれる。actor が変わっていればタブ列の確定状態をリセットし、
 * ボタンの表示状態を更新してタブバーの監視を張り直したうえで、
 * タブ列の解決 (未確定なら) を試みる。
 */
async function onNavigate() {
    try {
        const info = getPageInfo();
        ExtDebug.log('遷移を検知', {
            url: location.pathname,
            対象: (info && info.actor) || null,
            画面: (info && info.view) || null,
            ライトボックス実体: isLightboxVisible(),
            ライトボックス履歴フラグ: isLightboxStatePushed()
        });
        if (!info) {
            currentTabs = [];
            currentActor = null;
            tabsResolved = false;
            // 対象外のページに出たら、確定の再試行も残さない
            cancelTabsResolveRetry();
        } else if (info.actor !== currentActor) {
            currentActor = info.actor;
            currentTabs = [];
            tabsResolved = false;
            selectedTabIndex = 0;
        }
        if (navButtonManager) {
            navButtonManager.update();
        }
        // SPA 遷移でタブバーの要素が差し替わる (または非プロフィールページへ出て
        // 消える) ため、attach() を呼び直す。pager が無ければ描画され次第
        // tryAttach() が監視を張る。待ち時間に上限は無い (Task 7 修正ラウンド 3・4)
        if (tabObserver) {
            tabObserver.attach();
        }
        // まだ確定していなければ解決を試みる。DOM 未準備なら未確定のまま残り、
        // 次の NavigationObserver / TabObserver の発火か、
        // scheduleTabsResolveRetry() の低頻度タイマーで再試行される
        await ensureTabsResolved();
    } catch (error) {
        console.error('[Bluesky拡張] ページ遷移の処理に失敗しました', error);
    }
}

/** 拡張機能のエントリポイント。 */
function main() {
    try {
        trackTabClicks();
        navButtonManager = new NavButtonManager();
        navButtonManager.initButtons();

        tabObserver = new TabObserver(handleTabChange);

        const observer = new NavigationObserver(onNavigate);
        observer.start();

        onNavigate();
    } catch (error) {
        console.error('[Bluesky拡張] 初期化に失敗しました', error);
    }
}

// tests から require するためだけの分岐。content script では module が未定義のため何もしない
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {parseProfilePath, isLightboxDialog};
}

// content script としての起動。Node のテストからは document が無いため実行されない
if (typeof document !== 'undefined') {
    main();
}
