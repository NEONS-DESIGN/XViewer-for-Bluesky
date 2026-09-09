/**
 * ライトボックスに重ねる投稿情報パネル。
 * 画像を開いたとき、右側に本文・投稿日時・作者・反応数を並べる。
 *
 * **メディアグリッド由来かどうかを知らない。** 開いているライトボックスの
 * activeLightbox.metricsContext.postUri を橋渡し (get-lightbox) で読み、
 * getPosts で投稿を引くだけ。グリッド側は openLightbox に
 * 本体と同じ metricsContext を添えるため、経路が 1 本で済む。
 * **取得はまず橋渡し経由の認証付き getPosts を試し、失敗したときだけ
 * 公開 API に落ちる** (viewer は認証付きでしか返らないため)。
 *
 * 依存: config.js (EXT_CONFIG) / debug.js (ExtDebug) /
 *       bridge-client.js (callBridge) / icons.js (createIcon) /
 *       content.js (subscribeLightboxVisibility, isLightboxVisible) /
 *       post-actions.js (PostActions)
 */

/**
 * 本文を facets で区切った断片。
 * @typedef {Object} PanelSegment
 * @property {string} text 表示する文字列
 * @property {'text'|'link'|'mention'|'tag'} kind 断片の種別
 * @property {string|null} value link: URL / mention: DID / tag: タグ名。text は null
 */

/**
 * パネルに描くための投稿。
 * @typedef {Object} PanelPost
 * @property {string} postUri AT URI
 * @property {string} cid 投稿の CID。いいね・リポスト・ブックマークに要る
 * @property {string} authorDid 作者の DID。投稿作成モーダルに渡す
 * @property {Object|null} viewer getPosts の viewer をそのまま。
 *   **未認証の取得では付かない。** 解釈は post-actions.js の readViewerState() が行う
 * @property {string} handle 作者のハンドル
 * @property {string} displayName 表示名 (無ければハンドル)
 * @property {string|null} avatarUrl
 * @property {string} text 本文 (生のまま)
 * @property {PanelSegment[]} segments facets を当てた本文の断片
 * @property {string} createdAt ISO 8601。空文字なら不明
 * @property {string} rkey 投稿ページへの遷移に使う
 * @property {{reply: number, repost: number, like: number, quote: number}} counts
 */

/** AT URI から投稿の did と rkey を取り出す正規表現 */
const PANEL_POST_URI_PATTERN = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/;

/**
 * 投稿の AT URI を分解する。投稿以外のコレクションは弾く。
 * @param {string} uri
 * @returns {{did: string, rkey: string}|null} 形が違えば null
 */
function parsePostUri(uri) {
    try {
        if (typeof uri !== 'string') {
            return null;
        }
        const matched = PANEL_POST_URI_PATTERN.exec(uri);
        if (!matched) {
            return null;
        }
        return {did: matched[1], rkey: matched[2]};
    } catch (error) {
        console.error('[Bluesky拡張] 投稿 URI の解析に失敗しました', error);
        return null;
    }
}

/**
 * facet 1 件を、本文のバイト範囲と種別に直す。
 * 扱えない形 (範囲外・逆順・未知の $type) はすべて null にして捨てる。
 * @param {Object} facet record.facets の 1 要素
 * @param {number} byteLength 本文の UTF-8 バイト長
 * @param {Object} config EXT_CONFIG.lightboxPanel
 * @returns {{start: number, end: number, kind: string, value: string}|null}
 */
function toFacetRange(facet, byteLength, config) {
    const index = facet && facet.index;
    const features = facet && facet.features;
    if (!index || !Array.isArray(features)) {
        return null;
    }
    const start = index.byteStart;
    const end = index.byteEnd;
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
        return null;
    }
    if (start < 0 || end > byteLength || start >= end) {
        return null;
    }
    for (const feature of features) {
        const mapping = config.facets[feature && feature.$type];
        if (!mapping) {
            continue;
        }
        const value = feature[mapping.valueKey];
        if (typeof value !== 'string' || !value) {
            continue;
        }
        return {start, end, kind: mapping.kind, value};
    }
    return null;
}

/**
 * 本文に facets を当てて断片の配列にする。
 * **byteStart / byteEnd は UTF-8 のバイト位置**で、JS の文字列インデックスとは
 * 一致しない (日本語・絵文字で必ずズレる)。TextEncoder でバイト列に直してから
 * 切り出す。壊れた facet は捨てて素通しにする (本文が読めなくなるより良い)。
 * @param {string} text 本文
 * @param {Object[]|undefined} facets record.facets
 * @param {Object} config EXT_CONFIG.lightboxPanel
 * @returns {PanelSegment[]} 空文字なら空の配列
 */
function applyFacets(text, facets, config) {
    try {
        if (typeof text !== 'string' || text === '') {
            return [];
        }
        const bytes = new TextEncoder().encode(text);
        const decoder = new TextDecoder();
        const ranges = (Array.isArray(facets) ? facets : [])
            .map((facet) => toFacetRange(facet, bytes.length, config))
            .filter((range) => range !== null)
            .sort((a, b) => a.start - b.start);

        const segments = [];
        let cursor = 0;
        for (const range of ranges) {
            // 直前の断片と重なるものは捨てる (先に来たほうを残す)
            if (range.start < cursor) {
                continue;
            }
            if (range.start > cursor) {
                segments.push({
                    text: decoder.decode(bytes.slice(cursor, range.start)),
                    kind: 'text',
                    value: null
                });
            }
            segments.push({
                text: decoder.decode(bytes.slice(range.start, range.end)),
                kind: range.kind,
                value: range.value
            });
            cursor = range.end;
        }
        if (cursor < bytes.length) {
            segments.push({
                text: decoder.decode(bytes.slice(cursor)),
                kind: 'text',
                value: null
            });
        }
        return segments;
    } catch (error) {
        console.error('[Bluesky拡張] 本文の装飾の解析に失敗しました', error);
        // 装飾が落ちても本文は読めるようにする
        return typeof text === 'string' && text !== ''
            ? [{text, kind: 'text', value: null}]
            : [];
    }
}

/**
 * 数値を反応数として取り込む。欠けていれば 0。
 * @param {*} value
 * @returns {number}
 */
function toPanelCount(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? value
        : 0;
}

/**
 * getPosts のレスポンスをパネルに描ける形にする。
 * @param {Object|null} json getPosts のレスポンス
 * @param {Object} config EXT_CONFIG.lightboxPanel
 * @returns {PanelPost|null} 読めなければ null
 */
function parsePostForPanel(json, config) {
    try {
        const post = json && Array.isArray(json.posts) ? json.posts[0] : null;
        if (!post) {
            return null;
        }
        const parsed = parsePostUri(post.uri);
        if (!parsed) {
            return null;
        }
        const author = post.author || {};
        const record = post.record || {};
        const handle = typeof author.handle === 'string' ? author.handle : '';
        if (!handle) {
            return null;
        }
        const text = typeof record.text === 'string' ? record.text : '';
        return {
            postUri: post.uri,
            cid: typeof post.cid === 'string' ? post.cid : '',
            authorDid: typeof author.did === 'string' ? author.did : '',
            viewer: (post.viewer && typeof post.viewer === 'object') ? post.viewer : null,
            handle,
            displayName: (typeof author.displayName === 'string' && author.displayName)
                ? author.displayName
                : handle,
            avatarUrl: typeof author.avatar === 'string' ? author.avatar : null,
            text,
            segments: applyFacets(text, record.facets, config),
            createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
            rkey: parsed.rkey,
            counts: {
                reply: toPanelCount(post.replyCount),
                repost: toPanelCount(post.repostCount),
                like: toPanelCount(post.likeCount),
                quote: toPanelCount(post.quoteCount)
            }
        };
    } catch (error) {
        console.error('[Bluesky拡張] 投稿の解析に失敗しました', error);
        return null;
    }
}

/**
 * 投稿日時を絶対表記にする。
 * 本体のフィードは相対表記 (「3日」) なので、パネルは本体で見られない
 * 情報を補う役に徹する。
 * @param {string} iso ISO 8601
 * @param {Object} config EXT_CONFIG.lightboxPanel
 * @returns {string|null} 読めなければ null
 */
function formatPostDate(iso, config) {
    try {
        if (typeof iso !== 'string' || !iso) {
            return null;
        }
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) {
            return null;
        }
        return new Intl.DateTimeFormat(config.locale, config.dateFormat).format(date);
    } catch (error) {
        console.error('[Bluesky拡張] 投稿日時の整形に失敗しました', error);
        return null;
    }
}

/**
 * 反応数を桁区切りの文字列にする。
 * @param {*} value
 * @param {Object} config EXT_CONFIG.lightboxPanel
 * @returns {string}
 */
function formatCount(value, config) {
    const count = toPanelCount(value);
    try {
        return new Intl.NumberFormat(config.locale).format(count);
    } catch (error) {
        console.error('[Bluesky拡張] 反応数の整形に失敗しました', error);
        return String(count);
    }
}

/**
 * パネルを出してよいかを判定する。
 * 狭いウィンドウでは画像が潰れるため出さない。
 * @param {{enabled: boolean, innerWidth: number}|null} state
 * @param {Object} config EXT_CONFIG.lightboxPanel
 * @returns {boolean}
 */
function shouldShowPanel(state, config) {
    if (!state || state.enabled !== true) {
        return false;
    }
    const width = state.innerWidth;
    if (typeof width !== 'number' || !Number.isFinite(width)) {
        return false;
    }
    return width >= config.minWindowWidthPx;
}

/**
 * 本文中のリンクを a の href に入れてよいかを判定する。
 * **facets の uri は投稿者が自由に決められる値**のため、許可した scheme
 * (config.allowedLinkProtocols) 以外は押せる要素にしない。
 * @param {string} uri facets の feature が持つ URL
 * @param {Object} config EXT_CONFIG.lightboxPanel
 * @returns {string|null} 安全な絶対 URL。押させてはいけないものは null
 */
function toSafeLinkHref(uri, config) {
    try {
        if (typeof uri !== 'string' || !uri) {
            return null;
        }
        const parsed = new URL(uri);
        if (config.allowedLinkProtocols.indexOf(parsed.protocol) === -1) {
            return null;
        }
        return parsed.href;
    } catch (error) {
        // 相対 URL や壊れた文字列は URL の解析で例外になる。押させない
        return null;
    }
}

/**
 * 成功した操作の結果を、覚えている投稿へ書き戻す。
 * **その種別 (kind) に対応するフィールドだけを書き、他の種別には触れない。**
 * `this.pending` は種別ごとにしか操作を弾かないため、別種の操作
 * (例: いいねとブックマーク) が同時に飛行中になり得る。全フィールドを
 * まるごと書き戻すと、後から書き戻った側が先に書き戻した側の結果を
 * 消してしまう (2026-09-09 実機の手前で見つかった Important。
 * `CHANGELOG.md` `[2.6.3]` 参照)。
 * 書き戻す先は自前で作った `PanelPost` (キャッシュに入っているものと
 * 同じ参照) で、本体 DOM にも本体のキャッシュにも触れない
 * @param {PanelPost} post 書き戻す先
 * @param {'like'|'repost'|'bookmark'} kind
 * @param {ActionState} state 反映する状態。kind に対応するフィールドだけを読む
 * @returns {void}
 */
function syncPostViewer(post, kind, state) {
    try {
        const viewer = Object.assign({}, post.viewer);
        const counts = Object.assign({}, post.counts);
        if (kind === 'like') {
            viewer.like = state.likeUri;
            counts.like = state.counts.like;
        } else if (kind === 'repost') {
            viewer.repost = state.repostUri;
            counts.repost = state.counts.repost;
        } else if (kind === 'bookmark') {
            viewer.bookmarked = state.bookmarked;
        }
        post.viewer = viewer;
        post.counts = counts;
    } catch (error) {
        console.error('[Bluesky拡張] 投稿の状態の書き戻しに失敗しました', error);
    }
}

/**
 * 失敗した操作を、その種別だけ打ち消した新しい状態にする。
 * **他の種別 (別の操作が同時に飛行中でも) には触れない。** もう一度
 * `toggleActionState()` を通すだけで、対象の種別だけが打ち消され、
 * 他の種別が積み重ねた変化はそのまま残る。
 * `toggleActionState()` は方向によらず対象種別の URI を null にするため、
 * **「削除に失敗して元の反応が残った」場合は、ここで元の URI を戻す**
 * (でなければ、まだ存在するレコードの URI をパネルが見失う)
 * @param {ActionState} state 打ち消す元になる、今の状態
 * @param {'like'|'repost'|'bookmark'} kind
 * @param {ActionState} previous 押す前の状態。URI の復元に使う
 * @returns {ActionState} 打ち消した後の新しい状態
 */
function revertActionState(state, kind, previous) {
    const reverted = toggleActionState(state, kind);
    if (kind === 'like') {
        reverted.likeUri = previous.likeUri;
    } else if (kind === 'repost') {
        reverted.repostUri = previous.repostUri;
    }
    return reverted;
}

/**
 * ライトボックスの右側に投稿情報を出す。
 *
 * **本体 DOM への介入は、ダイアログの固定親に当てるインラインの right
 * 1 プロパティだけ。** 当てた要素そのものを覚えておき、撤去時はその参照に
 * 対して**上書き前に控えておいた元のインラインの値**を書き戻す。
 * Bluesky 自身が right: 0px をインラインで書いているため、空文字に戻すと
 * その指定ごと消えて固定親の幅が shrink-to-fit で 0 に潰れる
 * (2026-09-09 実機で確認した Critical)。セレクタで引き直さない
 * (閉じた後は引けない)。要素が既に消えていれば何もしない (設計文書 8 節)
 */
class LightboxPanel {
    /**
     * @param {Object} config EXT_CONFIG.lightboxPanel
     */
    constructor(config) {
        this.config = config;
        this.enabled = config.defaultEnabled;
        this.collapsed = config.defaultCollapsed;
        /** @type {HTMLElement|null} 生成したパネル */
        this.panelEl = null;
        /** @type {HTMLElement|null} right を当てた本体の要素。撤去時に戻す相手 */
        this.shrunkEl = null;
        /**
         * right を当てる前に本体が持っていたインラインの値。
         * **Bluesky 自身が right: 0px をインラインで書いている** (2026-09-09 実測)。
         * 空文字で消すと本体の値ごと消え、固定親の幅が shrink-to-fit になって
         * 0 に潰れる。撤去時はここへ戻す
         */
        this.shrunkPreviousRight = '';
        /** @type {Map<string, PanelPost>} postUri をキーにした取得済みの投稿 */
        this.cache = new Map();
        /**
         * 取得の世代。応答待ちの間にライトボックスが閉じたり別の投稿に
         * 変わったりしたら、その応答は丸ごと捨てる (MediaFetcher.generation と同じ考え方)
         */
        this.generation = 0;
        /**
         * 投稿操作の呼び出し層。**取得を認証付きにするためにも使う**
         * (viewer は認証付きの getPosts でしか返らない)
         */
        this.actions = new PostActions(EXT_CONFIG.postActions);
        /** @type {ActionState|null} 描画中の投稿の反応状態 */
        this.state = null;
        /** @type {PanelPost|null} 描画中の投稿 */
        this.post = null;
        /**
         * 飛行中の操作の種別。**連打を弾くために要る。**
         * createRecord が 2 本飛ぶと、いいねレコードが 2 つできて
         * 片方が取り消せなくなる
         * @type {Set<string>}
         */
        this.pending = new Set();
        /** 投稿操作を出すか。ポップアップのトグル */
        this.actionsEnabled = EXT_CONFIG.postActions.defaultEnabled;
        /** @type {HTMLElement|null} 開いているリポストのメニュー */
        this.menuEl = null;
        /** @type {Function|null} メニューの外側の押下を受けるリスナー。外すのに要る */
        this.onOutsideClick = null;
        /**
         * @type {HTMLElement|null} メニューを開いたボタン。
         * 閉じるときに aria-expanded を戻すのに要る
         */
        this.menuAnchor = null;
    }

    /**
     * 設定を読み、ライトボックスの開閉を購読する。
     * @returns {Promise<void>}
     */
    async init() {
        const config = this.config;
        try {
            const stored = await chrome.storage.sync.get([
                config.storageKey,
                config.collapsedStorageKey,
                EXT_CONFIG.postActions.storageKey
            ]);
            this.enabled = stored[config.storageKey] ?? config.defaultEnabled;
            this.collapsed = stored[config.collapsedStorageKey] ?? config.defaultCollapsed;
            this.actionsEnabled = stored[EXT_CONFIG.postActions.storageKey]
                ?? EXT_CONFIG.postActions.defaultEnabled;
        } catch (error) {
            console.error('[Bluesky拡張] パネルの設定の読み込みに失敗しました', error);
        }
        try {
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area !== 'sync') {
                    return;
                }
                if (changes[EXT_CONFIG.postActions.storageKey]) {
                    this.actionsEnabled = changes[EXT_CONFIG.postActions.storageKey].newValue
                        ?? EXT_CONFIG.postActions.defaultEnabled;
                    // 描画済みのパネルにその場で反映する (リロードを求めない)
                    if (this.post) {
                        this.renderPost(this.post);
                    }
                }
                if (!changes[config.storageKey]) {
                    return;
                }
                this.setEnabled(
                    changes[config.storageKey].newValue ?? config.defaultEnabled
                );
            });
        } catch (error) {
            console.error('[Bluesky拡張] パネルの設定の購読に失敗しました', error);
        }
        try {
            subscribeLightboxVisibility((visible) => {
                if (visible) {
                    this.open();
                } else {
                    this.teardown();
                }
            });
            // タブを閉じる・遷移で離れるときにも本体の変更を必ず戻す
            window.addEventListener('pagehide', () => this.teardown());
        } catch (error) {
            console.error('[Bluesky拡張] パネルの起動に失敗しました', error);
        }
    }

    /**
     * ポップアップのトグルを反映する。OFF にした瞬間に撤去する。
     * @param {boolean} enabled
     * @returns {void}
     */
    setEnabled(enabled) {
        this.enabled = enabled === true;
        ExtDebug.log('パネルの設定が変わった', {有効: this.enabled});
        if (!this.enabled) {
            this.teardown();
            return;
        }
        // ライトボックスが開いたままなら、その場で出す
        if (isLightboxVisible()) {
            this.open();
        }
    }

    /**
     * パネルを出す。開いているのが画像ライトボックスでなければ何もしない。
     * @returns {Promise<void>}
     */
    async open() {
        try {
            if (this.panelEl) {
                return;
            }
            if (!shouldShowPanel(
                {enabled: this.enabled, innerWidth: window.innerWidth},
                this.config
            )) {
                return;
            }
            const generation = this.generation;
            const result = await callBridge(
                EXT_CONFIG.mediaGrid.bridge.actions.getLightbox, {}
            );
            if (generation !== this.generation) {
                return;
            }
            if (!result || !result.ok || !result.open || !result.postUri) {
                ExtDebug.log('パネルを出さない', {
                    理由: result && result.ok
                        ? (result.open ? 'postUri が無い' : '画像ライトボックスではない')
                        : (result && result.reason) || '応答なし'
                });
                return;
            }
            // 応答を待つ間に閉じられている可能性がある
            if (!isLightboxVisible()) {
                return;
            }

            const postUri = result.postUri;
            this.mountPanel();
            this.applyShrink();

            const cached = this.cache.get(postUri);
            if (cached) {
                this.renderPost(cached);
                return;
            }
            this.renderStatus(this.config.text.loading);
            ExtDebug.log('パネルの取得を開始', {postUri});
            const post = await this.fetchPost(postUri);
            if (generation !== this.generation || !this.panelEl) {
                return;
            }
            if (!post) {
                this.renderStatus(this.config.text.error);
                return;
            }
            this.remember(postUri, post);
            this.renderPost(post);
            ExtDebug.log('パネルの取得が終了', {postUri, 本文の長さ: post.text.length});
        } catch (error) {
            console.error('[Bluesky拡張] パネルの表示に失敗しました', error);
        }
    }

    /**
     * パネルを撤去し、本体に当てた変更を戻す。
     * **どの閉じ方をされても必ずここを通る。**
     * @returns {void}
     */
    teardown() {
        this.closeRepostMenu();
        // 飛行中の取得の応答を捨てる
        this.generation += 1;
        this.releaseShrink();
        this.post = null;
        this.state = null;
        this.pending.clear();
        this.unmountPanel();
    }

    /**
     * 取得済みの投稿を覚える。上限を超えたら古いものから捨てる。
     * @param {string} postUri
     * @param {PanelPost} post
     * @returns {void}
     */
    remember(postUri, post) {
        this.cache.set(postUri, post);
        while (this.cache.size > this.config.cacheLimit) {
            const oldest = this.cache.keys().next();
            if (oldest.done) {
                break;
            }
            this.cache.delete(oldest.value);
        }
    }

    /**
     * 投稿を 1 件引く。
     *
     * **まず橋渡し経由の認証付き getPosts を試す。** viewer (いいね済みか等) は
     * 認証付きでしか返らないため。橋渡しが使えない・未ログインのときは
     * 公開 API に落ちる。その場合 viewer が無く、操作ボタンは出ない
     * @param {string} postUri
     * @returns {Promise<PanelPost|null>} 読めなければ null
     */
    async fetchPost(postUri) {
        const authed = await this.actions.fetchPost(postUri);
        if (authed) {
            const post = parsePostForPanel(authed, this.config);
            if (post) {
                return post;
            }
        }
        return this.fetchPostPublic(postUri);
    }

    /**
     * 公開 API から投稿を 1 件引く。**未認証のため viewer は付かない。**
     * @param {string} postUri
     * @returns {Promise<PanelPost|null>} 読めなければ null
     */
    async fetchPostPublic(postUri) {
        const api = this.config.api;
        const url = `${api.origin}${api.postsPath}?uris=${encodeURIComponent(postUri)}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), api.timeoutMs);
        try {
            const response = await fetch(url, {signal: controller.signal});
            if (!response.ok) {
                console.error('[Bluesky拡張] 投稿の取得に失敗しました', response.status);
                return null;
            }
            return parsePostForPanel(await response.json(), this.config);
        } catch (error) {
            console.error('[Bluesky拡張] 投稿の取得に失敗しました', error);
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * `dialogSelector` に一致する要素のうち、実際に見えている**画像ライトボックス**を
     * 1 件返す。
     * **同じ目印の要素がページ内に複数あり、素の `querySelector` が非表示の
     * 方を掴む**ことでこのプロジェクトは 2 回 Critical を踏んでいる
     * (`postsFeed` / `profilePager`。`SITE_SPEC.md` 6.3)。開閉の判定
     * (`isLightboxVisible()`) と介入対象を必ず同じ要素にするため、
     * `querySelectorAll` + `getClientRects().length > 0` に揃える。
     * **投稿作成モーダルが同時に開いていることがある**ため、
     * `isLightboxDialog()` で除く
     * @returns {Element|null}
     */
    findVisibleDialog() {
        const nodes = document.querySelectorAll(this.config.dialogSelector);
        for (let i = 0; i < nodes.length; i += 1) {
            if (nodes[i].getClientRects().length > 0
                && isLightboxDialog(nodes[i], EXT_CONFIG.lightbox)) {
                return nodes[i];
            }
        }
        return null;
    }

    /**
     * 本体のダイアログの固定親を狭める。
     * **見つからなければ何もしない** (パネルは重なる表示に落ちる)。
     * **上書きする前に元のインラインの値を控える。** Bluesky 自身が
     * right: 0px をインラインで書いているため (2026-09-09 実測)、
     * 空文字で戻すと本体の指定ごと消えてしまう
     * @returns {void}
     */
    applyShrink() {
        try {
            if (this.collapsed || this.shrunkEl) {
                return;
            }
            const dialog = this.findVisibleDialog();
            const parent = dialog && dialog.parentElement;
            if (!parent) {
                return;
            }
            this.shrunkEl = parent;
            // 上書きする前に本体の値を控える (空文字で消すと本体の指定ごと消える)
            this.shrunkPreviousRight = parent.style.right;
            parent.style.right = `${this.config.widthPx}px`;
        } catch (error) {
            console.error('[Bluesky拡張] ライトボックスの幅の調整に失敗しました', error);
        }
    }

    /**
     * 本体に当てた right を戻す。**保持している参照に対して書く。**
     * **空文字ではなく、控えておいた元の値に戻す。** Bluesky 自身が
     * right: 0px をインラインで書いており、空文字にすると right の指定が
     * どこにも無くなって固定親が shrink-to-fit の幅 (0px) に潰れる
     * (2026-09-09 実機で確認した Critical)
     * @returns {void}
     */
    releaseShrink() {
        try {
            if (this.shrunkEl) {
                this.shrunkEl.style.right = this.shrunkPreviousRight;
            }
        } catch (error) {
            console.error('[Bluesky拡張] ライトボックスの幅の復帰に失敗しました', error);
        } finally {
            this.shrunkEl = null;
            this.shrunkPreviousRight = '';
        }
    }

    /**
     * パネルの外枠を作って body 直下に置く。**既存のものは必ず消してから足す。**
     * @returns {void}
     */
    mountPanel() {
        const config = this.config;
        this.unmountPanel();
        const panel = document.createElement('aside');
        panel.id = config.panelId;
        panel.style.width = `${config.widthPx}px`;
        panel.style.zIndex = String(config.zIndex);
        if (this.collapsed) {
            panel.classList.add(config.collapsedClass);
        }

        const header = document.createElement('div');
        header.className = config.headerClass;
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = config.toggleClass;
        toggle.addEventListener('click', () => this.setCollapsed(!this.collapsed));
        header.appendChild(toggle);
        panel.appendChild(header);

        const body = document.createElement('div');
        body.className = config.bodyClass;
        panel.appendChild(body);

        document.body.appendChild(panel);
        this.panelEl = panel;
        this.toggleEl = toggle;
        this.bodyEl = body;
        this.updateToggle();
        ExtDebug.log('パネルを生成', {畳んでいる: this.collapsed});
    }

    /** パネルを DOM から外す。 */
    unmountPanel() {
        try {
            const existing = document.getElementById(this.config.panelId);
            if (existing) {
                existing.remove();
            }
        } catch (error) {
            console.error('[Bluesky拡張] パネルの撤去に失敗しました', error);
        } finally {
            this.panelEl = null;
            this.toggleEl = null;
            this.bodyEl = null;
        }
    }

    /**
     * 畳む / 開くを切り替える。状態は保存する。
     * @param {boolean} collapsed
     * @returns {void}
     */
    setCollapsed(collapsed) {
        this.collapsed = collapsed === true;
        try {
            if (this.panelEl) {
                this.panelEl.classList.toggle(
                    this.config.collapsedClass, this.collapsed
                );
            }
            this.updateToggle();
            if (this.collapsed) {
                this.releaseShrink();
            } else {
                this.applyShrink();
            }
        } catch (error) {
            console.error('[Bluesky拡張] パネルの折り畳みに失敗しました', error);
        }
        try {
            chrome.storage.sync.set({
                [this.config.collapsedStorageKey]: this.collapsed
            });
        } catch (error) {
            console.error('[Bluesky拡張] 折り畳み状態の保存に失敗しました', error);
        }
    }

    /** 畳む / 開くボタンのアイコンとラベルを今の状態に合わせる。 */
    updateToggle() {
        if (!this.toggleEl) {
            return;
        }
        const text = this.config.text;
        const label = this.collapsed ? text.expand : text.collapse;
        this.toggleEl.textContent = '';
        this.toggleEl.setAttribute('aria-label', label);
        this.toggleEl.title = label;
        this.toggleEl.appendChild(createIcon(
            document, this.collapsed ? 'chevronLeft' : 'chevronRight'
        ));
    }

    /**
     * 本文の代わりに 1 行の文言を出す (読み込み中・失敗)。
     * @param {string} message
     * @returns {void}
     */
    renderStatus(message) {
        if (!this.bodyEl) {
            return;
        }
        this.bodyEl.textContent = '';
        const status = document.createElement('p');
        status.className = this.config.statusClass;
        status.textContent = message;
        this.bodyEl.appendChild(status);
    }

    /**
     * 投稿をパネルに描く。
     * @param {PanelPost} post
     * @returns {void}
     */
    renderPost(post) {
        try {
            if (!this.bodyEl) {
                return;
            }
            // bodyEl をまるごと作り直すため、メニューが宙に浮く前に片付ける
            // (chrome.storage.onChanged からの再描画は mountPanel() を経由せず
            // ここへ直接来るため、renderActions() の片付けだけでは足りない)
            this.closeRepostMenu();
            const config = this.config;
            this.post = post;
            this.state = readViewerState(post.viewer, post.counts);
            this.bodyEl.textContent = '';
            this.bodyEl.appendChild(this.buildAuthor(post));

            const text = document.createElement('p');
            text.className = config.textClass;
            for (const segment of post.segments) {
                text.appendChild(this.buildSegment(segment));
            }
            this.bodyEl.appendChild(text);

            const formatted = formatPostDate(post.createdAt, config);
            if (formatted) {
                const date = document.createElement('time');
                date.className = config.dateClass;
                date.setAttribute('datetime', post.createdAt);
                date.textContent = formatted;
                this.bodyEl.appendChild(date);
            }

            this.bodyEl.appendChild(this.shouldShowActions(post)
                ? this.buildActions()
                : this.buildCounts(post));
            this.bodyEl.appendChild(this.buildOpenPost(post));
        } catch (error) {
            console.error('[Bluesky拡張] パネルの描画に失敗しました', error);
            this.renderStatus(this.config.text.error);
        }
    }

    /**
     * 作者の行を作る。
     * @param {PanelPost} post
     * @returns {HTMLElement}
     */
    buildAuthor(post) {
        const config = this.config;
        const author = document.createElement('div');
        author.className = config.authorClass;
        if (post.avatarUrl) {
            const avatar = document.createElement('img');
            avatar.className = config.avatarClass;
            avatar.src = post.avatarUrl;
            // 名前は隣に文字で出ているので、画像は装飾として扱う
            avatar.alt = '';
            author.appendChild(avatar);
        }
        const names = document.createElement('div');
        const name = document.createElement('span');
        name.className = config.nameClass;
        name.textContent = post.displayName;
        const handle = document.createElement('span');
        handle.className = config.handleClass;
        handle.textContent = `@${post.handle}`;
        names.appendChild(name);
        names.appendChild(handle);
        author.appendChild(names);
        return author;
    }

    /**
     * 本文の断片 1 つを要素にする。
     * リンクだけは a の既定動作 (新しいタブ) に任せる。外部サイトへの遷移は
     * 本体のルーターの管轄外のため、SPA 遷移にする必要が無い。
     * @param {PanelSegment} segment
     * @returns {Node}
     */
    buildSegment(segment) {
        const config = this.config;
        const routes = EXT_CONFIG.mediaGrid.bridge.routes;
        if (segment.kind === 'link') {
            const href = toSafeLinkHref(segment.value, config);
            // 許可した scheme でなければ押せる要素にしない。本文は文字列として残す
            if (!href) {
                return document.createTextNode(segment.text);
            }
            const link = document.createElement('a');
            link.className = config.linkClass;
            link.href = href;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = segment.text;
            return link;
        }
        if (segment.kind === 'mention' || segment.kind === 'tag') {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = config.linkClass;
            button.textContent = segment.text;
            const params = segment.kind === 'mention'
                ? {route: routes.profile, params: {name: segment.value}}
                : {route: routes.hashtag, params: {tag: segment.value}};
            button.addEventListener('click', () => this.leaveTo(params));
            return button;
        }
        return document.createTextNode(segment.text);
    }

    /**
     * 反応数の行を作る。0 の項目も出す (欠けると横並びの位置がずれて読みにくい)。
     * @param {PanelPost} post
     * @returns {HTMLElement}
     */
    buildCounts(post) {
        const config = this.config;
        const row = document.createElement('div');
        row.className = config.countsClass;
        const items = [
            {icon: 'chatBubble', label: config.text.replyCount, value: post.counts.reply},
            {icon: 'repeat', label: config.text.repostCount, value: post.counts.repost},
            {icon: 'favorite', label: config.text.likeCount, value: post.counts.like},
            {icon: 'formatQuote', label: config.text.quoteCount, value: post.counts.quote}
        ];
        for (const item of items) {
            const cell = document.createElement('span');
            cell.className = config.countClass;
            cell.setAttribute('aria-label', item.label);
            cell.title = item.label;
            const icon = createIcon(document, item.icon);
            icon.classList.add(config.countIconClass);
            cell.appendChild(icon);
            const number = document.createElement('span');
            number.textContent = formatCount(item.value, config);
            cell.appendChild(number);
            row.appendChild(cell);
        }
        return row;
    }

    /**
     * 操作ボタンを出せるかどうか。
     * **viewer が無い取得 (未ログイン・橋渡し失敗) では出さない。**
     * 出しても押した瞬間に必ず失敗するため、数値の表示に留める
     * @param {PanelPost} post
     * @returns {boolean}
     */
    shouldShowActions(post) {
        return this.actionsEnabled === true
            && post.viewer !== null
            && post.cid !== '';
    }

    /**
     * 押せる操作行を作る。反応数の行 (buildCounts) と入れ替わりで出す。
     * **0 の項目も出す** (欠けると横並びの位置がずれて読みにくい)。
     * @returns {HTMLElement}
     */
    buildActions() {
        const config = EXT_CONFIG.postActions;
        const state = this.state;
        const row = document.createElement('div');
        row.className = config.actionsClass;
        const items = [
            {
                kind: 'reply',
                icon: 'chatBubble',
                label: config.text.reply,
                active: false,
                count: state.counts.reply
            },
            {
                kind: 'repost',
                icon: 'repeat',
                label: config.text.repost,
                active: state.reposted,
                count: state.counts.repost
            },
            {
                kind: 'like',
                icon: 'favorite',
                label: state.liked ? config.text.likeUndo : config.text.like,
                active: state.liked,
                count: state.counts.like
            },
            {
                kind: 'bookmark',
                icon: 'bookmark',
                label: state.bookmarked ? config.text.bookmarkUndo : config.text.bookmark,
                active: state.bookmarked,
                count: null
            }
        ];
        for (const item of items) {
            row.appendChild(this.buildActionButton(item));
        }
        return row;
    }

    /**
     * 操作ボタンを 1 つ作る。
     * @param {{kind: string, icon: string, label: string, active: boolean,
     *   count: number|null}} item
     * @returns {HTMLElement}
     */
    buildActionButton(item) {
        const config = EXT_CONFIG.postActions;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = item.active
            ? `${config.actionClass} ${config.activeClass}`
            : config.actionClass;
        // アイコンだけでは意味が伝わらないので、読み上げ用と マウス用の両方を付ける
        button.setAttribute('aria-label', item.label);
        button.title = item.label;
        button.disabled = this.pending.has(item.kind);
        // メニューを持つのはリポストだけ。他の 3 つには付けない
        if (item.kind === 'repost') {
            button.setAttribute('aria-haspopup', 'menu');
            button.setAttribute('aria-expanded', 'false');
        }
        const icon = createIcon(document, item.icon);
        icon.classList.add(config.actionIconClass);
        button.appendChild(icon);
        if (item.count !== null) {
            const number = document.createElement('span');
            number.textContent = formatCount(item.count, this.config);
            button.appendChild(number);
        }
        button.addEventListener('click', () => {
            if (item.kind === 'reply') {
                this.openComposerFor(EXT_CONFIG.postActions.composerModes.reply);
                return;
            }
            if (item.kind === 'repost') {
                this.toggleRepostMenu(button);
                return;
            }
            this.runAction(item.kind);
        });
        return button;
    }

    /**
     * 操作を 1 つ実行する。
     *
     * **楽観的更新。** 押した瞬間に見た目を変え、失敗したら控えておいた
     * 元の状態へ戻す。飛行中の同じ操作は弾く (連打で同じレコードが
     * 2 つできると片方が取り消せなくなる)。
     * @param {'like'|'repost'|'bookmark'} kind
     * @returns {Promise<void>}
     */
    async runAction(kind) {
        // catch でも巻き戻せるよう、try の外のスコープに出しておく
        let previous = null;
        try {
            if (!this.post || !this.state || this.pending.has(kind)) {
                return;
            }
            const post = this.post;
            // teardown() で必ず加算される世代。**this.post だけでは
            // 「閉じて同じ投稿を開き直した」を検知できない**
            // (this.cache が同じ PanelPost 参照を返すため)
            const generation = this.generation;
            previous = this.state;
            const next = toggleActionState(previous, kind);
            this.pending.add(kind);
            this.state = next;
            this.renderActions();

            const result = await this.callAction(kind, post, previous, next);
            this.pending.delete(kind);
            if (result.ok) {
                // createRecord の応答の URI を取り込む。取り込まないと取り消せない
                if (kind === 'like' && next.liked) {
                    next.likeUri = result.recordUri;
                }
                if (kind === 'repost' && next.reposted) {
                    next.repostUri = result.recordUri;
                }
                // 覚えている投稿にも反映する。**この種別のフィールドだけを書く**
                // (this.pending は種別ごとにしか弾かないため、別種の操作が同時に
                // 飛行中の場合がある。全フィールドを書くと互いの結果を消し合う)。
                // 破棄ガードより前で無条件に行う。post はこの呼び出しがローカルに
                // 掴んでいるキャッシュ内のオブジェクトなので、応答待ちの間に
                // 閉じられていても書き戻して構わない
                syncPostViewer(post, kind, next);
            }
            // 応答を待つ間に別の投稿へ移った・閉じて開き直されていたら、
            // 画面への反映は捨てる (書き戻しは上で完了しているので、次に開いたときは
            // 正しい状態から描かれる)
            if (this.post !== post || generation !== this.generation) {
                return;
            }
            if (!result.ok) {
                // その種別だけを打ち消す。previous へまるごと戻すと、飛行中の
                // 別種の操作の結果を消してしまう
                this.state = revertActionState(this.state, kind, previous);
                this.renderActions();
                this.showActionError();
                return;
            }
            // 足りないのは URI だけ。liked / bookmarked / counts はこの種別の
            // 楽観的更新が既に生きた状態の連鎖に入っているため、まるごと
            // 差し替えない (差し替えると、飛行中の別種の操作の結果を消してしまう)
            if (kind === 'like' && next.liked) {
                this.state.likeUri = result.recordUri;
            }
            if (kind === 'repost' && next.reposted) {
                this.state.repostUri = result.recordUri;
            }
            this.renderActions();
        } catch (error) {
            console.error('[Bluesky拡張] 投稿操作に失敗しました', error);
            this.pending.delete(kind);
            // 通信していないのに見た目だけ変わったままにしない。その種別だけを
            // 打ち消す (this.state が既に無ければ何もしない)
            if (previous && this.state) {
                this.state = revertActionState(this.state, kind, previous);
                this.renderActions();
                this.showActionError();
            }
        }
    }

    /**
     * 種別に応じた通信を 1 回行う。
     * @param {'like'|'repost'|'bookmark'} kind
     * @param {PanelPost} post
     * @param {ActionState} previous 押す前の状態 (取り消しの URI を持つ)
     * @param {ActionState} next 押した後の状態
     * @returns {Promise<{ok: boolean, recordUri: string|null}>}
     */
    async callAction(kind, post, previous, next) {
        if (kind === 'like') {
            return next.liked
                ? this.actions.createLike(post.postUri, post.cid)
                : Object.assign(
                    {recordUri: null},
                    await this.actions.deleteLike(previous.likeUri)
                );
        }
        if (kind === 'repost') {
            return next.reposted
                ? this.actions.createRepost(post.postUri, post.cid)
                : Object.assign(
                    {recordUri: null},
                    await this.actions.deleteRepost(previous.repostUri)
                );
        }
        if (kind === 'bookmark') {
            const result = next.bookmarked
                ? await this.actions.createBookmark(post.postUri, post.cid)
                : await this.actions.deleteBookmark(post.postUri);
            return {ok: result.ok, recordUri: null};
        }
        return {ok: false, recordUri: null};
    }

    /**
     * 操作行だけを描き直す。**パネル全体は作り直さない**
     * (本文のスクロール位置と、開いているメニューが失われるため)。
     * @returns {void}
     */
    renderActions() {
        try {
            if (!this.bodyEl || !this.state) {
                return;
            }
            this.closeRepostMenu();
            const current = this.bodyEl.querySelector(
                `.${EXT_CONFIG.postActions.actionsClass}`
            );
            if (!current) {
                return;
            }
            current.replaceWith(this.buildActions());
            const stale = this.bodyEl.querySelector(`.${EXT_CONFIG.postActions.errorClass}`);
            if (stale) {
                stale.remove();
            }
        } catch (error) {
            console.error('[Bluesky拡張] 操作行の描き直しに失敗しました', error);
        }
    }

    /**
     * 本体の投稿作成モーダルを開く。**ライトボックスは閉じない**
     * (2026-09-09 実測で同時に開けることを確認済み。CSS で前面に出している)。
     * @param {'reply'|'quote'} mode
     * @returns {Promise<void>}
     */
    async openComposerFor(mode) {
        try {
            if (!this.post) {
                return;
            }
            this.closeRepostMenu();
            const result = await this.actions.openComposer(mode, {
                uri: this.post.postUri,
                cid: this.post.cid,
                text: this.post.text,
                author: {
                    did: this.post.authorDid,
                    handle: this.post.handle,
                    displayName: this.post.displayName,
                    avatar: this.post.avatarUrl
                }
            });
            if (!result.ok) {
                this.showActionError();
            }
        } catch (error) {
            console.error('[Bluesky拡張] 投稿作成モーダルを開けませんでした', error);
        }
    }

    /**
     * リポストのメニューを開閉する。
     * **本体のリポストボタンと同じく「リポスト / 引用」の 2 つを出す。**
     * 外を押したら閉じる。Escape はライトボックスを閉じるため受けない
     * (メニューだけ閉じる挙動にすると、閉じたつもりが閉じない誤解を生む)
     * @param {HTMLElement} anchor 押されたボタン
     * @returns {void}
     */
    toggleRepostMenu(anchor) {
        try {
            if (this.menuEl) {
                this.closeRepostMenu();
                return;
            }
            if (!this.state) {
                return;
            }
            const config = EXT_CONFIG.postActions;
            const menu = document.createElement('div');
            menu.className = config.menuClass;
            menu.setAttribute('role', 'menu');
            const items = [
                {
                    label: this.state.reposted ? config.text.repostUndo : config.text.repostDo,
                    run: () => this.runAction('repost')
                },
                {
                    label: config.text.quote,
                    run: () => this.openComposerFor(config.composerModes.quote)
                }
            ];
            for (const item of items) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = config.menuItemClass;
                button.setAttribute('role', 'menuitem');
                button.textContent = item.label;
                button.addEventListener('click', () => {
                    this.closeRepostMenu();
                    item.run();
                });
                menu.appendChild(button);
            }
            // ボタンの真上に出す。行の左端からの位置で置く
            menu.style.left = `${anchor.offsetLeft}px`;
            menu.style.bottom = `${anchor.offsetHeight + 4}px`;
            anchor.parentElement.appendChild(menu);
            this.menuEl = menu;
            this.menuAnchor = anchor;
            anchor.setAttribute('aria-expanded', 'true');
            // 開いた押下自体で閉じないよう、次の周回から外側の押下を受ける
            this.onOutsideClick = (event) => {
                // ボタン自身の押下はここで無視する。**capture 段のため、この
                // リスナーはボタンの click より先に走る。** ここで閉じてしまうと
                // 続く click が「閉じている」と見て開き直し、実質トグルが
                // 死ぬ (押しても閉じられない)
                if (!this.menuEl
                    || this.menuEl.contains(event.target)
                    || anchor.contains(event.target)) {
                    return;
                }
                this.closeRepostMenu();
            };
            setTimeout(() => {
                document.addEventListener('click', this.onOutsideClick, true);
            }, 0);
        } catch (error) {
            console.error('[Bluesky拡張] リポストのメニューを開けませんでした', error);
        }
    }

    /**
     * リポストのメニューを閉じる。**登録と同じ関数参照でリスナーを外す。**
     * 既に閉じていれば何もしない
     * @returns {void}
     */
    closeRepostMenu() {
        try {
            if (this.onOutsideClick) {
                document.removeEventListener('click', this.onOutsideClick, true);
                this.onOutsideClick = null;
            }
            if (this.menuEl) {
                this.menuEl.remove();
                this.menuEl = null;
            }
            if (this.menuAnchor) {
                this.menuAnchor.setAttribute('aria-expanded', 'false');
                this.menuAnchor = null;
            }
        } catch (error) {
            console.error('[Bluesky拡張] リポストのメニューを閉じられませんでした', error);
        }
    }

    /**
     * 操作の失敗を 1 行で伝える。**alert は使わない**
     * (ライトボックスの操作が止まるため)。次の操作が成功したら消える
     * @returns {void}
     */
    showActionError() {
        try {
            if (!this.bodyEl) {
                return;
            }
            const config = EXT_CONFIG.postActions;
            let line = this.bodyEl.querySelector(`.${config.errorClass}`);
            if (!line) {
                line = document.createElement('p');
                line.className = config.errorClass;
                line.setAttribute('role', 'alert');
                this.bodyEl.appendChild(line);
            }
            line.textContent = config.text.failed;
        } catch (error) {
            console.error('[Bluesky拡張] 失敗の表示に失敗しました', error);
        }
    }

    /**
     * 「投稿を開く」ボタンを作る。
     * @param {PanelPost} post
     * @returns {HTMLElement}
     */
    buildOpenPost(post) {
        const config = this.config;
        const routes = EXT_CONFIG.mediaGrid.bridge.routes;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = config.openPostClass;
        button.appendChild(createIcon(document, 'openInNew'));
        const label = document.createElement('span');
        label.textContent = config.text.openPost;
        button.appendChild(label);
        button.addEventListener('click', () => this.leaveTo({
            route: routes.post,
            params: {name: post.handle, rkey: post.rkey}
        }));
        return button;
    }

    /**
     * ライトボックスを閉じてから SPA 遷移する。
     * 閉じるのに失敗しても遷移は試みる (本体が遷移で畳むため)。
     * @param {{route: string, params: Object}} target
     * @returns {Promise<void>}
     */
    async leaveTo(target) {
        const actions = EXT_CONFIG.mediaGrid.bridge.actions;
        try {
            await callBridge(actions.closeLightbox, {});
            await callBridge(actions.navigate, target);
        } catch (error) {
            console.error('[Bluesky拡張] パネルからの遷移に失敗しました', error);
        } finally {
            // callBridge は仕様上 reject しないが、finally にしておくことで
            // 「遷移に失敗したのに right が戻らない」経路を構造的に無くす
            this.teardown();
        }
    }
}

// tests から require するためだけの分岐。content script では module が未定義のため何もしない
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        parsePostUri,
        applyFacets,
        parsePostForPanel,
        formatPostDate,
        formatCount,
        shouldShowPanel,
        toSafeLinkHref,
        syncPostViewer,
        revertActionState
    };
}

// content script としての起動。Node のテストからは document が無いため実行されない
if (typeof document !== 'undefined') {
    try {
        const lightboxPanel = new LightboxPanel(EXT_CONFIG.lightboxPanel);
        lightboxPanel.init();
    } catch (error) {
        console.error('[Bluesky拡張] パネルの初期化に失敗しました', error);
    }
}
