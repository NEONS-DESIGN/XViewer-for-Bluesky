/**
 * 入力欄の末尾に出す知らせの 1 行。出せるのは 1 つだけで、出し直すと前のものを消す。
 * 文の 1 行 (role="alert" の p) のほか、ボタンを持つ問い合わせのような要素もそのまま出せる。
 * 出したものに印 (meta) を添えておけば、原因が無くなったときにその知らせだけを消せる。
 *
 * 依存: なし
 */

/**
 * @typedef {Object} NoticeLineOptions
 * @property {string} className 文の 1 行のクラス名
 * @property {string} separator 複数の文をつなぐ区切り
 */

/**
 * 知らせの 1 行。
 */
export class NoticeLine {
	/**
	 * @param {HTMLElement} host 末尾に知らせを足す入れ物
	 * @param {NoticeLineOptions} options
	 */
	constructor(host, options) {
		this.host = host;
		this.className = options.className;
		this.separator = options.separator;
		/** @type {HTMLElement|null} 出している要素 */
		this.element = null;
		/** @type {*} 出している知らせに添えた印 (無ければ null) */
		this.meta = null;
	}

	/**
	 * 文の 1 行を出す (前のものは消す)。文が無ければ消すだけ。
	 * @param {string[]} messages 知らせる文
	 * @param {*} [meta] 添える印
	 * @returns {HTMLElement|null} 出した要素
	 */
	show(messages, meta = null) {
		this.clear();
		if (!Array.isArray(messages) || messages.length === 0) return null;
		try {
			const notice = this.host.ownerDocument.createElement('p');
			notice.className = this.className;
			notice.textContent = messages.join(this.separator);
			notice.setAttribute('role', 'alert');
			return this.place(notice, meta);
		} catch (error) {
			console.error('[XViewer] 知らせの 1 行を出せませんでした', error);
			return null;
		}
	}

	/**
	 * 組み終えた要素 (問い合わせなど) を知らせとして出す (前のものは消す)。
	 * @param {HTMLElement} element
	 * @param {*} [meta] 添える印
	 * @returns {HTMLElement|null} 出した要素
	 */
	showElement(element, meta = null) {
		this.clear();
		if (!element) return null;
		try {
			return this.place(element, meta);
		} catch (error) {
			console.error('[XViewer] 知らせを出せませんでした', error);
			return null;
		}
	}

	/**
	 * 入れ物の末尾に置いて覚える。
	 * @param {HTMLElement} element
	 * @param {*} meta
	 * @returns {HTMLElement}
	 */
	place(element, meta) {
		this.host.append(element);
		this.element = element;
		this.meta = meta === undefined ? null : meta;
		return element;
	}

	/**
	 * 出している知らせを消す。
	 * @returns {void}
	 */
	clear() {
		const element = this.element;
		this.element = null;
		this.meta = null;
		if (!element) return;
		try {
			element.remove();
		} catch (error) {
			console.error('[XViewer] 知らせの 1 行を消せませんでした', error);
		}
	}

	/**
	 * 印が条件に合う知らせを出しているときだけ消す。
	 * @param {(meta: *) => boolean} predicate
	 * @returns {boolean} 消したか
	 */
	clearIf(predicate) {
		if (!this.element) return false;
		let match = false;
		try {
			match = predicate(this.meta) === true;
		} catch (error) {
			match = false;
		}
		if (match) this.clear();
		return match;
	}
}
