/**
 * ライトボックスのパネルの返信欄で使う純関数。
 * 書記素の数え方・本文からの facets の検出・返信の record の組み立て・
 * getPostThread の応答の整形を持つ。**DOM も通信も config も知らない。**
 * 値 (上限など) は引数で受け取る。
 */
import {extractLabels} from './media-source.js';

/**
 * 投稿への参照 (com.atproto.repo.strongRef)。
 * @typedef {Object} StrongRef
 * @property {string} uri AT URI
 * @property {string} cid
 */

/**
 * 返信の参照 (app.bsky.feed.post#replyRef)。
 * @typedef {Object} ReplyRef
 * @property {StrongRef} root スレッドの先頭の投稿
 * @property {StrongRef} parent 直接の返信先
 */

/**
 * 返信欄に描く 1 件。
 * @typedef {Object} ReplyItem
 * @property {string} uri AT URI
 * @property {string} cid
 * @property {string} rkey 投稿ページへの遷移と削除に使う
 * @property {string} authorDid
 * @property {string} handle
 * @property {string} displayName 無ければ handle
 * @property {string|null} avatarUrl
 * @property {string} text 本文 (生のまま)
 * @property {Array<Object>} facets record.facets (無ければ空配列)
 * @property {string} createdAt record.createdAt。無ければ indexedAt
 * @property {number} replyCount
 * @property {boolean} hasEmbed 画像・リンクカードなどの添付を持つか
 * @property {Object|null} embed post.embed (画像の取り出しは描く側が行う)
 * @property {string[]} labels 投稿と作者に付いたラベル値
 * @property {ReplyRef|null} replyRef record.reply。この返信へ返信するとき root を引き継ぐのに使う
 * @property {string|null} parentUri 直接の返信先の AT URI
 * @property {string|null} parentHandle 開いた返信の中で、親が起点でないときの親の handle
 * @property {string[]|null} langs record.langs (返信への返信の言語の提案に使う)
 * @property {Object|null} [node] 取得した threadViewPost そのもの (返信の画像から開き直すとき、
 *   パネルに PostView と返信の一覧を渡して引き直しを省く)。自分で送った返信には無い
 */

/** getPostThread の中で、中身のある投稿を表す $type */
const THREAD_VIEW_POST_TYPE = 'app.bsky.feed.defs#threadViewPost';

/** 投稿の AT URI から rkey を取り出す */
const POST_URI_PATTERN = /^at:\/\/[^/]+\/app\.bsky\.feed\.post\/([^/]+)$/;

/** facets の feature の $type */
const FACET_TYPES = Object.freeze({
	link: 'app.bsky.richtext.facet#link',
	mention: 'app.bsky.richtext.facet#mention',
	tag: 'app.bsky.richtext.facet#tag'
});

/**
 * リンクの候補。行頭・空白・開き括弧の後に始まる http(s) の語。
 * 1 番目の括弧は手前の区切り、2 番目がリンクの本体
 */
const LINK_PATTERN = /(^|[\s(（「])(https?:\/\/[^\s]+)/gu;

/** リンクの末尾から落とす句読点 (文の終わりに付いた記号をリンクに含めない) */
const LINK_TRAILING_PATTERN = /[.,;:!?、。！？」』）]+$/u;

/** ハッシュタグの候補。行頭か空白の後の # と、空白・# 以外の連なり */
const TAG_PATTERN = /(^|\s)#([^\s#]+)/gu;

/** タグの末尾から落とす句読点 */
const TAG_TRAILING_PATTERN = /[.,;:!?、。！？」』）)]+$/u;

/** 数字だけのタグ (#123) はタグにしない (本体と同じ扱い) */
const DIGITS_ONLY_PATTERN = /^[0-9０-９]+$/u;

/** タグの長さの上限 (書記素)。app.bsky.richtext.facet#tag の maxGraphemes */
const TAG_MAX_GRAPHEMES = 64;

/** メンションの候補。行頭・空白・開き括弧の後の @ と、ハンドルに使える文字の連なり */
const MENTION_PATTERN = /(^|[\s(（「])@([a-zA-Z0-9.-]+)/gu;

/** ハンドル (ドメイン形) として正しいか */
const HANDLE_PATTERN = /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

/** 書記素の区切り器。Intl.Segmenter が無い環境では null */
const graphemeSegmenter = (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function')
	? new Intl.Segmenter(undefined, {granularity: 'grapheme'})
	: null;

/** 入力欄の高さを上限と比べるときに、丸めの誤差として見逃す差 (px) */
const FIT_ROUNDING_PX = 1;

/** UTF-8 への変換器 (facets の位置と上限はバイトで数える) */
const utf8Encoder = new TextEncoder();

/**
 * 文字列の UTF-8 のバイト数。
 * @param {string} text
 * @returns {number}
 */
export function utf8Length(text) {
	return utf8Encoder.encode(text).length;
}

/**
 * 書記素 (見た目の 1 文字) の数を数える。Bluesky の文字数の上限はこの単位。
 * @param {string} text
 * @returns {number}
 */
export function countGraphemes(text) {
	if (typeof text !== 'string' || text === '') {
		return 0;
	}
	if (!graphemeSegmenter) {
		return Array.from(text).length;
	}
	let count = 0;
	for (const unused of graphemeSegmenter.segment(text)) {
		count += 1;
	}
	return count;
}

/**
 * 書記素 (見た目の 1 文字) で上限まで切る。
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function truncateGraphemes(text, max) {
	if (countGraphemes(text) <= max) {
		return text;
	}
	const units = graphemeSegmenter
		? Array.from(graphemeSegmenter.segment(text), (part) => part.segment)
		: Array.from(text);
	return units.slice(0, max).join('');
}

/**
 * 文字列中の範囲を UTF-8 のバイト位置に直す。
 * @param {string} text 本文
 * @param {number} start UTF-16 の開始位置
 * @param {string} value 範囲の文字列
 * @returns {{byteStart: number, byteEnd: number}}
 */
function toByteRange(text, start, value) {
	const byteStart = utf8Length(text.slice(0, start));
	return {byteStart, byteEnd: byteStart + utf8Length(value)};
}

/**
 * 本文からリンク・ハッシュタグ・メンションを拾う。位置は UTF-8 のバイト。
 * メンションは DID に引く前のハンドルのまま返す (引くのは呼び出し側)。
 * @param {string} text
 * @returns {{links: Array<{byteStart: number, byteEnd: number, uri: string}>,
 *   tags: Array<{byteStart: number, byteEnd: number, tag: string}>,
 *   mentions: Array<{byteStart: number, byteEnd: number, handle: string}>}}
 */
export function detectRichText(text) {
	const result = {links: [], tags: [], mentions: []};
	if (typeof text !== 'string' || text === '') {
		return result;
	}
	for (const match of text.matchAll(LINK_PATTERN)) {
		const uri = match[2].replace(LINK_TRAILING_PATTERN, '').replace(/\)+$/, (closing) => {
			// 括弧を含む URL (Wikipedia など) は、開きと同じ数の閉じだけ残す
			const opens = (match[2].match(/\(/g) || []).length;
			return closing.slice(0, opens);
		});
		if (uri.length <= 'https://'.length) {
			continue;
		}
		const start = match.index + match[1].length;
		result.links.push(Object.assign(toByteRange(text, start, uri), {uri}));
	}
	for (const match of text.matchAll(TAG_PATTERN)) {
		const tag = match[2].replace(TAG_TRAILING_PATTERN, '');
		if (!tag || DIGITS_ONLY_PATTERN.test(tag) || countGraphemes(tag) > TAG_MAX_GRAPHEMES) {
			continue;
		}
		const start = match.index + match[1].length;
		result.tags.push(Object.assign(toByteRange(text, start, `#${tag}`), {tag}));
	}
	for (const match of text.matchAll(MENTION_PATTERN)) {
		const handle = match[2].replace(/[.-]+$/, '');
		if (!HANDLE_PATTERN.test(handle)) {
			continue;
		}
		const start = match.index + match[1].length;
		result.mentions.push(Object.assign(toByteRange(text, start, `@${handle}`), {handle}));
	}
	return result;
}

/**
 * 検出結果から record.facets を作る。DID を引けなかったメンションは含めない
 * (素の文字のまま送る)。並びは byteStart の昇順。
 * @param {ReturnType<typeof detectRichText>} detected
 * @param {Map<string, string>} didByHandle ハンドル -> DID
 * @returns {Array<Object>}
 */
export function buildFacets(detected, didByHandle) {
	const facets = [];
	const index = (item) => ({byteStart: item.byteStart, byteEnd: item.byteEnd});
	for (const link of detected.links) {
		facets.push({index: index(link), features: [{$type: FACET_TYPES.link, uri: link.uri}]});
	}
	for (const tag of detected.tags) {
		facets.push({index: index(tag), features: [{$type: FACET_TYPES.tag, tag: tag.tag}]});
	}
	for (const mention of detected.mentions) {
		const did = didByHandle && didByHandle.get(mention.handle);
		if (typeof did === 'string' && did) {
			facets.push({index: index(mention), features: [{$type: FACET_TYPES.mention, did}]});
		}
	}
	return facets.sort((a, b) => a.index.byteStart - b.index.byteStart);
}

/**
 * 返信先から record.reply を決める。
 * **返信先そのものが返信なら、その root を引き継ぐ。** 引き継がずに返信先を
 * root にすると、Bluesky 上でスレッドが割れる (画像の投稿が返信であることがある)
 * @param {{uri: string, cid: string, replyRef: ReplyRef|null}} target 返信先
 * @returns {ReplyRef}
 */
export function resolveReplyRef(target) {
	const parent = {uri: target.uri, cid: target.cid};
	const inherited = target.replyRef && target.replyRef.root;
	const root = inherited && typeof inherited.uri === 'string' && typeof inherited.cid === 'string'
		? {uri: inherited.uri, cid: inherited.cid}
		: parent;
	return {root, parent};
}

/**
 * 返信の record (app.bsky.feed.post) を組み立てる。
 * 空の facets と langs: null、null の embed と labels はキーごと出さない。
 * @param {{text: string, reply: ReplyRef, createdAt: string,
 *   langs: string[]|null, facets: Array<Object>,
 *   embed?: Object|null, labels?: Object|null}} input
 * @returns {Object}
 */
export function buildReplyRecord(input) {
	const record = {
		$type: 'app.bsky.feed.post',
		text: input.text,
		createdAt: input.createdAt,
		reply: input.reply
	};
	if (Array.isArray(input.langs) && input.langs.length > 0) {
		record.langs = input.langs;
	}
	if (Array.isArray(input.facets) && input.facets.length > 0) {
		record.facets = input.facets;
	}
	if (input.embed) {
		record.embed = input.embed;
	}
	if (input.labels) {
		record.labels = input.labels;
	}
	return record;
}

/**
 * 言語タグの主タグを返す ('ja-JP' -> 'ja')。返信の langs に使う。
 * @param {string|undefined} tag navigator.language など
 * @returns {string|null}
 */
export function primaryLanguage(tag) {
	if (typeof tag !== 'string' || !tag) {
		return null;
	}
	const primary = tag.split('-')[0].toLowerCase();
	return /^[a-z]{2,3}$/.test(primary) ? primary : null;
}

/**
 * getPostThread のノード 1 つを返信欄の 1 件に直す。
 * @param {Object} node threadViewPost
 * @returns {ReplyItem|null} 中身の無い投稿 (見つからない・ブロック) は null
 */
function toReplyItem(node) {
	try {
		if (!node || node.$type !== THREAD_VIEW_POST_TYPE || !node.post) {
			return null;
		}
		const post = node.post;
		const matched = typeof post.uri === 'string' ? POST_URI_PATTERN.exec(post.uri) : null;
		const author = post.author || {};
		if (!matched || typeof post.cid !== 'string' || typeof author.did !== 'string') {
			return null;
		}
		const record = post.record || {};
		const handle = typeof author.handle === 'string' ? author.handle : author.did;
		const reply = record.reply && typeof record.reply === 'object' ? record.reply : null;
		return {
			uri: post.uri,
			cid: post.cid,
			rkey: matched[1],
			authorDid: author.did,
			handle,
			displayName: typeof author.displayName === 'string' && author.displayName
				? author.displayName
				: handle,
			avatarUrl: typeof author.avatar === 'string' ? author.avatar : null,
			text: typeof record.text === 'string' ? record.text : '',
			facets: Array.isArray(record.facets) ? record.facets : [],
			createdAt: typeof record.createdAt === 'string' && record.createdAt
				? record.createdAt
				: (typeof post.indexedAt === 'string' ? post.indexedAt : ''),
			replyCount: typeof post.replyCount === 'number' ? post.replyCount : 0,
			hasEmbed: !!post.embed,
			embed: post.embed && typeof post.embed === 'object' ? post.embed : null,
			labels: extractLabels(post),
			langs: Array.isArray(record.langs)
				? record.langs.filter((lang) => typeof lang === 'string')
				: null,
			replyRef: reply,
			parentUri: reply && reply.parent && typeof reply.parent.uri === 'string'
				? reply.parent.uri
				: null,
			parentHandle: null,
			node
		};
	} catch (error) {
		return null;
	}
}

/**
 * getPostThread の応答から、起点の投稿の PostView を取り出す。
 * @param {Object|null} json getPostThread の応答
 * @returns {Object|null} 起点が中身のある投稿でなければ (見つからない・ブロック) null
 */
export function threadPostView(json) {
	const thread = json && json.thread;
	return thread && thread.$type === THREAD_VIEW_POST_TYPE && thread.post && typeof thread.post === 'object'
		? thread.post
		: null;
}

/**
 * 返信の行のノードから、その返信を起点にした getPostThread の応答の形を作る。
 * 直接の返信が揃っている (replies を持つ、または返信が 0 件) ときだけ作る。
 * 深さの上限に届いたノードは replies を持たないため、作らずに引き直させる
 * @param {Object|null} node threadViewPost
 * @returns {Object|null} {thread} の形。揃っていなければ null
 */
export function threadFromNode(node) {
	if (!node || node.$type !== THREAD_VIEW_POST_TYPE || !node.post) {
		return null;
	}
	if (Array.isArray(node.replies)) {
		return {thread: node};
	}
	return node.post.replyCount === 0 ? {thread: {...node, replies: []}} : null;
}

/**
 * getPostThread の応答から、起点の投稿への直接の返信 (1 段目) を取り出す。
 * @param {Object|null} json getPostThread の応答
 * @returns {ReplyItem[]} 並びはサーバのまま
 */
export function parseThreadReplies(json) {
	const thread = json && json.thread;
	if (!thread || thread.$type !== THREAD_VIEW_POST_TYPE || !Array.isArray(thread.replies)) {
		return [];
	}
	return thread.replies.map(toReplyItem).filter((item) => item !== null);
}

/**
 * 日時の文字列を比べるための数値にする。読めなければ 0。
 * @param {string} iso
 * @returns {number}
 */
function toTime(iso) {
	const time = Date.parse(iso);
	return Number.isNaN(time) ? 0 : time;
}

/**
 * 開いた返信 (起点) の下の部分木を、古い順の 1 列に平らにする。
 * 起点自身は含めない。親が起点でない返信には親の handle を付ける
 * (「返信先 @handle」の表示に使う)
 * @param {Object|null} json 起点を uri にした getPostThread の応答
 * @param {string} anchorUri 起点の AT URI
 * @returns {ReplyItem[]}
 */
export function flattenThreadBranch(json, anchorUri) {
	const thread = json && json.thread;
	if (!thread || thread.$type !== THREAD_VIEW_POST_TYPE) {
		return [];
	}
	const items = [];
	const walk = (node, parentItem) => {
		const replies = node && Array.isArray(node.replies) ? node.replies : [];
		for (const child of replies) {
			const item = toReplyItem(child);
			if (!item) {
				continue;
			}
			item.parentHandle = parentItem && parentItem.uri !== anchorUri
				? parentItem.handle
				: null;
			items.push(item);
			walk(child, item);
		}
	};
	walk(thread, toReplyItem(thread));
	return items.sort((a, b) => toTime(a.createdAt) - toTime(b.createdAt));
}

/**
 * 新しい順に並べた新しい配列を返す。元の配列は変えない。
 * @param {ReplyItem[]} items
 * @returns {ReplyItem[]}
 */
export function sortNewestFirst(items) {
	return items.slice().sort((a, b) => toTime(b.createdAt) - toTime(a.createdAt));
}

/**
 * 2 桁に 0 で埋める。
 * @param {number} value
 * @returns {string}
 */
function pad2(value) {
	return String(value).padStart(2, '0');
}

/**
 * 返信の日時を 'YYYY-MM-DD HH:mm' (ローカル時刻) にする。
 * @param {string} iso
 * @returns {string} 読めなければ空文字
 */
export function formatReplyDate(iso) {
	if (typeof iso !== 'string' || !iso) {
		return '';
	}
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return '';
	}
	return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
		+ ` ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/**
 * 投稿した返信を、表示中の範囲の末尾に入れた新しい配列を返す。
 * 末尾 (items の最後) に足すと、まだ描いていない返信が多いときに
 * 「もっと見る」の奥に隠れ、投稿が失敗したように見えて送り直しを招く
 * @param {Array<Object>} items 元の配列 (変えない)
 * @param {number} shown 表示中の件数
 * @param {Object} item 入れる返信
 * @returns {{items: Array<Object>, shown: number}}
 */
export function insertVisible(items, shown, item) {
	const index = Math.max(0, Math.min(shown, items.length));
	const next = items.slice();
	next.splice(index, 0, item);
	return {items: next, shown: index + 1};
}

/**
 * 入力欄の高さと、スクロールバーを出すかを決める。
 * scrollHeight は枠線を含まないため、box-sizing: border-box の欄にそのまま当てると
 * 枠線の分だけ中身がはみ出し、1 行でもスクロールバーが出る (2026-10-18 実機で確認)。
 * 上限 (10 行) に届くまでは隠し、超えたら上限で止めて欄の中で送る
 * @param {number} scrollHeight 中身の高さ (枠線を除く)
 * @param {number} borderHeight 上下の枠線の合計
 * @param {number} maxHeight 上限 (computed の max-height)。読めなければ NaN
 * @returns {{height: number, scroll: boolean}}
 */
export function fitTextareaHeight(scrollHeight, borderHeight, maxHeight) {
	const wanted = scrollHeight + borderHeight;
	if (!Number.isFinite(maxHeight)) {
		return {height: wanted, scroll: false};
	}
	// 上限は 10lh から計算した小数になり、scrollHeight は整数に丸められるため、
	// ちょうど 10 行でも 1px 未満だけ上回ることがある。その差は超えたとみなさない
	if (wanted < maxHeight + FIT_ROUNDING_PX) {
		return {height: Math.min(wanted, maxHeight), scroll: false};
	}
	return {height: maxHeight, scroll: true};
}

/**
 * 1 枚だけの画像の枠の縦横比 (幅 / 高さ) を、範囲に収めて返す。
 * 寸法が読めなければ正方形にする。
 * @param {{width: number, height: number}|null} dimensions aspectRatio
 * @param {{min: number, max: number}} range
 * @returns {number}
 */
export function mediaAspectRatio(dimensions, range) {
	const width = dimensions && dimensions.width;
	const height = dimensions && dimensions.height;
	if (!(width > 0) || !(height > 0)) {
		return 1;
	}
	return Math.min(range.max, Math.max(range.min, width / height));
}
