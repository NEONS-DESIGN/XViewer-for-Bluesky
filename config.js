/**
 * ページ種別。Bluesky のプロフィールタブに対応する。
 * @readonly
 */
const EXT_VIEWS = {
    POSTS: 'posts',
    MEDIA: 'media',
    VIDEOS: 'videos',
    OTHER: 'other'
};

const EXT_CONFIG = {
    /** プロフィールページのパス 1 段目 */
    profilePathRoot: 'profile',

    /**
     * Bluesky 本体 (social-app の src/view/screens/Profile.tsx) と同じ順序・条件でタブ列を組む。
     * 順序は固定だが、どのタブが存在するかはアカウントによって変わる。
     * ここを実測なしに書き換えない (設計文書 2.5)。
     */
    profileTabs: [
        {name: 'labels', when: (c) => c.hasLabeler},
        {name: 'listsForLabeler', when: (c) => c.showLists && c.hasLabeler},
        {name: 'posts', when: () => true, view: EXT_VIEWS.POSTS},
        {name: 'replies', when: (c) => c.hasSession},
        {name: 'media', when: (c) => !c.hasLabeler, view: EXT_VIEWS.MEDIA},
        {name: 'videos', when: (c) => !c.hasLabeler, view: EXT_VIEWS.VIDEOS},
        {name: 'likes', when: (c) => c.isMe},
        {name: 'feeds', when: (c) => c.isMe || c.feedGenCount > 0},
        {name: 'starterPacks', when: (c) => c.isMe || c.starterPackCount > 0},
        {name: 'lists', when: (c) => c.showLists && !c.hasLabeler}
    ],

    selectors: {
        pager: '[data-testid="profilePager"]',
        tabPrefix: 'profilePager-selector-',
        tab: '[data-testid^="profilePager-selector-"]',
        /**
         * 選択中タブだけが持つ下線バーのセレクタ。
         * 実機確認済み (Task 7 修正ラウンド 1):
         * 選択中タブだけが、インラインスタイルで背景色を持つ下線バーの子要素を
         * 1 件持つ。非選択タブは 0 件。React Native Web の生成クラス
         * (.r-1p0dtai 等) は全タブが持つため使えない
         */
        tabUnderline: '[style*="background-color"]',
        feed: '[data-testid="postsFeed"]',
        /**
         * 左ナビのプロフィールリンク。実機確認済み (Task 7 修正ラウンド 1):
         * 単純な a[href^="/profile/"] だとプロフィール本文中のリンク
         * (フォロワー数・おすすめアカウント等) にも大量にヒットするため、
         * nav[role="navigation"] 配下に絞り込む (ページ内に一意で、
         * その中の /profile/ リンクはちょうど 1 件 = 自分のプロフィール)
         */
        sideNavProfileLink: 'nav[role="navigation"] a[href^="/profile/"]',
        /**
         * 左ナビ (sideNavProfileLink の絞り込み元と同じ nav) 自体のセレクタ。
         * DOM の描画が済んだかどうかの判定 (isDomReadyForTabResolution, content.js)
         * に使う。プロフィールリンクの有無だけで判定すると、未ログインで
         * 恒久的にリンクが存在しないケースと、単にまだ描画されていない
         * ケースを区別できないため、コンテナ自体の有無を見る (Task 7 修正ラウンド 3)
         */
        sideNav: 'nav[role="navigation"]'
    },

    /**
     * Bluesky 本体の画像ライトボックス (モーダル) の扱い (content.js)。
     * 開閉の判定を history.state のフラグだけに頼ると、ブラウザバックで
     * 閉じたときに取りこぼすため、DOM 上の実体も見る (Task 7 修正ラウンド 5)
     */
    lightbox: {
        /**
         * ライトボックス (モーダル) の実体を DOM から探すセレクタ。
         * Bluesky 本体のモーダルはアクセシビリティ属性を持つ前提で拾う。
         * 画像ライトボックス以外のモーダル (投稿作成など) にも一致するが、
         * モーダル表示中にナビボタンを隠すのは意図した挙動なので問題ない
         */
        selector: '[role="dialog"], [aria-modal="true"]',
        /**
         * ライトボックス表示中に、ナビボタンの表示判定をやり直す間隔 (ms)。
         * どの閉じ方 (Escape / 閉じるボタン / ブラウザバック / 背景クリック) でも
         * 確実にボタンを復帰させるための最後の受け皿。閉じたと分かった時点で止める
         */
        recheckIntervalMs: 400
    },

    /**
     * ポップアップの保存値 (popup.js)。
     * 要素 ID・文言・設定項目の並びといったポップアップ固有の値は popup.js の
     * 定数側に置き、**保存キーと既定値だけ** をここに集約する
     * (保存キーは content script 側と共有する可能性があるため)。
     */
    popup: {
        /** 配色の選択。UI_DESIGN_KIT 2 節に合わせ、既定はダーク */
        themeStorageKey: 'popupTheme',
        defaultTheme: 'dark'
    },

    /**
     * デバッグモード (debug.js)。ポップアップの 3 つ目のトグルで切り替える。
     * 既定は OFF で、OFF のあいだ ExtDebug は何もしない
     * (sync() のような極めて高頻度のコールバックから呼ばれるため、
     * 無効時に文字列の組み立てや JSON 化を走らせない)。
     * 出力先は 2 つある:
     * 1. コンソール (prefix 付き)。時系列で「何が起きたか」を追う用
     * 2. html 要素の data 属性 (stateAttribute)。「今どうなっているか」を
     *    DevTools の Elements や MAIN ワールドから一目で読む用。
     *    content script は分離ワールドで動くため、内部状態を外から覗く
     *    手段がこれしかない
     */
    debug: {
        storageKey: 'debugEnabled',
        /** 既定は無効。利用者が明示的に有効にしたときだけ動く */
        defaultEnabled: false,
        /** コンソール出力の接頭辞。通常のエラーログと見分けるため [debug] を足す */
        prefix: '[Bluesky拡張][debug]',
        /** 内部状態を書き出す html 要素の属性名 */
        stateAttribute: 'data-bsky-ext-state'
    },

    /**
     * タブバー (pager) の出現待ちと、タブ列の確定リトライの設定 (content.js)。
     * 待ち方を 2 段構えにする: まず body の一時監視で描画され次第すぐ気づき、
     * 一定時間で一時監視を畳んだ後は低頻度のポーリングだけで待ち続ける。
     * ポーリング側に時間の上限は設けない (タブバーの描画がどれだけ遅れても
     * 最終的に機能が起動するようにするため。Task 7 修正ラウンド 4)
     */
    tabResolution: {
        /** body の一時監視を続ける上限時間 (ms)。これを過ぎたら一時監視だけを畳む */
        waitObserverMaxMs: 10000,
        /** タブバーの出現を確認し直す間隔 (ms)。一時監視と併走し、時間の上限は設けない */
        pollIntervalMs: 2000,
        /** タブ列を確定できなかったときに確定を再試行する間隔 (ms)。時間の上限は設けない */
        retryIntervalMs: 2000
    },

    ui: {
        containerId: 'ext-nav-btn-container',
        columnClass: 'ext-nav-btn-column',
        buttonClass: 'ext-nav-btn',
        /** 配列順がそのまま表示順になる */
        navButtons: [
            {id: 'ext-nav-media', text: 'メディアへ', view: EXT_VIEWS.MEDIA},
            {id: 'ext-nav-videos', text: 'ビデオへ', view: EXT_VIEWS.VIDEOS},
            {id: 'ext-nav-posts', text: '投稿へ', view: EXT_VIEWS.POSTS}
        ],
        scrollTopButton: {
            id: 'ext-nav-scroll-top',
            text: 'ページ先頭へ',
            showAfterPx: 200
        }
    },

    styles: {
        hiddenClass: 'ext-hidden'
    },

    mediaGrid: {
        storageKey: 'mediaGridEnabled',
        defaultEnabled: true,
        containerId: 'ext-media-grid',
        listClass: 'ext-media-list',
        tileClass: 'ext-media-tile',
        badgeClass: 'ext-media-badge',
        videoBadgeClass: 'ext-media-video-badge',
        blurClass: 'ext-media-blur',
        blurLabelClass: 'ext-media-blur-label',
        statusId: 'ext-media-status',
        hiddenFeedClass: 'ext-feed-hidden',
        columns: 3,
        gapPx: 4,
        /**
         * グリッドの最大幅 (px)。Bluesky は中央カラムを postsFeed 自身ではなく、
         * その内側の要素に max-width: 600px を当てて作っている
         * (実測: 投稿カードから祖先を辿って深さ 4 の無名 div で確認。Task 8 修正ラウンド 3)。
         * postsFeed 自体は画面幅いっぱいのため、その直下の親にグリッドを prepend すると
         * 何もしなければ全幅に広がってしまう。ここで Bluesky と同じ実測値に揃える
         */
        maxWidthPx: 600,
        maxMediaPerPost: 10,
        /**
         * 動画をグリッドから除外するか。
         * Bluesky にはメディアタブとは別にビデオタブがあり、動画はそちらで
         * 一覧できるため、メディアグリッドには画像だけを並べる。
         * false にすると従来どおり動画タイル (再生バッジ付き・押下で投稿ページへ遷移)
         * も並ぶ。除外は取得後の解析段階で行う: public API の filter には
         * 「画像だけ」に相当する値が無いため、posts_with_media のまま取得して落とす
         */
        excludeVideos: true,
        blurLabels: ['porn', 'sexual', 'nudity', 'graphic-media'],
        /**
         * NSFW ラベルによるぼかしと警告文の解除 (ポップアップの 2 つ目のトグル)。
         * 解除してもラベルの判定 (shouldBlur) とタイルの blurClass はそのまま残し、
         * グリッドのルート要素に containerClass を付けて CSS で打ち消すだけにする。
         * 描画済みのタイルを作り直さずに切り替えられ、OFF に戻せば即座にぼかしが戻るため
         */
        unblur: {
            storageKey: 'nsfwUnblurEnabled',
            /** 既定は解除しない (従来どおりぼかす) */
            defaultEnabled: false,
            containerClass: 'ext-media-unblur'
        },
        /**
         * ぼかしタイルに重ねるラベルの日本語表示名。
         * ラベラーは自由にラベル値を追加できるため、ここに無い値は
         * media-grid.js 側で生の値のままフォールバック表示する
         */
        blurLabelNames: {
            porn: 'ポルノ',
            sexual: '性的な内容',
            nudity: 'ヌード',
            'graphic-media': '生々しい表現'
        },
        text: {
            loading: '読み込み中...',
            end: 'すべて読み込みました',
            empty: 'メディアが見つかりません',
            error: '読み込めませんでした',
            videoBadge: '▶'
        },
        api: {
            origin: 'https://public.api.bsky.app',
            feedPath: '/xrpc/app.bsky.feed.getAuthorFeed',
            profilePath: '/xrpc/app.bsky.actor.getProfile',
            filter: 'posts_with_media',
            limit: 100,
            cooldownMs: 1000,
            bootstrapLimit: 3,
            maxConsecutiveErrors: 3,
            retryAfterMs: 60000,
            nearEndPx: 600,
            stopStatuses: [429],
            timeoutMs: 12000,
            embedTypes: {
                images: 'app.bsky.embed.images#view',
                gallery: 'app.bsky.embed.gallery#view',
                video: 'app.bsky.embed.video#view',
                recordWithMedia: 'app.bsky.embed.recordWithMedia#view'
            }
        },
        bridge: {
            requestEvent: 'ext:bridge-request',
            resultEvent: 'ext:bridge-result',
            actions: {
                openLightbox: 'open-lightbox',
                switchTab: 'switch-tab',
                navigate: 'navigate'
            },
            timeoutMs: 15000
        }
    }
};

// tests から require するためだけの分岐。content script では module が未定義のため何もしない
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {EXT_VIEWS, EXT_CONFIG};
}
