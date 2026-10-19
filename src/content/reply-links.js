/**
 * 返信欄のリンクの扱いの純関数。保存する本文でのリンクの短縮と、
 * 本文から読み取るカード・引用の提案の規則を持つ。DOM と設定には触れない。
 */

import {truncateGraphemes} from './reply-text.js';

const LINK_FEATURE_TYPE = 'app.bsky.richtext.facet#link';

/** URL の続きになる文字。直後にあれば、その出現は別の長い URL の一部とみなす */
const URL_CONTINUATION = /[A-Za-z0-9\/?#&=%@~+_-]/;

/** 本文を UTF-8 のバイト列にする変換器 */
const utf8Encoder = new TextEncoder();

/** バイト列を本文に戻す変換器。先頭の U+FEFF を BOM として捨てると、以後の facet がすべて 3 バイトずれる */
const utf8Decoder = new TextDecoder('utf-8', {ignoreBOM: true});

/**
 * @typedef {Object} ShortenRule
 * @property {number} maxRestChars ホストより後ろがこの長さを超えたら切る
 * @property {number} keepChars 切るときに残す先頭の文字数
 */

/**
 * @typedef {Object} CardRule
 * @property {string[]} excludedHosts カードにしないホスト
 * @property {string[]} imageExtensions カードにしない画像の拡張子 (小文字、ドット無し)
 */

/**
 * URL を文字列から読む。http(s) 以外と読めないものは null。
 * @param {string} uri
 * @returns {URL|null}
 */
function parseHttpUrl(uri) {
	try {
		const url = new URL(uri);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			return null;
		}
		return url;
	} catch (_e) {
		return null;
	}
}

/**
 * 本文に残す短い表記にする。スキームを除き、ホストより後ろ (先頭の / も数える) が長ければ、先頭を残して「...」で切る。
 * @param {string} uri
 * @param {ShortenRule} rule
 * @returns {string} URL として読めなければ入力のまま
 */
export function toShortUrl(uri, rule) {
	const url = parseHttpUrl(uri);
	if (!url) {
		return uri;
	}
	const path = (url.pathname === '/' ? '' : url.pathname) + url.search + url.hash;
	if (path.length > rule.maxRestChars) {
		return url.host + path.slice(0, rule.keepChars) + '...';
	}
	return url.host + path;
}

/**
 * link の facet の範囲を短い表記に置き換え、以後の facet のバイト位置をずらす。
 * 置き換える link の範囲と重なる facet (URL の中のメンションなど) は、短縮後に別の文字を指すため落とす。
 * @param {string} text
 * @param {Object[]} facets 各要素は {index: {byteStart, byteEnd}, features: Object[]}
 * @param {ShortenRule} rule
 * @returns {{text: string, facets: Object[]}} 入力は変更しない。link の uri は変えない。link が無ければ入力のまま
 */
export function shortenLinks(text, facets, rule) {
	try {
		const ordered = [...facets].sort((a, b) => a.index.byteStart - b.index.byteStart);
		const replaced = new Set();
		let scan = 0;
		for (const facet of ordered) {
			const isLink = facet.features.some((f) => f.$type === LINK_FEATURE_TYPE);
			if (isLink && facet.index.byteStart >= scan) {
				replaced.add(facet);
				scan = facet.index.byteEnd;
			}
		}
		if (replaced.size === 0) {
			return {text, facets};
		}
		const overlapsReplaced = (facet) => [...replaced].some((r) => r !== facet
			&& facet.index.byteStart < r.index.byteEnd && facet.index.byteEnd > r.index.byteStart);
		const source = utf8Encoder.encode(text);
		const chunks = [];
		const result = [];
		let cursor = 0;
		let delta = 0;
		for (const facet of ordered) {
			const {byteStart, byteEnd} = facet.index;
			const link = facet.features.find((f) => f.$type === LINK_FEATURE_TYPE);
			if (replaced.has(facet)) {
				const replacement = utf8Encoder.encode(toShortUrl(link.uri, rule));
				chunks.push(source.slice(cursor, byteStart), replacement);
				cursor = byteEnd;
				result.push({
					...facet,
					index: {byteStart: byteStart + delta, byteEnd: byteStart + delta + replacement.length},
				});
				delta += replacement.length - (byteEnd - byteStart);
			} else if (!overlapsReplaced(facet)) {
				result.push({
					...facet,
					index: {byteStart: byteStart + delta, byteEnd: byteEnd + delta},
				});
			}
		}
		chunks.push(source.slice(cursor));
		const total = chunks.reduce((sum, c) => sum + c.length, 0);
		const joined = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			joined.set(chunk, offset);
			offset += chunk.length;
		}
		return {text: utf8Decoder.decode(joined), facets: result};
	} catch (_e) {
		return {text, facets};
	}
}

/**
 * Bluesky の投稿の URL からハンドル (または DID) と rkey を読む。
 * @param {string} uri
 * @param {string[]} hosts 投稿の URL として認めるホスト
 * @returns {{actor: string, rkey: string}|null}
 */
export function parsePostUrl(uri, hosts) {
	const url = parseHttpUrl(uri);
	if (!url || !hosts.includes(url.hostname)) {
		return null;
	}
	const match = /^\/profile\/([^/]+)\/post\/([^/]+)\/?$/.exec(url.pathname);
	if (!match) {
		return null;
	}
	try {
		return {actor: decodeURIComponent(match[1]), rkey: decodeURIComponent(match[2])};
	} catch (_e) {
		return null;
	}
}

/**
 * リンクカードにしてよい URL か。
 * @param {string} uri
 * @param {CardRule} rule
 * @returns {boolean}
 */
export function isCardableUrl(uri, rule) {
	const url = parseHttpUrl(uri);
	if (!url || !url.hostname.includes('.')) {
		return false;
	}
	if (rule.excludedHosts.includes(url.hostname)) {
		return false;
	}
	const dot = url.pathname.lastIndexOf('.');
	if (dot >= 0 && !url.pathname.slice(dot).includes('/')) {
		const extension = url.pathname.slice(dot + 1).toLowerCase();
		if (rule.imageExtensions.includes(extension)) {
			return false;
		}
	}
	return true;
}

/**
 * 本文中の URL の全出現を調べ、打ち終わっているかを返す。別の長い URL の一部の出現は無視し、
 * 残った出現がすべて直後が空白で、1 つ以上あれば true。
 * @param {string} text
 * @param {string} link
 * @returns {boolean}
 */
function isTypedAndFinished(text, link) {
	if (link === '') {
		return false;
	}
	let found = 0;
	let from = 0;
	while (from <= text.length) {
		const at = text.indexOf(link, from);
		if (at < 0) {
			break;
		}
		from = at + link.length;
		const before = at === 0 ? '' : text.charAt(at - 1);
		if (before !== '' && !/[\s(\[{<]/.test(before)) {
			continue;
		}
		const after = text.charAt(from);
		if (URL_CONTINUATION.test(after)) {
			continue;
		}
		if (!/\s/.test(after)) {
			return false;
		}
		found += 1;
	}
	return found > 0;
}

/**
 * 本文のリンクから、カードと引用の提案を決める。貼り付けか、前回もあって直後が空白の URL だけが対象。
 * @param {{links: string[], previousLinks: string[], text: string, pasted: boolean, dismissed: string[], hosts: string[], cardRule: CardRule}} input
 * @returns {{card: string|null, quote: string|null}}
 */
export function pickSuggestion(input) {
	const {links, previousLinks, text, pasted, dismissed, hosts, cardRule} = input;
	let card = null;
	let quote = null;
	for (const link of links) {
		if (dismissed.includes(link)) {
			continue;
		}
		if (!pasted) {
			if (!previousLinks.includes(link)) {
				continue;
			}
			if (!isTypedAndFinished(text, link)) {
				continue;
			}
		}
		if (quote === null && parsePostUrl(link, hosts)) {
			quote = link;
		}
		if (card === null && isCardableUrl(link, cardRule)) {
			card = link;
		}
	}
	return {card, quote};
}

/**
 * 提案しない URL の理由。dismissed は × で外した (カードにも引用にも出さない)、failedCard / failedQuote は
 * 取得できなかった (その種類だけ取り直さない)。
 * @typedef {'dismissed'|'failedCard'|'failedQuote'} SuppressKind
 */

/**
 * URL を提案しない理由を足す。
 * @param {Map<string, Set<SuppressKind>>} suppressed
 * @param {string} url
 * @param {SuppressKind} kind
 * @returns {void}
 */
export function suppressUrl(suppressed, url, kind) {
	const kinds = suppressed.get(url);
	if (kinds) kinds.add(kind);
	else suppressed.set(url, new Set([kind]));
}

/**
 * 理由のどれかで提案しない URL の一覧。
 * @param {Map<string, Set<SuppressKind>>} suppressed
 * @param {SuppressKind[]} kinds
 * @returns {string[]}
 */
export function suppressedUrls(suppressed, kinds) {
	const result = [];
	for (const [url, reasons] of suppressed) {
		if (kinds.some((kind) => reasons.has(kind))) result.push(url);
	}
	return result;
}

/**
 * 本文から消えた URL の理由を忘れる (もう一度書けば提案する)。
 * @param {Map<string, Set<SuppressKind>>} suppressed
 * @param {string[]} links 今の本文の link の URL
 * @returns {void}
 */
export function pruneSuppressed(suppressed, links) {
	for (const url of Array.from(suppressed.keys())) {
		if (!links.includes(url)) suppressed.delete(url);
	}
}

/**
 * リンクカードの応答を読む。200 で error が空文字のときだけ成功。
 * @param {number} status HTTP ステータス
 * @param {any} json 応答の JSON
 * @param {{maxTitleGraphemes: number, maxDescriptionGraphemes: number}} limits
 * @returns {{title: string, description: string, imageUrl: string|null}|null}
 */
export function parseCardResponse(status, json, limits) {
	try {
		if (status !== 200 || !json || json.error !== '') {
			return null;
		}
		const title = typeof json.title === 'string' ? json.title : '';
		const description = typeof json.description === 'string' ? json.description : '';
		const image = typeof json.image === 'string' ? json.image : '';
		return {
			title: truncateGraphemes(title, limits.maxTitleGraphemes),
			description: truncateGraphemes(description, limits.maxDescriptionGraphemes),
			imageUrl: image !== '' && parseHttpUrl(image) ? image : null,
		};
	} catch (_e) {
		return null;
	}
}
