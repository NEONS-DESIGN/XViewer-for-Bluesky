/**
 * ポップアップの描画を Node で確かめるための最小の偽 DOM。
 * 依存を足さない (jsdom を入れない) ために、popup-ui.js が使う範囲だけを持つ。
 *
 * 持っているもの: 要素の木・属性・dataset・classList・textContent・hidden・
 * イベントの捕捉と浮上 (stopPropagation / stopImmediatePropagation / preventDefault)・focus・
 * querySelector (`[data-role="x"]` / `[role="x"]` / タグ名 / それらのカンマ区切り)。
 * 持っていないもの: CSS・レイアウト・既定動作 (チェックボックスの切り替えは click() が代わりに行う)。
 */

/**
 * 偽のイベント。
 */
export class FakeEvent {
	/**
	 * @param {string} type 種類
	 * @param {{key?: string, bubbles?: boolean}} [init] キーボードのキーなど。bubbles を false にすると浮上しない (video の source の error など)
	 */
	constructor(type, init = {}) {
		this.type = type;
		this.key = init.key;
		this.bubbles = init.bubbles !== false;
		this.defaultPrevented = false;
		this.target = null;
		this.stopped = false;
		this.stoppedImmediately = false;
	}

	/** @returns {void} */
	preventDefault() {
		this.defaultPrevented = true;
	}

	/** @returns {void} */
	stopPropagation() {
		this.stopped = true;
	}

	/** @returns {void} */
	stopImmediatePropagation() {
		this.stopped = true;
		this.stoppedImmediately = true;
	}
}

/**
 * 偽のテキストノード。
 */
class FakeText {
	/** @param {string} text 中身 */
	constructor(text) {
		this.nodeType = 3;
		this.data = String(text);
		this.parentNode = null;
	}

	/** @returns {string} 中身 */
	get textContent() {
		return this.data;
	}
}

/**
 * 偽の要素。
 */
class FakeElement {
	/**
	 * @param {FakeDocument} ownerDocument 属する文書
	 * @param {string} tagName タグ名 (小文字)
	 */
	constructor(ownerDocument, tagName) {
		this.nodeType = 1;
		this.ownerDocument = ownerDocument;
		this.tagName = tagName.toUpperCase();
		this.localName = tagName.toLowerCase();
		this.childNodes = [];
		this.parentNode = null;
		this.attributes = new Map();
		this.dataset = {};
		this.listeners = [];
		this.classes = new Set();
		this.hidden = false;
		this.checked = false;
		this.value = '';
		this.type = '';
		this.title = '';
		const classes = this.classes;
		this.classList = {
			add: (...names) => names.forEach((name) => classes.add(name)),
			remove: (...names) => names.forEach((name) => classes.delete(name)),
			toggle: (name, force) => {
				const on = force === undefined ? !classes.has(name) : Boolean(force);
				if (on) classes.add(name);
				else classes.delete(name);
				return on;
			},
			contains: (name) => classes.has(name)
		};
	}

	/** @returns {string} クラス名 */
	get className() {
		return [...this.classes].join(' ');
	}

	/** @param {string} value クラス名 (空白区切り) */
	set className(value) {
		this.classes.clear();
		String(value).split(/\s+/).filter(Boolean).forEach((name) => this.classes.add(name));
	}

	/** @returns {FakeElement[]} 子要素 */
	get children() {
		return this.childNodes.filter((node) => node.nodeType === 1);
	}

	/** @returns {string} 子孫のテキストをつないだもの */
	get textContent() {
		return this.childNodes.map((node) => node.textContent).join('');
	}

	/** @param {string} value 中身を置き換えるテキスト */
	set textContent(value) {
		this.replaceChildren();
		if (value !== '' && value !== null && value !== undefined) this.append(String(value));
	}

	/** @returns {string} id 属性 */
	get id() {
		return this.getAttribute('id') ?? '';
	}

	/** @param {string} name 属性名 @param {string} value 値 */
	setAttribute(name, value) {
		this.attributes.set(name, String(value));
	}

	/** @param {string} name 属性名 @returns {string|null} 値 */
	getAttribute(name) {
		return this.attributes.has(name) ? this.attributes.get(name) : null;
	}

	/** @param {string} name 属性名 @returns {boolean} 持っているか */
	hasAttribute(name) {
		return this.attributes.has(name);
	}

	/** @param {string} name 属性名 */
	removeAttribute(name) {
		this.attributes.delete(name);
	}

	/**
	 * 子を末尾へ足す。文字列はテキストノードにする。
	 * @param {...(FakeElement|FakeText|string)} nodes 足すもの
	 * @returns {void}
	 */
	append(...nodes) {
		for (const node of nodes) {
			const child = typeof node === 'string' ? new FakeText(node) : node;
			if (child.parentNode) child.parentNode.removeChild(child);
			child.parentNode = this;
			this.childNodes.push(child);
		}
	}

	/** @param {FakeElement|FakeText} node 足すもの @returns {FakeElement|FakeText} 足したもの */
	appendChild(node) {
		this.append(node);
		return node;
	}

	/** @param {FakeElement|FakeText} node 外すもの */
	removeChild(node) {
		const index = this.childNodes.indexOf(node);
		if (index >= 0) this.childNodes.splice(index, 1);
		node.parentNode = null;
	}

	/** @param {...(FakeElement|FakeText|string)} nodes 置き換える中身 */
	replaceChildren(...nodes) {
		for (const node of [...this.childNodes]) this.removeChild(node);
		this.append(...nodes);
	}

	/** @returns {void} 親から外す */
	remove() {
		this.parentNode?.removeChild(this);
	}

	/** @param {FakeElement} other 調べる要素 @returns {boolean} 自分か子孫か */
	contains(other) {
		for (let node = other; node; node = node.parentNode) {
			if (node === this) return true;
		}
		return false;
	}

	/**
	 * @param {string} type 種類
	 * @param {Function} listener 処理
	 * @param {boolean|{capture?: boolean}} [options] 捕捉で受けるか
	 */
	addEventListener(type, listener, options) {
		const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
		this.listeners.push({type, listener, capture});
	}

	/**
	 * @param {string} type 種類
	 * @param {Function} listener 処理
	 * @param {boolean|{capture?: boolean}} [options] 捕捉で受けるか
	 */
	removeEventListener(type, listener, options) {
		const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
		this.listeners = this.listeners.filter((one) =>
			!(one.type === type && one.listener === listener && one.capture === capture));
	}

	/**
	 * 捕捉 (根から自分へ) → 浮上 (自分から根へ) の順に処理を呼ぶ。
	 * @param {FakeEvent} event イベント
	 * @returns {boolean} 既定動作を止められていなければ true
	 */
	dispatchEvent(event) {
		event.target = this;
		const path = [];
		for (let node = this; node; node = node.parentNode) path.push(node);
		const phases = [
			...[...path].reverse().map((node) => [node, true]),
			...(event.bubbles ? path : [this]).map((node) => [node, false])
		];
		for (const [node, capture] of phases) {
			if (event.stopped) break;
			for (const one of [...node.listeners]) {
				if (one.type !== event.type) continue;
				// 自分の上でも捕捉の登録を先に呼ぶ (今のブラウザと同じ順)
				if (one.capture !== capture) continue;
				one.listener.call(node, event);
				if (event.stoppedImmediately) break;
			}
		}
		return !event.defaultPrevented;
	}

	/** @returns {void} フォーカスを受ける */
	focus() {
		this.ownerDocument.activeElement = this;
	}

	/**
	 * 子孫を前から順に返す。
	 * @returns {FakeElement[]} 子孫の要素
	 */
	descendants() {
		const out = [];
		for (const child of this.children) out.push(child, ...child.descendants());
		return out;
	}

	/**
	 * 簡単な選択子に合うか。
	 * @param {string} selector `[data-role="x"]` / `[role="x"]` / タグ名
	 * @returns {boolean} 合えば true
	 */
	matches(selector) {
		return selector.split(',').map((part) => part.trim()).some((part) => {
			if (/^\.[\w-]+$/.test(part)) return this.classList.contains(part.slice(1));
			const attr = /^\[([\w-]+)="([^"]*)"\]$/.exec(part);
			if (attr) {
				const [, name, value] = attr;
				return name === 'data-role' ? this.dataset.role === value : this.getAttribute(name) === value;
			}
			return this.localName === part.toLowerCase();
		});
	}

	/** @param {string} selector 選択子 @returns {FakeElement|null} 最初に合う子孫 */
	querySelector(selector) {
		return this.descendants().find((node) => node.matches(selector)) ?? null;
	}

	/** @param {string} selector 選択子 @returns {FakeElement[]} 合う子孫すべて */
	querySelectorAll(selector) {
		return this.descendants().filter((node) => node.matches(selector));
	}
}

/**
 * 偽の文書。
 */
export class FakeDocument {
	/**
	 * @param {{prefersLight?: boolean}} [options] OS の配色 (matchMedia の答え)
	 */
	constructor({prefersLight = false} = {}) {
		this.documentElement = new FakeElement(this, 'html');
		this.body = new FakeElement(this, 'body');
		this.documentElement.append(this.body);
		this.activeElement = this.body;
		this.defaultView = {matchMedia: () => ({matches: prefersLight})};
	}

	/** @param {string} tagName タグ名 @returns {FakeElement} 要素 */
	createElement(tagName) {
		return new FakeElement(this, tagName);
	}

	/** @param {string} _ns 名前空間 @param {string} tagName タグ名 @returns {FakeElement} 要素 */
	createElementNS(_ns, tagName) {
		return new FakeElement(this, tagName);
	}

	/** @param {string} text 中身 @returns {FakeText} テキストノード */
	createTextNode(text) {
		return new FakeText(text);
	}

	/** @param {string} id id @returns {FakeElement|null} 要素 */
	getElementById(id) {
		return [this.documentElement, ...this.documentElement.descendants()]
			.find((node) => node.getAttribute('id') === id) ?? null;
	}
}

/**
 * クリックする。止められなければチェックボックスを切り替えて change を送る (ブラウザの既定動作の代わり)。
 * @param {FakeElement} element 押す要素
 * @returns {void}
 */
export function click(element) {
	const allowed = element.dispatchEvent(new FakeEvent('click'));
	if (allowed && element.localName === 'input' && element.type === 'checkbox') {
		element.checked = !element.checked;
		element.dispatchEvent(new FakeEvent('change'));
	}
}

/**
 * キーを押す (keydown を送る)。
 * @param {FakeElement} element 押す先
 * @param {string} key キー名
 * @returns {FakeEvent} 送ったイベント
 */
export function pressKey(element, key) {
	const event = new FakeEvent('keydown', {key});
	element.dispatchEvent(event);
	return event;
}
