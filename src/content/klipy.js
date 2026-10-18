/**
 * Klipy (GIF の検索) の純関数。問い合わせ URL の組み立て・応答の解析・
 * app.bsky.embed.external の組み立て・GIF の動画 URL の算出を持つ。DOM と設定には触れない。
 */

import {truncateGraphemes} from './reply-text.js';

const EXTERNAL_TYPE = 'app.bsky.embed.external';
/** 利用者が書いた ALT 文に付ける description の接頭辞 */
export const GIF_ALT_PREFIX = 'Alt: ';
/** ALT 文が無いとき、題名に付ける description の接頭辞 */
export const GIF_TITLE_ALT_PREFIX = 'ALT: ';
const ALT_PREFIX_PATTERN = /^Alt: |^ALT: /;
const KLIPY_PATH_PREFIX = '/ii/';
const TENOR_WEBM_ID_FROM = 'AAAAC';
const TENOR_WEBM_ID_TO = 'AAAP3';
const TENOR_MP4_ID_TO = 'AAAP1';
const MIME_WEBM = 'video/webm';
const MIME_MP4 = 'video/mp4';

/**
 * @typedef {Object} GifItem
 * @property {string} id
 * @property {string} title
 * @property {string} gifUrl 元の GIF の URL (static.klipy.com)
 * @property {number} width
 * @property {number} height
 * @property {string} previewUrl
 * @property {string} tinyUrl 一覧に出す小さい GIF の URL (ホストはプレーヤー用に替えてある)
 * @property {number} tinyWidth
 * @property {number} tinyHeight
 * @property {string|null} playerUrl 一覧の動画 (tinywebm か webm)。プレーヤー用のホスト
 * @property {string|null} mp4Slug mp4 のファイル名 (拡張子なし)
 * @property {string|null} webmSlug webm のファイル名 (拡張子なし)
 */

/**
 * @typedef {Object} KlipyQueryRule
 * @property {string} origin
 * @property {{featured: string, search: string}} paths
 * @property {string} clientKey
 * @property {number} limit
 * @property {string} contentFilter
 */

/**
 * Klipy の問い合わせ URL を組む。
 * @param {'featured'|'search'} kind
 * @param {{q?: string, pos?: string, locale?: string|null}} query
 * @param {KlipyQueryRule} rule
 * @returns {string}
 */
export function buildKlipyUrl(kind, query, rule) {
	const url = new URL(kind === 'search' ? rule.paths.search : rule.paths.featured, rule.origin);
	url.searchParams.set('client_key', rule.clientKey);
	url.searchParams.set('limit', String(rule.limit));
	url.searchParams.set('contentfilter', rule.contentFilter);
	if (kind === 'search' && query.q) {
		url.searchParams.set('q', query.q);
	}
	if (query.pos) {
		url.searchParams.set('pos', query.pos);
	}
	if (query.locale) {
		url.searchParams.set('locale', query.locale);
	}
	return url.toString();
}

/**
 * 形式の項目から URL と大きさを読む。url が文字列で dims が正の整数 2 つのときだけ返す。
 * @param {any} format
 * @returns {{url: string, width: number, height: number}|null}
 */
function readFormat(format) {
	if (!format || typeof format.url !== 'string' || format.url === '' || !Array.isArray(format.dims)) {
		return null;
	}
	const [width, height] = format.dims;
	if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
		return null;
	}
	return {url: format.url, width, height};
}

/**
 * URL のホストを替える。読めなければ null。
 * @param {string} uri
 * @param {string} host
 * @returns {string|null}
 */
function withHost(uri, host) {
	try {
		const url = new URL(uri);
		url.host = host;
		return url.toString();
	} catch (_e) {
		return null;
	}
}

/**
 * URL の末尾のファイル名から拡張子を除いたもの。取れなければ null。
 * @param {string|undefined} uri
 * @returns {string|null}
 */
function fileSlug(uri) {
	if (typeof uri !== 'string') {
		return null;
	}
	try {
		const name = new URL(uri).pathname.split('/').pop() || '';
		const dot = name.lastIndexOf('.');
		const slug = dot > 0 ? name.slice(0, dot) : name;
		return slug === '' ? null : slug;
	} catch (_e) {
		return null;
	}
}

/**
 * URL のホストが指定のものか。読めなければ false。
 * @param {string} uri
 * @param {string} host
 * @returns {boolean}
 */
function isSourceHost(uri, host) {
	try {
		return new URL(uri).hostname === host;
	} catch (_e) {
		return false;
	}
}

/**
 * 結果 1 件を GifItem にする。必要な形式が欠けていれば null。
 * @param {any} result
 * @param {{playerHost: string, sourceHost: string}} rule
 * @returns {GifItem|null}
 */
function toGifItem(result, rule) {
	const formats = result && result.media_formats;
	if (!formats || typeof formats !== 'object') {
		return null;
	}
	const gif = readFormat(formats.gif);
	const tiny = readFormat(formats.tinygif);
	const preview = readFormat(formats.preview);
	if (!gif || !tiny || !preview) {
		return null;
	}
	const tinyUrl = withHost(tiny.url, rule.playerHost);
	if (!tinyUrl) {
		return null;
	}
	const playerSource = formats.tinywebm && formats.tinywebm.url
		? formats.tinywebm.url
		: (formats.webm && formats.webm.url);
	const playerUrl = typeof playerSource === 'string' ? withHost(playerSource, rule.playerHost) : null;
	const fromSource = isSourceHost(gif.url, rule.sourceHost);
	const description = typeof result.content_description === 'string' ? result.content_description : '';
	const title = typeof result.title === 'string' ? result.title : '';
	return {
		id: String(result.id),
		title: description !== '' ? description : title,
		gifUrl: gif.url,
		width: gif.width,
		height: gif.height,
		previewUrl: preview.url,
		tinyUrl,
		tinyWidth: tiny.width,
		tinyHeight: tiny.height,
		playerUrl,
		mp4Slug: fromSource ? fileSlug(formats.mp4 && formats.mp4.url) : null,
		webmSlug: fromSource ? fileSlug(formats.webm && formats.webm.url) : null,
	};
}

/**
 * Klipy の応答を一覧にする。必要な形式が欠けた項目は捨てる。
 * @param {any} json
 * @param {{playerHost: string, sourceHost: string}} rule
 * @returns {{items: GifItem[], next: string|null}}
 */
export function parseKlipyResponse(json, rule) {
	try {
		if (!json || !Array.isArray(json.results)) {
			return {items: [], next: null};
		}
		const items = [];
		for (const result of json.results) {
			const item = toGifItem(result, rule);
			if (item) {
				items.push(item);
			}
		}
		const next = typeof json.next === 'string' && json.next !== '' ? json.next : null;
		return {items, next};
	} catch (_e) {
		return {items: [], next: null};
	}
}

/**
 * external の description。ALT 文があれば「Alt: 」、無ければ題名を「ALT: 」で付ける。
 * @param {string} title
 * @param {string} alt
 * @returns {string}
 */
export function gifDescription(title, alt) {
	const trimmed = String(alt || '').trim();
	return trimmed ? GIF_ALT_PREFIX + trimmed : GIF_TITLE_ALT_PREFIX + title;
}

/**
 * description の先頭の「Alt: 」「ALT: 」を除く。
 * @param {string} description
 * @returns {string}
 */
export function stripAltPrefix(description) {
	return String(description || '').replace(ALT_PREFIX_PATTERN, '');
}

/**
 * GIF を貼る app.bsky.embed.external を組む。uri には大きさと動画の名前を付ける。
 * limits があれば title と description を書記素で上限まで切る (送る record は上限を超えると拒まれる)。
 * @param {GifItem} gif
 * @param {string} alt
 * @param {Object|null} thumb アップロード済みの blob
 * @param {{maxTitleGraphemes: number, maxDescriptionGraphemes: number}|null} [limits] 題名と説明の上限
 * @returns {Object}
 */
export function buildGifExternal(gif, alt, thumb, limits = null) {
	const params = new URLSearchParams({hh: String(gif.height), ww: String(gif.width)});
	if (gif.mp4Slug) {
		params.set('mp4', gif.mp4Slug);
	}
	if (gif.webmSlug) {
		params.set('webm', gif.webmSlug);
	}
	const external = {
		uri: `${gif.gifUrl}?${params.toString()}`,
		title: limits ? truncateGraphemes(gif.title, limits.maxTitleGraphemes) : gif.title,
		description: limits
			? truncateGraphemes(gifDescription(gif.title, alt), limits.maxDescriptionGraphemes)
			: gifDescription(gif.title, alt),
	};
	if (thumb) {
		external.thumb = thumb;
	}
	return {$type: EXTERNAL_TYPE, external};
}

/**
 * 正の数として読む。読めなければ null。
 * @param {string|null} value
 * @returns {number|null}
 */
function positiveNumber(value) {
	const n = Number(value);
	return value !== null && value !== '' && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Klipy の GIF の uri から動画を組む。
 * @param {URL} url
 * @param {{sourceHost: string, playerHost: string}} rule
 * @param {number} width
 * @param {number} height
 * @returns {{sources: Array<{src: string, type: string}>, width: number, height: number}|null}
 */
function klipyPlayer(url, rule, width, height) {
	if (url.hostname !== rule.sourceHost || !url.pathname.startsWith(KLIPY_PATH_PREFIX)) {
		return null;
	}
	const segments = url.pathname.split('/');
	const sources = [];
	for (const [param, ext, type] of [['webm', 'webm', MIME_WEBM], ['mp4', 'mp4', MIME_MP4]]) {
		const slug = url.searchParams.get(param);
		if (slug && !slug.includes('/')) {
			const path = [...segments.slice(0, -1), `${slug}.${ext}`].join('/');
			sources.push({src: `https://${rule.playerHost}${path}`, type});
		}
	}
	return sources.length > 0 ? {sources, width, height} : null;
}

/**
 * Tenor の GIF の uri から動画を組む。
 * @param {URL} url
 * @param {{sourceHost: string, playerHost: string}} rule
 * @param {number} width
 * @param {number} height
 * @returns {{sources: Array<{src: string, type: string}>, width: number, height: number}|null}
 */
function tenorPlayer(url, rule, width, height) {
	const match = /^\/([^/]+)\/([^/]+)\.gif$/.exec(url.pathname);
	if (url.hostname !== rule.sourceHost || !match) {
		return null;
	}
	const [, id, name] = match;
	const webmId = id.replace(TENOR_WEBM_ID_FROM, TENOR_WEBM_ID_TO);
	const mp4Id = id.replace(TENOR_WEBM_ID_FROM, TENOR_MP4_ID_TO);
	return {
		sources: [
			{src: `https://${rule.playerHost}/${webmId}/${name}.webm`, type: MIME_WEBM},
			{src: `https://${rule.playerHost}/${mp4Id}/${name}.mp4`, type: MIME_MP4},
		],
		width,
		height,
	};
}

/**
 * GIF の external の uri から、再生する動画の URL と大きさを読む。本体の Klipy・Tenor の規則と同じ。
 * @param {string} uri
 * @param {{klipy: {sourceHost: string, playerHost: string}, tenor: {sourceHost: string, playerHost: string}}} rule
 * @returns {{sources: Array<{src: string, type: string}>, width: number, height: number}|null}
 */
export function gifPlayerFromUri(uri, rule) {
	try {
		const url = new URL(uri);
		const height = positiveNumber(url.searchParams.get('hh'));
		const width = positiveNumber(url.searchParams.get('ww'));
		if (height === null || width === null) {
			return null;
		}
		return klipyPlayer(url, rule.klipy, width, height) || tenorPlayer(url, rule.tenor, width, height);
	} catch (_e) {
		return null;
	}
}
