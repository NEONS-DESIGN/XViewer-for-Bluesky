/**
 * 返信の入力欄 1 つ分の部品。本文・添付 (画像 10 枚まで)・ALT・切り抜き・コンテンツの警告・
 * 投稿言語と言語の提案・絵文字・貼り付けとドロップ・送信を持つ。
 * 投稿への入力欄も、返信への返信の入力欄もこれを使う。
 *
 * **返信欄 (lightbox-replies.js) を import しない。** 送った結果・世代・送信中の印・
 * 言語の保存は、返信欄が deps として渡す口だけを使う。書き込みは呼び出し層 (PostActions)
 * と橋渡しを通る。
 *
 * 依存: debug.js / icons.js / reply-text.js / reply-embed.js / reply-sheets.js /
 *       reply-attachments.js / reply-submit.js / sheet-dom.js
 */
import {ExtDebug} from '../common/debug.js';
import {createIcon} from '../common/icons.js';
import {
	detectRichText, buildFacets, resolveReplyRef, buildReplyRecord, primaryLanguage, fitTextareaHeight
} from './reply-text.js';
import {
	buildMediaEmbed, buildSelfLabels, acceptImages, canSubmitComposer, normalizeLanguages,
	suggestReplyLanguage, buildOwnEmbedView
} from './reply-embed.js';
import {
	openAltSheet, openCropSheet, openLabelSheet, openLanguageSheet, openEmojiSheet, languageName
} from './reply-sheets.js';
import {renderAttachments, updateAttachmentCell, createIconButton} from './reply-attachments.js';
import {createElement, createButton, formatText, browserLocale} from './sheet-dom.js';
import {pickPastedImages, hasImageItems, runSubmit} from './reply-submit.js';

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
		/** @type {HTMLElement|null} 入力欄の末尾の 1 行 (失敗・受け取れなかった画像の知らせ) */
		this.noticeEl = null;
		/** この入力欄が送信中か */
		this.busy = false;
		this.destroyed = false;
		this.build(placeholder);
		this.applyStoredLanguages();
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
		const emojiTool = createIconButton(doc, cc.tool, 'mood', t.emoji);
		const languageButton = createButton(doc, cc.languageButton, '');
		languageButton.title = t.language;
		const languageText = createElement(doc, 'span', cc.languageText);
		languageButton.append(createIcon(doc, 'translate'), languageText);
		const remaining = createElement(doc, 'span', c.remaining);
		const submit = createButton(doc, c.submit, this.config.text.submit);
		toolbar.append(fileInput, imageTool, emojiTool, languageButton, remaining, submit);
		el.append(row, attachments, labelsButton, suggest, toolbar);

		Object.assign(this, {
			el, avatar, textarea, attachmentsEl: attachments, labelsButton, suggestEl: suggest,
			suggestText, fileInput, imageTool, emojiTool, languageButton, languageText, remaining, submitButton: submit
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
		this.textarea.addEventListener('input', () => this.sync());
		this.textarea.addEventListener('keydown', (event) => {
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
			if (!this.busy) this.fileInput.click();
		});
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
	 * 書きかけがあるか (本文か添付が 1 つでもある)。Escape でライトボックスを閉じさせない判定に使う。
	 * @returns {boolean}
	 */
	hasDraft() {
		if (this.destroyed || !this.el.isConnected) return false;
		return this.textarea.value.trim() !== '' || this.attachments.length > 0 || this.isPreparing();
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
		const check = canSubmitComposer(this.textarea.value, this.attachments.length, this.config.limits);
		this.remaining.textContent = `${this.config.text.remaining} ${check.remaining}`;
		this.remaining.classList.toggle(c.warn, check.remaining <= this.config.warnRemaining);
		this.submitButton.disabled = !check.ok || this.busy || this.isPreparing() || this.deps.isPosting();
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
	 * ラベルのボタンの文言を今の選択に合わせる。添付があるときだけ出す。
	 * @returns {void}
	 */
	renderLabels() {
		const doc = this.labelsButton.ownerDocument;
		const t = this.compose.text;
		const values = [];
		if (this.labels.adult) values.push(this.labels.adult);
		if (this.labels.graphic) values.push(this.compose.labels.graphic);
		const names = values.map((value) => t.labelNames[value] || value).join(t.listSeparator);
		this.labelsButton.hidden = this.attachments.length === 0;
		this.labelsButton.classList.toggle(this.compose.classes.labelsActive, values.length > 0);
		this.labelsButton.textContent = '';
		this.labelsButton.append(createIcon(doc, 'warning'), createElement(doc, 'span', '', names || t.labels));
		this.labelsButton.setAttribute('aria-label', names ? formatText(t.labelsCurrent, {names}) : t.labelTitle);
	}

	/**
	 * 添付のプレビューを描き直す。
	 * @returns {void}
	 */
	renderAttachments() {
		renderAttachments(this.attachmentsEl, this.attachments, this.compose, {
			onAlt: (attachment, button) => this.openAlt(attachment, button),
			onCrop: (attachment, button) => this.openCrop(attachment, button),
			onRemove: (attachment) => this.removeAttachment(attachment)
		}, this.busy);
		this.renderLabels();
	}

	/**
	 * 選んだ・貼り付けた・落としたファイルを取り込む。受け取れないものは 1 行で知らせる。
	 * 1 枚ずつ縮小して預かる。縮小の最中は送信ボタンだけを止める。
	 * @param {File[]|FileList} files
	 * @returns {Promise<void>}
	 */
	async addFiles(files) {
		if (this.destroyed || this.busy) return;
		const t = this.compose.text;
		const list = Array.from(files || []);
		const result = acceptImages(this.attachments.length + this.importing, list,
			this.compose.acceptImageTypes, this.compose.maxImages);
		const notices = [];
		if (result.tooMany > 0) notices.push(t.tooManyImages);
		if (result.unsupported > 0) notices.push(t.unsupportedImage);
		this.showNotice(notices);
		this.importing += result.accepted.length;
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
			});
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
			button, (crop) => this.recrop(attachment, crop));
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
		if (!this.deps.sheets || this.busy) return;
		openLabelSheet(this.deps.sheets, {...this.labels}, this.labelsButton, (selection) => {
			this.labels = {adult: selection.adult || null, graphic: selection.graphic === true};
			this.renderLabels();
		});
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
		});
	}

	/**
	 * 絵文字の画面を開く。選んだ絵文字は本文のカーソルの位置に入れ、画面は開いたままにする。
	 * @returns {void}
	 */
	openEmoji() {
		if (!this.deps.sheets || this.busy) return;
		openEmojiSheet(this.deps.sheets, this.emojiTool, (native) => this.insertText(native));
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
		this.sync();
	}

	/**
	 * 貼り付け。画像があるときだけ既定の貼り付けを止めて取り込む (文字だけなら何もしない)。
	 * @param {ClipboardEvent} event
	 * @returns {void}
	 */
	onPaste(event) {
		const files = pickPastedImages(event.clipboardData && event.clipboardData.items);
		if (files.length === 0) return;
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
	 * 返信を送る。失敗したら本文・添付・ALT・ラベル・言語を残して 1 行で知らせる。
	 * @returns {Promise<void>}
	 */
	async submit() {
		if (this.destroyed || this.busy || this.isPreparing() || this.deps.isPosting()) return;
		const value = this.textarea.value;
		if (!canSubmitComposer(value, this.attachments.length, this.config.limits).ok) return;
		const generation = this.deps.getGeneration();
		const hadFocus = document.activeElement === this.textarea;
		const attachments = this.attachments.slice();
		const languages = this.languages.slice();
		const labels = attachments.length > 0 ? buildSelfLabels(this.labels) : null;
		const legacyMax = this.compose.legacyImagesMax;
		const toUploaded = (blobs) => attachments.map((attachment, index) => ({
			blob: blobs[index], alt: attachment.alt, width: attachment.prepared.width, height: attachment.prepared.height
		}));
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
					const detected = detectRichText(value);
					const didByHandle = await this.resolveMentions(detected.mentions);
					return buildReplyRecord({
						text: value,
						reply: resolveReplyRef(this.target),
						createdAt: new Date().toISOString(),
						langs: languages.length > 0 ? languages : null,
						facets: buildFacets(detected, didByHandle),
						embed: buildMediaEmbed(toUploaded(blobs), legacyMax),
						labels
					});
				},
				createReply: (record) => this.deps.actions.createReply(record),
				onPosted: (result, record, blobs) => {
					const did = this.deps.getSessionDid();
					const embedView = buildOwnEmbedView(toUploaded(blobs), did, this.compose.cdn, legacyMax);
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
			this.sync();
			if (hadFocus && this.textarea.isConnected) this.textarea.focus({preventScroll: true});
		}
	}

	/**
	 * 送れた後に、本文・添付・ラベルを空に戻し、言語を覚えたものに戻す。
	 * 言語の提案を閉じたことはその入力欄のあいだ保つ。
	 * @returns {void}
	 */
	resetAfterPost() {
		this.textarea.value = '';
		for (const attachment of this.attachments) this.revoke(attachment.prepared);
		this.attachments = [];
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
	 * @returns {void}
	 */
	showNotice(messages) {
		try {
			if (this.noticeEl) this.noticeEl.remove();
			this.noticeEl = null;
			if (!Array.isArray(messages) || messages.length === 0 || this.destroyed) return;
			const notice = createElement(this.el.ownerDocument, 'p', this.config.classes.error,
				messages.join(this.compose.text.noticeSeparator));
			notice.setAttribute('role', 'alert');
			this.el.append(notice);
			this.noticeEl = notice;
		} catch (error) {
			console.error('[XViewer] 入力欄の知らせを出せませんでした', error);
		}
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
		try {
			this.el.remove();
		} catch (error) {
			console.error('[XViewer] 入力欄の撤去に失敗しました', error);
		}
	}
}
