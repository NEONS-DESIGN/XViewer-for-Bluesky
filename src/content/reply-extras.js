/**
 * 返信の入力欄の GIF・リンクカード・引用の状態。
 * 本文のリンクからカードと引用を提案して取得し (取得ごとに要求の枠で印を配り、古い応答は捨てて通信も止める)、
 * プレビューを描き、送信のときに external と引用する投稿 (uri と cid) を組み立てる。通信は依存として受け取る。
 * リンクカードのサムネイルは、カードが取れた時点で 1 回だけ取得し、プレビューと送信の両方に使う。
 *
 * 依存: bridge-protocol.js / reply-links.js / klipy.js / reply-embed.js / embed-cards.js / sheet-dom.js /
 *       motion.js / reply-text.js / object-url.js / request-slot.js / keyed-parts.js
 */

import {BRIDGE_PROTOCOL} from '../common/bridge-protocol.js';
import {prefersReducedMotion} from '../common/motion.js';
import {
	pickSuggestion, parsePostUrl, parseCardResponse, suppressUrl, suppressedUrls, pruneSuppressed
} from './reply-links.js';
import {buildGifExternal, gifPlayerFromUri} from './klipy.js';
import {toQuoteViewRecord} from './reply-embed.js';
import {buildLinkCard, buildQuoteCard, buildGifPlayer, classifyEmbedView} from './embed-cards.js';
import {createElement} from './sheet-dom.js';
import {utf8Length} from './reply-text.js';
import {createObjectUrl, revokeObjectUrl} from './object-url.js';
import {createRequestSlot} from './request-slot.js';
import {syncKeyedParts} from './keyed-parts.js';

/** 返信の record に付ける embed の $type と external の上限 */
const RECORD_RULES = BRIDGE_PROTOCOL.postRecord;

/** 入力欄のプレビューで GIF の動画として流す形式 */
const GIF_PREVIEW_MIME = 'video/webm';

/** 投稿の AT URI の collection */
const POST_COLLECTION = BRIDGE_PROTOCOL.collections.post;

/** カードの提案を止める理由 (× で外した・取得できなかった) */
const CARD_SUPPRESS = ['dismissed', 'failedCard'];

/** 引用の提案を止める理由 (× で外した・付けられなかった) */
const QUOTE_SUPPRESS = ['dismissed', 'failedQuote'];

/**
 * @typedef {import('./klipy.js').GifItem} GifItem
 */

/**
 * @typedef {Object} GifState
 * @property {GifItem} item 選んだ GIF
 * @property {string} alt ALT 文 (未入力は空文字)
 */

/**
 * リンクカードのサムネイル。カードが取れた時点で 1 回だけ取得する。
 * @typedef {Object} CardThumb
 * @property {'loading'|'ready'|'failed'} status
 * @property {Blob|null} blob 取得できた画像 (送るときはこれを縮める)
 * @property {string} url blob の object URL (プレビューに使う。作れなければ空)
 * @property {Promise<Blob|null>} done 取得の終わり (取れなければ null)
 */

/**
 * @typedef {Object} CardState
 * @property {string} url 本文のリンクの URL
 * @property {'loading'|'ready'} status
 * @property {{title: string, description: string, imageUrl: string|null}|null} data 取得できたカードの中身
 * @property {CardThumb|null} thumb サムネイル (画像の URL が無いカードは null)
 */

/**
 * @typedef {Object} QuoteState
 * @property {string} url 本文の投稿の URL
 * @property {'loading'|'ready'} status
 * @property {Object|null} post getPosts の PostView
 * @property {{uri: string, cid: string}|null} ref 引用する投稿
 */

/**
 * @typedef {Object} PreviewHandlers
 * @property {(button: HTMLButtonElement) => void} onGifAlt GIF の ALT ボタンを押した
 * @property {() => void} [onRemoved] × で外して描き直した後に呼ぶ (消えた × の代わりのフォーカスの移し先を決める)
 */

/**
 * × の処理の後に onRemoved を呼ぶ関数を返す。
 * @param {() => void} remove 外す処理
 * @param {PreviewHandlers|undefined} handlers
 * @returns {() => void}
 */
function withRemoved(remove, handlers) {
	return () => {
		remove();
		if (!handlers || typeof handlers.onRemoved !== 'function') return;
		try {
			handlers.onRemoved();
		} catch (error) {
			console.error('[XViewer] 外した後のフォーカスを移せませんでした', error);
		}
	};
}

/**
 * 入力欄の口 (ComposerDeps) のうち、GIF・カード・引用が使うもの。
 * @typedef {Object} ExtrasDeps
 * @property {(url: string, timeoutMs: number, signal?: AbortSignal) => Promise<{status: number, json: any}|null>} fetchJson
 * @property {(url: string, timeoutMs: number, signal?: AbortSignal) => Promise<Blob|null>} fetchBlob
 * @property {(handle: string) => Promise<string|null>} resolveHandle ハンドルを DID に直す
 * @property {(uri: string) => Promise<Object|null>} fetchPost getPosts の応答 ({posts: PostView[]})
 * @property {(blob: Blob, crop: null, rules: Object, options?: {preview?: boolean}) => Promise<{blob: Blob, previewUrl?: string|null}|null>} prepareImage
 * @property {(blob: Blob) => Promise<{ok: boolean, blob: Object|null, reason: string|null}>} uploadBlob
 * @property {(uri: string) => string|null} safeHref リンクにしてよい URL か
 * @property {(iso: string) => string} formatDate 引用元の日時の表示
 * @property {(labels: string[]) => string|null} [blurText] 引用元の画像をぼかす理由 (無ければぼかさない)
 */

/**
 * @typedef {Object} SubmitExtras
 * @property {Object|null} external app.bsky.embed.external の embed (GIF かカード)
 * @property {{uri: string, cid: string}|null} quote 引用する投稿
 * @property {Object|null} quoteView 投稿直後に描くための record#viewRecord
 */

/**
 * 入力欄の GIF・リンクカード・引用の状態を持つ。
 */
export class ComposerExtras {
	/**
	 * @param {Object} config EXT_CONFIG.lightboxReplies
	 * @param {ExtrasDeps} deps 口は呼ぶたびに引く (差し替えに追随する)
	 * @param {() => void} [onChange] 状態が変わったことを入力欄へ知らせる
	 */
	constructor(config, deps, onChange) {
		this.config = config;
		this.compose = config.compose;
		this.cards = config.cards;
		this.deps = deps;
		this.onChange = typeof onChange === 'function' ? onChange : null;
		/** @type {GifState|null} */
		this.gif = null;
		/** @type {CardState|null} */
		this.card = null;
		/** @type {QuoteState|null} */
		this.quote = null;
		/**
		 * 提案しない URL とその理由 (本文に残っているあいだ再提案・取り直しをしない)
		 * @type {Map<string, Set<import('./reply-links.js').SuppressKind>>}
		 */
		this.suppressed = new Map();
		/** 1 行で出す知らせ @type {string|null} */
		this.notice = null;
		/** 知らせの元になった URL (本文から消えたら知らせも消す) @type {string|null} */
		this.noticeUrl = null;
		/** 前回の本文の link の URL @type {string[]} */
		this.previousLinks = [];
		/** 今の本文の link の URL @type {string[]} */
		this.links = [];
		/** カード (とそのサムネイル) の取得の枠。外す・取り直す・空に戻すと前の取得を止める */
		this.cardSlot = createRequestSlot();
		/** 引用の取得の枠 */
		this.quoteSlot = createRequestSlot();
		this.destroyed = false;
	}

	/**
	 * 状態が変わったことを知らせる。
	 * @returns {void}
	 */
	notify() {
		if (this.destroyed || !this.onChange) return;
		try {
			this.onChange();
		} catch (error) {
			console.error('[XViewer] 入力欄の添付の変化を知らせられませんでした', error);
		}
	}

	/**
	 * URL を × で外した・取得できなかったか。
	 * @param {string} url
	 * @param {import('./reply-links.js').SuppressKind} kind
	 * @returns {boolean}
	 */
	isSuppressed(url, kind) {
		const kinds = this.suppressed.get(url);
		return Boolean(kinds && kinds.has(kind));
	}

	/**
	 * 本文が変わったときに呼ぶ。消えた URL のカード・引用を外し、新しい候補の取得を始める。
	 * @param {string} text 入力欄の本文 (短縮前)
	 * @param {string[]} links その本文の link の URL
	 * @param {boolean} pasted 貼り付けによる変化か
	 * @returns {void}
	 */
	onTextChange(text, links, pasted) {
		if (this.destroyed) return;
		try {
			const current = Array.isArray(links) ? links.slice() : [];
			let changed = false;
			this.links = current;
			pruneSuppressed(this.suppressed, current);
			if (this.card && !current.includes(this.card.url)) {
				this.dropCard();
				changed = true;
			}
			if (this.quote && !current.includes(this.quote.url)) {
				this.dropQuote();
				changed = true;
			}
			if (this.noticeUrl !== null && !current.includes(this.noticeUrl)) {
				this.clearNotice();
				changed = true;
			}
			const base = {
				links: current,
				previousLinks: this.previousLinks,
				text: String(text || ''),
				pasted: pasted === true,
				hosts: this.compose.quote.hosts,
				cardRule: {excludedHosts: this.compose.card.excludedHosts, imageExtensions: this.compose.card.imageExtensions}
			};
			const cardUrl = pickSuggestion({...base, dismissed: suppressedUrls(this.suppressed, CARD_SUPPRESS)}).card;
			const quoteUrl = pickSuggestion({...base, dismissed: suppressedUrls(this.suppressed, QUOTE_SUPPRESS)}).quote;
			this.previousLinks = current;
			if (cardUrl && !this.card && this.fitsExternalUri(cardUrl)) {
				this.startCard(cardUrl);
				changed = true;
			}
			if (quoteUrl && !this.quote) {
				this.startQuote(quoteUrl);
				changed = true;
			}
			if (changed) this.notify();
		} catch (error) {
			console.error('[XViewer] 本文のリンクを読めませんでした', error);
		}
	}

	/**
	 * external の uri の上限 (バイト) に収まるか。
	 * @param {string} url
	 * @returns {boolean}
	 */
	fitsExternalUri(url) {
		return utf8Length(url) <= RECORD_RULES.external.maxUriBytes;
	}

	/**
	 * 知らせを消す。
	 * @returns {void}
	 */
	clearNotice() {
		this.notice = null;
		this.noticeUrl = null;
	}

	/**
	 * カードを外す (取得中ならそれも止め、サムネイルの URL を捨てる)。知らせはしない。
	 * @returns {void}
	 */
	dropCard() {
		const card = this.card;
		this.card = null;
		this.cardSlot.cancel();
		if (card && card.thumb) revokeObjectUrl(card.thumb.url);
	}

	/**
	 * 引用を外す (取得中ならそれも止める)。知らせはしない。
	 * @returns {void}
	 */
	dropQuote() {
		this.quote = null;
		this.quoteSlot.cancel();
	}

	/**
	 * 応答を反映してよいか。外された・取り直された・本文から消えた・撤去された後なら偽。
	 * @param {'card'|'quote'} kind
	 * @param {import('./request-slot.js').RequestToken} token 取得を始めたときの印
	 * @param {string} url
	 * @returns {boolean}
	 */
	isCurrentFetch(kind, token, url) {
		if (this.destroyed || !this.links.includes(url)) return false;
		const state = kind === 'card' ? this.card : this.quote;
		const slot = kind === 'card' ? this.cardSlot : this.quoteSlot;
		return slot.isCurrent(token) && state !== null && state.url === url && state.status === 'loading';
	}

	/**
	 * リンクカードを取得する。失敗したらカードを付けない。取れたらサムネイルの取得を始める。
	 * @param {string} url
	 * @returns {Promise<void>}
	 */
	async startCard(url) {
		const token = this.cardSlot.begin();
		this.card = {url, status: 'loading', data: null, thumb: null};
		let data = null;
		try {
			const rule = this.compose.card;
			const response = await this.deps.fetchJson(`${rule.extractUrl}?url=${encodeURIComponent(url)}`,
				rule.timeoutMs, token.signal || undefined);
			data = response
				? parseCardResponse(response.status, response.json, {
					maxTitleGraphemes: RECORD_RULES.external.maxTitleGraphemes,
					maxDescriptionGraphemes: RECORD_RULES.external.maxDescriptionGraphemes
				})
				: null;
		} catch (error) {
			console.error('[XViewer] リンクカードを取得できませんでした', error);
			data = null;
		}
		if (!this.isCurrentFetch('card', token, url)) return;
		if (data) {
			const card = {url, status: 'ready', data, thumb: null};
			this.card = card;
			if (data.imageUrl) card.thumb = this.loadCardThumb(card, token);
		} else {
			this.card = null;
			suppressUrl(this.suppressed, url, 'failedCard');
		}
		this.notify();
	}

	/**
	 * カードのサムネイルを 1 回だけ取得する。取れたら object URL を作ってプレビューを描き直させる。
	 * 取得中にカードが外された・取り直された・撤去されたら、届いた画像は使わない。
	 * @param {CardState} card
	 * @param {import('./request-slot.js').RequestToken} token カードの取得の印 (外すと通信も止まる)
	 * @returns {CardThumb}
	 */
	loadCardThumb(card, token) {
		/** @type {CardThumb} */
		const thumb = {status: 'loading', blob: null, url: '', done: Promise.resolve(null)};
		const isCurrent = () => !this.destroyed && this.card === card && this.cardSlot.isCurrent(token);
		thumb.done = (async () => {
			let blob = null;
			try {
				blob = await this.deps.fetchBlob(card.data.imageUrl, this.compose.card.timeoutMs, token.signal || undefined);
			} catch (error) {
				console.error('[XViewer] リンクカードのサムネイルを取得できませんでした', error);
				blob = null;
			}
			if (!isCurrent()) return null;
			if (!blob) {
				thumb.status = 'failed';
				return null;
			}
			thumb.blob = blob;
			thumb.url = createObjectUrl(blob);
			thumb.status = 'ready';
			this.notify();
			return blob;
		})();
		return thumb;
	}

	/**
	 * 引用する投稿を引く。見つからない・引用できないときは付けずに 1 行で知らせる。
	 * @param {string} url
	 * @returns {Promise<void>}
	 */
	async startQuote(url) {
		const token = this.quoteSlot.begin();
		this.quote = {url, status: 'loading', post: null, ref: null};
		if (this.noticeUrl !== null) this.clearNotice();
		let post = null;
		let failure = this.cards.text.quoteNotFound;
		try {
			const parsed = parsePostUrl(url, this.compose.quote.hosts);
			if (parsed) {
				const did = parsed.actor.startsWith('did:') ? parsed.actor : await this.deps.resolveHandle(parsed.actor);
				if (!this.isCurrentFetch('quote', token, url)) return;
				if (typeof did === 'string' && did !== '') {
					const json = await this.deps.fetchPost(`at://${did}/${POST_COLLECTION}/${parsed.rkey}`);
					const first = json && Array.isArray(json.posts) ? json.posts[0] : null;
					if (first && first.viewer && first.viewer.embeddingDisabled === true) {
						failure = this.compose.text.quoteDisabled;
					} else if (toQuoteViewRecord(first)) {
						post = first;
					}
				}
			}
		} catch (error) {
			console.error('[XViewer] 引用する投稿を取得できませんでした', error);
			post = null;
		}
		if (!this.isCurrentFetch('quote', token, url)) return;
		if (post) {
			this.quote = {url, status: 'ready', post, ref: {uri: post.uri, cid: post.cid}};
		} else {
			this.quote = null;
			suppressUrl(this.suppressed, url, 'failedQuote');
			this.notice = failure;
			this.noticeUrl = url;
		}
		this.notify();
	}

	/**
	 * GIF を付ける。ALT 文は空で始める。
	 * @param {GifItem} item
	 * @returns {void}
	 */
	setGif(item) {
		if (this.destroyed || !item) return;
		this.gif = {item, alt: ''};
		this.notify();
	}

	/**
	 * GIF を外す。
	 * @returns {void}
	 */
	removeGif() {
		if (!this.gif) return;
		this.gif = null;
		this.notify();
	}

	/**
	 * GIF の ALT 文を変える。
	 * @param {string} alt
	 * @returns {void}
	 */
	setGifAlt(alt) {
		if (!this.gif) return;
		this.gif = {item: this.gif.item, alt: String(alt || '')};
		this.notify();
	}

	/**
	 * リンクカードを外し、その URL を本文に残っているあいだ再提案しない。
	 * @returns {void}
	 */
	removeCard() {
		if (!this.card) return;
		suppressUrl(this.suppressed, this.card.url, 'dismissed');
		this.dropCard();
		this.notify();
	}

	/**
	 * 引用を外し、その URL を本文に残っているあいだ再提案しない。
	 * @returns {void}
	 */
	removeQuote() {
		if (!this.quote) return;
		suppressUrl(this.suppressed, this.quote.url, 'dismissed');
		this.dropQuote();
		this.notify();
	}

	/**
	 * メディア (画像か GIF) があるか。
	 * @param {number} imageCount 添付 (取り込み中を含む) の画像の枚数
	 * @returns {boolean}
	 */
	hasMedia(imageCount) {
		return imageCount > 0 || this.gif !== null;
	}

	/**
	 * 送るリンクカード。メディアがある・取得中なら null。
	 * @param {number} imageCount
	 * @returns {CardState|null}
	 */
	sendableCard(imageCount) {
		if (this.hasMedia(imageCount) || !this.card || this.card.status !== 'ready') return null;
		return this.card;
	}

	/**
	 * 送信できる条件に渡す添付の数 (画像の枚数 + GIF + 送るカード + 取得できた引用)。
	 * @param {number} imageCount
	 * @returns {number}
	 */
	contentCount(imageCount) {
		const images = imageCount > 0 ? imageCount : 0;
		return images
			+ (this.gif ? 1 : 0)
			+ (this.sendableCard(imageCount) ? 1 : 0)
			+ (this.quote && this.quote.status === 'ready' ? 1 : 0);
	}

	/**
	 * プレビューを今の状態に合わせる。GIF・カード (メディアがあれば出さない)・引用カード・取得中や知らせの 1 行の順。
	 * 部品ごとに鍵を持ち、変わらない部品は作り直さない (打鍵のたびに GIF の再生が最初に戻らないため)。
	 * 何も無ければ入れ物を隠す。
	 * @param {HTMLElement} container 入れ物
	 * @param {number} imageCount
	 * @param {PreviewHandlers} handlers
	 * @returns {void}
	 */
	render(container, imageCount, handlers) {
		try {
			const doc = container.ownerDocument;
			const parts = [];
			const text = {...this.compose.text, ...this.cards.text};
			if (this.gif) {
				const {item, alt} = this.gif;
				parts.push({
					key: JSON.stringify(['gif', item.id, item.gifUrl, item.playerUrl, alt]),
					build: () => this.buildGifPreview(doc, text, handlers)
				});
			}
			const showCard = !this.hasMedia(imageCount);
			const card = this.card;
			if (showCard && card && card.status === 'ready' && card.data) {
				const thumbUrl = card.thumb && card.thumb.status === 'ready' ? card.thumb.url : '';
				parts.push({
					key: JSON.stringify(['card', card.url, card.data.title, card.data.description, thumbUrl]),
					build: () => this.buildCardPreview(doc, text, handlers, card, thumbUrl)
				});
			}
			if (this.quote && this.quote.status === 'ready') {
				const model = this.quoteModel();
				if (model) {
					const blurText = this.quoteBlurText(model);
					parts.push({
						key: JSON.stringify(['quote', this.quote.ref.uri, this.quote.ref.cid, blurText]),
						build: () => buildQuoteCard(doc, model, {
							classes: this.cards.classes,
							text,
							blurText,
							formatDate: this.deps.formatDate,
							onRemove: withRemoved(() => this.removeQuote(), handlers)
						})
					});
				}
			}
			const cardLoading = showCard && card && card.status === 'loading';
			const quoteLoading = this.quote && this.quote.status === 'loading';
			if (cardLoading || quoteLoading) {
				parts.push({key: 'status', build: () => this.buildLoadingLine(doc)});
			}
			if (this.notice) {
				const message = this.notice;
				parts.push({
					key: JSON.stringify(['notice', message]),
					build: () => {
						const notice = createElement(doc, 'p', this.config.classes.error, message);
						notice.setAttribute('role', 'alert');
						return notice;
					}
				});
			}
			const nodes = syncKeyedParts(container, parts);
			container.hidden = nodes.length === 0;
		} catch (error) {
			console.error('[XViewer] 入力欄の添付のプレビューを描けませんでした', error);
		}
	}

	/**
	 * 取得中の 1 行を組む。
	 * @param {Document} doc
	 * @returns {HTMLElement}
	 */
	buildLoadingLine(doc) {
		const status = createElement(doc, 'div', this.config.classes.status);
		status.setAttribute('role', 'status');
		status.append(createElement(doc, 'p', undefined, this.compose.text.cardLoading));
		return status;
	}

	/**
	 * リンクカードのプレビューを組む。サムネイルは取得できた画像の object URL で出す (取れるまでは画像無し)。
	 * @param {Document} doc
	 * @param {Object} text 文言 (compose.text と cards.text を合わせたもの)
	 * @param {PreviewHandlers} handlers
	 * @param {CardState} card
	 * @param {string} thumbUrl サムネイルの object URL (無ければ空)
	 * @returns {HTMLElement}
	 */
	buildCardPreview(doc, text, handlers, card, thumbUrl) {
		const external = {uri: card.url, title: card.data.title, description: card.data.description};
		if (thumbUrl) external.thumb = thumbUrl;
		return buildLinkCard(doc, external, {
			classes: this.cards.classes,
			text,
			safeHref: this.deps.safeHref,
			blurText: null,
			onRemove: withRemoved(() => this.removeCard(), handlers)
		});
	}

	/**
	 * 取得できた引用を QuoteModel にする。
	 * @returns {import('./embed-cards.js').QuoteModel|null}
	 */
	quoteModel() {
		const viewRecord = this.quote ? toQuoteViewRecord(this.quote.post) : null;
		if (!viewRecord) return null;
		return classifyEmbedView({$type: this.cards.types.record, record: viewRecord}, this.cards.types).quote;
	}

	/**
	 * 引用元の画像をぼかす理由。依存が無ければぼかさない。
	 * @param {import('./embed-cards.js').QuoteModel} model
	 * @returns {string|null}
	 */
	quoteBlurText(model) {
		if (typeof this.deps.blurText !== 'function') return null;
		try {
			return this.deps.blurText(model.labels || []) || null;
		} catch (_e) {
			return null;
		}
	}

	/**
	 * GIF のプレビューを組む。動画の URL が無ければプレビュー画像で出す。
	 * @param {Document} doc
	 * @param {Object} text 文言 (compose.text と cards.text を合わせたもの)
	 * @param {PreviewHandlers} handlers
	 * @returns {HTMLElement}
	 */
	buildGifPreview(doc, text, handlers) {
		const {item, alt} = this.gif;
		const player = this.gifPreviewPlayer(item);
		const label = alt || item.title;
		const root = buildGifPlayer(doc, player, {
			classes: this.cards.classes,
			text,
			label,
			autoplay: !prefersReducedMotion(doc.defaultView),
			posterUrl: item.previewUrl,
			onRemove: withRemoved(() => this.removeGif(), handlers),
			onAlt: handlers && typeof handlers.onGifAlt === 'function' ? handlers.onGifAlt : undefined,
			altDone: alt !== ''
		});
		if (player.sources.length === 0) {
			// 流す動画が無いときは、動画と再生ボタンを静止画に差し替える
			const classes = this.cards.classes;
			const poster = createElement(doc, 'img', classes.gifPoster);
			poster.setAttribute('src', item.previewUrl);
			poster.setAttribute('alt', label);
			const rest = Array.from(root.children).filter((child) =>
				!child.classList.contains(classes.gifVideo) && !child.classList.contains(classes.gifPlay));
			root.replaceChildren(poster, ...rest);
		}
		return root;
	}

	/**
	 * プレビューで流す動画。一覧の動画の URL、無ければ GIF の URL から本体と同じ規則で作る。
	 * @param {GifItem} item
	 * @returns {{sources: Array<{src: string, type: string}>, width: number, height: number}}
	 */
	gifPreviewPlayer(item) {
		if (item.playerUrl) {
			return {sources: [{src: item.playerUrl, type: GIF_PREVIEW_MIME}], width: item.width, height: item.height};
		}
		const rule = this.compose.gif;
		const fromUri = gifPlayerFromUri(buildGifExternal(item, '', null).external.uri, {
			klipy: {sourceHost: rule.sourceHost, playerHost: rule.playerHost},
			tenor: rule.tenor
		});
		return fromUri || {sources: [], width: item.width, height: item.height};
	}

	/**
	 * 送信の直前に、GIF かカードの external と引用する投稿 (uri と cid) を組み立てる。サムネイルの取得・縮小・
	 * アップロードのどこで失敗しても thumb 無しで作る。例外を投げない。
	 * カードのサムネイルは取得済みの画像を縮めるだけで、取り直さない (取得中なら終わるのを待つ)。
	 * @param {(done: number, total: number) => void} onProgress サムネイルの進み具合
	 * @param {number} [imageCount] 画像の枚数。画像があるときはカードを付けない
	 * @returns {Promise<SubmitExtras>}
	 */
	async resolveForSubmit(onProgress, imageCount = 0) {
		const result = {external: null, quote: null, quoteView: null};
		try {
			const gif = this.gif;
			const card = this.sendableCard(imageCount);
			const quote = this.quote && this.quote.status === 'ready' ? this.quote : null;
			if (quote) {
				result.quote = {uri: quote.ref.uri, cid: quote.ref.cid};
				result.quoteView = toQuoteViewRecord(quote.post);
			}
			if (gif) {
				const previewUrl = gif.item.previewUrl;
				const load = previewUrl ? () => this.deps.fetchBlob(previewUrl, this.compose.gif.timeoutMs) : null;
				const thumb = await this.uploadThumb(load, onProgress);
				result.external = buildGifExternal(gif.item, gif.alt, thumb, {
					maxTitleGraphemes: RECORD_RULES.external.maxTitleGraphemes,
					maxDescriptionGraphemes: RECORD_RULES.external.maxDescriptionGraphemes
				});
			} else if (card && card.data) {
				const cardThumb = card.thumb;
				const thumb = await this.uploadThumb(cardThumb ? () => cardThumb.done : null, onProgress);
				const external = {uri: card.url, title: card.data.title, description: card.data.description};
				if (thumb) external.thumb = thumb;
				result.external = {$type: RECORD_RULES.embedTypes.external, external};
			}
		} catch (error) {
			console.error('[XViewer] 返信の添付を組み立てられませんでした', error);
		}
		return result;
	}

	/**
	 * サムネイルの画像を縮小してアップロードする。プレビューの object URL は作らせない。
	 * @param {(() => Promise<Blob|null>)|null} load 画像を得る (無ければサムネイル無し)
	 * @param {(done: number, total: number) => void} onProgress
	 * @returns {Promise<Object|null>} BlobRef。失敗は null
	 */
	async uploadThumb(load, onProgress) {
		if (typeof load !== 'function') return null;
		const report = (done) => {
			try {
				if (typeof onProgress === 'function') onProgress(done, 1);
			} catch (_e) {
				// 進み具合の表示の失敗は送信を止めない
			}
		};
		report(0);
		try {
			const blob = await load();
			if (!blob) return null;
			const prepared = await this.deps.prepareImage(blob, null, this.compose.thumb, {preview: false});
			// 作らない指定でも作られていたら捨てる
			if (prepared) revokeObjectUrl(prepared.previewUrl);
			if (!prepared || !prepared.blob) return null;
			const uploaded = await this.deps.uploadBlob(prepared.blob);
			return uploaded && uploaded.ok && uploaded.blob ? uploaded.blob : null;
		} catch (error) {
			console.error('[XViewer] リンクのサムネイルを送れませんでした', error);
			return null;
		} finally {
			report(1);
		}
	}

	/**
	 * 空に戻す (送信の後)。取得中の応答は以後捨て、通信も止める。
	 * @returns {void}
	 */
	reset() {
		this.gif = null;
		this.dropCard();
		this.dropQuote();
		this.suppressed.clear();
		this.previousLinks = [];
		this.links = [];
		this.clearNotice();
	}

	/**
	 * 撤去する。以後の応答・入力は何もしない。
	 * @returns {void}
	 */
	destroy() {
		this.reset();
		this.destroyed = true;
	}
}
