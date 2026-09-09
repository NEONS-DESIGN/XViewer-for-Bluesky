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
                config.collapsedStorageKey
            ]);
            this.enabled = stored[config.storageKey] ?? config.defaultEnabled;
            this.collapsed = stored[config.collapsedStorageKey] ?? config.defaultCollapsed;
        } catch (error) {
            console.error('[Bluesky拡張] パネルの設定の読み込みに失敗しました', error);
        }
        try {
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area !== 'sync' || !changes[config.storageKey]) {
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
        // 飛行中の取得の応答を捨てる
        this.generation += 1;
        this.releaseShrink();
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
            const config = this.config;
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

            this.bodyEl.appendChild(this.buildCounts(post));
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
        toSafeLinkHref
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
