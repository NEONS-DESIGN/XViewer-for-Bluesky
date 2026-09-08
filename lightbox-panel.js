/**
 * ライトボックスに重ねる投稿情報パネル。
 * 画像を開いたとき、右側に本文・投稿日時・作者・反応数を並べる。
 *
 * **メディアグリッド由来かどうかを知らない。** 開いているライトボックスの
 * activeLightbox.metricsContext.postUri を橋渡し (get-lightbox) で読み、
 * 公開 API の getPosts で投稿を引くだけ。グリッド側は openLightbox に
 * 本体と同じ metricsContext を添えるため、経路が 1 本で済む。
 *
 * 依存: config.js (EXT_CONFIG) / debug.js (ExtDebug) /
 *       bridge-client.js (callBridge) / icons.js (createIcon) /
 *       content.js (subscribeLightboxVisibility, isLightboxVisible)
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
        return new Intl.DateTimeFormat(config.locale, {
            dateStyle: 'long',
            timeStyle: 'short'
        }).format(date);
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

// tests から require するためだけの分岐。content script では module が未定義のため何もしない
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        parsePostUri,
        applyFacets,
        parsePostForPanel,
        formatPostDate,
        formatCount,
        shouldShowPanel
    };
}
