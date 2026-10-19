/**
 * 返信の入力欄の添付のプレビュー (2 列の格子)。マスごとに ALT・切り抜き・外すのボタンを持つ。
 * 押したときの処理は呼び出し側 (reply-composer.js) が渡す。ALT と切り抜きの後は
 * マスを作り直さずに中身だけ差し替える (重ねる画面を閉じたとき、開いたボタンへ
 * フォーカスを戻せるようにするため)。
 *
 * 依存: icons.js (createIcon)・sheet-dom.js (createElement / createButton / formatText)
 */
import {createIcon} from '../common/icons.js';
import {createElement, createButton, formatText} from './sheet-dom.js';

/**
 * 添付 1 枚分の状態。
 * @typedef {Object} Attachment
 * @property {import('./image-prepare.js').PreparedImage} prepared 縮小済みの画像
 * @property {string} alt ALT テキスト
 * @property {AttachmentCell|null} cell 描いているマス
 */

/**
 * 描いているマスの要素。
 * @typedef {Object} AttachmentCell
 * @property {HTMLElement} li マス
 * @property {HTMLImageElement} img プレビュー
 * @property {HTMLButtonElement} altButton ALT のボタン
 * @property {HTMLButtonElement} cropButton 切り抜きのボタン
 * @property {HTMLButtonElement} removeButton 外すボタン
 */

/**
 * マスのボタンが押されたときの処理。
 * @typedef {Object} AttachmentHandlers
 * @property {(attachment: Attachment, button: HTMLButtonElement) => void} onAlt
 * @property {(attachment: Attachment, button: HTMLButtonElement) => void} onCrop
 * @property {(attachment: Attachment) => void} onRemove
 */

/**
 * アイコンだけのボタンを作る。名前は aria-label と title に入れる。
 * @param {Document} doc 対象の文書
 * @param {string} className クラス名
 * @param {string} icon アイコンの名前
 * @param {string} label ボタンの名前
 * @returns {HTMLButtonElement}
 */
export function createIconButton(doc, className, icon, label) {
	const button = createButton(doc, className, '');
	button.setAttribute('aria-label', label);
	button.title = label;
	button.append(createIcon(doc, icon));
	return button;
}

/**
 * マスの中身 (プレビューの画像・代替テキスト・ALT のボタンの文言) を今の状態に合わせる。
 * @param {Attachment} attachment 添付
 * @param {number} index 何枚目か (0 始まり)
 * @param {Object} compose EXT_CONFIG.lightboxReplies.compose
 * @returns {void}
 */
export function updateAttachmentCell(attachment, index, compose) {
	const cell = attachment.cell;
	if (!cell) return;
	const {classes, text} = compose;
	const doc = cell.li.ownerDocument;
	const name = formatText(text.attachment, {index: index + 1});
	cell.img.src = attachment.prepared.previewUrl;
	cell.img.alt = attachment.alt ? `${name}: ${attachment.alt}` : name;
	const done = attachment.alt !== '';
	cell.altButton.classList.toggle(classes.altDone, done);
	cell.altButton.textContent = '';
	if (done) cell.altButton.append(createIcon(doc, 'check'));
	cell.altButton.append(createElement(doc, 'span', '', done ? text.altDone : text.alt));
	cell.altButton.setAttribute('aria-label', `${name}: ${done ? text.altDone : text.altTitle}`);
}

/**
 * マスを 1 つ作る。
 * @param {Document} doc
 * @param {Attachment} attachment
 * @param {Object} compose EXT_CONFIG.lightboxReplies.compose
 * @param {AttachmentHandlers} handlers
 * @returns {AttachmentCell}
 */
function buildCell(doc, attachment, compose, handlers) {
	const {classes, text} = compose;
	const li = createElement(doc, 'li', classes.attachment);
	const img = createElement(doc, 'img', classes.attachmentImage);
	img.setAttribute('draggable', 'false');
	const tools = createElement(doc, 'div', classes.attachmentTools);
	const cropButton = createIconButton(doc, classes.attachmentButton, 'crop', text.crop);
	const removeButton = createIconButton(doc, classes.attachmentButton, 'close', text.remove);
	const altButton = createButton(doc, classes.altButton, '');
	cropButton.addEventListener('click', () => handlers.onCrop(attachment, cropButton));
	removeButton.addEventListener('click', () => handlers.onRemove(attachment));
	altButton.addEventListener('click', () => handlers.onAlt(attachment, altButton));
	tools.append(cropButton, removeButton);
	li.append(img, tools, altButton);
	return {li, img, altButton, cropButton, removeButton};
}

/**
 * 添付のプレビューを今の並びに合わせる。0 枚なら入れ物を隠す。
 * 描いてあるマスが並びの先頭とそのまま一致するあいだは作り直さず、足された分だけを末尾に足す
 * (画像を 1 枚取り込むたびに全マスを作り直さないため)。外した・入れ替えたときはすべて作り直す。
 * @param {HTMLElement} container 入れ物 (ul)
 * @param {Attachment[]} attachments 添付
 * @param {Object} compose EXT_CONFIG.lightboxReplies.compose
 * @param {AttachmentHandlers} handlers 押されたときの処理
 * @param {boolean} disabled 送信中か (ボタンを押せなくする)
 * @returns {void}
 */
export function renderAttachments(container, attachments, compose, handlers, disabled) {
	const doc = container.ownerDocument;
	container.hidden = attachments.length === 0;
	container.dataset.count = String(attachments.length);
	const current = Array.from(container.children);
	let kept = 0;
	while (kept < current.length && kept < attachments.length
		&& attachments[kept].cell && attachments[kept].cell.li === current[kept]) {
		kept += 1;
	}
	if (kept < current.length) {
		container.textContent = '';
		kept = 0;
	}
	attachments.forEach((attachment, index) => {
		if (index >= kept) {
			attachment.cell = buildCell(doc, attachment, compose, handlers);
			container.append(attachment.cell.li);
			updateAttachmentCell(attachment, index, compose);
		}
		const cell = attachment.cell;
		for (const button of [cell.cropButton, cell.removeButton, cell.altButton]) button.disabled = disabled;
	});
}
