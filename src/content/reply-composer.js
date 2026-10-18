/**
 * 返信の入力欄 1 つ分の部品。本文・添付 (画像 10 枚まで、または GIF 1 つ)・ALT・切り抜き・
 * リンクカード・引用・コンテンツの警告・投稿言語と言語の提案・絵文字・貼り付けとドロップ・送信を持つ。
 * 投稿への入力欄も、返信への返信の入力欄もこれを使う。
 *
 * **返信欄 (lightbox-replies.js) を import しない。** 送った結果・世代・送信中の印・
 * 言語の保存・通信は、返信欄が deps として渡す口だけを使う。書き込みは呼び出し層 (PostActions)
 * と橋渡しを通る。
 *
 * 依存: debug.js / icons.js / reply-text.js / reply-embed.js / reply-sheets.js /
 *       reply-attachments.js / reply-submit.js / sheet-dom.js / reply-extras.js / reply-links.js /
 *       gif-sheet.js / klipy.js / bridge-protocol.js
 */
import {ExtDebug} from '../common/debug.js';
import {createIcon} from '../common/icons.js';
import {
	detectRichText, buildFacets, resolveReplyRef, buildReplyRecord, primaryLanguage, fitTextareaHeight, countGraphemes
} from './reply-text.js';
import {
	buildSelfLabels, acceptImages, canSubmitComposer, normalizeLanguages,
	suggestReplyLanguage, buildPostEmbed, hasLabelableMedia, buildOwnPostEmbedView
} from './reply-embed.js';
import {
	openAltSheet, openCropSheet, openLabelSheet, openLanguageSheet, openEmojiSheet, languageName
} from './reply-sheets.js';
import {renderAttachments, updateAttachmentCell, createIconButton} from './reply-attachments.js';
import {createElement, createButton, formatText, browserLocale} from './sheet-dom.js';
import {pickPastedImages, hasImageItems, runSubmit} from './reply-submit.js';
import {ComposerExtras} from './reply-extras.js';
import {shortenLinks} from './reply-links.js';
import {openGifSheet} from './gif-sheet.js';
import {GIF_ALT_PREFIX} from './klipy.js';
import {BRIDGE_PROTOCOL} from '../common/bridge-protocol.js';

/** GIF の検索の応答で中身を使ってよい HTTP の状態 */
const GIF_OK_STATUS = 200;

/** 送る本文の末尾の空白 */
const TRAILING_SPACE = /\s+$/u;

/**
 * GIF の ALT 文の上限 (書記素)。description は接頭辞 + ALT 文で、橋渡しの external の説明の上限に収める
 */
const GIF_ALT_MAX_GRAPHEMES = BRIDGE_PROTOCOL.postRecord.external.maxDescriptionGraphemes
	- countGraphemes(GIF_ALT_PREFIX);

export {pickPastedImages, hasImageItems, uploadAll, runSubmit} from './reply-submit.js';

/**
 * 入力欄が使う口。返信欄 (lightbox-replies.js) が入力欄ごとに作って渡す。
 * @typedef {Object} ComposerDeps
 * @property {import('./post-actions.js').PostActions} actions 呼び出し層
 * @property {import('./reply-sheets.js').SheetHost|null} sheets 重ねる画面の持ち主
 * @property {(blob: Blob) => Promise<{ok: boolean, blob: Object|null, reason: string|null}>} uploadBlob
 * @property {typeof import('./image-prepare.js').prepareImage} prepareImage
 * @property {() => Object|null} getSelfProfile 自分のプロフィール (アバターに使う)
 * @property {() => string|null} getSessionDid ログイン中の DID
 * @property {(generation: number) => boolean} isCurrent 応答を使ってよい世代か
 * @property {() => number} getGeneration 今の世代
 * @property {() => boolean} isPosting どれかの入力欄が送信中か
 * @property {(posting: boolean) => void} setPosting
 * @property {(result: {uri: string, cid: string}, record: Object,
 *   target: import('./lightbox-replies.js').ReplyTarget, embedView: Object|null) => void} onPosted
 *   送れた返信を一覧へ入れる
 * @property {(handle: string) => Promise<string|null>} resolveHandle メンションを DID に引く
 * @property {string[]|null} parentLangs 返信先の record.langs (言語の提案に使う)
 * @property {() => Promise<string[]>} loadLanguages 覚えている投稿言語
 * @property {(codes: string[]) => void} saveLanguages 選んだ投稿言語を覚える
 * @property {(url: string, timeoutMs: number) => Promise<{status: number, json: any}|null>} fetchJson
 *   JSON を引く (リンクカード・GIF の検索)。失敗は null
 * @property {(url: string, timeoutMs: number) => Promise<Blob|null>} fetchBlob サムネイルを引く。失敗は null
 * @property {(uri: string) => Promise<Object|null>} fetchPost 引用する投稿を引く (getPosts の応答)
 * @property {(uri: string) => string|null} safeHref リンクにしてよい URL か
 * @property {(iso: string) => string} formatDate 引用元の日時の表示
 * @property {string|null} gifLocale GIF の検索に渡す地域 (小文字の 2 文字。無ければ null)
 * @property {(labels: string[]) => string|null} [blurText] 引用元の画像をぼかす理由 (無ければぼかさない)
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
 * 入力欄 1 つ分。
 */
export class ReplyComposer {
	/**
	 * @param {Object} config EXT_CONFIG.lightboxReplies
	 * @param {ComposerDeps} deps 返信欄から渡す口
	 * @param {import('./lightbox-replies.js').ReplyTarget} target 返信の宛先
	 * @param {string} placeholder 本文の欄の placeholder
	 */
	constructor(config, deps, target, placeholder) {
		this.config = config;
		this.compose = config.compose;
		this.deps = deps;
		this.target = target;
		this.locale = browserLocale(this.compose.emoji.query.localeJa);
		/** @type {import('./reply-attachments.js').Attachment[]} */
		this.attachments = [];
		/** 取り込みで縮小している最中の枚数 (枚数の上限に数え、送信ボタンを止める) */
		this.importing = 0;
		/** 切り抜き直しで縮小している最中の枚数 (枚数には数えず、送信ボタンだけを止める) */
		this.recropping = 0;
		/** 自己ラベルの選択 */
		this.labels = {adult: null, graphic: false};
		/** @type {string[]} 選んでいる投稿言語 */
		this.languages = defaultLanguages(navigator.language, this.compose);
		/** 利用者が言語を選び直したか (覚えた言語の読み込みで上書きしない) */
		this.languagesTouched = false;
		/** 言語の提案を「×」で閉じたか */
		this.suggestDismissed = false;
		/** @type {string|null} 出している言語の提案 */
		this.suggestCode = null;
		/** @type {boolean} 出ている 1 行が GIF と画像の排他の知らせか */
		this.noticeIsGifExclusive = false;
		/** @type {HTMLElement|null} 入力欄の末尾の 1 行 (失敗・受け取れなかった画像の知らせ) */
		this.noticeEl = null;
		/** この入力欄が送信中か */
		this.busy = false;
		this.destroyed = false;
		/** 直前の操作が文字の貼り付けか (次の input の 1 回だけ真として extras へ渡す) */
		this.pastedPending = false;
		/** GIF・リンクカード・引用の状態 */
		this.extras = this.createExtras();
		this.build(placeholder);
		this.applyStoredLanguages();
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
	 * 入力欄の要素を組む。
	 * @param {string} placeholder
	 * @returns {void}
	 */
	build(placeholder) {
		const c = this.config.classes;
		const cc = this.compose.classes;
		const t = this.compose.text;
		const doc = document;
		const el = createElement(doc, 'div', `${c.form} ${cc.composer}`);
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
		frame.append(textarea);
		row.append(avatar, frame);

		const attachments = createElement(doc, 'ul', cc.attachments);
		attachments.setAttribute('aria-label', t.attachments);
		attachments.hidden = true;
		// GIF・リンクカード・引用のプレビュー (中身は extras が描く)
		const embedPreview = createElement(doc, 'div', cc.embedPreview);
		embedPreview.hidden = true;
		const labelsButton = createButton(doc, cc.labelsButton, '');
		labelsButton.hidden = true;
		const suggest = createElement(doc, 'div', cc.suggest);
		suggest.hidden = true;
		const suggestText = createElement(doc, 'span', cc.suggestText);
		const suggestAccept = createButton(doc, cc.suggestAccept, t.suggestAccept);
		const suggestDismiss = createIconButton(doc, cc.suggestDismiss, 'close', t.suggestDismiss);
		suggest.append(suggestText, suggestAccept, suggestDismiss);

		const toolbar = createElement(doc, 'div', `${c.formFoot} ${cc.toolbar}`);
		const fileInput = createElement(doc, 'input', cc.fileInput);
		fileInput.type = 'file';
		fileInput.multiple = true;
		fileInput.accept = this.compose.acceptImageTypes.join(',');
		fileInput.hidden = true;
		fileInput.tabIndex = -1;
		const imageTool = createIconButton(doc, cc.tool, 'image', t.addImage);
		const gifTool = createIconButton(doc, cc.tool, 'gifBox', t.addGif);
		const emojiTool = createIconButton(doc, cc.tool, 'mood', t.emoji);
		const languageButton = createButton(doc, cc.languageButton, '');
		languageButton.title = t.language;
		const languageText = createElement(doc, 'span', cc.languageText);
		languageButton.append(createIcon(doc, 'translate'), languageText);
		const remaining = createElement(doc, 'span', c.remaining);
		const submit = createButton(doc, c.submit, this.config.text.submit);
		toolbar.append(fileInput, imageTool, gifTool, emojiTool, languageButton, remaining, submit);
		el.append(row, attachments, embedPreview, labelsButton, suggest, toolbar);

		Object.assign(this, {
			el, avatar, textarea, attachmentsEl: attachments, embedEl: embedPreview, labelsButton, suggestEl: suggest,
			suggestText, fileInput, imageTool, gifTool, emojiTool, languageButton, languageText, remaining,
			submitButton: submit
		});
		this.bindEvents(suggestAccept, suggestDismiss);
		this.renderLabels();
		this.renderLanguages();
		this.sync();
	}

	/**
	 * 要素にリスナーを付ける。
	 * @param {HTMLButtonElement} suggestAccept 提案の「はい」
	 * @param {HTMLButtonElement} suggestDismiss 提案の「×」
	 * @returns {void}
	 */
	bindEvents(suggestAccept, suggestDismiss) {
		this.textarea.addEventListener('input', () => {
			const pasted = this.pastedPending;
			this.pastedPending = false;
			this.notifyTextChange(pasted);
			this.sync();
		});
		this.textarea.addEventListener('keydown', (event) => {
			// 打鍵は貼り付けより前に届く。何も貼られなかった貼り付けの印を次の入力へ持ち越さない
			this.pastedPending = false;
			if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
				event.preventDefault();
				this.submit();
			}
		});
		this.textarea.addEventListener('paste', (event) => this.onPaste(event));
		this.el.addEventListener('dragover', (event) => this.onDragOver(event));
		this.el.addEventListener('dragleave', (event) => this.onDragLeave(event));
		this.el.addEventListener('drop', (event) => this.onDrop(event));
		this.submitButton.addEventListener('click', () => this.submit());
		this.imageTool.addEventListener('click', () => {
			if (this.busy) return;
			if (this.extras.gif) {
				this.showNotice([this.compose.text.gifExclusive], true);
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
		this.languageButton.addEventListener('click', () => this.openLanguages());
		this.labelsButton.addEventListener('click', () => this.openLabels());
		suggestAccept.addEventListener('click', () => this.acceptSuggestion());
		suggestDismiss.addEventListener('click', () => {
			this.suggestDismissed = true;
			this.renderSuggest();
			this.textarea.focus({preventScroll: true});
		});
	}

	/**
	 * 本文の欄へフォーカスを移す。
	 * @returns {void}
	 */
	focus() {
		this.textarea.focus({preventScroll: true});
	}

	/**
	 * 書きかけがあるか (本文・添付・GIF が 1 つでもある)。Escape でライトボックスを閉じさせない判定に使う。
	 * @returns {boolean}
	 */
	hasDraft() {
		if (this.destroyed || !this.el.isConnected) return false;
		return this.textarea.value.trim() !== '' || this.attachments.length > 0 || this.isPreparing()
			|| this.extras.gif !== null;
	}

	/**
	 * 画像の枚数 (取り込み中を含む)。GIF・カードとの排他とラベルの判定に使う。
	 * @returns {number}
	 */
	imageCount() {
		return this.attachments.length + this.importing;
	}

	/**
	 * コンテンツの警告を付けられるか (画像・GIF・送るカードのどれかがある)。引用だけでは付けない。
	 * @returns {boolean}
	 */
	isLabelable() {
		const imageCount = this.imageCount();
		return hasLabelableMedia({
			imageCount,
			hasGif: this.extras.gif !== null,
			hasCard: Boolean(this.extras.sendableCard(imageCount))
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
		if (this.extras.gif === null) this.clearGifNotice();
		this.renderExtras();
		this.renderLabels();
		this.sync();
	}

	/**
	 * GIF・リンクカード・引用のプレビューを描き直す。送信中に描いたボタンは押せなくしておく。
	 * × で外した後は、押した × が消えるため本文の欄へフォーカスを移す。
	 * @returns {void}
	 */
	renderExtras() {
		if (this.destroyed) return;
		this.extras.render(this.embedEl, this.imageCount(), {
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
	 * 画像を縮小している最中か (取り込み・切り抜き直しのどちらか)。
	 * @returns {boolean}
	 */
	isPreparing() {
		return this.importing > 0 || this.recropping > 0;
	}

	/**
	 * 残りの文字数・送信ボタン・欄の高さを今の状態に合わせる。
	 * @returns {void}
	 */
	sync() {
		const c = this.config.classes;
		// contentCount は画像の枚数を含んだ合計 (GIF・送るカード・取得できた引用を足したもの)
		const check = canSubmitComposer(this.countedText(this.textarea.value),
			this.extras.contentCount(this.imageCount()), this.config.limits);
		this.remaining.textContent = `${this.config.text.remaining} ${check.remaining}`;
		this.remaining.classList.toggle(c.warn, check.remaining <= this.config.warnRemaining);
		this.submitButton.disabled = !check.ok || this.busy || this.isPreparing() || this.deps.isPosting();
		this.gifTool.disabled = this.busy || this.imageCount() > 0 || this.isPreparing();
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
	 * 覚えた言語を読み、まだ選び直していなければそれにする。
	 * @returns {Promise<void>}
	 */
	async applyStoredLanguages() {
		try {
			const codes = await this.deps.loadLanguages();
			if (this.destroyed || this.languagesTouched) return;
			// 空でもそのまま使う (提案で切り替えた言語を、送った後まで持ち越さない)
			this.languages = normalizeLanguages(codes, this.compose.maxLanguages, this.compose.languageCodes);
			this.renderLanguages();
		} catch (error) {
			console.error('[XViewer] 投稿言語を読み込めませんでした', error);
		}
	}

	/**
	 * 言語のボタンの文言と、言語の提案を今の選択に合わせる。
	 * @returns {void}
	 */
	renderLanguages() {
		const t = this.compose.text;
		const names = this.languages.map((code) => languageName(code, this.locale)).join(t.listSeparator);
		this.languageText.textContent = names || t.language;
		this.languageButton.setAttribute('aria-label', names ? formatText(t.languageCurrent, {names}) : t.language);
		this.renderSuggest();
	}

	/**
	 * 返信先の言語が選択に無いときだけ提案を出す。
	 * @returns {void}
	 */
	renderSuggest() {
		const code = this.suggestDismissed
			? null
			: suggestReplyLanguage(this.deps.parentLangs, this.languages, this.compose.languageCodes);
		this.suggestCode = code;
		this.suggestEl.hidden = code === null;
		this.suggestText.textContent = code === null
			? ''
			: formatText(this.compose.text.suggest, {言語: languageName(code, this.locale)});
	}

	/**
	 * 提案の「はい」。その言語だけに切り替える (覚えはしない。送った後は覚えた言語に戻す)。
	 * @returns {void}
	 */
	acceptSuggestion() {
		if (!this.suggestCode) return;
		this.languages = [this.suggestCode];
		this.languagesTouched = true;
		this.renderLanguages();
		this.textarea.focus({preventScroll: true});
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
	 * 1 枚ずつ縮小して預かる。縮小の最中は送信ボタンだけを止める。GIF があるあいだは取り込まない。
	 * @param {File[]|FileList} files
	 * @returns {Promise<void>}
	 */
	async addFiles(files) {
		if (this.destroyed || this.busy) return;
		const t = this.compose.text;
		if (this.extras.gif) {
			this.showNotice([t.gifExclusive], true);
			return;
		}
		const list = Array.from(files || []);
		const result = acceptImages(this.attachments.length + this.importing, list,
			this.compose.acceptImageTypes, this.compose.maxImages);
		const notices = [];
		if (result.tooMany > 0) notices.push(t.tooManyImages);
		if (result.unsupported > 0) notices.push(t.unsupportedImage);
		this.showNotice(notices);
		this.importing += result.accepted.length;
		if (result.accepted.length > 0) {
			// 取り込み中から画像として扱う (カードを隠し、ラベルを出す)
			this.renderExtras();
			this.renderLabels();
		}
		this.sync();
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
			this.sync();
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
		this.renderAttachments();
		this.sync();
		const next = this.attachments[Math.min(index, this.attachments.length - 1)];
		const target = next && next.cell ? next.cell.removeButton : this.imageTool;
		target.focus({preventScroll: true});
	}

	/**
	 * 重ねる画面に添える情報。持ち主はこの入力欄で、開いたボタンが描き直されて外れていたら
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
		this.sync();
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
		this.sync();
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
		}, this.sheetOptions(() => this.labelsButton));
	}

	/**
	 * 投稿言語の画面を開く。選んだものは覚えて次回の既定にする。
	 * @returns {void}
	 */
	openLanguages() {
		if (!this.deps.sheets || this.busy) return;
		openLanguageSheet(this.deps.sheets, {selected: this.languages.slice()}, this.languageButton, (codes) => {
			this.languages = normalizeLanguages(codes, this.compose.maxLanguages, this.compose.languageCodes);
			this.languagesTouched = true;
			this.deps.saveLanguages(this.languages.slice());
			this.renderLanguages();
		}, this.sheetOptions(() => this.languageButton));
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
	 * GIF の画面を開く。画像がある (取り込み中を含む)・送信中なら開かない。
	 * @returns {void}
	 */
	openGif() {
		if (!this.deps.sheets || this.busy || this.imageCount() > 0 || this.isPreparing()) return;
		openGifSheet(this.deps.sheets, {
			fetchJson: (url) => this.fetchGifJson(url),
			locale: typeof this.deps.gifLocale === 'string' && this.deps.gifLocale ? this.deps.gifLocale : null,
			rule: this.compose.gif
		}, this.gifTool, (item) => {
			if (this.destroyed) return;
			// 画面を開いているあいだに画像が落とされていたら付けない
			if (this.imageCount() > 0) {
				this.showNotice([this.compose.text.gifExclusive], true);
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
		this.sync();
	}

	/**
	 * 貼り付け。画像があるときだけ既定の貼り付けを止めて取り込む (GIF があれば取り込まずに知らせる)。
	 * 文字だけなら既定の貼り付けに任せ、続く input を「貼り付けの直後」として扱う。
	 * @param {ClipboardEvent} event
	 * @returns {void}
	 */
	onPaste(event) {
		const files = pickPastedImages(event.clipboardData && event.clipboardData.items);
		if (files.length === 0) {
			this.pastedPending = true;
			return;
		}
		event.preventDefault();
		this.addFiles(files);
	}

	/**
	 * ドラッグが重なった。画像のファイルを含むときだけ受ける (送信中は受けないが、既定の動作は止める)。
	 * @param {DragEvent} event
	 * @returns {void}
	 */
	onDragOver(event) {
		const transfer = event.dataTransfer;
		if (!transfer || !hasImageItems(transfer.items)) return;
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
	 * ドロップ。画像のファイルを含むときだけ受け、本体のページへは届かせない。送信中は取り込まない。
	 * @param {DragEvent} event
	 * @returns {void}
	 */
	onDrop(event) {
		this.el.classList.remove(this.compose.classes.dragOver);
		const transfer = event.dataTransfer;
		if (!transfer || !hasImageItems(transfer.items)) return;
		event.preventDefault();
		event.stopPropagation();
		// 送信中は取り込まない (添付が送るものと食い違うため)
		if (!this.busy) this.addFiles(Array.from(transfer.files || []));
	}

	/**
	 * 返信を送る。失敗したら本文・添付・ALT・GIF・カード・引用・ラベル・言語を残して 1 行で知らせる。
	 * 本文のリンクは短い形にして送る (facet の uri は元のまま)。
	 * @returns {Promise<void>}
	 */
	async submit() {
		if (this.destroyed || this.busy || this.isPreparing() || this.deps.isPosting()) return;
		const value = this.textarea.value;
		const imageCount = this.attachments.length;
		const check = canSubmitComposer(this.countedText(value), this.extras.contentCount(imageCount), this.config.limits);
		if (!check.ok) return;
		const generation = this.deps.getGeneration();
		const hadFocus = document.activeElement === this.textarea;
		const attachments = this.attachments.slice();
		const languages = this.languages.slice();
		const labels = this.isLabelable() ? buildSelfLabels(this.labels) : null;
		const legacyMax = this.compose.legacyImagesMax;
		const toUploaded = (blobs) => attachments.map((attachment, index) => ({
			blob: blobs[index], alt: attachment.alt, width: attachment.prepared.width, height: attachment.prepared.height
		}));
		/** @type {import('./reply-extras.js').SubmitExtras} 送った GIF・カード・引用 (投稿直後の描画に使う) */
		let resolved = {external: null, quote: null, quoteView: null};
		this.deps.setPosting(true);
		this.setBusy(true);
		this.showNotice([]);
		try {
			await runSubmit({
				images: attachments.map((attachment) => attachment.prepared),
				upload: this.deps.uploadBlob,
				onProgress: (current, total) => this.showProgress(current, total),
				// 入力欄が外されただけ (描き直し・返信への返信の入力欄を閉じた) なら送信は続ける。
				// 止めると、作れた返信が一覧に入らない・書きかけが黙って消える
				isCurrent: () => this.deps.isCurrent(generation),
				buildRecord: async (blobs) => {
					// GIF・カードのサムネイルを送るあいだも送信ボタンに進み具合 (1/1) を出す
					resolved = await this.extras.resolveForSubmit(
						(done, total) => this.showProgress(done, total), attachments.length);
					// 本体と同じく、送る本文の末尾の空白は除く (リンクカードの提案は後ろの空白で始まる)
					const sendValue = value.replace(TRAILING_SPACE, '');
					const detected = detectRichText(sendValue);
					const didByHandle = await this.resolveMentions(detected.mentions);
					const shortened = shortenLinks(sendValue, buildFacets(detected, didByHandle), this.compose.links);
					return buildReplyRecord({
						text: shortened.text,
						reply: resolveReplyRef(this.target),
						createdAt: new Date().toISOString(),
						langs: languages.length > 0 ? languages : null,
						facets: shortened.facets,
						embed: buildPostEmbed({
							images: toUploaded(blobs), external: resolved.external, quote: resolved.quote
						}, legacyMax),
						labels
					});
				},
				createReply: (record) => this.deps.actions.createReply(record),
				onPosted: (result, record, blobs) => {
					const did = this.deps.getSessionDid();
					const embedView = buildOwnPostEmbedView({
						images: toUploaded(blobs), external: resolved.external, quoteView: resolved.quoteView
					}, did, this.compose.cdn, legacyMax);
					if (!this.destroyed) this.resetAfterPost();
					this.deps.onPosted(result, record, this.target, embedView);
				},
				onFailed: (kind, reason) => {
					ExtDebug.log('返信の投稿が失敗', {段階: kind, 理由: reason});
					if (!this.destroyed) this.showNotice([kind === 'upload' ? this.compose.text.uploadFailed : this.config.text.postFailed]);
				}
			});
		} catch (error) {
			console.error('[XViewer] 返信の投稿に失敗しました', error);
			if (!this.destroyed && this.deps.isCurrent(generation)) this.showNotice([this.config.text.postFailed]);
		} finally {
			if (this.deps.isCurrent(generation)) this.deps.setPosting(false);
			this.setBusy(false);
			// 送信中に外されていたら、送り終えたここで extras を片付ける
			if (this.destroyed) this.extras.destroy();
			this.sync();
			if (hadFocus && this.textarea.isConnected) this.textarea.focus({preventScroll: true});
		}
	}

	/**
	 * 送れた後に、本文・添付・GIF・カード・引用・ラベルを空に戻し、言語を覚えたものに戻す。
	 * 言語の提案を閉じたことはその入力欄のあいだ保つ。
	 * @returns {void}
	 */
	resetAfterPost() {
		this.textarea.value = '';
		this.pastedPending = false;
		for (const attachment of this.attachments) this.revoke(attachment.prepared);
		this.attachments = [];
		this.extras.reset();
		this.clearGifNotice();
		this.labels = {adult: null, graphic: false};
		this.languagesTouched = false;
		this.renderAttachments();
		this.renderLanguages();
		this.applyStoredLanguages();
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
	 * 送信中の見た目にする / 戻す。入力欄・ツールバー・プレビューの操作を止める。
	 * @param {boolean} busy
	 * @returns {void}
	 */
	setBusy(busy) {
		this.busy = busy;
		try {
			for (const control of this.el.querySelectorAll(this.compose.busyControls)) control.disabled = busy;
			if (busy) {
				this.submitButton.setAttribute('aria-busy', 'true');
			} else {
				this.submitButton.removeAttribute('aria-busy');
				this.submitButton.textContent = this.config.text.submit;
			}
		} catch (error) {
			console.error('[XViewer] 入力欄の送信中の表示に失敗しました', error);
		}
	}

	/**
	 * 送信ボタンにアップロードの進み具合 (いま送っている枚目) を出す。
	 * @param {number} current いま送っている枚目 (1 始まり)
	 * @param {number} total 全体の枚数
	 * @returns {void}
	 */
	showProgress(current, total) {
		const done = Math.min(Math.max(current, 1), total);
		if (this.busy) this.submitButton.textContent = formatText(this.compose.text.sending, {done, total});
	}

	/**
	 * 入力欄の末尾の 1 行を出す (前のものは消す)。空なら消すだけ。
	 * @param {string[]} messages 知らせる文
	 * @param {boolean} [gifExclusive] GIF と画像の排他の知らせか (GIF を外したときに消すため覚える)
	 * @returns {void}
	 */
	showNotice(messages, gifExclusive = false) {
		try {
			if (this.noticeEl) this.noticeEl.remove();
			this.noticeEl = null;
			this.noticeIsGifExclusive = false;
			if (!Array.isArray(messages) || messages.length === 0 || this.destroyed) return;
			const notice = createElement(this.el.ownerDocument, 'p', this.config.classes.error,
				messages.join(this.compose.text.noticeSeparator));
			notice.setAttribute('role', 'alert');
			this.el.append(notice);
			this.noticeEl = notice;
			this.noticeIsGifExclusive = gifExclusive;
		} catch (error) {
			console.error('[XViewer] 入力欄の知らせを出せませんでした', error);
		}
	}

	/**
	 * 出ている 1 行が GIF と画像の排他の知らせなら消す。他の知らせは残す。
	 * @returns {void}
	 */
	clearGifNotice() {
		if (this.noticeEl && this.noticeIsGifExclusive) this.showNotice([]);
	}

	/**
	 * 後始末。開いている重ねる画面がこの入力欄のものなら閉じ、預かった画像の URL を破棄して外す。
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
		// 送信中は送り終えるまで GIF・カード・引用を残す (送る record がそれを読む)
		if (!this.busy) this.extras.destroy();
		try {
			this.el.remove();
		} catch (error) {
			console.error('[XViewer] 入力欄の撤去に失敗しました', error);
		}
	}
}
