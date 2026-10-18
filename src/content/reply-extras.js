/**
 * 返信の入力欄の GIF・リンクカード・引用の状態。
 * 本文のリンクからカードと引用を提案して取得し (取得ごとに番号を振り、古い応答は捨てる)、
 * プレビューを描き、送信のときに external と引用する投稿 (uri と cid) を組み立てる。通信は依存として受け取る。
 */

import {BRIDGE_PROTOCOL} from '../common/bridge-protocol.js';
import {pickSuggestion, pruneDismissed, parsePostUrl, parseCardResponse} from './reply-links.js';
import {buildGifExternal, gifPlayerFromUri} from './klipy.js';
import {toQuoteViewRecord} from './reply-embed.js';
import {buildLinkCard, buildQuoteCard, buildGifPlayer, classifyEmbedView, prefersReducedMotion} from './embed-cards.js';
import {createElement} from './sheet-dom.js';

/** 返信の record に付ける embed の $type と external の上限 */
const RECORD_RULES = BRIDGE_PROTOCOL.postRecord;

/** 入力欄のプレビューで GIF の動画として流す形式 */
const GIF_PREVIEW_MIME = 'video/webm';

/** 投稿の AT URI の collection */
const POST_COLLECTION = BRIDGE_PROTOCOL.collections.post;

/** URL のバイト数を数える変換器 */
const utf8Encoder = new TextEncoder();

/**
 * @typedef {import('./klipy.js').GifItem} GifItem
 */

/**
 * @typedef {Object} GifState
 * @property {GifItem} item 選んだ GIF
 * @property {string} alt ALT 文 (未入力は空文字)
 */

/**
 * @typedef {Object} CardState
 * @property {string} url 本文のリンクの URL
 * @property {'loading'|'ready'} status
 * @property {{title: string, description: string, imageUrl: string|null}|null} data 取得できたカードの中身
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
 * @typedef {Object} ExtrasDeps
 * @property {(url: string, timeoutMs: number) => Promise<{status: number, json: any}|null>} fetchJson
 * @property {(url: string, timeoutMs: number) => Promise<Blob|null>} fetchBlob
 * @property {(handle: string) => Promise<string|null>} resolveHandle ハンドルを DID に直す
 * @property {(uri: string) => Promise<Object|null>} fetchPost getPosts の応答 ({posts: PostView[]})
 * @property {(blob: Blob, crop: null, rules: Object) => Promise<{blob: Blob, previewUrl?: string|null}|null>} prepareImage
 * @property {(blob: Blob) => Promise<{ok: boolean, blob: Object|null, reason: string|null}>} uploadBlob
 * @property {(uri: string) => string|null} safeHref リンクにしてよい URL か
 * @property {(iso: string) => string} formatDate 引用元の日時の表示
 * @property {() => void} onChange 状態が変わったことを入力欄へ知らせる
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
	 * @param {ExtrasDeps} deps
	 */
	constructor(config, deps) {
		this.config = config;
		this.compose = config.compose;
		this.cards = config.cards;
		this.deps = deps;
		/** @type {GifState|null} */
		this.gif = null;
		/** @type {CardState|null} */
		this.card = null;
		/** @type {QuoteState|null} */
		this.quote = null;
		/** × で外した URL (本文に残っているあいだ再提案しない) @type {string[]} */
		this.dismissed = [];
		/** 1 行で出す知らせ @type {string|null} */
		this.notice = null;
		/** 知らせの元になった URL (本文から消えたら知らせも消す) @type {string|null} */
		this.noticeUrl = null;
		/** 取得に失敗したカードの URL (本文に残っているあいだ取り直さない) @type {string[]} */
		this.failedCards = [];
		/** 付けられなかった引用の URL (同じ) @type {string[]} */
		this.failedQuotes = [];
		/** 前回の本文の link の URL @type {string[]} */
		this.previousLinks = [];
		/** 今の本文の link の URL @type {string[]} */
		this.links = [];
		/** 取得の番号。取得を始める・外す・空に戻すたびに進め、届いた応答と照らす */
		this.cardSeq = 0;
		this.quoteSeq = 0;
		this.destroyed = false;
	}

	/**
	 * 状態が変わったことを知らせる。
	 * @returns {void}
	 */
	notify() {
		if (this.destroyed) return;
		try {
			this.deps.onChange();
		} catch (error) {
			console.error('[XViewer] 入力欄の添付の変化を知らせられませんでした', error);
		}
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
			this.dismissed = pruneDismissed(this.dismissed, current);
			this.failedCards = pruneDismissed(this.failedCards, current);
			this.failedQuotes = pruneDismissed(this.failedQuotes, current);
			if (this.card && !current.includes(this.card.url)) {
				this.card = null;
				this.cardSeq += 1;
				changed = true;
			}
			if (this.quote && !current.includes(this.quote.url)) {
				this.quote = null;
				this.quoteSeq += 1;
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
			const cardUrl = pickSuggestion({...base, dismissed: this.dismissed.concat(this.failedCards)}).card;
			const quoteUrl = pickSuggestion({...base, dismissed: this.dismissed.concat(this.failedQuotes)}).quote;
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
		return utf8Encoder.encode(url).length <= RECORD_RULES.external.maxUriBytes;
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
	 * 応答を反映してよいか。外された・取り直された・本文から消えた・撤去された後なら偽。
	 * @param {'card'|'quote'} kind
	 * @param {number} seq 取得を始めたときの番号
	 * @param {string} url
	 * @returns {boolean}
	 */
	isCurrentFetch(kind, seq, url) {
		if (this.destroyed || !this.links.includes(url)) return false;
		const state = kind === 'card' ? this.card : this.quote;
		const currentSeq = kind === 'card' ? this.cardSeq : this.quoteSeq;
		return seq === currentSeq && state !== null && state.url === url && state.status === 'loading';
	}

	/**
	 * リンクカードを取得する。失敗したらカードを付けない。
	 * @param {string} url
	 * @returns {Promise<void>}
	 */
	async startCard(url) {
		this.cardSeq += 1;
		const seq = this.cardSeq;
		this.card = {url, status: 'loading', data: null};
		let data = null;
		try {
			const rule = this.compose.card;
			const response = await this.deps.fetchJson(`${rule.extractUrl}?url=${encodeURIComponent(url)}`, rule.timeoutMs);
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
		if (!this.isCurrentFetch('card', seq, url)) return;
		if (data) {
			this.card = {url, status: 'ready', data};
		} else {
			this.card = null;
			this.failedCards.push(url);
		}
		this.notify();
	}

	/**
	 * 引用する投稿を引く。見つからない・引用できないときは付けずに 1 行で知らせる。
	 * @param {string} url
	 * @returns {Promise<void>}
	 */
	async startQuote(url) {
		this.quoteSeq += 1;
		const seq = this.quoteSeq;
		this.quote = {url, status: 'loading', post: null, ref: null};
		if (this.noticeUrl !== null) this.clearNotice();
		let post = null;
		let failure = this.cards.text.quoteNotFound;
		try {
			const parsed = parsePostUrl(url, this.compose.quote.hosts);
			if (parsed) {
				const did = parsed.actor.startsWith('did:') ? parsed.actor : await this.deps.resolveHandle(parsed.actor);
				if (!this.isCurrentFetch('quote', seq, url)) return;
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
		if (!this.isCurrentFetch('quote', seq, url)) return;
		if (post) {
			this.quote = {url, status: 'ready', post, ref: {uri: post.uri, cid: post.cid}};
		} else {
			this.quote = null;
			this.failedQuotes.push(url);
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
		if (!this.dismissed.includes(this.card.url)) this.dismissed.push(this.card.url);
		this.card = null;
		this.cardSeq += 1;
		this.notify();
	}

	/**
	 * 引用を外し、その URL を本文に残っているあいだ再提案しない。
	 * @returns {void}
	 */
	removeQuote() {
		if (!this.quote) return;
		if (!this.dismissed.includes(this.quote.url)) this.dismissed.push(this.quote.url);
		this.quote = null;
		this.quoteSeq += 1;
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
	 * カードか引用を取得中か。送信は止めない (取得中のものは送らない)。
	 * @returns {boolean}
	 */
	isLoading() {
		return Boolean((this.card && this.card.status === 'loading') || (this.quote && this.quote.status === 'loading'));
	}

	/**
	 * プレビューを描き直す。GIF・カード (メディアがあれば出さない)・引用カード・取得中や知らせの 1 行の順。
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
			if (this.gif) parts.push(this.buildGifPreview(doc, text, handlers));
			const showCard = !this.hasMedia(imageCount);
			if (showCard && this.card && this.card.status === 'ready' && this.card.data) {
				const data = this.card.data;
				const external = {uri: this.card.url, title: data.title, description: data.description};
				if (data.imageUrl) external.thumb = data.imageUrl;
				parts.push(buildLinkCard(doc, external, {
					classes: this.cards.classes,
					text,
					safeHref: this.deps.safeHref,
					blurText: null,
					onRemove: withRemoved(() => this.removeCard(), handlers)
				}));
			}
			if (this.quote && this.quote.status === 'ready') {
				const model = this.quoteModel();
				if (model) {
					parts.push(buildQuoteCard(doc, model, {
						classes: this.cards.classes,
						text,
						blurText: this.quoteBlurText(model),
						formatDate: this.deps.formatDate,
						onRemove: withRemoved(() => this.removeQuote(), handlers)
					}));
				}
			}
			const cardLoading = showCard && this.card && this.card.status === 'loading';
			const quoteLoading = this.quote && this.quote.status === 'loading';
			if (cardLoading || quoteLoading) {
				const status = createElement(doc, 'div', this.config.classes.status);
				status.setAttribute('role', 'status');
				status.append(createElement(doc, 'p', undefined, this.compose.text.cardLoading));
				parts.push(status);
			}
			if (this.notice) {
				const notice = createElement(doc, 'p', this.config.classes.error, this.notice);
				notice.setAttribute('role', 'alert');
				parts.push(notice);
			}
			container.replaceChildren(...parts);
			container.hidden = parts.length === 0;
		} catch (error) {
			console.error('[XViewer] 入力欄の添付のプレビューを描けませんでした', error);
		}
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
				const thumb = await this.uploadThumb(gif.item.previewUrl, this.compose.gif.timeoutMs, onProgress);
				result.external = buildGifExternal(gif.item, gif.alt, thumb, {
					maxTitleGraphemes: RECORD_RULES.external.maxTitleGraphemes,
					maxDescriptionGraphemes: RECORD_RULES.external.maxDescriptionGraphemes
				});
			} else if (card && card.data) {
				const thumb = await this.uploadThumb(card.data.imageUrl, this.compose.card.timeoutMs, onProgress);
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
	 * サムネイルを取得・縮小してアップロードする。
	 * @param {string|null} url
	 * @param {number} timeoutMs
	 * @param {(done: number, total: number) => void} onProgress
	 * @returns {Promise<Object|null>} BlobRef。失敗は null
	 */
	async uploadThumb(url, timeoutMs, onProgress) {
		if (!url) return null;
		const report = (done) => {
			try {
				if (typeof onProgress === 'function') onProgress(done, 1);
			} catch (_e) {
				// 進み具合の表示の失敗は送信を止めない
			}
		};
		report(0);
		let prepared = null;
		try {
			const blob = await this.deps.fetchBlob(url, timeoutMs);
			if (!blob) return null;
			prepared = await this.deps.prepareImage(blob, null, this.compose.thumb);
			if (!prepared || !prepared.blob) return null;
			const uploaded = await this.deps.uploadBlob(prepared.blob);
			return uploaded && uploaded.ok && uploaded.blob ? uploaded.blob : null;
		} catch (error) {
			console.error('[XViewer] リンクのサムネイルを送れませんでした', error);
			return null;
		} finally {
			report(1);
			if (prepared && prepared.previewUrl) {
				try {
					URL.revokeObjectURL(prepared.previewUrl);
				} catch (_e) {
					// URL を破棄できない環境では何もしない
				}
			}
		}
	}

	/**
	 * 空に戻す (送信の後)。取得中の応答は以後捨てる。
	 * @returns {void}
	 */
	reset() {
		this.gif = null;
		this.card = null;
		this.quote = null;
		this.dismissed = [];
		this.failedCards = [];
		this.failedQuotes = [];
		this.previousLinks = [];
		this.links = [];
		this.clearNotice();
		this.cardSeq += 1;
		this.quoteSeq += 1;
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
