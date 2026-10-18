/**
 * 入力欄の動画の「字幕と ALT」の画面。ALT テキストと字幕 (.vtt) を 1 枚の画面で選ぶ。
 * 開き方・閉じ方・フォーカスの扱いは ALT テキストの画面と同じ (SheetHost に載せる)。
 *
 * 依存: reply-sheets.js (altState)・language-sheet.js (languageName)・sheet-dom.js
 */
import {altState} from './reply-sheets.js';
import {languageName} from './language-sheet.js';
import {createElement, createButton, formatText, safeCall} from './sheet-dom.js';

/**
 * 画面で選ぶ字幕。
 * @typedef {Object} SheetCaption
 * @property {Blob} blob text/vtt に付け直した字幕
 * @property {string} name ファイル名
 * @property {string} lang 字幕の言語 (ISO 639-1)
 */

/**
 * 画面を開くときに渡すもの。
 * @typedef {Object} VideoSheetInput
 * @property {string} previewUrl 動画のオブジェクト URL (空なら縮小表示を出さない)
 * @property {string} alt 今の ALT テキスト
 * @property {SheetCaption|null} caption 今の字幕
 * @property {number} maxAltGraphemes ALT の上限 (書記素)
 * @property {string[]} languageCodes 字幕の言語の選択肢
 * @property {string} defaultLang 字幕を選んだときの既定の言語
 * @property {string} locale 言語の表示名に使う言語
 * @property {(file: File) => Promise<{ok: true, blob: Blob, name: string}|{ok: false, notice: 'notVtt'|'tooLarge'}>} readCaption
 *   選んだファイルを確かめる
 */

/**
 * 字幕の言語の選択肢。今の言語が一覧に無ければ先頭に足す。
 * @param {string[]} codes 一覧
 * @param {string} current 今の言語
 * @returns {string[]}
 */
function captionLanguages(codes, current) {
	const list = Array.isArray(codes) ? codes.filter((code) => typeof code === 'string' && code !== '') : [];
	if (current && list.indexOf(current) === -1) list.unshift(current);
	return list;
}

/**
 * 字幕と ALT の画面を開く。ALT の欄は書記素で残りを数え、上限を超えたら「完了」を押せなくする。
 * 字幕は選ぶとファイル名・言語の選択・「字幕を外す」を出し、断ったときは画面の中に 1 行出す。
 * 「完了」で ALT (前後の空白を除く) と字幕を onSave へ渡す。キャンセル・Escape では何も渡さない。
 * 字幕の言語は選択の実際の値で、選べる言語が 1 つも無いときは字幕を渡さない。
 * @param {import('./reply-sheets.js').SheetHost} host 重ねる画面の持ち主
 * @param {VideoSheetInput} input
 * @param {HTMLElement} opener 開いたボタン
 * @param {(value: {alt: string, caption: (SheetCaption|null)}) => void} onSave
 * @param {import('./reply-sheets.js').SheetOptions} [options] 持ち主とフォーカスの戻し先
 * @returns {void}
 */
export function openVideoSheet(host, input, opener, onSave, options) {
	const {classes, text} = host.config;
	const captionRule = host.config.video.caption;
	const maxAltGraphemes = Number.isInteger(input?.maxAltGraphemes) && input.maxAltGraphemes > 0
		? input.maxAltGraphemes
		: host.config.maxAltGraphemes;
	const original = input?.caption;
	/** @type {SheetCaption|null} */
	let caption = original && original.blob
		? {blob: original.blob, name: String(original.name || ''), lang: String(original.lang || input?.defaultLang || '')}
		: null;
	let field = null;
	let select = null;
	host.open({
		title: text.videoSheetTitle,
		build: (body, done) => {
			const doc = body.ownerDocument;
			let closed = false;
			/** 字幕を選んだ回の番号。選び直す・外すたびに進め、読み終えた結果が最新の回のものか照らす */
			let readSeq = 0;
			if (input?.previewUrl) {
				const preview = createElement(doc, 'video', classes.altPreview);
				preview.muted = true;
				preview.setAttribute('muted', '');
				preview.setAttribute('playsinline', '');
				preview.setAttribute('preload', 'metadata');
				preview.setAttribute('src', input.previewUrl);
				preview.setAttribute('aria-label', text.video);
				body.append(preview);
			}

			const frame = createElement(doc, 'div', classes.altFrame);
			field = createElement(doc, 'textarea', classes.altInput);
			field.setAttribute('aria-label', text.altLabel);
			field.value = input?.alt || '';
			frame.append(field);
			const remaining = createElement(doc, 'p', classes.altRemaining);
			remaining.setAttribute('aria-live', 'polite');
			const sync = () => {
				const state = altState(field.value, maxAltGraphemes);
				remaining.textContent = formatText(text.altRemaining, {count: state.remaining});
				remaining.classList.toggle(classes.warn, state.over);
				host.setDoneDisabled(state.over);
			};
			field.addEventListener('input', sync);
			field.addEventListener('keydown', (event) => {
				if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
					event.preventDefault();
					if (!altState(field.value, maxAltGraphemes).over) done();
				}
			});

			const section = createElement(doc, 'div', classes.labelGroup);
			section.append(createElement(doc, 'p', classes.labelGroupTitle, text.captionSection));
			const fileInput = doc.createElement('input');
			fileInput.type = 'file';
			fileInput.className = classes.fileInput;
			fileInput.setAttribute('accept', `${captionRule.extension},${captionRule.mimeType}`);
			fileInput.setAttribute('aria-label', text.captionPick);
			fileInput.hidden = true;
			const pick = createButton(doc, classes.button, text.captionPick);
			pick.addEventListener('click', () => {
				try {
					fileInput.click();
				} catch (error) {
					console.error('[XViewer] 字幕のファイルを選ぶ画面を開けませんでした', error);
				}
			});
			const row = createElement(doc, 'div', classes.captionRow);
			const name = createElement(doc, 'span', classes.captionName);
			select = doc.createElement('select');
			select.setAttribute('aria-label', text.captionLanguage);
			select.addEventListener('change', () => {
				if (caption) caption.lang = select.value;
			});
			const remove = createButton(doc, classes.button, text.captionRemove);
			row.append(name, select, remove);
			const error = createElement(doc, 'p', classes.error);
			error.setAttribute('role', 'alert');
			error.hidden = true;

			const showCaption = () => {
				pick.hidden = !!caption;
				row.hidden = !caption;
				if (!caption) return;
				name.textContent = caption.name;
				name.title = caption.name;
				const codes = captionLanguages(input?.languageCodes, caption.lang);
				select.replaceChildren(...codes.map((code) => {
					const option = doc.createElement('option');
					option.value = code;
					option.textContent = languageName(code, input?.locale);
					return option;
				}));
				// 空の言語や選択肢に無い言語は選べないため、選択肢の先頭に揃えて選択と保存する値を一致させる
				const lang = codes.indexOf(caption.lang) !== -1 ? caption.lang : (codes[0] || '');
				select.value = lang;
				caption.lang = lang;
			};
			const showError = (message) => {
				error.textContent = message || '';
				error.hidden = !message;
			};

			fileInput.addEventListener('change', async () => {
				const file = fileInput.files && fileInput.files[0];
				fileInput.value = '';
				if (!file || typeof input?.readCaption !== 'function') return;
				readSeq += 1;
				const seq = readSeq;
				let result = null;
				try {
					result = await input.readCaption(file);
				} catch (failure) {
					result = {ok: false, notice: 'notVtt'};
				}
				// 閉じた後・選び直した後・外した後に届いた結果は捨てる
				if (closed || seq !== readSeq) return;
				try {
					if (!result || !result.ok) {
						showError(result && result.notice === 'tooLarge' ? text.captionTooLarge : text.captionNotVtt);
						return;
					}
					showError('');
					const lang = caption ? caption.lang : String(input?.defaultLang || '');
					caption = {blob: result.blob, name: String(result.name || ''), lang};
					showCaption();
					// 選ぶボタンが隠れるため、フォーカスを言語の選択へ移す (画面の外へ落とさない)
					select.focus();
				} catch (failure) {
					console.error('[XViewer] 字幕を取り込めませんでした', failure);
				}
			});
			remove.addEventListener('click', () => {
				readSeq += 1;
				caption = null;
				showError('');
				showCaption();
				pick.focus();
			});

			section.append(pick, fileInput, row, error);
			body.append(frame, remaining, section);
			sync();
			showCaption();
			return () => {
				closed = true;
			};
		},
		onDone: () => {
			// 保存する言語は選択の実際の値にそろえる。空の言語の字幕は橋渡しが返信ごと断るため渡さない
			const lang = caption ? String((select && select.value) || caption.lang || '') : '';
			safeCall(onSave, {alt: (field?.value || '').trim(), caption: caption && lang ? {...caption, lang} : null});
		}
	}, opener, options);
}
