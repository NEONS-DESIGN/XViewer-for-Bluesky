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
 * @param {{reply: number, repost: number, like: number, quote: number}} counts
 * @returns {ActionState}
 */
function readViewerState(viewer, counts) {
    const likeUri = (viewer && typeof viewer.like === 'string' && viewer.like)
        ? viewer.like
        : null;
    const repostUri = (viewer && typeof viewer.repost === 'string' && viewer.repost)
        ? viewer.repost
        : null;
    return {
        liked: likeUri !== null,
        likeUri,
        reposted: repostUri !== null,
        repostUri,
        bookmarked: !!(viewer && viewer.bookmarked === true),
        counts: {
            reply: counts.reply,
            repost: counts.repost,
            like: counts.like,
            quote: counts.quote
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

// tests から require するためだけの分岐。content script では module が未定義のため何もしない
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {parseRecordUri, readViewerState, toggleActionState};
}
