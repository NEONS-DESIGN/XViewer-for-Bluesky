/**
 * グリッドに並べる 1 投稿ぶんのメディア。
 * 1 投稿 = 1 エントリとし、先頭のメディアだけをタイルに表示する。
 * 複数枚の投稿は siblings 経由でライトボックスに全メディアを渡す。
 * @typedef {Object} MediaEntry
 * @property {string} key            重複排除キー (postId そのもの)
 * @property {string} postId         投稿の rkey
 * @property {string} postHref       /profile/<handle>/post/<rkey>
 * @property {string} authorHandle   投稿者のハンドル (SPA 遷移の bridge に渡す。postHref からの再抽出はしない)
 * @property {'image'|'video'} type  先頭メディアの種別
 * @property {string} thumbUrl       先頭メディアのサムネイル URL
 * @property {string|null} fullsizeUrl  先頭メディアの原寸 URL (動画は null)
 * @property {string} alt            先頭メディアの alt
 * @property {{width:number,height:number}|null} dimensions  先頭メディアの寸法
 * @property {number} mediaCount     その投稿の添付総数 (複数枚バッジの出し分けに使う)
 * @property {Object[]} siblings     同じ投稿の全メディア (ライトボックスに渡す形)
 * @property {string[]} labels       投稿と作者に付いたラベル値
 */

/**
 * embed から 0 件以上のメディアを取り出す。未知の形式は空配列。
 * config.excludeVideos が真なら動画を落とす。動画だけの投稿はこれで 0 件になり、
 * toMediaEntries がその投稿ごとグリッドから外す。
 * @param {Object|null} embed
 * @param {Object} config EXT_CONFIG.mediaGrid
 * @returns {Object[]} {type, thumbUrl, fullsizeUrl, alt, dimensions} の配列
 */
function extractMediaFromEmbed(embed, config) {
    const media = extractAllMediaFromEmbed(embed, config);
    if (!config || !config.excludeVideos) {
        return media;
    }
    // 種別での絞り込みは 1 箇所に集約する。embed の形式が増えても漏れないようにするため
    return media.filter((item) => item.type !== 'video');
}

/**
 * embed から 0 件以上のメディアを、種別で絞り込まずに取り出す。
 * 呼び出し側は extractMediaFromEmbed を使うこと。
 * @param {Object|null} embed
 * @param {Object} config EXT_CONFIG.mediaGrid
 * @returns {Object[]} {type, thumbUrl, fullsizeUrl, alt, dimensions} の配列
 */
function extractAllMediaFromEmbed(embed, config) {
    try {
        if (!embed || typeof embed !== 'object') {
            return [];
        }
        const types = config.api.embedTypes;
        const limit = config.maxMediaPerPost;

        if (embed.$type === types.images && Array.isArray(embed.images)) {
            return embed.images.map((item) => ({
                type: 'image',
                thumbUrl: item.thumb || null,
                fullsizeUrl: item.fullsize || null,
                alt: item.alt || '',
                dimensions: item.aspectRatio || null
            })).filter((m) => m.thumbUrl).slice(0, limit);
        }

        // gallery はサムネイルのキーが thumbnail である (images の thumb とは違う)
        if (embed.$type === types.gallery && Array.isArray(embed.items)) {
            return embed.items.map((item) => ({
                type: 'image',
                thumbUrl: item.thumbnail || null,
                fullsizeUrl: item.fullsize || null,
                alt: item.alt || '',
                dimensions: item.aspectRatio || null
            })).filter((m) => m.thumbUrl).slice(0, limit);
        }

        if (embed.$type === types.video) {
            if (!embed.thumbnail) {
                return [];
            }
            return [{
                type: 'video',
                thumbUrl: embed.thumbnail,
                fullsizeUrl: null,
                alt: embed.alt || '',
                dimensions: embed.aspectRatio || null
            }];
        }

        // 引用 + メディア。中の media を同じ手順で処理する
        // (絞り込みは呼び出し元の extractMediaFromEmbed が一括で行う)
        if (embed.$type === types.recordWithMedia) {
            return extractAllMediaFromEmbed(embed.media, config);
        }

        return [];
    } catch (error) {
        console.error('[Bluesky拡張] embed の解析に失敗しました', error);
        return [];
    }
}

/**
 * at:// URI から rkey を取り出す。
 * @param {string} uri
 * @returns {string|null}
 */
function extractRkey(uri) {
    if (typeof uri !== 'string') {
        return null;
    }
    const parts = uri.split('/');
    const rkey = parts[parts.length - 1];
    return rkey || null;
}

/**
 * 投稿と作者に付いたラベル値を集める。
 * @param {Object} post
 * @returns {string[]}
 */
function extractLabels(post) {
    const collect = (labels) => Array.isArray(labels)
        ? labels.map((l) => l && l.val).filter((v) => typeof v === 'string')
        : [];
    return [...new Set([...collect(post.labels), ...collect(post.author && post.author.labels)])];
}

/**
 * フィードの 1 要素を 0 件または 1 件の MediaEntry に変換する。
 * 1 投稿 = 1 エントリとし、先頭のメディアだけをタイル表示に使う。
 * @param {Object} feedItem
 * @param {Object} config EXT_CONFIG.mediaGrid
 * @returns {MediaEntry[]} 0 件または 1 件の配列 (呼び出し側の集約が扱いやすいよう配列で返す)
 */
function toMediaEntries(feedItem, config) {
    try {
        const post = feedItem && feedItem.post;
        if (!post) {
            return [];
        }
        const postId = extractRkey(post.uri);
        const handle = post.author && post.author.handle;
        if (!postId || !handle) {
            return [];
        }
        const media = extractMediaFromEmbed(post.embed, config);
        if (media.length === 0) {
            return [];
        }
        const labels = extractLabels(post);
        // ライトボックスに渡す配列。本体が受け付ける最小構成 (設計文書 2.4)
        const siblings = media.map((m) => ({
            type: m.type,
            uri: m.fullsizeUrl || m.thumbUrl,
            thumbUri: m.thumbUrl,
            alt: m.alt,
            dimensions: m.dimensions
        }));

        const head = media[0];
        return [{
            key: postId,
            postId,
            postHref: `/profile/${handle}/post/${postId}`,
            authorHandle: handle,
            type: head.type,
            thumbUrl: head.thumbUrl,
            fullsizeUrl: head.fullsizeUrl,
            alt: head.alt,
            dimensions: head.dimensions,
            mediaCount: media.length,
            siblings,
            labels
        }];
    } catch (error) {
        console.error('[Bluesky拡張] 投稿の変換に失敗しました', error);
        return [];
    }
}

/**
 * getAuthorFeed のレスポンスを解析する。
 * ok:false は「このアカウントのフィードは読めない」を意味し、呼び出し側は終端扱いにする。
 * @param {Object|null} json
 * @param {Object} config EXT_CONFIG.mediaGrid
 * @returns {{ok: boolean, entries: MediaEntry[], cursor: string|null}}
 */
function parseAuthorFeed(json, config) {
    try {
        if (!json || !Array.isArray(json.feed)) {
            return {ok: false, entries: [], cursor: null};
        }
        const entries = [];
        for (const item of json.feed) {
            entries.push(...toMediaEntries(item, config));
        }
        return {
            ok: true,
            entries,
            cursor: typeof json.cursor === 'string' ? json.cursor : null
        };
    } catch (error) {
        console.error('[Bluesky拡張] フィードの解析に失敗しました', error);
        return {ok: false, entries: [], cursor: null};
    }
}

/**
 * ぼかし表示にすべきメディアかを判定する。
 * public API はログイン中のラベル表示設定を反映しないため、自前で判定する。
 * @param {MediaEntry|null} entry
 * @param {Object} config EXT_CONFIG.mediaGrid
 * @returns {boolean}
 */
function shouldBlur(entry, config) {
    try {
        if (!entry || !Array.isArray(entry.labels)) {
            return false;
        }
        return entry.labels.some((label) => config.blurLabels.includes(label));
    } catch (error) {
        console.error('[Bluesky拡張] ラベル判定に失敗しました', error);
        return false;
    }
}

/**
 * MediaEntry を key で重複排除しつつ追加順に保持する。
 */
class MediaStore {
    constructor() {
        this.items = new Map();
        this.listeners = [];
    }

    /**
     * @param {MediaEntry} entry
     * @returns {boolean} 新規に格納したら true
     */
    add(entry) {
        if (!entry || !entry.key || this.items.has(entry.key)) {
            return false;
        }
        this.items.set(entry.key, entry);
        return true;
    }

    /** @returns {MediaEntry[]} 追加順の全件 */
    getAll() {
        return [...this.items.values()];
    }

    get size() {
        return this.items.size;
    }

    /**
     * 対象アカウントが変わったときだけ呼ぶ。
     * 呼び出し側 (UI の制御層) の責務。MediaFetcher からは強制されない。
     */
    clear() {
        this.items.clear();
    }

    subscribe(listener) {
        if (typeof listener === 'function' && !this.listeners.includes(listener)) {
            this.listeners.push(listener);
        }
    }

    unsubscribe(listener) {
        this.listeners = this.listeners.filter((l) => l !== listener);
    }

    /**
     * 1 ページぶんを入れ終えてから 1 回だけ呼ぶ。
     * リスナの配列は複製してから回し、各リスナの例外は握る。
     * @param {number} count 追加された件数
     */
    notify(count) {
        if (!count) {
            return;
        }
        for (const listener of this.listeners.slice()) {
            try {
                listener(count);
            } catch (error) {
                console.error('[Bluesky拡張] 追加通知のリスナが失敗しました', error);
            }
        }
    }
}

/**
 * public API からフィードを取得して MediaStore へ流し込む。
 */
class MediaFetcher {
    /**
     * @param {MediaStore} store
     * @param {Object} config EXT_CONFIG.mediaGrid
     * @param {Function} [fetchImpl] テストで差し替えるための fetch
     */
    constructor(store, config, fetchImpl) {
        this.store = store;
        this.config = config;
        this.fetchImpl = fetchImpl || ((...args) => globalThis.fetch(...args));
        this.actor = null;
        this.onBatchEnd = null;
        this.generation = 0;
        this.reset();
    }

    reset() {
        this.cursor = null;
        this.exhausted = false;
        this.failed = false;
        this.running = false;
        this.errorCount = 0;
        this.pageCount = 0;
        this.lastRunAt = 0;
        this.generation += 1;
    }

    /**
     * 対象アカウントを設定する。変わったときだけ状態を作り直す。
     * @param {string} actor ハンドルまたは DID
     */
    setActor(actor) {
        if (this.actor === actor) {
            return;
        }
        this.actor = actor;
        this.reset();
    }

    get cooldownRemainingMs() {
        return Math.max(0, this.config.api.cooldownMs - (Date.now() - this.lastRunAt));
    }

    /**
     * 失敗から復帰できるかを判定する。
     * 許可するときは副作用として failed を戻す。
     * @returns {boolean}
     */
    canRetry() {
        if (!this.failed) {
            return false;
        }
        if (Date.now() - this.lastRunAt < this.config.api.retryAfterMs) {
            return false;
        }
        this.failed = false;
        this.errorCount = 0;
        return true;
    }

    /**
     * 次の 1 ページを取得する。同時実行はしない。
     * @returns {Promise<void>}
     */
    async fetchNext() {
        if (this.running || this.exhausted || this.failed || !this.actor) {
            return;
        }
        if (this.cooldownRemainingMs > 0) {
            return;
        }
        this.running = true;
        this.lastRunAt = Date.now();
        const generation = this.generation;

        try {
            const api = this.config.api;
            const url = new URL(api.origin + api.feedPath);
            url.searchParams.set('actor', this.actor);
            url.searchParams.set('filter', api.filter);
            url.searchParams.set('limit', String(api.limit));
            if (this.cursor) {
                url.searchParams.set('cursor', this.cursor);
            }

            const response = await this.fetchImpl(url.toString(), {credentials: 'omit'});

            // 待っている間に対象が変わっていたら、この応答は丸ごと捨てる。
            // 蓄積にもカーソルにも入れず、失敗にも数えない
            if (generation !== this.generation) {
                return;
            }

            if (this.config.api.stopStatuses.includes(response.status)) {
                this.failed = true;
                return;
            }
            if (!response.ok) {
                this.countError();
                return;
            }

            const json = await response.json();
            if (generation !== this.generation) {
                return;
            }

            const parsed = parseAuthorFeed(json, this.config);
            if (!parsed.ok) {
                this.exhausted = true;
                return;
            }

            this.errorCount = 0;
            this.pageCount += 1;
            let added = 0;
            for (const entry of parsed.entries) {
                if (this.store.add(entry)) {
                    added += 1;
                }
            }
            this.store.notify(added);

            // 末尾判定の 3 条件
            if (!parsed.cursor || parsed.cursor === this.cursor || parsed.entries.length === 0) {
                this.exhausted = true;
            } else {
                this.cursor = parsed.cursor;
            }
        } catch (error) {
            if (generation === this.generation) {
                console.error('[Bluesky拡張] 取得に失敗しました', error);
                this.countError();
            }
        } finally {
            if (generation === this.generation) {
                this.running = false;
                if (typeof this.onBatchEnd === 'function') {
                    try {
                        this.onBatchEnd();
                    } catch (error) {
                        console.error('[Bluesky拡張] onBatchEnd が失敗しました', error);
                    }
                }
            }
        }
    }

    countError() {
        this.errorCount += 1;
        if (this.errorCount >= this.config.api.maxConsecutiveErrors) {
            this.failed = true;
        }
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {extractMediaFromEmbed, extractLabels, toMediaEntries, parseAuthorFeed, shouldBlur, MediaStore, MediaFetcher};
}
