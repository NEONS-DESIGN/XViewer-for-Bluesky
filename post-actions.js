/**
 * ライトボックスのパネルからの投稿操作。
 *
 * **この拡張機能で唯一の書き込み機能。** 認証は Bluesky 本体が React context に
 * 持つ agent.fetchHandler を橋渡し (call-xrpc) 経由で借りるだけで、
 * localStorage の accessJwt には触らない (SITE_SPEC.md 5.2)。
 *
 * **DOM を知らない。** 見た目は lightbox-panel.js が持つ。
 *
 * 依存: config.js (EXT_CONFIG) / bridge-client.js (callBridge)
 */

/**
 * 投稿への反応の状態。パネルが手元に持ち、押すたびに作り直す。
 * @typedef {Object} ActionState
 * @property {boolean} liked いいね済みか
 * @property {string|null} likeUri いいねレコードの AT URI。取り消しに要る
 * @property {boolean} reposted リポスト済みか
 * @property {string|null} repostUri リポストレコードの AT URI
 * @property {boolean} bookmarked ブックマーク済みか
 * @property {{reply: number, repost: number, like: number, quote: number}} counts
 */

/**
 * レコードの AT URI を分解する正規表現。
 * **コレクションを問わない。** lightbox-panel.js の PANEL_POST_URI_PATTERN は
 * app.bsky.feed.post に限定しているため、いいね・リポストのレコードには使えない
 */
const POST_ACTION_RECORD_URI_PATTERN = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/;

/**
 * レコードの AT URI を分解する。
 * @param {string} uri at://<did>/<collection>/<rkey>
 * @returns {{did: string, collection: string, rkey: string}|null} 形が違えば null
 */
function parseRecordUri(uri) {
    try {
        if (typeof uri !== 'string') {
            return null;
        }
        const matched = POST_ACTION_RECORD_URI_PATTERN.exec(uri);
        if (!matched) {
            return null;
        }
        return {did: matched[1], collection: matched[2], rkey: matched[3]};
    } catch (error) {
        console.error('[Bluesky拡張] レコード URI の解析に失敗しました', error);
        return null;
    }
}

/**
 * getPosts の viewer から反応の状態を読む。
 * **viewer は未認証の取得では付かない。** 無い場合はすべて未反応として扱う。
 * @param {Object|null|undefined} viewer post.viewer
 * @param {{reply: number, repost: number, like: number, quote: number}|null|undefined} counts
 * @returns {ActionState}
 */
function readViewerState(viewer, counts) {
    const likeUri = (viewer && typeof viewer.like === 'string' && viewer.like)
        ? viewer.like
        : null;
    const repostUri = (viewer && typeof viewer.repost === 'string' && viewer.repost)
        ? viewer.repost
        : null;
    const normalizedCounts = counts || {};
    return {
        liked: likeUri !== null,
        likeUri,
        reposted: repostUri !== null,
        repostUri,
        bookmarked: !!(viewer && viewer.bookmarked === true),
        counts: {
            reply: typeof normalizedCounts.reply === 'number' ? normalizedCounts.reply : 0,
            repost: typeof normalizedCounts.repost === 'number' ? normalizedCounts.repost : 0,
            like: typeof normalizedCounts.like === 'number' ? normalizedCounts.like : 0,
            quote: typeof normalizedCounts.quote === 'number' ? normalizedCounts.quote : 0
        }
    };
}

/**
 * 反応の状態を 1 つ切り替えた新しい状態を返す。
 *
 * **押した直後に描くための値であって、通信の結果ではない** (楽観的更新)。
 * 失敗したら呼び出し側が控えておいた元の状態へ戻す。そのため
 * **元の状態を書き換えない** (counts も作り直す)。
 * 付ける方向ではレコードの URI がまだ分からないため null のままにし、
 * createRecord の応答が返ってから呼び出し側が埋める。
 * @param {ActionState} state 今の状態
 * @param {'like'|'repost'|'bookmark'} kind 切り替える種別
 * @returns {ActionState} 新しい状態。知らない種別なら中身の同じものを返す
 */
function toggleActionState(state, kind) {
    const next = {
        liked: state.liked,
        likeUri: state.likeUri,
        reposted: state.reposted,
        repostUri: state.repostUri,
        bookmarked: state.bookmarked,
        counts: {
            reply: state.counts.reply,
            repost: state.counts.repost,
            like: state.counts.like,
            quote: state.counts.quote
        }
    };
    if (kind === 'like') {
        next.liked = !state.liked;
        next.likeUri = null;
        next.counts.like = Math.max(0, state.counts.like + (next.liked ? 1 : -1));
        return next;
    }
    if (kind === 'repost') {
        next.reposted = !state.reposted;
        next.repostUri = null;
        next.counts.repost = Math.max(0, state.counts.repost + (next.reposted ? 1 : -1));
        return next;
    }
    if (kind === 'bookmark') {
        next.bookmarked = !state.bookmarked;
        return next;
    }
    return next;
}

/**
 * 投稿操作の呼び出し層。橋渡し (call-xrpc / open-composer / get-session) を
 * 意味のある単位に包む。**DOM を知らない。**
 *
 * どのメソッドも例外を投げない。失敗は {ok: false, reason} に潰す
 * (クラッシュより非表示を優先する方針)。
 */
class PostActions {
    /**
     * @param {Object} config EXT_CONFIG.postActions
     */
    constructor(config) {
        this.config = config;
        /**
         * ログイン中の DID。**1 回引いたら覚える。**
         * アカウントを切り替えるとページが作り直されるため、
         * ここで古い値を持ち続ける経路は無い
         * @type {string|null}
         */
        this.sessionDid = null;
        /** @type {boolean} 一度でも get-session を試したか */
        this.sessionAsked = false;
    }

    /**
     * ログイン中の DID を返す。
     * @returns {Promise<string|null>} 未ログイン・橋渡し失敗なら null
     */
    async getSessionDid() {
        if (this.sessionAsked) {
            return this.sessionDid;
        }
        const actions = EXT_CONFIG.mediaGrid.bridge.actions;
        const result = await callBridge(actions.getSession, {});
        this.sessionAsked = true;
        this.sessionDid = (result && result.ok && typeof result.did === 'string')
            ? result.did
            : null;
        return this.sessionDid;
    }

    /**
     * 橋渡し経由で XRPC を 1 回呼ぶ。
     * @param {string} nsid EXT_CONFIG.postActions.nsid のいずれか
     * @param {Object} options {params, body}
     * @returns {Promise<{ok: boolean, json: Object|null, reason: string|null}>}
     */
    async call(nsid, options) {
        const actions = EXT_CONFIG.mediaGrid.bridge.actions;
        const result = await callBridge(actions.callXrpc, {
            nsid,
            params: options && options.params,
            body: options && options.body
        });
        if (!result || !result.ok) {
            ExtDebug.log('投稿操作の呼び出しが失敗', {
                nsid,
                理由: (result && result.reason) || '応答なし'
            });
            return {ok: false, json: null, reason: (result && result.reason) || 'no-result'};
        }
        return {ok: true, json: result.json || null, reason: null};
    }

    /**
     * 認証付きで投稿を 1 件引く。**viewer を得るのが目的。**
     * @param {string} postUri
     * @returns {Promise<Object|null>} getPosts のレスポンス。失敗なら null
     */
    async fetchPost(postUri) {
        const result = await this.call(this.config.nsid.getPosts, {
            params: {uris: [postUri]}
        });
        return result.ok ? result.json : null;
    }

    /**
     * レコードを 1 件作る。
     * @param {string} collection app.bsky.feed.like など
     * @param {string} uri 対象の投稿の AT URI
     * @param {string} cid 対象の投稿の CID
     * @returns {Promise<{ok: boolean, recordUri: string|null, reason: string|null}>}
     */
    async createRecord(collection, uri, cid) {
        const did = await this.getSessionDid();
        if (!did) {
            return {ok: false, recordUri: null, reason: 'no-session'};
        }
        const result = await this.call(this.config.nsid.createRecord, {
            body: {
                repo: did,
                collection,
                record: {
                    subject: {uri, cid},
                    createdAt: new Date().toISOString()
                }
            }
        });
        if (!result.ok) {
            return {ok: false, recordUri: null, reason: result.reason};
        }
        const recordUri = (result.json && typeof result.json.uri === 'string')
            ? result.json.uri
            : null;
        return {ok: true, recordUri, reason: null};
    }

    /**
     * レコードを 1 件消す。
     * **`rkey` は消す相手のレコードの AT URI から取る** (投稿の URI ではない)。
     * @param {string} recordUri いいね・リポストのレコードの AT URI
     * @returns {Promise<{ok: boolean, reason: string|null}>}
     */
    async deleteRecord(recordUri) {
        const parsed = parseRecordUri(recordUri);
        if (!parsed) {
            return {ok: false, reason: 'invalid-record-uri'};
        }
        const did = await this.getSessionDid();
        if (!did) {
            return {ok: false, reason: 'no-session'};
        }
        const result = await this.call(this.config.nsid.deleteRecord, {
            body: {repo: did, collection: parsed.collection, rkey: parsed.rkey}
        });
        return {ok: result.ok, reason: result.reason};
    }

    /**
     * いいねを付ける。
     * @param {string} uri 投稿の AT URI
     * @param {string} cid 投稿の CID
     * @returns {Promise<{ok: boolean, recordUri: string|null, reason: string|null}>}
     */
    createLike(uri, cid) {
        return this.createRecord(this.config.collections.like, uri, cid);
    }

    /**
     * いいねを外す。
     * @param {string} recordUri いいねレコードの AT URI
     * @returns {Promise<{ok: boolean, reason: string|null}>}
     */
    deleteLike(recordUri) {
        return this.deleteRecord(recordUri);
    }

    /**
     * リポストする。
     * @param {string} uri 投稿の AT URI
     * @param {string} cid 投稿の CID
     * @returns {Promise<{ok: boolean, recordUri: string|null, reason: string|null}>}
     */
    createRepost(uri, cid) {
        return this.createRecord(this.config.collections.repost, uri, cid);
    }

    /**
     * リポストを取り消す。
     * @param {string} recordUri リポストレコードの AT URI
     * @returns {Promise<{ok: boolean, reason: string|null}>}
     */
    deleteRepost(recordUri) {
        return this.deleteRecord(recordUri);
    }

    /**
     * ブックマークに追加する。
     * **レコードではなく appview の procedure。** 入力は {uri, cid} (lexicon で確認)
     * @param {string} uri 投稿の AT URI
     * @param {string} cid 投稿の CID
     * @returns {Promise<{ok: boolean, reason: string|null}>}
     */
    async createBookmark(uri, cid) {
        const result = await this.call(this.config.nsid.createBookmark, {
            body: {uri, cid}
        });
        return {ok: result.ok, reason: result.reason};
    }

    /**
     * ブックマークから外す。入力は {uri} だけ (lexicon で確認)。
     * @param {string} uri 投稿の AT URI
     * @returns {Promise<{ok: boolean, reason: string|null}>}
     */
    async deleteBookmark(uri) {
        const result = await this.call(this.config.nsid.deleteBookmark, {
            body: {uri}
        });
        return {ok: result.ok, reason: result.reason};
    }

    /**
     * 本体の投稿作成モーダルを返信・引用モードで開く。
     * **ライトボックスは閉じない** (2026-09-09 実測で、同時に開けることを確認)。
     * @param {'reply'|'quote'} mode
     * @param {{uri: string, cid: string, text: string, author: Object}} post
     * @returns {Promise<{ok: boolean, reason: string|null}>}
     */
    async openComposer(mode, post) {
        const actions = EXT_CONFIG.mediaGrid.bridge.actions;
        const result = await callBridge(actions.openComposer, {mode, post});
        if (!result || !result.ok) {
            ExtDebug.log('投稿作成モーダルを開けなかった', {
                mode,
                理由: (result && result.reason) || '応答なし'
            });
            return {ok: false, reason: (result && result.reason) || 'no-result'};
        }
        return {ok: true, reason: null};
    }
}

// tests から require するためだけの分岐。content script では module が未定義のため何もしない
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {parseRecordUri, readViewerState, toggleActionState};
}
