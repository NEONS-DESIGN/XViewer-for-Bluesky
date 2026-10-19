/**
 * パネルに重ねる画面 (reply-sheets.js / crop-sheet.js / language-sheet.js など) とカード (embed-cards.js) が
 * 共通で使う、要素の組み立てと小さな道具。config も知らない。
 */

/**
 * 要素を作る。
 * @param {Document} doc 対象の文書
 * @param {string} tagName タグ名
 * @param {string} [className] クラス名
 * @param {string} [text] 中身の文字
 * @returns {HTMLElement}
 */
export function createElement(doc, tagName, className, text) {
	const element = doc.createElement(tagName);
	if (className) element.className = className;
	if (text !== undefined) element.textContent = text;
	return element;
}

/**
 * 押しボタンを作る (type="button")。
 * @param {Document} doc 対象の文書
 * @param {string} className クラス名
 * @param {string} label 文言
 * @returns {HTMLButtonElement}
 */
export function createButton(doc, className, label) {
	const button = createElement(doc, 'button', className, label);
	button.type = 'button';
	return button;
}

/**
 * 失敗を知らせる 1 行 (role="alert")。最初は隠しておき、出すときに hidden を外す。
 * @param {Document} doc 対象の文書
 * @param {string} className クラス名
 * @param {string} [text] 文言 (後から textContent で差し替えてもよい)
 * @returns {HTMLElement}
 */
export function createAlert(doc, className, text) {
	const alert = createElement(doc, 'p', className, text);
	alert.setAttribute('role', 'alert');
	alert.hidden = true;
	return alert;
}

/**
 * 押下を親へ伝えずに処理する。既定の動作 (カードの a の遷移など) も止める。
 * カードの中に置くボタン (外す・ALT・再生) が、カード自身の押下を起こさないようにする。
 * @param {HTMLElement} element 押す要素
 * @param {(event: Event) => void} handler 押したときの処理
 * @returns {void}
 */
export function onIsolatedClick(element, handler) {
	element.addEventListener('click', (event) => {
		event.preventDefault();
		event.stopPropagation();
		handler(event);
	});
}

/**
 * 選択肢の 1 行。ラジオかチェックボックスと文言を label で包む。
 * @param {Document} doc 対象の文書
 * @param {string} className 行のクラス名
 * @param {'radio'|'checkbox'} type 種類
 * @param {string} name name 属性 (ラジオの組。チェックボックスは空でよい)
 * @param {string} label 文言
 * @param {boolean} checked 選ばれているか
 * @returns {{row: HTMLLabelElement, control: HTMLInputElement}}
 */
export function createOption(doc, className, type, name, label, checked) {
	const row = createElement(doc, 'label', className);
	const control = doc.createElement('input');
	control.type = type;
	control.name = name;
	control.checked = checked;
	row.append(control, createElement(doc, 'span', '', label));
	return {row, control};
}

/**
 * 文言の {名前} を値で置き換える。値の無い名前はそのまま残す。
 * @param {string} template 文言
 * @param {Record<string, string|number>} values 差し込む値
 * @returns {string}
 */
export function formatText(template, values) {
	return String(template).replace(/\{([^{}\s]+)\}/g, (whole, name) =>
		(Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : whole));
}

/**
 * 呼び出し側の処理を呼ぶ。例外は記録して飲み込む (画面の開閉を途中で止めない)。
 * @param {Function|undefined} callback 呼ぶ処理
 * @param {...*} args 引数
 * @returns {*} 処理の戻り値。呼べなかった・失敗したときは undefined
 */
export function safeCall(callback, ...args) {
	if (typeof callback !== 'function') return undefined;
	try {
		return callback(...args);
	} catch (error) {
		console.error('[XViewer] 重ねる画面の処理に失敗しました', error);
		return undefined;
	}
}

/**
 * ブラウザの言語。読めなければ fallback を返す。
 * @param {string} fallback 読めないときの言語
 * @returns {string}
 */
export function browserLocale(fallback) {
	try {
		return (typeof navigator !== 'undefined' && navigator.language) || fallback;
	} catch (error) {
		return fallback;
	}
}
