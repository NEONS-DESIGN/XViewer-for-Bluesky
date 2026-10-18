/**
 * 返信の一覧と入力欄のプレビューで共通の、リンクカード・引用カード・GIF の部品。
 * embed の view の分類は純関数で、DOM の組み立ては文書と設定を引数で受け取る。
 */

import {createElement} from './sheet-dom.js';
import {createIconButton} from './reply-attachments.js';

/** 引用先の投稿に付いた画像のサムネイルを探す深さの上限 (embeds の入れ子) */
const MAX_EMBED_DEPTH = 2;

/**
 * @typedef {Object} QuoteModel
 * @property {'post'|'unavailable'} kind 投稿か、見つからない・ブロック・分離で出せないか
 * @property {string} [uri] 引用元の AT URI
 * @property {string} [cid] 引用元の CID
 * @property {string} [handle] 作者のハンドル
 * @property {string} [displayName] 作者の表示名
 * @property {string|null} [avatarUrl] 作者のアイコンの URL
 * @property {string} [text] 本文
 * @property {string} [createdAt] 投稿日時 (ISO 8601)
 * @property {string} [rkey] 投稿の rkey (URI の末尾)
 * @property {string|null} [imageUrl] 引用元の先頭の画像のサムネイル
 * @property {string[]} [labels] ラベルの値
 */

/**
 * @typedef {Object} EmbedClassification
 * @property {Object|null} media images / gallery の view
 * @property {Object|null} external external の view の中身 ({uri, title, description, thumb})
 * @property {QuoteModel|null} quote 引用
 * @property {Object|null} video video#view
 * @property {boolean} other 出せない種類 (フィードやリストなどの投稿でない record) を含むか
 */

/**
 * 文字列か。
 * @param {*} value
 * @returns {string|undefined}
 */
function str(value) {
	return typeof value === 'string' ? value : undefined;
}

/**
 * view から先頭の画像のサムネイルを探す。recordWithMedia の中も見る。
 * @param {Object} view embed の view
 * @param {Object} rule EXT_CONFIG.lightboxReplies.cards.types
 * @param {number} depth 入れ子の深さ
 * @returns {string|null}
 */
function firstThumb(view, rule, depth) {
	if (!view || typeof view !== 'object' || depth > MAX_EMBED_DEPTH) return null;
	if (view.$type === rule.images && Array.isArray(view.images)) {
		return str(view.images[0] && view.images[0].thumb) || null;
	}
	if (view.$type === rule.gallery && Array.isArray(view.items)) {
		return str(view.items[0] && view.items[0].thumbnail) || null;
	}
	if (view.$type === rule.recordWithMedia) {
		return firstThumb(view.media, rule, depth + 1);
	}
	return null;
}

/**
 * 引用先の record の view を QuoteModel にする。投稿でも出せない種類でもなければ null。
 * @param {Object} record record#view の record
 * @param {Object} rule EXT_CONFIG.lightboxReplies.cards.types
 * @returns {QuoteModel|null}
 */
function toQuoteModel(record, rule) {
	if (!record || typeof record !== 'object') return null;
	if (record.$type === rule.viewNotFound || record.$type === rule.viewBlocked || record.$type === rule.viewDetached) {
		return {kind: 'unavailable', uri: str(record.uri)};
	}
	if (record.$type !== rule.viewRecord) return null;
	const author = record.author || {};
	const value = record.value || {};
	const uri = str(record.uri);
	const embeds = Array.isArray(record.embeds) ? record.embeds : [];
	return {
		kind: 'post',
		uri,
		cid: str(record.cid),
		handle: str(author.handle),
		displayName: str(author.displayName),
		avatarUrl: str(author.avatar) || null,
		text: str(value.text) || '',
		createdAt: str(value.createdAt) || str(record.indexedAt),
		rkey: uri ? uri.split('/').pop() : undefined,
		imageUrl: firstThumb(embeds[0], rule, 0),
		labels: Array.isArray(record.labels) ? record.labels.map((one) => one && one.val).filter((one) => typeof one === 'string') : []
	};
}

/**
 * embed の view を、メディア・リンクカード・引用に分ける。
 * @param {Object|null} view 投稿の embed の view
 * @param {Object} rule EXT_CONFIG.lightboxReplies.cards.types
 * @returns {EmbedClassification}
 */
export function classifyEmbedView(view, rule) {
	const result = {media: null, external: null, quote: null, video: null, other: false};
	try {
		if (!view || typeof view !== 'object') return result;
		if (view.$type === rule.images || view.$type === rule.gallery) {
			result.media = view;
		} else if (view.$type === rule.external) {
			result.external = view.external || null;
		} else if (view.$type === rule.video) {
			result.video = view;
		} else if (view.$type === rule.record) {
			applyRecord(result, view.record, rule);
		} else if (view.$type === rule.recordWithMedia) {
			applyRecord(result, view.record && view.record.record, rule);
			const media = view.media || {};
			if (media.$type === rule.images || media.$type === rule.gallery) {
				result.media = media;
			} else if (media.$type === rule.external) {
				result.external = media.external || null;
			} else if (media.$type === rule.video) {
				result.video = media;
			} else {
				result.other = true;
			}
		}
	} catch (_e) {
		return {media: null, external: null, quote: null, video: null, other: false};
	}
	return result;
}

/**
 * record の部分を分類の結果へ反映する。
 * @param {EmbedClassification} result
 * @param {Object} record
 * @param {Object} rule
 * @returns {void}
 */
function applyRecord(result, record, rule) {
	const quote = toQuoteModel(record, rule);
	if (quote) {
		result.quote = quote;
	} else {
		result.other = true;
	}
}

/**
 * 動きを減らす設定か。
 * @param {Window} win
 * @returns {boolean}
 */
export function prefersReducedMotion(win) {
	try {
		return Boolean(win.matchMedia('(prefers-reduced-motion: reduce)').matches);
	} catch (_e) {
		return false;
	}
}

/**
 * 外すボタン (右上の ×)。押しても親の押下は起こさない。
 * @param {Document} doc
 * @param {Object} classes cards.classes
 * @param {string} label ボタンの名前
 * @param {() => void} onRemove
 * @returns {HTMLButtonElement}
 */
function createRemoveButton(doc, classes, label, onRemove) {
	const button = createIconButton(doc, classes.remove, 'close', label);
	button.addEventListener('click', (event) => {
		event.preventDefault();
		event.stopPropagation();
		onRemove();
	});
	return button;
}

/**
 * 外すボタンを持つカードを、ボタンがカードの入れ子にならないよう枠で包む。
 * ボタンが要らなければカードをそのまま返す。
 * @param {Document} doc
 * @param {Object} classes cards.classes
 * @param {HTMLElement} card
 * @param {HTMLButtonElement|null} remove
 * @returns {HTMLElement}
 */
function wrapWithRemove(doc, classes, card, remove) {
	if (!remove) return card;
	const frame = createElement(doc, 'div', classes.cardFrame);
	frame.append(card, remove);
	return frame;
}

/**
 * ぼかす画像の入れ物に、ぼかしの印と理由の文言を付ける。
 * @param {Document} doc
 * @param {Object} classes cards.classes
 * @param {HTMLElement} holder 画像を入れる要素
 * @param {string|null} blurText ぼかすときの理由 (null ならぼかさない)
 * @returns {void}
 */
function applyBlur(doc, classes, holder, blurText) {
	if (!blurText) return;
	holder.classList.add(classes.blurred);
	holder.append(createElement(doc, 'span', classes.blurLabel, blurText));
}

/**
 * URL の表示用のホスト名。解釈できなければ空。
 * @param {string} uri
 * @returns {string}
 */
function hostOf(uri) {
	try {
		return new URL(uri).hostname;
	} catch (_e) {
		return '';
	}
}

/**
 * リンクカードを組み立てる。
 * @param {Document} doc
 * @param {{uri: string, title?: string, description?: string, thumb?: string}} external
 * @param {{classes: Object, text: Object, safeHref: (uri: string) => string|null, blurText: string|null, onRemove?: () => void}} opts
 * @returns {HTMLElement}
 */
export function buildLinkCard(doc, external, opts) {
	const {classes, text} = opts;
	const href = opts.safeHref(external.uri);
	const card = typeof href === 'string' ? createElement(doc, 'a', classes.linkCard) : createElement(doc, 'div', classes.linkCard);
	if (typeof href === 'string') {
		card.setAttribute('href', href);
		card.setAttribute('target', '_blank');
		card.setAttribute('rel', 'noopener noreferrer');
	}
	if (external.thumb) {
		const holder = createElement(doc, 'span', classes.linkCardThumb);
		const image = createElement(doc, 'img');
		image.setAttribute('src', external.thumb);
		image.setAttribute('alt', '');
		image.setAttribute('loading', 'lazy');
		holder.append(image);
		applyBlur(doc, classes, holder, opts.blurText);
		card.append(holder);
	}
	const body = createElement(doc, 'span', classes.linkCardBody);
	if (external.title) body.append(createElement(doc, 'span', classes.linkCardTitle, external.title));
	if (external.description) body.append(createElement(doc, 'span', classes.linkCardDescription, external.description));
	const host = hostOf(external.uri);
	if (host) body.append(createElement(doc, 'span', classes.linkCardHost, host));
	card.append(body);
	const remove = opts.onRemove ? createRemoveButton(doc, classes, text.removeCard, opts.onRemove) : null;
	return wrapWithRemove(doc, classes, card, remove);
}

/**
 * 引用カードを組み立てる。onOpen があればカード全体が押せる。
 * @param {Document} doc
 * @param {QuoteModel} model
 * @param {{classes: Object, text: Object, onOpen?: () => void, blurText: string|null, onRemove?: () => void, formatDate: (iso: string) => string}} opts
 * @returns {HTMLElement}
 */
export function buildQuoteCard(doc, model, opts) {
	const {classes, text} = opts;
	const card = createElement(doc, 'div', classes.quote);
	if (model.kind !== 'post') {
		card.classList.add(classes.quoteUnavailable);
		card.append(createElement(doc, 'span', classes.quoteText, text.quoteUnavailable));
	} else {
		const head = createElement(doc, 'span', classes.quoteHead);
		const avatar = createElement(doc, 'span', classes.quoteAvatar);
		if (model.avatarUrl) {
			const image = createElement(doc, 'img');
			image.setAttribute('src', model.avatarUrl);
			image.setAttribute('alt', '');
			avatar.append(image);
		}
		head.append(avatar);
		head.append(createElement(doc, 'span', classes.quoteName, model.displayName || model.handle || ''));
		if (model.handle) head.append(createElement(doc, 'span', classes.quoteHandle, `@${model.handle}`));
		if (model.createdAt) head.append(createElement(doc, 'span', classes.quoteDate, opts.formatDate(model.createdAt)));
		card.append(head);
		if (model.text) card.append(createElement(doc, 'span', classes.quoteText, model.text));
		if (model.imageUrl) {
			const holder = createElement(doc, 'span', classes.quoteImage);
			const image = createElement(doc, 'img');
			image.setAttribute('src', model.imageUrl);
			image.setAttribute('alt', text.quoteImage);
			image.setAttribute('loading', 'lazy');
			holder.append(image);
			applyBlur(doc, classes, holder, opts.blurText);
			card.append(holder);
		}
	}
	if (opts.onOpen && model.kind === 'post') {
		const onOpen = opts.onOpen;
		card.setAttribute('role', 'button');
		card.setAttribute('tabindex', '0');
		card.addEventListener('click', () => onOpen());
		card.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				onOpen();
			}
		});
	}
	const remove = opts.onRemove ? createRemoveButton(doc, classes, text.removeQuote, opts.onRemove) : null;
	return wrapWithRemove(doc, classes, card, remove);
}

/**
 * 再生と停止を切り替えるボタン。video の play / pause に合わせて名前と見た目 (is-playing) を変える。
 * 押しても親の押下は起こさない。
 * @param {Document} doc
 * @param {HTMLVideoElement} video
 * @param {string} className ボタンのクラス
 * @param {{play: string, pause: string}} labels 止まっているとき・流れているときのボタンの名前
 * @param {boolean} playing 作った時点の名前を「止める」にするか (自動再生のとき)
 * @returns {HTMLButtonElement}
 */
function createPlayToggle(doc, video, className, labels, playing) {
	const toggle = createIconButton(doc, className, 'playArrow', playing ? labels.pause : labels.play);
	const sync = () => {
		const nowPlaying = !video.paused;
		const label = nowPlaying ? labels.pause : labels.play;
		toggle.setAttribute('aria-label', label);
		toggle.title = label;
		toggle.classList.toggle('is-playing', nowPlaying);
	};
	toggle.addEventListener('click', (event) => {
		event.preventDefault();
		event.stopPropagation();
		try {
			if (video.paused) {
				const started = video.play();
				if (started && typeof started.catch === 'function') started.catch(() => {});
			} else {
				video.pause();
			}
		} catch (_e) {
			// 再生できない環境では何もしない
		}
	});
	video.addEventListener('play', sync);
	video.addEventListener('pause', sync);
	return toggle;
}

/**
 * フォーカスを移す。移せなくても何もしない。
 * @param {HTMLElement|null} element
 * @returns {void}
 */
function focusSafely(element) {
	try {
		if (element && typeof element.focus === 'function') element.focus();
	} catch (_e) {
		// フォーカスを移せない環境では何もしない
	}
}

/**
 * GIF のプレイヤーを組み立てる。動画は消音・ループ・インライン再生。
 * autoplay が偽なら、押すと再生・停止できる再生ボタンを重ねる。
 * @param {Document} doc
 * @param {{sources: Array<{src: string, type: string}>, width: number, height: number}} player
 * @param {{classes: Object, text: Object, label: string, autoplay: boolean, posterUrl?: string|null, onRemove?: () => void, onAlt?: (button: HTMLButtonElement) => void, altDone?: boolean}} opts
 * @returns {HTMLElement}
 */
export function buildGifPlayer(doc, player, opts) {
	const {classes, text} = opts;
	const root = createElement(doc, 'div', classes.gif);
	if (root.style && player.width > 0 && player.height > 0) {
		root.style.aspectRatio = `${player.width} / ${player.height}`;
	}
	const video = createElement(doc, 'video', classes.gifVideo);
	video.muted = true;
	video.loop = true;
	video.playsInline = true;
	video.setAttribute('muted', '');
	video.setAttribute('loop', '');
	video.setAttribute('playsinline', '');
	video.setAttribute('preload', 'auto');
	video.setAttribute('aria-label', opts.label);
	for (const one of player.sources) {
		const source = createElement(doc, 'source');
		source.setAttribute('src', one.src);
		source.setAttribute('type', one.type);
		video.append(source);
	}
	root.append(video);

	const toggle = createPlayToggle(doc, video, classes.gifPlay, {play: text.gifPlay, pause: text.gifPause}, opts.autoplay);
	root.append(toggle);

	// 読み込みの失敗は video ではなく各 source に飛び、バブリングもしない。全部が失敗したら静止画にする
	const showPoster = () => {
		if (!opts.posterUrl || !video.parentNode) return;
		const poster = createElement(doc, 'img', classes.gifPoster);
		poster.setAttribute('src', opts.posterUrl);
		poster.setAttribute('alt', opts.label);
		const rest = Array.from(root.children).filter((child) => child !== video && child !== toggle);
		root.replaceChildren(poster, ...rest);
	};
	let failedSources = 0;
	for (const source of video.children) {
		source.addEventListener('error', () => {
			failedSources += 1;
			if (failedSources >= player.sources.length) showPoster();
		});
	}
	video.addEventListener('error', showPoster);

	if (opts.autoplay) {
		video.autoplay = true;
		video.setAttribute('autoplay', '');
		try {
			const started = video.play();
			if (started && typeof started.catch === 'function') started.catch(() => {});
		} catch (_e) {
			// 自動再生が拒まれたときは再生ボタンから始められる
		}
	}

	if (opts.onAlt || opts.onRemove) {
		const tools = createElement(doc, 'span', classes.gifTools);
		if (opts.onAlt) {
			const onAlt = opts.onAlt;
			const alt = createElement(doc, 'button', classes.gifAlt, opts.altDone ? text.gifAltDone : text.gifAlt);
			alt.type = 'button';
			if (opts.altDone) alt.classList.add(classes.gifAltDone);
			alt.addEventListener('click', (event) => {
				event.preventDefault();
				event.stopPropagation();
				onAlt(alt);
			});
			tools.append(alt);
		}
		if (opts.onRemove) tools.append(createRemoveButton(doc, classes, text.removeGif, opts.onRemove));
		root.append(tools);
	}
	return root;
}

/**
 * 寸法として使える {width, height} か。
 * @param {*} ratio
 * @returns {boolean}
 */
function isAspect(ratio) {
	return !!ratio && ratio.width > 0 && ratio.height > 0;
}

/**
 * 動画のカードを組み立てる。サムネイルと再生ボタンを出し、押すと video に替えて再生を始め、video へフォーカスを移す。
 * 再生できなければ「投稿で見る」(onOpenPost があるときだけ) に替える。
 * presentation が gif の動画は消音・ループ・操作部なしで、autoplay が真なら最初から流す。
 * 操作部の代わりに、押すと停止と再生を切り替えるボタンを重ねる (再生ボタンから始めたときはそこへフォーカスを移す)。
 * @param {Document} doc
 * @param {{playlist?: string, thumbnail?: string, alt?: string, aspectRatio?: {width: number, height: number}, presentation?: string}} view video#view
 * @param {{classes: Object, text: Object, autoplay: boolean, blurText: string|null, defaultAspect?: {width: number, height: number}, startPlayback: (video: HTMLVideoElement, url: string) => Promise<boolean>, onOpenPost: (() => void)|null}} opts
 *   defaultAspect は view に縦横比が無いときに使う (無ければ縦横比を指定しない)
 * @returns {HTMLElement}
 */
export function buildVideoCard(doc, view, opts) {
	const {classes, text} = opts;
	const isGif = view.presentation === 'gif';
	const root = createElement(doc, 'div', classes.video);
	const ratio = isAspect(view.aspectRatio) ? view.aspectRatio : (isAspect(opts.defaultAspect) ? opts.defaultAspect : null);
	if (root.style && ratio) root.style.aspectRatio = `${ratio.width} / ${ratio.height}`;
	const label = view.alt || text.videoLabel;

	const holder = createElement(doc, 'span', classes.videoThumb);
	if (view.thumbnail) {
		const image = createElement(doc, 'img');
		image.setAttribute('src', view.thumbnail);
		image.setAttribute('alt', label);
		image.setAttribute('loading', 'lazy');
		holder.append(image);
	}
	root.append(holder);
	applyBlur(doc, classes, root, opts.blurText);
	const play = createIconButton(doc, classes.videoPlay, 'playArrow', text.videoPlay);
	root.append(play);

	let started = false;
	/**
	 * 「投稿で見る」に替える。
	 * @returns {HTMLButtonElement|null} 出したボタン (onOpenPost が無ければ null)
	 */
	const showFallback = () => {
		const items = Array.from(root.children).filter((child) => child.classList && child.classList.contains(classes.videoPlayer));
		for (const one of items) one.remove();
		if (!opts.onOpenPost) return null;
		const onOpenPost = opts.onOpenPost;
		const button = createElement(doc, 'button', classes.videoFallback, text.videoOpenPost);
		button.type = 'button';
		button.addEventListener('click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			onOpenPost();
		});
		root.append(button);
		return button;
	};
	/**
	 * 再生を始める。
	 * @param {boolean} fromButton 再生ボタンから始めたか (フォーカスを移す)
	 * @returns {Promise<void>}
	 */
	const begin = async (fromButton) => {
		if (started || typeof view.playlist !== 'string') return;
		started = true;
		const video = createElement(doc, 'video', classes.videoPlayer);
		video.setAttribute('playsinline', '');
		video.playsInline = true;
		video.setAttribute('aria-label', label);
		if (isGif) {
			video.muted = true;
			video.loop = true;
			video.setAttribute('muted', '');
			video.setAttribute('loop', '');
		} else {
			video.controls = true;
			video.setAttribute('controls', '');
		}
		holder.remove();
		play.remove();
		root.append(video);
		const toggle = isGif
			? createPlayToggle(doc, video, classes.gifPlay, {play: text.videoPlay, pause: text.videoPause}, false)
			: null;
		if (toggle) root.append(toggle);
		// 押したボタンは外したため、フォーカスが文書の先頭へ落ちないよう再生の操作へ移す
		// (gif の video は操作部を持たずフォーカスできないため、切り替えのボタンへ)
		if (fromButton) focusSafely(toggle || video);
		const fail = () => {
			const active = doc.activeElement;
			const hadFocus = !!active && (active === video || active === toggle);
			video.remove();
			if (toggle) toggle.remove();
			const fallback = showFallback();
			if (hadFocus) focusSafely(fallback);
		};
		try {
			const ok = await opts.startPlayback(video, view.playlist);
			if (!ok) {
				fail();
				return;
			}
			// 再生が始まった後の致命的なエラー (hls.js が video に出す error) も投稿で見るに替える
			video.addEventListener('error', fail, {once: true});
			const result = video.play();
			if (result && typeof result.catch === 'function') result.catch(() => {});
		} catch (_e) {
			fail();
		}
	};
	play.addEventListener('click', (event) => {
		event.preventDefault();
		event.stopPropagation();
		begin(true);
	});
	if (isGif && opts.autoplay) begin(false);
	return root;
}
