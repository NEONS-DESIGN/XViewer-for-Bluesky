/**
 * 返信の入力欄のうち投稿 1 件分。本文・添付 (画像 10 枚まで、GIF 1 つ、または動画 1 本)・ALT・切り抜き・
 * リンクカード・引用・コンテンツの警告・絵文字・貼り付けとドロップ・知らせの 1 行・ツールバー (画像・GIF・絵文字)・投稿を消す「×」を持つ。
 * 送るときは、送る blob の並び (uploadImages) と record の中身 (buildRecord) を入れ物へ渡す。
 *
 * **入れ物 (reply-composer.js) を import しない。** 中身が変わった・アクティブになった・送れと言われたは
 * 入れ物から渡された hooks で知らせ、投稿言語と送信中かどうかも hooks から読む。
 *
 * 依存: icons.js / reply-text.js / reply-embed.js / reply-sheets.js / reply-attachments.js / reply-submit.js /
 *       sheet-dom.js / reply-extras.js / reply-links.js / gif-sheet.js / klipy.js / bridge-protocol.js /
 *       reply-video.js / video-sheet.js / video-rules.js / reply-thread.js
 */
import {createIcon} from '../common/icons.js';
import {
	detectRichText, buildFacets, buildReplyRecord, primaryLanguage, fitTextareaHeight, countGraphemes
} from './reply-text.js';
import {
	buildSelfLabels, acceptImages, canSubmitComposer, normalizeLanguages, buildPostEmbed, hasLabelableMedia,
	buildOwnPostEmbedView
} from './reply-embed.js';
import {openAltSheet, openCropSheet, openLabelSheet, openEmojiSheet} from './reply-sheets.js';
import {renderAttachments, updateAttachmentCell, createIconButton} from './reply-attachments.js';
import {createElement, createButton, formatText, browserLocale} from './sheet-dom.js';
import {pickPastedMedia, hasMediaItems} from './reply-submit.js';
import {ComposerExtras} from './reply-extras.js';
import {shortenLinks} from './reply-links.js';
import {openGifSheet} from './gif-sheet.js';
import {GIF_ALT_PREFIX} from './klipy.js';
import {BRIDGE_PROTOCOL} from '../common/bridge-protocol.js';
import {ComposerVideo, readCaptionFile} from './reply-video.js';
import {openVideoSheet} from './video-sheet.js';
import {isVideoFile} from './video-rules.js';
import {isEmptyPost} from './reply-thread.js';

/** GIF の検索の応答で中身を使ってよい HTTP の状態 */
const GIF_OK_STATUS = 200;

/** 送る本文の末尾の空白 */
const TRAILING_SPACE = /\s+$/u;

/**
 * GIF の ALT 文の上限 (書記素)。description は接頭辞 + ALT 文で、橋渡しの external の説明の上限に収める
 */
const GIF_ALT_MAX_GRAPHEMES = BRIDGE_PROTOCOL.postRecord.external.maxDescriptionGraphemes
	- countGraphemes(GIF_ALT_PREFIX);

/**
 * 投稿が入れ物へ知らせる口と、入れ物から読む口。
 * @typedef {Object} PostHooks
 * @property {(post: ComposerPost) => void} onChange 残りの文字数・送信ボタンに関わる中身が変わった
 * @property {(post: ComposerPost) => void} onActivate 投稿の中にフォーカスが入った
 * @property {() => void} onSubmit Ctrl+Enter / Cmd+Enter で送れと言われた
 * @property {(post: ComposerPost) => void} onRemove 「×」でこの投稿を消せと言われた (中身があれば聞き返した後)
 * @property {() => string[]} getLanguages 選んでいる投稿言語
 * @property {() => boolean} isBusy 入れ物が送信中か
 */

/**
 * メディアの排他の知らせの原因。GIF・動画・画像のどれがあるために断ったか。
 * @typedef {'gif'|'video'|'images'} ExclusiveCause
 */

/**
 * 送るときに控える中身。uploadImages で控え、buildRecord がこれから record を組む
 * (送っている最中に入力欄が外されても、送り始めた時点の中身で組む)。
 * @typedef {Object} SendingSnapshot
 * @property {string} value 本文
 * @property {import('./reply-attachments.js').Attachment[]} attachments 添付の画像
 * @property {Object|null} labels 自己ラベル (付けられないときは null)
 * @property {number} mediaCount メディアの数
 * @property {boolean} hasVideo 動画があるか
 * @property {{blob: Blob}|null} caption 動画の字幕
 */

/**
 * 覚えた言語が無いときの既定。ブラウザの言語の主タグ (選べる一覧にあるときだけ)。
 * @param {string|undefined} locale ブラウザの言語
 * @param {{maxLanguages: number, languageCodes: string[]}} compose
 * @returns {string[]}
 */
export function defaultLanguages(locale, compose) {
	return normalizeLanguages([primaryLanguage(locale)], compose.maxLanguages, compose.languageCodes);
}

/**
 * 投稿 1 件分。
 */
export class ComposerPost {
	/**
	 * @param {Object} config EXT_CONFIG.lightboxReplies
	 * @param {import('./reply-composer.js').ComposerDeps} deps 返信欄から渡された口 (入れ物と同じもの)
	 * @param {PostHooks} hooks 入れ物との口
	 * @param {string} placeholder 本文の欄の placeholder
	 */
	constructor(config, deps, hooks, placeholder) {
		this.config = config;
		this.compose = config.compose;
		this.deps = deps;
		this.hooks = hooks;
		this.locale = browserLocale(this.compose.emoji.query.localeJa);
		/** @type {import('./reply-attachments.js').Attachment[]} */
		this.attachments = [];
		/** 取り込みで縮小している最中の枚数 (枚数の上限に数え、送信ボタンを止める) */
		this.importing = 0;
		/** 切り抜き直しで縮小している最中の枚数 (枚数には数えず、送信ボタンだけを止める) */
		this.recropping = 0;
		/** 自己ラベルの選択 */
		this.labels = {adult: null, graphic: false};
		/**
		 * 出ている 1 行がメディアの排他の知らせなら、その原因 (それが無くなったら消す)。他の知らせは null
		 * @type {ExclusiveCause|null}
		 */
		this.noticeExclusive = null;
		/** @type {HTMLElement|null} 投稿の末尾の 1 行 (取り込み・排他・アップロードの失敗の知らせ) */
		this.noticeEl = null;
		/** setBusy で止めているか (入れ物の送信中とあわせて busy になる) */
		this.locked = false;
		this.destroyed = false;
		/** 直前の操作が文字の貼り付けか (次の input の 1 回だけ真として extras へ渡す) */
		this.pastedPending = false;
		/** @type {HTMLElement[]} 入れ物から預かってツールバーに並べている共通の要素 */
		this.sharedNodes = [];
		/** @type {SendingSnapshot|null} 送るときに控えた中身 */
		this.sending = null;
		/** 「×」が聞き返し (「本当に削除？」) の状態か */
		this.removeConfirming = false;
		/** GIF・リンクカード・引用の状態 */
		this.extras = this.createExtras();
		/** 動画 1 本の状態 (組み立ての中で参照するため、build より前に作る) */
		this.video = this.createVideo();
		this.build(placeholder);
	}

	/**
	 * 送信中か (この投稿を止めている、または入れ物が送信中)。
	 * @returns {boolean}
	 */
	get busy() {
		if (this.locked) return true;
		try {
			return this.hooks.isBusy() === true;
		} catch (error) {
			return false;
		}
	}

	/**
	 * GIF・リンクカード・引用の状態を作る。口は呼ぶたびに this.deps から引く (差し替えに追随する)。
	 * @returns {ComposerExtras}
	 */
	createExtras() {
		const deps = () => this.deps;
		return new ComposerExtras(this.config, {
			fetchJson: (url, timeoutMs) => deps().fetchJson(url, timeoutMs),
			fetchBlob: (url, timeoutMs) => deps().fetchBlob(url, timeoutMs),
			resolveHandle: (handle) => deps().resolveHandle(handle),
			fetchPost: (uri) => deps().fetchPost(uri),
			prepareImage: (blob, crop, rules) => deps().prepareImage(blob, crop, rules),
			uploadBlob: (blob) => deps().uploadBlob(blob),
			safeHref: (uri) => deps().safeHref(uri),
			formatDate: (iso) => deps().formatDate(iso),
			blurText: (labels) => (typeof deps().blurText === 'function' ? deps().blurText(labels) : null),
			onChange: () => this.onExtrasChange()
		});
	}

	/**
	 * 動画 1 本の状態を作る。口は呼ぶたびに this.deps から引く (差し替えに追随する)。
	 * @returns {ComposerVideo}
	 */
	createVideo() {
		const deps = () => this.deps;
		return new ComposerVideo(this.config, {
			uploadVideo: (blob, onProgress) => deps().uploadVideo(blob, onProgress),
			cancelVideoUpload: (id) => deps().cancelVideoUpload(id),
			readMeta: (file) => deps().readVideoMeta(file),
			onChange: () => this.onVideoChange()
		});
	}

	/**
	 * 投稿の要素を組む。共通の行 (言語・残り・送信と言語の提案) は入れ物が mountShared で並べる。
	 * @param {string} placeholder
	 * @returns {void}
	 */
	build(placeholder) {
		const c = this.config.classes;
		const cc = this.compose.classes;
		const t = this.compose.text;
		const doc = document;
		const el = createElement(doc, 'div', `${c.form} ${cc.composer} ${cc.post}`);
		const row = createElement(doc, 'div', c.formRow);
		const avatar = createElement(doc, 'img', c.formAvatar);
		avatar.alt = '';
		const profile = this.deps.getSelfProfile();
		if (profile && profile.avatarUrl) avatar.src = profile.avatarUrl;
		else avatar.hidden = true;
		const textarea = createElement(doc, 'textarea', c.input);
		textarea.rows = 1;
		textarea.placeholder = placeholder;
		textarea.setAttribute('aria-label', placeholder);
		// 枠と余白は外側の入れ物が持つ (欄に余白があるとスクロール時に文字が枠に接する)
		const frame = createElement(doc, 'div', c.inputFrame);
		// 投稿を消す「×」は本文の枠の右上。投稿が 2 件以上あるときにアクティブな投稿にだけ出す (入れ物が決める)
		const removeButton = createIconButton(doc, cc.removePost, 'close', t.removePost);
		removeButton.hidden = true;
		frame.append(textarea, removeButton);
		row.append(avatar, frame);

		const attachments = createElement(doc, 'ul', cc.attachments);
		attachments.setAttribute('aria-label', t.attachments);
		attachments.hidden = true;
		// 動画のプレビュー (中身は video が描く。描くたびに子を入れ替えるため専用の入れ物にする)
		const videoPreview = createElement(doc, 'div', cc.video);
		videoPreview.hidden = true;
		// GIF・リンクカード・引用のプレビュー (中身は extras が描く)
		const embedPreview = createElement(doc, 'div', cc.embedPreview);
		embedPreview.hidden = true;
		const labelsButton = createButton(doc, cc.labelsButton, '');
		labelsButton.hidden = true;

		const toolbar = createElement(doc, 'div', `${c.formFoot} ${cc.toolbar}`);
		const fileInput = createElement(doc, 'input', cc.fileInput);
		fileInput.type = 'file';
		fileInput.multiple = true;
		fileInput.accept = this.compose.acceptImageTypes.concat(this.compose.video.acceptTypes).join(',');
		fileInput.hidden = true;
		fileInput.tabIndex = -1;
		const imageTool = createIconButton(doc, cc.tool, 'image', t.addImage);
		const gifTool = createIconButton(doc, cc.tool, 'gifBox', t.addGif);
		const emojiTool = createIconButton(doc, cc.tool, 'mood', t.emoji);
		toolbar.append(fileInput, imageTool, gifTool, emojiTool);
		el.append(row, attachments, videoPreview, embedPreview, labelsButton, toolbar);

		Object.assign(this, {
			el, avatar, textarea, removeButton, attachmentsEl: attachments, videoEl: videoPreview, embedEl: embedPreview,
			labelsButton, toolbarEl: toolbar, fileInput, imageTool, gifTool, emojiTool
		});
		this.bindEvents();
		this.renderLabels();
		this.sync();
	}

	/**
	 * 要素にリスナーを付ける。
	 * @returns {void}
	 */
	bindEvents() {
		this.textarea.addEventListener('input', () => {
			const pasted = this.pastedPending;
			this.pastedPending = false;
			this.notifyTextChange(pasted);
			this.changed();
		});
		this.textarea.addEventListener('keydown', (event) => {
			// 打鍵は貼り付けより前に届く。何も貼られなかった貼り付けの印を次の入力へ持ち越さない
			this.pastedPending = false;
			if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
				event.preventDefault();
				this.hooks.onSubmit();
			}
		});
		this.textarea.addEventListener('paste', (event) => this.onPaste(event));
		this.el.addEventListener('focusin', () => this.hooks.onActivate(this));
		this.el.addEventListener('click', (event) => this.onInactiveClick(event));
		this.el.addEventListener('dragover', (event) => this.onDragOver(event));
		this.el.addEventListener('dragleave', (event) => this.onDragLeave(event));
		this.el.addEventListener('drop', (event) => this.onDrop(event));
		this.imageTool.addEventListener('click', () => {
			if (this.busy) return;
			if (this.extras.gif) {
				this.showNotice([this.compose.text.gifExclusive], 'gif');
				return;
			}
			// 動画は 1 本までで画像とも並べないため、選ぶ画面を開いても取り込めるものが無い
			if (this.video.isActive()) {
				this.showNotice([this.compose.text.videoExclusive], 'video');
				return;
			}
			this.fileInput.click();
		});
		this.gifTool.addEventListener('click', () => this.openGif());
		this.fileInput.addEventListener('change', () => {
			const files = Array.from(this.fileInput.files || []);
			// 同じファイルを続けて選んでも change が出るよう空にする
			this.fileInput.value = '';
			this.addFiles(files);
		});
		this.emojiTool.addEventListener('click', () => this.openEmoji());
		this.labelsButton.addEventListener('click', () => this.openLabels());
		this.removeButton.addEventListener('click', () => this.onRemoveClick());
		// focusout ではなく blur で受ける (パネルのフォーカスの扱いが、パネルの中の focusout を window の capture で止めるため)
		this.removeButton.addEventListener('blur', () => this.cancelRemoveConfirm());
		this.removeButton.addEventListener('keydown', (event) => {
			if (event.key === 'Escape' && this.removeConfirming) {
				// 聞き返しを畳むだけにする (ライトボックスまで閉じない)
				event.stopPropagation();
				this.cancelRemoveConfirm();
			}
		});
	}

	/**
	 * アクティブな投稿か (共通の行を並べる投稿か) を見た目に出す。アクティブでない投稿は薄く描き、ツールバーを隠す。
	 * @param {boolean} active
	 * @returns {void}
	 */
	setActive(active) {
		this.el.classList.toggle(this.compose.classes.postInactive, !active);
		this.toolbarEl.hidden = !active;
	}

	/**
	 * 薄く描いた投稿の、押しても何も起きない所 (アバター・枠の余白など) が押されたら本文の欄へフォーカスを移す
	 * (フォーカスが入るとアクティブになる)。ボタン・欄・リンクを押したときはそのままにする。
	 * @param {Event} event click
	 * @returns {void}
	 */
	onInactiveClick(event) {
		if (this.destroyed || !this.el.classList.contains(this.compose.classes.postInactive)) return;
		try {
			// 押した要素からこの投稿までを辿る (押したボタンの処理でこの投稿が薄くなった直後にも、ボタンとして扱う)
			for (let node = event && event.target; node && node !== this.el; node = node.parentNode) {
				if (typeof node.matches === 'function' && node.matches(this.compose.activateIgnore)) return;
			}
			this.focus();
		} catch (error) {
			console.error('[XViewer] 投稿をアクティブにできませんでした', error);
		}
	}

	/**
	 * 「×」を出す / 隠す。隠すときは聞き返しも畳む。
	 * @param {boolean} removable
	 * @returns {void}
	 */
	setRemovable(removable) {
		if (!removable) this.cancelRemoveConfirm();
		this.removeButton.hidden = !removable;
	}

	/**
	 * 「×」の押下。空の投稿はすぐ消し、中身があれば 1 回目で聞き返し、2 回目で消す。
	 * @returns {void}
	 */
	onRemoveClick() {
		if (this.busy || this.destroyed) return;
		if (!this.removeConfirming && !isEmptyPost(this.summary())) {
			this.removeConfirming = true;
			this.renderRemoveButton();
			return;
		}
		this.cancelRemoveConfirm();
		try {
			this.hooks.onRemove(this);
		} catch (error) {
			console.error('[XViewer] 投稿を消せませんでした', error);
		}
	}

	/**
	 * 「×」の聞き返しを畳む。
	 * @returns {void}
	 */
	cancelRemoveConfirm() {
		if (!this.removeConfirming) return;
		this.removeConfirming = false;
		this.renderRemoveButton();
	}

	/**
	 * 「×」を今の状態 (ふだんはアイコン、聞き返しのあいだは「本当に削除？」の文字) で描く。
	 * @returns {void}
	 */
	renderRemoveButton() {
		const button = this.removeButton;
		const t = this.compose.text;
		const label = this.removeConfirming ? t.confirmRemovePost : t.removePost;
		try {
			button.textContent = '';
			if (this.removeConfirming) button.append(label);
			else button.append(createIcon(button.ownerDocument, 'close'));
			button.setAttribute('aria-label', label);
			button.title = label;
			button.classList.toggle(this.config.classes.confirming, this.removeConfirming);
		} catch (error) {
			console.error('[XViewer] 投稿を消すボタンを描けませんでした', error);
		}
	}

	/**
	 * 中身が変わったことを入れ物へ知らせる (入れ物が残りの文字数・送信ボタン・この投稿の sync を合わせる)。
	 * @returns {void}
	 */
	changed() {
		try {
			this.hooks.onChange(this);
		} catch (error) {
			console.error('[XViewer] 入力欄の変化を知らせられませんでした', error);
		}
	}

	/**
	 * 共通の要素 (言語・残り・送信) をツールバーの末尾に、言語の提案をツールバーの前に並べる。
	 * 空の配列を渡すと預かったものを外す。動かすのは預かった要素だけで、この投稿の要素 (本文の欄・
	 * ツールバーのボタン) は外さない (押している最中のボタンやフォーカスのある欄を付け外ししないため)。
	 * @param {HTMLElement[]} nodes ツールバーの末尾に並べる要素
	 * @param {HTMLElement|null} [suggest] ツールバーの前に置く言語の提案
	 * @returns {void}
	 */
	mountShared(nodes, suggest = null) {
		const shared = Array.isArray(nodes) ? nodes.filter(Boolean) : [];
		const next = suggest ? shared.concat(suggest) : shared;
		try {
			// 前に預かっていて今回は並べないものを外す
			for (const node of this.sharedNodes) {
				if (next.indexOf(node) === -1 && this.el.contains(node)) node.remove();
			}
			this.toolbarEl.append(...shared);
			if (suggest) this.el.insertBefore(suggest, this.toolbarEl);
			this.sharedNodes = next;
		} catch (error) {
			console.error('[XViewer] 入力欄の共通の行を並べられませんでした', error);
		}
	}

	/**
	 * 入れ物から預かった共通の要素 (またはその中) か。setBusy はこれに触らない。
	 * @param {HTMLElement} node
	 * @returns {boolean}
	 */
	isShared(node) {
		return this.sharedNodes.some((shared) => shared === node || shared.contains(node));
	}

	/**
	 * 本文の欄へフォーカスを移す。
	 * @returns {void}
	 */
	focus() {
		this.textarea.focus({preventScroll: true});
	}

	/**
	 * 書きかけがあるか (本文・添付・GIF・動画が 1 つでもある)。
	 * @returns {boolean}
	 */
	hasDraft() {
		if (this.destroyed) return false;
		return this.textarea.value.trim() !== '' || this.attachments.length > 0 || this.isPreparing()
			|| this.extras.gif !== null || this.video.isActive();
	}

	/**
	 * 投稿の要約 (空の投稿の判定・「＋」の出し分けに使う)。
	 * @returns {import('./reply-thread.js').PostSummary}
	 */
	summary() {
		return {
			text: this.textarea.value,
			contentCount: this.extras.contentCount(this.mediaCount()),
			preparing: this.isPreparing()
		};
	}

	/**
	 * この投稿を送れるか (文字数とメディアの数。準備中なら送れない) と残りの文字数。
	 * @returns {{ok: boolean, remaining: number}}
	 */
	check() {
		// contentCount はメディアの数を含んだ合計 (GIF・送るカード・取得できた引用を足したもの)
		const result = canSubmitComposer(this.countedText(this.textarea.value),
			this.extras.contentCount(this.mediaCount()), this.config.limits);
		return {ok: result.ok && !this.isPreparing(), remaining: result.remaining};
	}

	/**
	 * 画像の枚数 (取り込み中を含む)。画像だけの判定 (枚数の上限・ラベル) に使う。
	 * @returns {number}
	 */
	imageCount() {
		return this.attachments.length + this.importing;
	}

	/**
	 * メディアの数 (画像の枚数 + 動画)。GIF・カードとの排他と送信できる条件に使う。
	 * @returns {number}
	 */
	mediaCount() {
		return this.imageCount() + (this.video.isActive() ? 1 : 0);
	}

	/**
	 * コンテンツの警告を付けられるか (画像・GIF・動画・送るカードのどれかがある)。引用だけでは付けない。
	 * @returns {boolean}
	 */
	isLabelable() {
		return hasLabelableMedia({
			imageCount: this.imageCount(),
			hasGif: this.extras.gif !== null,
			hasCard: Boolean(this.extras.sendableCard(this.mediaCount())),
			hasVideo: this.video.isActive()
		});
	}

	/**
	 * 送るときの本文 (リンクを短い形にしたもの)。残りの文字数と送信できる条件はこれで数える。
	 * @param {string} value 入力欄の本文
	 * @returns {string}
	 */
	countedText(value) {
		const facets = buildFacets(detectRichText(value), new Map());
		return shortenLinks(value, facets, this.compose.links).text;
	}

	/**
	 * 本文のリンクを extras へ渡す (カードと引用の提案)。渡すのは短くする前の本文。
	 * @param {boolean} pasted 貼り付けの直後か
	 * @returns {void}
	 */
	notifyTextChange(pasted) {
		if (this.destroyed) return;
		try {
			const value = this.textarea.value;
			const links = detectRichText(value).links.map((link) => link.uri);
			this.extras.onTextChange(value, links, pasted === true);
		} catch (error) {
			console.error('[XViewer] 本文のリンクを読めませんでした', error);
		}
	}

	/**
	 * extras の状態が変わった。プレビュー・ラベル・送信ボタンを合わせる。
	 * @returns {void}
	 */
	onExtrasChange() {
		if (this.destroyed) return;
		if (this.extras.gif === null) this.clearExclusiveNotice('gif');
		this.renderExtras();
		this.renderLabels();
		this.changed();
	}

	/**
	 * 動画の状態が変わった。動画のプレビュー・カードの出し入れ・ラベル・送信ボタンを合わせる。
	 * @returns {void}
	 */
	onVideoChange() {
		if (this.destroyed) return;
		if (!this.video.isActive()) this.clearExclusiveNotice('video');
		this.renderVideo();
		this.renderExtras();
		this.renderLabels();
		this.changed();
	}

	/**
	 * 動画のプレビューを描き直す。× で外した後は、押した × が消えるため本文の欄へフォーカスを移す。
	 * @returns {void}
	 */
	renderVideo() {
		if (this.destroyed) return;
		this.video.render(this.videoEl, {
			onAlt: (button) => this.openVideoAlt(button),
			onRemoved: () => {
				if (!this.destroyed) this.focus();
			}
		}, this.busy);
	}

	/**
	 * GIF・リンクカード・引用のプレビューを描き直す。送信中に描いたボタンは押せなくしておく。
	 * × で外した後は、押した × が消えるため本文の欄へフォーカスを移す。
	 * @returns {void}
	 */
	renderExtras() {
		if (this.destroyed) return;
		this.extras.render(this.embedEl, this.mediaCount(), {
			onGifAlt: (button) => this.openGifAlt(button),
			onRemoved: () => {
				if (!this.destroyed) this.focus();
			}
		});
		if (!this.busy) return;
		try {
			for (const control of this.embedEl.querySelectorAll(this.compose.busyControls)) control.disabled = true;
		} catch (error) {
			console.error('[XViewer] 入力欄のプレビューを送信中の表示にできませんでした', error);
		}
	}

	/**
	 * 送る前の準備が終わっていないか (画像の取り込み・切り抜き直しの縮小、動画の読み取り・アップロード・処理・失敗)。
	 * @returns {boolean}
	 */
	isPreparing() {
		return this.importing > 0 || this.recropping > 0 || this.video.isPending();
	}

	/**
	 * GIF ボタンと本文の欄の高さを今の状態に合わせる。残りの文字数と送信ボタンは入れ物が持つ。
	 * @returns {void}
	 */
	sync() {
		this.gifTool.disabled = this.busy || this.mediaCount() > 0 || this.isPreparing();
		this.fitHeight();
	}

	/**
	 * 本文の欄の高さを中身に合わせる。DOM に入る前は scrollHeight が 0 で、
	 * そのまま当てると欄が潰れる (2026-10-18 実機で確認)。入れた後に呼び直す。
	 * @returns {void}
	 */
	fitHeight() {
		const textarea = this.textarea;
		if (!textarea.isConnected) return;
		try {
			const style = window.getComputedStyle(textarea);
			const border = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
			// 一度高さを外してから測ると、消して短くなったときも縮む
			textarea.style.height = '';
			const fitted = fitTextareaHeight(textarea.scrollHeight, border, parseFloat(style.maxHeight));
			textarea.style.height = `${fitted.height}px`;
			textarea.style.overflowY = fitted.scroll ? 'auto' : 'hidden';
		} catch (error) {
			console.error('[XViewer] 入力欄の高さの調整に失敗しました', error);
		}
	}

	/**
	 * ラベルのボタンの文言を今の選択に合わせる。画像・GIF・送るカードのどれかがあるときだけ出し、
	 * どれも無くなったら選択を空に戻す。
	 * @returns {void}
	 */
	renderLabels() {
		const doc = this.labelsButton.ownerDocument;
		const t = this.compose.text;
		const labelable = this.isLabelable();
		if (!labelable) this.labels = {adult: null, graphic: false};
		const values = [];
		if (this.labels.adult) values.push(this.labels.adult);
		if (this.labels.graphic) values.push(this.compose.labels.graphic);
		const names = values.map((value) => t.labelNames[value] || value).join(t.listSeparator);
		this.labelsButton.hidden = !labelable;
		this.labelsButton.classList.toggle(this.compose.classes.labelsActive, values.length > 0);
		this.labelsButton.textContent = '';
		this.labelsButton.append(createIcon(doc, 'warning'), createElement(doc, 'span', '', names || t.labels));
		this.labelsButton.setAttribute('aria-label', names ? formatText(t.labelsCurrent, {names}) : t.labelTitle);
	}

	/**
	 * 添付のプレビューを描き直す。画像の有無でカードの出し入れが変わるため、extras のプレビューも描き直す。
	 * @returns {void}
	 */
	renderAttachments() {
		renderAttachments(this.attachmentsEl, this.attachments, this.compose, {
			onAlt: (attachment, button) => this.openAlt(attachment, button),
			onCrop: (attachment, button) => this.openCrop(attachment, button),
			onRemove: (attachment) => this.removeAttachment(attachment)
		}, this.busy);
		this.renderExtras();
		this.renderLabels();
	}

	/**
	 * 選んだ・貼り付けた・落としたファイルを取り込む。受け取れないものは 1 行で知らせる。
	 * 動画と画像に分け、メディアは 1 種類だけにする。動画は GIF・画像 (取り込み中と同じ回の画像を含む) が
	 * あれば取り込まず、1 本まで。画像は動画か GIF があれば取り込まない。
	 * 受け付けない形式の動画 (.mkv など) は画像として扱わず、動画の形式の知らせを出す。
	 * @param {File[]|FileList} files
	 * @returns {Promise<void>}
	 */
	async addFiles(files) {
		if (this.destroyed || this.busy) return;
		const t = this.compose.text;
		const list = Array.from(files || []);
		const videoTypes = this.compose.video.acceptTypes;
		const videoPrefix = this.compose.video.typePrefix;
		const isOtherVideo = (file) => !isVideoFile(file, videoTypes)
			&& !!file && typeof file.type === 'string' && file.type.startsWith(videoPrefix);
		const videos = list.filter((file) => isVideoFile(file, videoTypes));
		const unsupportedVideos = list.filter(isOtherVideo);
		const images = list.filter((file) => !isVideoFile(file, videoTypes) && !isOtherVideo(file));
		const notices = unsupportedVideos.length > 0 ? [t.videoUnsupported] : [];
		/** @type {ExclusiveCause|null} 動画を断った原因 (排他の知らせだけのとき、それが無くなったら消す) */
		let cause = null;
		if (videos.length > 0) {
			if (this.extras.gif || this.imageCount() > 0 || images.length > 0) {
				notices.push(t.videoExclusive);
				cause = this.extras.gif ? 'gif' : 'images';
			} else if (videos.length > 1 || this.video.isActive()) {
				notices.push(t.tooManyVideos);
			} else {
				await this.addVideo(videos[0], notices);
				return;
			}
		}
		if (images.length === 0) {
			this.showNotice(notices, notices.length === 1 ? cause : null);
			return;
		}
		if (this.video.isActive()) {
			if (notices.indexOf(t.videoExclusive) === -1) notices.push(t.videoExclusive);
			this.showNotice(notices, notices.length === 1 ? 'video' : null);
			return;
		}
		if (this.extras.gif) {
			// GIF があるとき出す排他の行はどれも GIF が原因 (動画も GIF のために断っている)。
			// 形式の知らせが混じるときは、GIF を外しても消さない
			const gifCause = notices.indexOf(t.videoUnsupported) === -1 ? 'gif' : null;
			this.showNotice(notices.concat(t.gifExclusive), gifCause);
			return;
		}
		await this.addImages(images, notices, cause);
	}

	/**
	 * 動画を 1 本取り込む。受け取れなければ 1 行で知らせる (読んでいる間に外されたときは知らせない)。
	 * @param {File} file
	 * @param {string[]} [notices] 先に出す知らせ (同じ回で断ったほかのファイルの分)
	 * @returns {Promise<void>}
	 */
	async addVideo(file, notices = []) {
		this.showNotice(notices);
		let result = null;
		try {
			result = await this.video.setFile(file);
		} catch (error) {
			console.error('[XViewer] 動画を取り込めませんでした', error);
			result = {ok: false, notice: this.compose.text.videoUnreadable};
		}
		if (this.destroyed || !result || result.ok) return;
		if (result.notice) this.showNotice(notices.concat(result.notice));
	}

	/**
	 * 画像を 1 枚ずつ縮小して預かる。縮小の最中は送信ボタンだけを止める。
	 * @param {File[]} list 画像の候補 (受け付けない形式を含んでよい)
	 * @param {string[]} notices 先に出す知らせ
	 * @param {ExclusiveCause|null} cause notices が排他の知らせのとき、その原因
	 * @returns {Promise<void>}
	 */
	async addImages(list, notices, cause) {
		const t = this.compose.text;
		const result = acceptImages(this.attachments.length + this.importing, list,
			this.compose.acceptImageTypes, this.compose.maxImages);
		if (result.tooMany > 0) notices.push(t.tooManyImages);
		if (result.unsupported > 0) notices.push(t.unsupportedImage);
		this.showNotice(notices, notices.length === 1 ? cause : null);
		this.importing += result.accepted.length;
		if (result.accepted.length > 0) {
			// 取り込み中から画像として扱う (カードを隠し、ラベルを出す)
			this.renderExtras();
			this.renderLabels();
		}
		this.changed();
		let failed = false;
		for (const index of result.accepted) {
			const prepared = await this.prepare(list[index], null);
			this.importing -= 1;
			if (this.destroyed) {
				this.revoke(prepared);
				continue;
			}
			if (prepared) this.attachments.push({prepared, alt: '', cell: null});
			else failed = true;
			this.renderAttachments();
			this.changed();
		}
		if (failed && !this.destroyed) this.showNotice(notices.concat(t.imageLoadFailed));
	}

	/**
	 * 画像を 1 枚縮小する。失敗・例外は null。
	 * @param {File} file
	 * @param {import('./image-prepare.js').CropRect|null} crop
	 * @returns {Promise<import('./image-prepare.js').PreparedImage|null>}
	 */
	async prepare(file, crop) {
		try {
			return (await this.deps.prepareImage(file, crop, this.compose.image)) || null;
		} catch (error) {
			console.error('[XViewer] 画像を取り込めませんでした', error);
			return null;
		}
	}

	/**
	 * 縮小済みの画像の object URL を破棄する。
	 * @param {import('./image-prepare.js').PreparedImage|null} prepared
	 * @returns {void}
	 */
	revoke(prepared) {
		try {
			if (prepared && prepared.previewUrl) URL.revokeObjectURL(prepared.previewUrl);
		} catch (error) {
			console.error('[XViewer] 画像の URL を破棄できませんでした', error);
		}
	}

	/**
	 * 添付を 1 枚外す。フォーカスは次のマスの「外す」、無ければ「画像を追加」へ移す。
	 * @param {import('./reply-attachments.js').Attachment} attachment
	 * @returns {void}
	 */
	removeAttachment(attachment) {
		const index = this.attachments.indexOf(attachment);
		if (index === -1 || this.busy) return;
		this.attachments.splice(index, 1);
		this.revoke(attachment.prepared);
		if (this.imageCount() === 0) this.clearExclusiveNotice('images');
		this.renderAttachments();
		this.changed();
		const next = this.attachments[Math.min(index, this.attachments.length - 1)];
		const target = next && next.cell ? next.cell.removeButton : this.imageTool;
		target.focus({preventScroll: true});
	}

	/**
	 * 重ねる画面に添える情報。持ち主はこの投稿で、開いたボタンが描き直されて外れていたら
	 * focusTarget が返す要素 (無ければ「画像を追加」) へフォーカスを戻す。
	 * @param {() => (HTMLElement|null|undefined)} [focusTarget] 描き直した後の戻し先
	 * @returns {import('./reply-sheets.js').SheetOptions}
	 */
	sheetOptions(focusTarget) {
		return {
			owner: this.el,
			restoreFocus: () => {
				const target = (typeof focusTarget === 'function' && focusTarget()) || this.imageTool;
				if (target && this.el.contains(target)) target.focus({preventScroll: true});
			}
		};
	}

	/**
	 * ALT テキストの画面を開く。
	 * @param {import('./reply-attachments.js').Attachment} attachment
	 * @param {HTMLButtonElement} button
	 * @returns {void}
	 */
	openAlt(attachment, button) {
		if (!this.deps.sheets || this.busy) return;
		openAltSheet(this.deps.sheets, {previewUrl: attachment.prepared.previewUrl, alt: attachment.alt}, button,
			(alt) => {
				attachment.alt = alt;
				updateAttachmentCell(attachment, this.attachments.indexOf(attachment), this.compose);
			}, this.sheetOptions(() => attachment.cell && attachment.cell.altButton));
	}

	/**
	 * 切り抜きの画面を開く。保存したら元のファイルから縮小し直す。
	 * @param {import('./reply-attachments.js').Attachment} attachment
	 * @param {HTMLButtonElement} button
	 * @returns {void}
	 */
	openCrop(attachment, button) {
		if (!this.deps.sheets || this.busy) return;
		const prepared = attachment.prepared;
		openCropSheet(this.deps.sheets, {source: prepared.source, image: prepared.natural, crop: prepared.crop},
			button, (crop) => this.recrop(attachment, crop),
			this.sheetOptions(() => attachment.cell && attachment.cell.cropButton));
	}

	/**
	 * 切り抜き直した画像に差し替える。失敗したら前の画像のまま 1 行で知らせる。
	 * @param {import('./reply-attachments.js').Attachment} attachment
	 * @param {import('./image-prepare.js').CropRect|null} crop
	 * @returns {Promise<void>}
	 */
	async recrop(attachment, crop) {
		this.recropping += 1;
		this.changed();
		const next = await this.prepare(attachment.prepared.source, crop);
		this.recropping -= 1;
		if (this.destroyed || this.attachments.indexOf(attachment) === -1) {
			this.revoke(next);
			return;
		}
		if (!next) {
			this.showNotice([this.compose.text.imageLoadFailed]);
		} else {
			this.revoke(attachment.prepared);
			attachment.prepared = next;
			updateAttachmentCell(attachment, this.attachments.indexOf(attachment), this.compose);
		}
		this.changed();
	}

	/**
	 * コンテンツの警告の画面を開く。
	 * @returns {void}
	 */
	openLabels() {
		if (!this.deps.sheets || this.busy || !this.isLabelable()) return;
		openLabelSheet(this.deps.sheets, {...this.labels}, this.labelsButton, (selection) => {
			this.labels = {adult: selection.adult || null, graphic: selection.graphic === true};
			this.renderLabels();
			this.changed();
		}, this.sheetOptions(() => this.labelsButton));
	}

	/**
	 * 絵文字の画面を開く。選んだ絵文字は本文のカーソルの位置に入れ、画面は開いたままにする。
	 * @returns {void}
	 */
	openEmoji() {
		if (!this.deps.sheets || this.busy) return;
		openEmojiSheet(this.deps.sheets, this.emojiTool, (native) => this.insertText(native),
			this.sheetOptions(() => this.emojiTool));
	}

	/**
	 * GIF の画面を開く。画像 (取り込み中を含む) か動画がある・送信中なら開かない。
	 * @returns {void}
	 */
	openGif() {
		if (!this.deps.sheets || this.busy || this.mediaCount() > 0 || this.isPreparing()) return;
		openGifSheet(this.deps.sheets, {
			fetchJson: (url) => this.fetchGifJson(url),
			locale: typeof this.deps.gifLocale === 'string' && this.deps.gifLocale ? this.deps.gifLocale : null,
			rule: this.compose.gif
		}, this.gifTool, (item) => {
			if (this.destroyed) return;
			// 画面を開いているあいだに画像か動画が落とされていたら付けない
			if (this.video.isActive()) {
				this.showNotice([this.compose.text.videoExclusive], 'video');
				return;
			}
			if (this.imageCount() > 0) {
				this.showNotice([this.compose.text.gifExclusive], 'images');
				return;
			}
			this.showNotice([]);
			this.extras.setGif(item);
		}, this.sheetOptions(() => this.gifTool));
	}

	/**
	 * GIF の検索を 1 回引く。状態が 200 のときだけ中身を返し、それ以外・失敗は null。
	 * @param {string} url
	 * @returns {Promise<any|null>}
	 */
	async fetchGifJson(url) {
		try {
			const response = await this.deps.fetchJson(url, this.compose.gif.timeoutMs);
			return response && response.status === GIF_OK_STATUS ? response.json : null;
		} catch (error) {
			console.error('[XViewer] GIF を検索できませんでした', error);
			return null;
		}
	}

	/**
	 * GIF の ALT テキストの画面を開く。初期値は入力済みの ALT、無ければ GIF の題名。
	 * 上限は画像の ALT より短い (external の説明に接頭辞ごと収めるため)。
	 * @param {HTMLButtonElement} button プレビューの ALT ボタン
	 * @returns {void}
	 */
	openGifAlt(button) {
		const gif = this.extras.gif;
		if (!this.deps.sheets || this.busy || !gif) return;
		const altSelector = `.${this.config.cards.classes.gifAlt}`;
		openAltSheet(this.deps.sheets, {
			previewUrl: gif.item.previewUrl, alt: gif.alt || gif.item.title, maxGraphemes: GIF_ALT_MAX_GRAPHEMES
		}, button,
			(alt) => this.extras.setGifAlt(String(alt || '').trim()),
			this.sheetOptions(() => this.embedEl.querySelector(altSelector) || this.gifTool));
	}

	/**
	 * 動画の字幕と ALT の画面を開く。字幕の言語の既定は選んでいる投稿言語の先頭。
	 * @param {HTMLButtonElement} button プレビューの ALT ボタン
	 * @returns {void}
	 */
	openVideoAlt(button) {
		const state = this.video.state;
		if (!this.deps.sheets || this.busy || !state) return;
		const altSelector = `.${this.config.cards.classes.gifAlt}`;
		openVideoSheet(this.deps.sheets, {
			previewUrl: state.url,
			alt: state.alt,
			caption: state.caption,
			maxAltGraphemes: this.compose.maxAltGraphemes,
			languageCodes: this.compose.languageCodes,
			defaultLang: this.currentLanguages()[0] || defaultLanguages(navigator.language, this.compose)[0] || '',
			locale: this.locale,
			readCaption: (file) => readCaptionFile(file, this.compose.video)
		}, button, (value) => {
			// 画面を開いているあいだに外した・別の動画に替えたなら付けない
			if (this.destroyed || this.video.state !== state) return;
			this.video.setAlt(value.alt);
			this.video.setCaption(value.caption);
		}, this.sheetOptions(() => this.videoEl.querySelector(altSelector) || this.imageTool));
	}

	/**
	 * 入れ物で選んでいる投稿言語。読めなければ空。
	 * @returns {string[]}
	 */
	currentLanguages() {
		try {
			const codes = this.hooks.getLanguages();
			return Array.isArray(codes) ? codes : [];
		} catch (error) {
			return [];
		}
	}

	/**
	 * 本文のカーソルの位置 (選択範囲があれば置き換え) に文字を入れる。
	 * @param {string} value 入れる文字
	 * @returns {void}
	 */
	insertText(value) {
		if (typeof value !== 'string' || value === '' || this.destroyed) return;
		const textarea = this.textarea;
		try {
			const start = typeof textarea.selectionStart === 'number' ? textarea.selectionStart : textarea.value.length;
			const end = typeof textarea.selectionEnd === 'number' ? textarea.selectionEnd : start;
			textarea.setRangeText(value, start, end, 'end');
		} catch (error) {
			textarea.value += value;
		}
		this.notifyTextChange(false);
		this.changed();
	}

	/**
	 * 貼り付け。画像か動画があるときだけ既定の貼り付けを止めて取り込む (取り込めなければ知らせる)。
	 * 文字だけなら既定の貼り付けに任せ、続く input を「貼り付けの直後」として扱う。
	 * @param {ClipboardEvent} event
	 * @returns {void}
	 */
	onPaste(event) {
		const files = pickPastedMedia(event.clipboardData && event.clipboardData.items);
		if (files.length === 0) {
			this.pastedPending = true;
			return;
		}
		event.preventDefault();
		this.addFiles(files);
	}

	/**
	 * ドラッグが重なった。画像か動画のファイルを含むときだけ受ける (送信中は受けないが、既定の動作は止める)。
	 * @param {DragEvent} event
	 * @returns {void}
	 */
	onDragOver(event) {
		const transfer = event.dataTransfer;
		if (!transfer || !hasMediaItems(transfer.items)) return;
		// 送信中も止める (止めないと、落としたファイルをブラウザが開いてタブが遷移する)
		event.preventDefault();
		if (this.busy) {
			transfer.dropEffect = this.compose.noDropEffect;
			return;
		}
		transfer.dropEffect = this.compose.dropEffect;
		this.el.classList.add(this.compose.classes.dragOver);
	}

	/**
	 * ドラッグが外へ出た。
	 * @param {DragEvent} event
	 * @returns {void}
	 */
	onDragLeave(event) {
		if (!event.relatedTarget || !this.el.contains(event.relatedTarget)) {
			this.el.classList.remove(this.compose.classes.dragOver);
		}
	}

	/**
	 * ドロップ。画像か動画のファイルを含むときだけ受け、本体のページへは届かせない。送信中は取り込まない。
	 * @param {DragEvent} event
	 * @returns {void}
	 */
	onDrop(event) {
		this.el.classList.remove(this.compose.classes.dragOver);
		const transfer = event.dataTransfer;
		if (!transfer || !hasMediaItems(transfer.items)) return;
		event.preventDefault();
		event.stopPropagation();
		// 送信中は取り込まない (添付が送るものと食い違うため)
		if (!this.busy) this.addFiles(Array.from(transfer.files || []));
	}

	/**
	 * 送る中身 (本文・添付・ラベル・メディアの数・動画と字幕) を控える。
	 * @returns {SendingSnapshot}
	 */
	snapshot() {
		const hasVideo = this.video.isActive();
		return {
			value: this.textarea.value,
			attachments: this.attachments.slice(),
			labels: this.isLabelable() ? buildSelfLabels(this.labels) : null,
			mediaCount: this.mediaCount(),
			hasVideo,
			caption: hasVideo && this.video.state.caption ? this.video.state.caption : null
		};
	}

	/**
	 * 送る blob の並びを返し、送る中身を控える (buildRecord はこの控えから組む)。
	 * 動画と画像は同時に付かないため、動画があるときは字幕 (あれば) だけで、ほかは縮めた画像。
	 * @returns {Array<{blob: Blob}>}
	 */
	uploadImages() {
		const sending = this.snapshot();
		this.sending = sending;
		if (sending.hasVideo) return sending.caption ? [{blob: sending.caption.blob}] : [];
		return sending.attachments.map((attachment) => attachment.prepared);
	}

	/**
	 * 送った blob から返信の record を組む。GIF・カードのサムネイルを送り、メンションを DID に引く。
	 * 本文のリンクは短い形にして送る (facet の uri は元のまま)。送る本文の末尾の空白は除く。
	 * @param {Object[]} blobs uploadImages の並びの順に送れた BlobRef (動画なら blobs[0] が字幕)
	 * @param {string[]} languages 投稿言語
	 * @param {Object} reply record の reply ({root, parent})
	 * @param {(done: number, total: number) => void} [onProgress] サムネイルを送るあいだの進み具合
	 * @returns {Promise<{record: Object, embedView: (did: string) => Object|null}>}
	 */
	async buildRecord(blobs, languages, reply, onProgress) {
		const sending = this.sending || this.snapshot();
		this.sending = null;
		const list = Array.isArray(blobs) ? blobs : [];
		const legacyMax = this.compose.legacyImagesMax;
		const toUploaded = () => sending.attachments.map((attachment, index) => ({
			blob: list[index], alt: attachment.alt, width: attachment.prepared.width, height: attachment.prepared.height
		}));
		// GIF・カードのサムネイルを送るあいだも送信ボタンに進み具合 (1/1) を出す
		const resolved = await this.extras.resolveForSubmit((done, total) => {
			if (typeof onProgress === 'function') onProgress(done, total);
		}, sending.mediaCount);
		/** @type {import('./reply-embed.js').UploadedVideo|null} 送った動画 (投稿直後の描画に使う) */
		const uploadedVideo = sending.hasVideo ? this.video.toUploaded(sending.caption ? list[0] || null : null) : null;
		// 本体と同じく、送る本文の末尾の空白は除く (リンクカードの提案は後ろの空白で始まる)
		const sendValue = sending.value.replace(TRAILING_SPACE, '');
		const detected = detectRichText(sendValue);
		const didByHandle = await this.resolveMentions(detected.mentions);
		const shortened = shortenLinks(sendValue, buildFacets(detected, didByHandle), this.compose.links);
		const langs = Array.isArray(languages) && languages.length > 0 ? languages : null;
		const record = buildReplyRecord({
			text: shortened.text,
			reply,
			createdAt: new Date().toISOString(),
			langs,
			facets: shortened.facets,
			embed: buildPostEmbed({
				images: toUploaded(), video: uploadedVideo, external: resolved.external, quote: resolved.quote
			}, legacyMax),
			labels: sending.labels
		});
		const embedView = (did) => buildOwnPostEmbedView({
			images: toUploaded(), video: uploadedVideo, external: resolved.external, quoteView: resolved.quoteView
		}, did, this.compose.cdn, legacyMax);
		return {record, embedView};
	}

	/**
	 * blob の送信の失敗を 1 行で知らせる (動画なら字幕、ほかは画像)。
	 * @returns {void}
	 */
	showUploadFailed() {
		const hasVideo = this.sending ? this.sending.hasVideo : this.video.isActive();
		this.clearSending();
		this.showNotice([hasVideo ? this.compose.text.captionUploadFailed : this.compose.text.uploadFailed]);
	}

	/**
	 * 送るときに控えた中身を捨てる。送信が buildRecord まで届かずに終わったとき (失敗・世代の変化) に呼ぶ
	 * (次の送信が古い控えを読まないため)。
	 * @returns {void}
	 */
	clearSending() {
		this.sending = null;
	}

	/**
	 * 送れた後に、本文・添付・GIF・動画・カード・引用・ラベルを空に戻す。
	 * @returns {void}
	 */
	resetAfterPost() {
		this.textarea.value = '';
		this.pastedPending = false;
		this.sending = null;
		for (const attachment of this.attachments) this.revoke(attachment.prepared);
		this.attachments = [];
		this.extras.reset();
		this.video.reset();
		this.renderVideo();
		this.clearExclusiveNotice(null);
		this.labels = {adult: null, graphic: false};
		this.renderAttachments();
	}

	/**
	 * 本文中のメンションを DID に引く。引けなかったものは含めない。
	 * @param {Array<{handle: string}>} mentions
	 * @returns {Promise<Map<string, string>>}
	 */
	async resolveMentions(mentions) {
		const map = new Map();
		const handles = Array.from(new Set(mentions.map((mention) => mention.handle)));
		await Promise.all(handles.map(async (handle) => {
			try {
				const did = await this.deps.resolveHandle(handle);
				if (typeof did === 'string' && did) map.set(handle, did);
			} catch (error) {
				// 引けなかったメンションは facets に含めない
			}
		}));
		return map;
	}

	/**
	 * この投稿の操作 (本文の欄・ツールバー・プレビュー) を止める / 戻す。入れ物から預かった要素には触らない。
	 * @param {boolean} busy
	 * @returns {void}
	 */
	setBusy(busy) {
		this.locked = busy === true;
		try {
			for (const control of this.el.querySelectorAll(this.compose.busyControls)) {
				if (!this.isShared(control)) control.disabled = this.locked;
			}
		} catch (error) {
			console.error('[XViewer] 入力欄の送信中の表示に失敗しました', error);
		}
		// 動画のプレビューのボタン (ALT・×・再試行) は送信中かどうかで描き分ける
		if (this.video.isActive()) this.renderVideo();
	}

	/**
	 * 投稿の末尾の 1 行を出す (前のものは消す)。空なら消すだけ。
	 * @param {string[]} messages 知らせる文
	 * @param {ExclusiveCause|null} [exclusive] メディアの排他の知らせなら、その原因
	 *   (原因のメディアを外したときに消すため覚える)
	 * @returns {void}
	 */
	showNotice(messages, exclusive = null) {
		try {
			if (this.noticeEl) this.noticeEl.remove();
			this.noticeEl = null;
			this.noticeExclusive = null;
			if (!Array.isArray(messages) || messages.length === 0 || this.destroyed) return;
			const notice = createElement(this.el.ownerDocument, 'p', this.config.classes.error,
				messages.join(this.compose.text.noticeSeparator));
			notice.setAttribute('role', 'alert');
			this.el.append(notice);
			this.noticeEl = notice;
			this.noticeExclusive = exclusive || null;
		} catch (error) {
			console.error('[XViewer] 入力欄の知らせを出せませんでした', error);
		}
	}

	/**
	 * 出ている 1 行がメディアの排他の知らせなら消す。他の知らせは残す。
	 * @param {ExclusiveCause|null} cause この原因の知らせだけを消す (null は原因を問わない)
	 * @returns {void}
	 */
	clearExclusiveNotice(cause) {
		if (!this.noticeEl || !this.noticeExclusive) return;
		if (cause === null || this.noticeExclusive === cause) this.showNotice([]);
	}

	/**
	 * GIF・カード・引用・動画を片付ける (動画のアップロードが走っていれば取り消す)。
	 * @returns {void}
	 */
	disposeMedia() {
		this.extras.destroy();
		this.video.destroy();
	}

	/**
	 * 後始末。開いている重ねる画面がこの投稿のものなら閉じ、預かった画像の URL を破棄して外す。
	 * 送信中でなければ GIF・カード・引用・動画も片付ける (送信中は送り終えた入れ物が disposeMedia を呼ぶ)。
	 * @returns {void}
	 */
	destroy() {
		if (this.destroyed) return;
		this.destroyed = true;
		try {
			const sheets = this.deps.sheets;
			if (sheets && sheets.isOpenedFrom(this.el)) sheets.close(false);
		} catch (error) {
			console.error('[XViewer] 入力欄の重ねる画面を閉じられませんでした', error);
		}
		for (const attachment of this.attachments) this.revoke(attachment.prepared);
		this.attachments = [];
		// 送信中は送り終えるまで GIF・カード・引用・動画を残す (送る record がそれを読む)
		if (!this.busy) this.disposeMedia();
		try {
			this.el.remove();
		} catch (error) {
			console.error('[XViewer] 入力欄の撤去に失敗しました', error);
		}
	}
}
