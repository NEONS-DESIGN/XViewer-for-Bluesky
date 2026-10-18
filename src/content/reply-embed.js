/**
 * 返信欄の添付 (画像) まわりの純関数。
 * 投稿の embed と自己ラベルの組み立て・添付の受け入れ・送信の可否・言語の扱い・
 * 投稿直後の自分の返信を描くための embed view を持つ。**DOM も通信も config も知らない。**
 * 値 (上限など) は引数で受け取る。
 */
import {BRIDGE_PROTOCOL} from '../common/bridge-protocol.js';
import {countGraphemes, primaryLanguage} from './reply-text.js';

/**
 * アップロード済みの画像 1 枚。
 * @typedef {Object} UploadedImage
 * @property {Object} blob uploadBlob が返した BlobRef
 * @property {string} alt 代替テキスト
 * @property {number} width 縮小後の幅 (px)
 * @property {number} height 縮小後の高さ (px)
 */

/**
 * アップロード済みの動画 1 本。
 * @typedef {Object} UploadedVideo
 * @property {Object} blob uploadBlob が返した BlobRef
 * @property {string} alt 代替テキスト (空なら付けない)
 * @property {number} width 動画の幅 (px)
 * @property {number} height 動画の高さ (px)
 * @property {Array<{lang: string, file: Object}>} captions 字幕 (無ければ空)
 */

/** 橋渡しと共有する record の規則 */
const RECORD_RULES = BRIDGE_PROTOCOL.postRecord;

/** 投稿の本文の上限のうちバイトの数え方に使う変換器 */
const utf8Encoder = new TextEncoder();

/** embed view の $type は record 側の $type に #view を足した形 */
const VIEW_SUFFIX = '#view';

/**
 * 幅・高さが正のときだけ aspectRatio にする。
 * @param {UploadedImage} image
 * @returns {{width: number, height: number}|null}
 */
function toAspectRatio(image) {
	return image.width > 0 && image.height > 0
		? {width: image.width, height: image.height}
		: null;
}

/**
 * 幅・高さがどちらも正のときだけ、整数に丸めた aspectRatio にする。
 * @param {{width: number, height: number}} source
 * @returns {{width: number, height: number}|null}
 */
function toRoundedAspectRatio(source) {
	const width = Math.round(source.width);
	const height = Math.round(source.height);
	return width > 0 && height > 0 ? {width, height} : null;
}

/**
 * 添付動画から投稿の embed を作る。ALT・字幕・縦横比は値があるときだけ付ける。
 * @param {UploadedVideo|null} video
 * @returns {Object|null} 動画が無ければ null
 */
export function buildVideoEmbed(video) {
	if (!video || !video.blob) {
		return null;
	}
	const embed = {$type: RECORD_RULES.embedTypes.video, video: video.blob};
	if (typeof video.alt === 'string' && video.alt !== '') {
		embed.alt = video.alt;
	}
	if (Array.isArray(video.captions) && video.captions.length > 0) {
		embed.captions = video.captions;
	}
	const aspectRatio = toRoundedAspectRatio(video);
	if (aspectRatio) {
		embed.aspectRatio = aspectRatio;
	}
	embed.presentation = BRIDGE_PROTOCOL.video.presentation;
	return embed;
}

/**
 * 添付画像から投稿の embed を作る。legacyMax 枚までは images、超えたら gallery。
 * gallery の aspectRatio は必須なので、寸法が読めない画像を渡さないのは呼び出し側の責任
 * (ここでは幅・高さをそのまま入れる)。
 * @param {UploadedImage[]} images
 * @param {number} legacyMax images に収める枚数の上限
 * @returns {Object|null} 0 枚は null
 */
export function buildMediaEmbed(images, legacyMax) {
	if (!Array.isArray(images) || images.length === 0) {
		return null;
	}
	if (images.length <= legacyMax) {
		return {
			$type: RECORD_RULES.embedTypes.images,
			images: images.map((image) => {
				const item = {image: image.blob, alt: image.alt};
				const aspectRatio = toAspectRatio(image);
				if (aspectRatio) {
					item.aspectRatio = aspectRatio;
				}
				return item;
			})
		};
	}
	return {
		$type: RECORD_RULES.embedTypes.gallery,
		items: images.map((image) => ({
			$type: RECORD_RULES.galleryImageType,
			image: image.blob,
			alt: image.alt,
			aspectRatio: {width: image.width, height: image.height}
		}))
	};
}

/**
 * 選択から自己ラベルを作る。何も選ばれていなければ null (橋渡しは空の values を拒む)。
 * @param {{adult: string|null, graphic: boolean}} selection
 * @returns {Object|null}
 */
export function buildSelfLabels(selection) {
	const values = [];
	if (selection && typeof selection.adult === 'string' && selection.adult) {
		values.push({val: selection.adult});
	}
	if (selection && selection.graphic) {
		values.push({val: RECORD_RULES.otherLabels[0]});
	}
	return values.length > 0
		? {$type: RECORD_RULES.selfLabelsType, values}
		: null;
}

/**
 * 選ばれたファイルのうち、受け取れるものの添字を入ってきた順に返す。
 * @param {number} currentCount いま添付済みの枚数
 * @param {Array<{type: string}>|ArrayLike<{type: string}>} files 配列か FileList
 * @param {string[]} accept 受け付ける MIME タイプ
 * @param {number} max 添付の上限
 * @returns {{accepted: number[], tooMany: number, unsupported: number}}
 */
export function acceptImages(currentCount, files, accept, max) {
	const accepted = [];
	let tooMany = 0;
	let unsupported = 0;
	// FileList のような配列もどきは読み、それ以外 (null や文字列) は空として扱う
	const list = Array.isArray(files)
		? files
		: (files && typeof files === 'object' && typeof files.length === 'number' ? Array.from(files) : []);
	list.forEach((file, index) => {
		if (!file || !accept.includes(file.type)) {
			unsupported += 1;
		} else if (currentCount + accepted.length >= max) {
			tooMany += 1;
		} else {
			accepted.push(index);
		}
	});
	return {accepted, tooMany, unsupported};
}

/**
 * 送信できるかと、残りの文字数 (書記素) を返す。
 * 本文 (trim 後) か添付が 1 つ以上あり、本文が上限内であること。
 * @param {string} text
 * @param {number} contentCount 画像の枚数 + GIF + 送るカード + 引用
 * @param {{maxGraphemes: number, maxBytes: number}} limits
 * @returns {{ok: boolean, remaining: number}}
 */
export function canSubmitComposer(text, contentCount, limits) {
	const value = typeof text === 'string' ? text : '';
	const remaining = limits.maxGraphemes - countGraphemes(value);
	const hasContent = value.trim() !== '' || contentCount > 0;
	const ok = hasContent && remaining >= 0
		&& utf8Encoder.encode(value).length <= limits.maxBytes;
	return {ok, remaining};
}

/**
 * 保存された言語の配列から、重複・未知のコード・上限超えを落とす。
 * @param {*} codes 保存値 (配列でなければ空扱い)
 * @param {number} max
 * @param {string[]} known 選べるコード
 * @returns {string[]}
 */
export function normalizeLanguages(codes, max, known) {
	if (!Array.isArray(codes)) {
		return [];
	}
	const result = [];
	for (const code of codes) {
		if (typeof code === 'string' && known.includes(code) && !result.includes(code)) {
			result.push(code);
		}
		if (result.length >= max) {
			break;
		}
	}
	return result;
}

/**
 * 返信先の言語が選択に無いとき、足す候補を返す。
 * @param {*} parentLangs 返信先の record.langs
 * @param {string[]} selected 選択中の言語
 * @param {string[]} known 選べるコード (一覧に無い言語は提案しない)
 * @returns {string|null} 返信先の先頭の主タグ。無い・選択済み・一覧に無いなら null
 */
export function suggestReplyLanguage(parentLangs, selected, known) {
	if (!Array.isArray(parentLangs) || parentLangs.length === 0 || !Array.isArray(known)) {
		return null;
	}
	const primary = primaryLanguage(parentLangs[0]);
	const chosen = Array.isArray(selected) ? selected : [];
	return primary && known.includes(primary) && !chosen.includes(primary) ? primary : null;
}

/**
 * 投稿した自分の返信を一覧に入れるための embed view を作る (取り直さずに描くため)。
 * @param {UploadedImage[]} images
 * @param {string} did 自分の DID
 * @param {{thumb: string, fullsize: string}} cdn CDN の接頭辞
 * @param {number} legacyMax images#view に収める枚数の上限
 * @returns {Object|null} 0 枚 (CID の読める画像が無い) は null
 */
export function buildOwnEmbedView(images, did, cdn, legacyMax) {
	if (!Array.isArray(images)) {
		return null;
	}
	const cidOf = (image) => {
		const cid = image && image.blob && image.blob.ref && image.blob.ref.$link;
		return typeof cid === 'string' && cid !== '' ? cid : null;
	};
	// CID が読めない画像は URL を作れないため描かない
	const usable = images.filter((image) => cidOf(image) !== null);
	if (usable.length === 0) {
		return null;
	}
	const urls = (image) => {
		const cid = cidOf(image);
		return {thumb: `${cdn.thumb}/${did}/${cid}`, fullsize: `${cdn.fullsize}/${did}/${cid}`};
	};
	if (usable.length <= legacyMax) {
		return {
			$type: RECORD_RULES.embedTypes.images + VIEW_SUFFIX,
			images: usable.map((image) => {
				const {thumb, fullsize} = urls(image);
				const item = {thumb, fullsize, alt: image.alt};
				const aspectRatio = toAspectRatio(image);
				if (aspectRatio) {
					item.aspectRatio = aspectRatio;
				}
				return item;
			})
		};
	}
	return {
		$type: RECORD_RULES.embedTypes.gallery + VIEW_SUFFIX,
		items: usable.map((image) => {
			const {thumb, fullsize} = urls(image);
			return {thumbnail: thumb, fullsize, alt: image.alt, aspectRatio: toAspectRatio(image)};
		})
	};
}

/**
 * 投稿に付ける添付の部品。
 * @typedef {Object} EmbedParts
 * @property {UploadedImage[]} images
 * @property {UploadedVideo|null} [video] 動画 (無ければ省く)
 * @property {Object|null} external app.bsky.embed.external の embed そのもの (GIF かカード)
 * @property {{uri: string, cid: string}|null} quote 引用する投稿
 */

/**
 * 添付の部品から投稿の embed を作る。media の優先は 画像、動画、external の順。
 * @param {EmbedParts} parts
 * @param {number} legacyMax images に収める枚数の上限
 * @returns {Object|null} 何も無ければ null
 */
export function buildPostEmbed(parts, legacyMax) {
	if (!parts) {
		return null;
	}
	const media = buildMediaEmbed(parts.images, legacyMax) || buildVideoEmbed(parts.video || null) || parts.external || null;
	const record = parts.quote
		? {$type: RECORD_RULES.embedTypes.record, record: parts.quote}
		: null;
	if (media && record) {
		return {$type: RECORD_RULES.embedTypes.recordWithMedia, media, record};
	}
	return media || record;
}

/**
 * コンテンツの警告 (自己ラベル) の入口を出す条件。ラベルの対象はメディアだけ。
 * @param {{imageCount: number, hasGif: boolean, hasCard: boolean, hasVideo?: boolean}} input
 * @returns {boolean}
 */
export function hasLabelableMedia(input) {
	return Boolean(input) && (input.imageCount > 0 || Boolean(input.hasGif) || Boolean(input.hasCard) || Boolean(input.hasVideo));
}

/**
 * BlobRef から CID を読む。
 * @param {*} blob
 * @returns {string|null}
 */
function blobCid(blob) {
	const cid = blob && blob.ref && blob.ref.$link;
	return typeof cid === 'string' && cid !== '' ? cid : null;
}

/**
 * external の embed から view を作る。thumb は CID が読めるときだけ CDN の URL にする。
 * @param {Object} external app.bsky.embed.external の embed
 * @param {string} did
 * @param {{thumb: string}} cdn
 * @returns {Object|null}
 */
function buildExternalView(external, did, cdn) {
	const source = external && external.external;
	if (!source || typeof source.uri !== 'string') {
		return null;
	}
	const view = {uri: source.uri, title: source.title, description: source.description};
	const cid = blobCid(source.thumb);
	if (cid) {
		view.thumb = `${cdn.thumb}/${did}/${cid}`;
	}
	return {$type: RECORD_RULES.embedTypes.external + VIEW_SUFFIX, external: view};
}

/**
 * 動画の embed から video#view を作る。CID が読めなければ null。
 * @param {UploadedVideo} video
 * @param {string} did
 * @param {{video?: string}} cdn
 * @returns {Object|null}
 */
function buildVideoView(video, did, cdn) {
	const cid = blobCid(video && video.blob);
	if (!cid || !cdn || typeof cdn.video !== 'string') {
		return null;
	}
	const base = `${cdn.video}/${encodeURIComponent(did)}/${cid}`;
	const view = {
		$type: RECORD_RULES.embedTypes.video + VIEW_SUFFIX,
		cid,
		playlist: `${base}/playlist.m3u8`,
		thumbnail: `${base}/thumbnail.jpg`
	};
	if (typeof video.alt === 'string' && video.alt !== '') {
		view.alt = video.alt;
	}
	const aspectRatio = toRoundedAspectRatio(video);
	if (aspectRatio) {
		view.aspectRatio = aspectRatio;
	}
	return view;
}

/**
 * 投稿した自分の返信の embed view を作る (取り直さずに描くため)。
 * @param {{images: UploadedImage[], video?: UploadedVideo|null, external: Object|null, quoteView: Object|null}} parts
 * @param {string} did 自分の DID
 * @param {{thumb: string, fullsize: string, video?: string}} cdn
 * @param {number} legacyMax
 * @returns {Object|null}
 */
export function buildOwnPostEmbedView(parts, did, cdn, legacyMax) {
	if (!parts) {
		return null;
	}
	const media = buildOwnEmbedView(parts.images, did, cdn, legacyMax)
		|| (parts.video ? buildVideoView(parts.video, did, cdn) : null)
		|| (parts.external ? buildExternalView(parts.external, did, cdn) : null);
	const record = parts.quoteView
		? {$type: RECORD_RULES.embedTypes.record + VIEW_SUFFIX, record: parts.quoteView}
		: null;
	if (media && record) {
		return {$type: RECORD_RULES.embedTypes.recordWithMedia + VIEW_SUFFIX, media, record};
	}
	return media || record;
}

/**
 * getPosts の PostView を、引用の viewRecord に写す。
 * @param {Object} post
 * @returns {Object|null} uri / cid / record が無ければ null
 */
export function toQuoteViewRecord(post) {
	if (!post || typeof post.uri !== 'string' || typeof post.cid !== 'string' || !post.record) {
		return null;
	}
	return {
		$type: RECORD_RULES.embedTypes.record + '#viewRecord',
		uri: post.uri,
		cid: post.cid,
		author: post.author,
		value: post.record,
		indexedAt: post.indexedAt,
		labels: Array.isArray(post.labels) ? post.labels : [],
		embeds: post.embed ? [post.embed] : []
	};
}
