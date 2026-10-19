/**
 * WAI-ARIA の tabs パターンで組むタブの並び。
 * 切り替えは hidden の付け外しだけで行い、パネルを描き直さない
 * (描き直すとスイッチの状態や確認の行が消えるため)。
 */

/** タブの選択を動かすキー。ここに無いキーは握りつぶさない */
export const TAB_KEYS = Object.freeze({
	prev: 'ArrowLeft',
	next: 'ArrowRight',
	first: 'Home',
	last: 'End'
});

/**
 * パネルの中の操作部品。これを 1 つも持たないパネルだけ自身に tabindex を付ける。
 * リンク (a) は数えない。末尾にリンクがあっても、先頭から読み進める手段にはならないため
 */
const CONTROL_SELECTOR = 'button, input, select, textarea';

/**
 * タブとパネルの組。
 * @typedef {Object} TabEntry
 * @property {string} id タブの id
 * @property {string} label 見出し
 * @property {HTMLElement} panel 中身
 */

/**
 * タブ本体の id。data-role にも同じ文字列を使う。
 * @param {string} id タブの id
 * @returns {string} 要素の id
 */
function tabElementId(id) {
	return `tab-${id}`;
}

/**
 * パネルの id。data-role にも同じ文字列を使う。
 * @param {string} id タブの id
 * @returns {string} 要素の id
 */
function panelElementId(id) {
	return `panel-${id}`;
}

/**
 * キーから次に選ぶタブの位置を出す関数の表。前後は端で反対側へ回り込む。
 * @param {number} count タブの数
 * @returns {Object<string, (current: number) => number>} キー名から「今の位置 → 次の位置」を引く表
 */
function keyMoves(count) {
	return {
		[TAB_KEYS.prev]: (i) => (i - 1 + count) % count,
		[TAB_KEYS.next]: (i) => (i + 1) % count,
		[TAB_KEYS.first]: () => 0,
		[TAB_KEYS.last]: () => count - 1
	};
}

/**
 * タブの並びを組み立て、パネルの表示と結び付ける。
 * @param {Document} doc 対象のドキュメント
 * @param {readonly TabEntry[]} entries タブとパネルの組
 * @param {{label: string, initialId?: string|null}} options 並び全体の読み上げ名と、最初に選ぶタブの id
 * @returns {{list: HTMLElement}} タブの並び
 */
export function renderTabs(doc, entries, {label, initialId = null}) {
	const list = doc.createElement('div');
	list.className = 'tabs';
	list.dataset.role = 'tabs';
	list.setAttribute('role', 'tablist');
	list.setAttribute('aria-label', label);

	const buttons = entries.map(({id, label: text, panel}) => {
		const tabId = tabElementId(id);
		const panelId = panelElementId(id);

		const button = doc.createElement('button');
		button.type = 'button';
		button.className = 'tab';
		button.textContent = text;
		button.setAttribute('role', 'tab');
		button.setAttribute('id', tabId);
		button.dataset.role = tabId;
		button.setAttribute('aria-controls', panelId);

		panel.setAttribute('id', panelId);
		panel.dataset.role = panelId;
		panel.setAttribute('role', 'tabpanel');
		panel.setAttribute('aria-labelledby', tabId);
		// 操作部品の無いパネルは Tab で掴めないと、キーボードだけではスクロールして読み進められない
		if (!panel.querySelector(CONTROL_SELECTOR)) {
			panel.setAttribute('tabindex', '0');
		}
		return button;
	});

	let current = Math.max(0, entries.findIndex(({id}) => id === initialId));

	/**
	 * index のタブを選ぶ。
	 * @param {number} index 選ぶタブの位置
	 * @param {boolean} moveFocus フォーカスも動かすか (キー操作のときだけ true)
	 * @returns {void}
	 */
	function select(index, moveFocus) {
		current = index;
		entries.forEach(({panel}, i) => {
			const on = i === index;
			// 選択状態は aria-selected だけで持つ。見た目も CSS が同じ属性を見る
			buttons[i].setAttribute('aria-selected', String(on));
			// 選択中のタブだけ Tab で止める (roving tabindex)
			buttons[i].setAttribute('tabindex', on ? '0' : '-1');
			panel.hidden = !on;
		});
		if (moveFocus) {
			buttons[index].focus();
		}
	}

	const moves = keyMoves(entries.length);

	list.addEventListener('keydown', (event) => {
		const move = moves[event.key];
		// 関係ないキーは通す。ここで握りつぶすと画面全体のキー操作を奪う
		if (!move) {
			return;
		}
		event.preventDefault();
		select(move(current), true);
	});

	buttons.forEach((button, index) => {
		// クリックではフォーカスを動かさない。押した時点で既にそこにある
		button.addEventListener('click', () => select(index, false));
		list.append(button);
	});

	select(current, false);
	return {list};
}
