/**
 * 投稿言語を選ぶ画面。パネルに重ねる画面 (reply-sheets.js の SheetHost) の 1 つ。
 * 検索欄とチェックボックスの一覧を出し、上限まで選んだら残りを止める。
 * 表示名は Intl.DisplayNames (表示言語はブラウザの言語) で出し、使えなければコードのまま。
 *
 * 依存: sheet-dom.js
 */
import {createElement, createOption, formatText, safeCall, browserLocale} from './sheet-dom.js';

/** 表示名を作る道具を、表示言語ごとに 1 つだけ作って使い回す */
const languageNamers = new Map();

/**
 * 言語コードの表示名。Intl.DisplayNames が使えない・コードを知らないときはコードのまま返す。
 * @param {string} code 言語コード (ISO 639-1)
 * @param {string} locale 表示に使う言語 (ブラウザの言語)
 * @returns {string}
 */
export function languageName(code, locale) {
	try {
		let namer = languageNamers.get(locale);
		if (namer === undefined) {
			try {
				namer = new Intl.DisplayNames([locale], {type: 'language'});
			} catch (error) {
				namer = null;
			}
			languageNamers.set(locale, namer);
		}
		if (!namer) return code;
		return namer.of(code) || code;
	} catch (error) {
		return code;
	}
}

/**
 * 言語の一覧の並び。選んでいるものを選んだ順に先頭へ、残りは元の並びにする。
 * 一覧に無いコードは捨てる。
 * @param {string[]} codes 一覧のコード
 * @param {string[]} selected 選んでいるコード
 * @returns {string[]}
 */
export function orderLanguages(codes, selected) {
	const known = selected.filter((code) => codes.indexOf(code) !== -1);
	return [...known, ...codes.filter((code) => known.indexOf(code) === -1)];
}

/**
 * 検索語で言語を絞る。表示名かコードの部分一致で、大文字小文字を区別しない。
 * @param {{code: string, name: string}[]} entries 言語の一覧
 * @param {string} query 検索語 (前後の空白は無視する)
 * @returns {{code: string, name: string}[]}
 */
export function filterLanguages(entries, query) {
	const needle = String(query || '').trim().toLowerCase();
	if (!needle) return entries.slice();
	return entries.filter((entry) => entry.name.toLowerCase().includes(needle)
		|| entry.code.toLowerCase().includes(needle));
}

/**
 * 上限まで選んだので、その言語を選べなくするか (選んでいるものは外せるよう止めない)。
 * @param {string} code 言語コード
 * @param {string[]} selected 選んでいるコード
 * @param {number} max 上限
 * @returns {boolean}
 */
export function isLanguageLocked(code, selected, max) {
	return selected.length >= max && selected.indexOf(code) === -1;
}

/**
 * 渡された選択から、一覧にあるものを重ねずに上限まで残す。
 * @param {*} given 渡された選択
 * @param {string[]} codes 一覧のコード
 * @param {number} max 上限
 * @returns {string[]}
 */
function normalizeSelection(given, codes, max) {
	const list = Array.isArray(given) ? given : [];
	return list.filter((code, index) => codes.indexOf(code) !== -1 && list.indexOf(code) === index).slice(0, max);
}

/**
 * 投稿言語の画面を開く。1 つも選んでいないあいだは「完了」を押せなくする。
 * @param {import('./reply-sheets.js').SheetHost} host 重ねる画面の持ち主
 * @param {{selected: string[]}} input 今選んでいるコード
 * @param {HTMLElement} opener 開いたボタン
 * @param {(codes: string[]) => void} onSave 「完了」で選んだコード (選んだ順) を受け取る
 * @param {import('./reply-sheets.js').SheetOptions} [options] 持ち主とフォーカスの戻し先
 * @returns {void}
 */
export function openLanguageSheet(host, input, opener, onSave, options) {
	const {classes, text, languageCodes, maxLanguages, emoji} = host.config;
	const selected = normalizeSelection(input?.selected, languageCodes, maxLanguages);
	host.open({
		title: text.langTitle,
		build: (body) => {
			const doc = body.ownerDocument;
			const locale = browserLocale(emoji.query.localeJa);
			const entries = orderLanguages(languageCodes, selected)
				.map((code) => ({code, name: languageName(code, locale)}));
			const search = createElement(doc, 'input', classes.langSearch);
			search.type = 'search';
			search.setAttribute('aria-label', text.langSearch);
			search.setAttribute('placeholder', text.langSearch);
			const count = createElement(doc, 'p', classes.langCount);
			count.setAttribute('aria-live', 'polite');
			const list = createElement(doc, 'div', classes.langList);
			list.setAttribute('role', 'group');
			list.setAttribute('aria-label', text.langTitle);
			const empty = createElement(doc, 'p', classes.note, text.langEmpty);
			empty.hidden = true;
			const rows = new Map();
			const sync = () => {
				for (const [code, option] of rows) {
					option.control.checked = selected.indexOf(code) !== -1;
					option.control.disabled = isLanguageLocked(code, selected, maxLanguages);
				}
				count.textContent = formatText(text.langCount, {count: selected.length, max: maxLanguages});
				host.setDoneDisabled(selected.length === 0);
			};
			const onChange = (code, checked) => {
				const index = selected.indexOf(code);
				if (checked && index === -1 && selected.length < maxLanguages) selected.push(code);
				if (!checked && index !== -1) selected.splice(index, 1);
				sync();
			};
			for (const entry of entries) {
				const option = createOption(doc, classes.option, 'checkbox', '', entry.name, false);
				option.control.value = entry.code;
				option.control.addEventListener('change', () => onChange(entry.code, option.control.checked));
				rows.set(entry.code, option);
				list.append(option.row);
			}
			search.addEventListener('input', () => {
				const visible = new Set(filterLanguages(entries, search.value).map((entry) => entry.code));
				for (const [code, option] of rows) option.row.hidden = !visible.has(code);
				empty.hidden = visible.size > 0;
			});
			body.append(search, count, list, empty);
			sync();
		},
		onDone: () => safeCall(onSave, selected.slice())
	}, opener, options);
}
