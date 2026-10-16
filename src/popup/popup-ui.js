/**
 * ポップアップの描画。
 * 画面の中身はすべて sections.js の定義表から組み立てる。項目を足すときは表へ 1 件足すだけで済む。
 *
 * 保存ボタンは作らず、変更のたびに保存する。見た目の反映は保存の完了を待たない。
 * 保存に失敗したら、その項目のスイッチだけを保存済みの値へ戻して通知を出す
 * (全部を描き直すと、同時に飛行中だった別の項目の結果が画面から消える)。
 */
import {EXT_CONFIG} from '../common/config.js';
import {createIcon} from '../common/icons.js';
import {ALL_FIELDS, POPUP_TEXT, SECTIONS, TABS, THEME_TOGGLE, lockMessage} from './sections.js';
import {renderTabs} from './tabs.js';
import {renderConfirmRow} from './confirm-row.js';
import {attachFieldLock} from './field-lock.js';
import {renderBriefDisclaimer, renderLicensePanel} from './license-panel.js';

/** OS の配色を尋ねるメディアクエリ */
const LIGHT_QUERY = '(prefers-color-scheme: light)';

/** 要素の目印 (data-role)。設定項目のスイッチは保存キーそのものを目印にする */
const ROLES = Object.freeze({
	themeToggle: 'theme-toggle',
	notice: 'notice'
});

/**
 * 画面に渡す設定。loadSettings() の戻り値と同じ形 (failed は見ない)。
 * @typedef {Object} RenderSettings
 * @property {string} theme 配色の保存値 ('system' | 'dark' | 'light')
 * @property {Object<string, boolean>} values 保存キーごとの値
 */

/**
 * 項目を描くときに引き回すもの。
 * @typedef {Object} RenderContext
 * @property {Document} doc 対象のドキュメント
 * @property {Object<string, boolean>} state 画面の今の値。押した瞬間に変え、子のロックの判定に使う
 * @property {Object<string, boolean>} saved 保存済みの値。保存に失敗したときに戻す先
 * @property {Object<string, number>} sequence 保存キーごとの、最後に出した保存の番号
 * @property {Array<{requires: string, lock: import('./field-lock.js').FieldLock}>} locks 親を持つ項目の一覧
 * @property {(key: string, value: boolean, input: HTMLInputElement) => void} save 1 項目を保存する
 */

/**
 * 保存値と OS の設定から、実際に描く配色を決める。
 * 明示の選択 (dark / light) は常に OS より優先する。判定できなければダークへ倒す。
 * @param {string} stored 保存されている配色 ('system' | 'dark' | 'light')
 * @param {Window|{matchMedia?: Function}|undefined} win matchMedia の提供元
 * @returns {'dark'|'light'} 描く配色
 */
export function resolveTheme(stored, win) {
	const {dark, light} = EXT_CONFIG.popup.themes;
	if (stored === dark || stored === light) {
		return stored;
	}
	try {
		return win?.matchMedia?.(LIGHT_QUERY)?.matches ? light : dark;
	} catch {
		return dark;
	}
}

/**
 * 配色を html 要素へ反映する。CSS は html[data-theme] を選択子にして上書きする。
 * @param {Document} doc 対象のドキュメント
 * @param {'dark'|'light'} theme 解決済みの配色
 * @returns {void}
 */
function applyTheme(doc, theme) {
	doc.documentElement.dataset.theme = theme;
}

/**
 * 説明文の id。スイッチの aria-describedby から参照する。
 * @param {string} key 保存キー
 * @returns {string} id
 */
function descriptionId(key) {
	return `${key}-description`;
}

/**
 * 保存を呼び、成否を真偽値にそろえる。呼び出し側の実装が投げても失敗として畳む。
 * @param {(key: string, value: unknown) => Promise<boolean>|boolean} onChange 保存
 * @param {string} key 保存キー
 * @param {unknown} value 値
 * @returns {Promise<boolean>} 保存できたか
 */
function trySave(onChange, key, value) {
	/**
	 * @param {unknown} error 例外
	 * @returns {boolean} 常に false (失敗)
	 */
	const fail = (error) => {
		console.error('[XViewer] ポップアップ設定の保存に失敗しました', key, error);
		return false;
	};
	try {
		// 書き込みはその場で始める。結果だけを後で受ける
		return Promise.resolve(onChange(key, value)).then((saved) => saved === true, fail);
	} catch (error) {
		return Promise.resolve(fail(error));
	}
}

/**
 * 通知の行 (保存の失敗など) を組み立てる。タブの外に置き、どのタブを見ていても目に入るようにする。
 * @param {Document} doc 対象のドキュメント
 * @param {string|null} initial 最初に出す文言。null なら隠す
 * @returns {{element: HTMLElement, show: (text: string) => void, hide: () => void}} 通知の行と出し入れ
 */
function createNotice(doc, initial) {
	const element = doc.createElement('p');
	element.className = 'notice';
	element.dataset.role = ROLES.notice;
	element.setAttribute('role', 'alert');

	/**
	 * @param {string} text 出す文言
	 * @returns {void}
	 */
	const show = (text) => {
		element.textContent = text;
		element.hidden = false;
	};
	/** @returns {void} */
	const hide = () => {
		element.textContent = '';
		element.hidden = true;
	};

	if (initial) {
		show(initial);
	} else {
		hide();
	}
	return {element, show, hide};
}

/**
 * 見出しの行 (題名と配色の切り替えボタン) を組み立てる。
 * ボタンは作り直さず中身だけを差し替える。押した後もフォーカスがそのまま残る。
 * @param {Document} doc 対象のドキュメント
 * @param {'dark'|'light'} initial 解決済みの配色
 * @param {(theme: 'dark'|'light') => void} onToggle 押したときの処理 (保存)
 * @returns {HTMLElement} 見出しの行
 */
function renderHeader(doc, initial, onToggle) {
	const header = doc.createElement('header');
	header.className = 'header';

	const title = doc.createElement('h1');
	title.textContent = POPUP_TEXT.title;

	const button = doc.createElement('button');
	button.type = 'button';
	button.className = 'theme-toggle';
	button.dataset.role = ROLES.themeToggle;

	let theme = initial;

	/**
	 * ボタンの見た目 (アイコンと読み上げ名) を今の配色に合わせる。
	 * @returns {void}
	 */
	function updateButton() {
		const {icon, label} = THEME_TOGGLE[theme];
		button.replaceChildren(createIcon(doc, icon));
		// アイコンだけのボタンなので、読み上げ用の aria-label とマウス利用者向けの title を両方付ける
		button.setAttribute('aria-label', label);
		button.title = label;
	}

	button.addEventListener('click', () => {
		theme = THEME_TOGGLE[theme].next;
		// 保存の完了を待たずに見た目を変える。保存に失敗しても次に開いたとき元へ戻るだけ
		applyTheme(doc, theme);
		updateButton();
		onToggle(theme);
	});

	updateButton();
	header.append(title, button);
	return header;
}

/**
 * スイッチの項目を 1 つ組み立てる (子があれば下に字下げして並べる)。
 * @param {RenderContext} ctx 描画の文脈
 * @param {import('./sections.js').Field} field 項目の定義
 * @returns {HTMLElement} 項目
 */
function renderField(ctx, field) {
	const {doc} = ctx;
	const wrapper = doc.createElement('div');
	wrapper.className = 'field';
	wrapper.dataset.role = field.role;

	const title = doc.createElement('h3');
	title.className = 'field-title';

	const label = doc.createElement('label');
	label.className = 'row';

	const text = doc.createElement('span');
	text.className = 'label';
	text.textContent = field.label;

	const input = doc.createElement('input');
	input.type = 'checkbox';
	// 見た目はスイッチなので、読み上げの役割も switch にする。
	// 入りと切りは checked がそのまま伝わるので aria-checked は置かない
	input.setAttribute('role', 'switch');
	input.checked = ctx.state[field.key] === true;
	input.dataset.role = field.key;
	input.setAttribute('aria-describedby', descriptionId(field.key));

	label.append(text, input);
	title.append(label);

	const description = doc.createElement('p');
	description.className = 'description';
	description.setAttribute('id', descriptionId(field.key));
	description.dataset.role = descriptionId(field.key);
	description.textContent = field.description;

	wrapper.append(title, description);

	let lock = null;
	if (field.requires !== undefined) {
		const parent = ALL_FIELDS.find((one) => one.key === field.requires);
		lock = attachFieldLock(doc, {
			wrapper,
			control: input,
			key: field.key,
			message: lockMessage(parent?.label ?? '')
		});
		ctx.locks.push({requires: field.requires, lock});
	}

	input.addEventListener('change', () => {
		if (lock?.isLocked()) {
			return;
		}
		ctx.save(field.key, input.checked, input);
	});

	if (field.children?.length) {
		const box = doc.createElement('div');
		box.className = 'field-children';
		for (const child of field.children) {
			box.append(renderField(ctx, child));
		}
		wrapper.append(box);
	}
	return wrapper;
}

/**
 * 設定タブの中身を組み立てる。
 * @param {RenderContext} ctx 描画の文脈
 * @param {() => void} onReset 初期化を確定したときの処理
 * @returns {HTMLElement} パネル
 */
function renderSettingsPanel(ctx, onReset) {
	const {doc} = ctx;
	const panel = doc.createElement('div');
	panel.className = 'panel settings';

	for (const {id, title, fields} of SECTIONS) {
		const section = doc.createElement('section');
		section.className = 'section';
		section.dataset.role = `section-${id}`;

		const heading = doc.createElement('h2');
		heading.textContent = title;
		section.append(heading);

		for (const field of fields) {
			section.append(renderField(ctx, field));
		}
		panel.append(section);
	}

	const reset = renderConfirmRow(doc, POPUP_TEXT.reset, onReset);
	// 設定項目との区切り。置き場所に依る見た目なので、汎用の確認の行ではなくここで付ける
	reset.classList.add('reset');
	panel.append(reset, renderBriefDisclaimer(doc));
	return panel;
}

/**
 * ポップアップを描く。何度呼んでも前の中身は残らない。
 * @param {Object} deps 依存
 * @param {Document} deps.doc 対象のドキュメント
 * @param {HTMLElement} deps.root 描き先
 * @param {RenderSettings} deps.settings 現在の設定 (正規化済み)
 * @param {(key: string, value: boolean|string) => Promise<boolean>} deps.onChange 1 項目を保存し、成否を返す
 * @param {() => void} deps.onReset 初期化を確定したときの処理
 * @param {string|null} [deps.notice] 最初から出しておく通知 (読み込み・初期化の失敗)
 * @param {string|null} [deps.initialTab] 最初に開くタブの id。省くと先頭
 * @returns {{dispose: () => void, currentTab: () => string|null}} 片付けと、今開いているタブの id
 */
export function renderPopup({doc, root, settings, onChange, onReset, notice = null, initialTab = null}) {
	const theme = resolveTheme(settings.theme, doc.defaultView);
	applyTheme(doc, theme);

	let disposed = false;
	const noticeRow = createNotice(doc, notice);

	/** @type {RenderContext} */
	const ctx = {
		doc,
		state: {...settings.values},
		saved: {...settings.values},
		sequence: {},
		locks: [],
		save(key, value, input) {
			ctx.state[key] = value;
			refreshLocks();
			// 同じ項目を続けて押したとき、画面を戻すかどうかは最後の保存の結果だけで決める
			const id = (ctx.sequence[key] ?? 0) + 1;
			ctx.sequence[key] = id;
			void trySave(onChange, key, value).then((ok) => {
				if (disposed) {
					return;
				}
				if (ok) {
					ctx.saved[key] = value;
					noticeRow.hide();
					return;
				}
				noticeRow.show(POPUP_TEXT.saveFailed);
				if (ctx.sequence[key] !== id) {
					return;
				}
				// 保存できなかったので、その項目だけを保存済みの値へ戻して食い違いを消す
				input.checked = ctx.saved[key] === true;
				ctx.state[key] = input.checked;
				refreshLocks();
			});
		}
	};

	/**
	 * 親を持つ項目のロックを、画面の今の値に合わせる。
	 * @returns {void}
	 */
	function refreshLocks() {
		for (const {requires, lock} of ctx.locks) {
			lock.setLocked(ctx.state[requires] !== true);
		}
	}

	const header = renderHeader(doc, theme, (next) => {
		void trySave(onChange, EXT_CONFIG.popup.themeStorageKey, next).then((ok) => {
			if (disposed) {
				return;
			}
			if (ok) {
				noticeRow.hide();
			} else {
				// 配色は戻さない。見た目はそのままで、次に開いたとき保存済みの配色に戻るだけ
				noticeRow.show(POPUP_TEXT.saveFailed);
			}
		});
	});

	const panels = {
		settings: renderSettingsPanel(ctx, onReset),
		license: renderLicensePanel(doc)
	};
	refreshLocks();

	const entries = TABS.map(({id, label}) => ({id, label, panel: panels[id]}));
	const tabs = renderTabs(doc, entries, {label: POPUP_TEXT.tabsLabel, initialId: initialTab});

	root.replaceChildren(header, noticeRow.element, tabs.list, ...entries.map(({panel}) => panel));

	return {
		dispose() {
			disposed = true;
			for (const {lock} of ctx.locks) {
				lock.dispose();
			}
			root.replaceChildren();
		},
		currentTab: tabs.currentId
	};
}
