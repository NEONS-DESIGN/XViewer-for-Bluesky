/**
 * GIF の検索画面。Klipy の一覧を検索欄と 2 列の格子で見せ、選んだ GIF を呼び出し側へ渡す。
 * 問い合わせの制御 (GifSearch) と、パネルに重ねる画面の組み立て (openGifSheet) を持つ。
 */

import {buildKlipyUrl, parseKlipyResponse} from './klipy.js';
import {createElement, formatText, safeCall} from './sheet-dom.js';

/**
 * @typedef {import('./klipy.js').GifItem} GifItem
 */

/**
 * @typedef {Object} GifSearchState
 * @property {GifItem[]} items 取得済みの GIF
 * @property {string|null} next 続きの位置。無ければ null
 * @property {boolean} loading 読み込み中か
 * @property {boolean} failed 直近の取得が失敗したか
 * @property {string} query 今の問い合わせ (空なら featured)
 */

/**
 * GIF の検索の状態を持つ。問い合わせは間引き、問い合わせを変えた後に届いた古い応答は捨てる。
 */
export class GifSearch {
	/**
	 * @param {Object} options
	 * @param {(url: string) => Promise<any|null>} options.fetchJson 解析済みの JSON を返す。失敗は null
	 * @param {Object} options.rule buildKlipyUrl と parseKlipyResponse の規則 (debounceMs を含む)
	 * @param {string|null} options.locale 言語
	 * @param {(fn: () => void, ms: number) => any} options.setTimer
	 * @param {(id: any) => void} options.clearTimer
	 * @param {(state: GifSearchState) => void} options.onChange 状態が変わるたびに呼ぶ
	 */
	constructor({fetchJson, rule, locale, setTimer, clearTimer, onChange}) {
		this.fetchJson = fetchJson;
		this.rule = rule;
		this.locale = locale;
		this.setTimer = setTimer;
		this.clearTimer = clearTimer;
		this.onChange = onChange;
		/** @type {GifSearchState} */
		this.state = {items: [], next: null, loading: false, failed: false, query: ''};
		this.timer = null;
		this.serial = 0;
		this.destroyed = false;
	}

	/**
	 * 最初の一覧 (featured) を引く。
	 * @returns {void}
	 */
	start() {
		this.request(true);
	}

	/**
	 * 問い合わせを変える。入力が続くあいだは待ち、止まって debounceMs 経ってから引く。
	 * @param {string} query 検索語。空なら featured
	 * @returns {void}
	 */
	setQuery(query) {
		if (this.destroyed) return;
		this.cancelTimer();
		this.timer = this.setTimer(() => {
			this.timer = null;
			this.state.query = query;
			this.request(true);
		}, this.rule.debounceMs);
	}

	/**
	 * 続きを引いて後ろに足す。続きが無いか、読み込み中か、失敗したままなら何もしない (再試行は retry だけ)。
	 * @returns {void}
	 */
	loadMore() {
		if (this.destroyed || this.state.loading || this.state.failed || !this.state.next) return;
		this.request(false);
	}

	/**
	 * 失敗した取得を、同じ問い合わせで引き直す。
	 * @returns {void}
	 */
	retry() {
		if (this.destroyed || this.state.loading) return;
		this.request(this.state.items.length === 0 || !this.state.next);
	}

	/**
	 * 待っている timer を止め、以後の応答を無視する。
	 * @returns {void}
	 */
	destroy() {
		this.destroyed = true;
		this.serial += 1;
		this.cancelTimer();
	}

	/**
	 * @returns {void}
	 */
	cancelTimer() {
		if (this.timer !== null) {
			this.clearTimer(this.timer);
			this.timer = null;
		}
	}

	/**
	 * 取得を始める。reset なら一覧を空にして先頭から、そうでなければ続きから。
	 * @param {boolean} reset 先頭から引くか
	 * @returns {void}
	 */
	request(reset) {
		if (this.destroyed) return;
		const serial = ++this.serial;
		const state = this.state;
		const pos = reset ? undefined : state.next || undefined;
		if (reset) {
			state.items = [];
			state.next = null;
		}
		state.loading = true;
		state.failed = false;
		this.emit();
		const url = buildKlipyUrl(state.query ? 'search' : 'featured', {q: state.query, pos, locale: this.locale}, this.rule);
		let pending;
		try {
			pending = Promise.resolve(this.fetchJson(url));
		} catch (_e) {
			pending = Promise.resolve(null);
		}
		pending.catch(() => null).then((json) => {
			if (this.destroyed || serial !== this.serial) return;
			state.loading = false;
			if (json === null || json === undefined) {
				state.failed = true;
			} else {
				const parsed = parseKlipyResponse(json, this.rule);
				state.items = state.items.concat(parsed.items);
				state.next = parsed.next;
			}
			this.emit();
		});
	}

	/**
	 * @returns {void}
	 */
	emit() {
		safeCall(this.onChange, this.state);
	}
}

/**
 * GIF の画面を開く。開いたボタンに付く吹き出しで、検索欄を上に固定し、その下の格子だけを送る。
 * 選ぶと onPick へ GIF を渡して閉じる。
 * @param {import('./reply-sheets.js').SheetHost} host 重ねる画面の持ち主
 * @param {{fetchJson: (url: string) => Promise<any|null>, locale: string|null, rule: Object}} deps 通信と規則
 * @param {HTMLElement} opener 開いたボタン
 * @param {(gif: GifItem) => void} onPick 選んだ GIF
 * @param {import('./reply-sheets.js').SheetOptions} [options] 持ち主とフォーカスの戻し先
 * @returns {void}
 */
export function openGifSheet(host, deps, opener, onPick, options) {
	const {classes, text} = host.config;
	host.open({
		title: text.gifTitle,
		popover: host.config.popover,
		build: (body) => {
			const doc = body.ownerDocument;
			const win = doc.defaultView;
			const input = createElement(doc, 'input', classes.gifSearch);
			input.setAttribute('type', 'search');
			input.setAttribute('aria-label', text.gifSearch);
			input.setAttribute('placeholder', text.gifSearch);
			const grid = createElement(doc, 'div', classes.gifGrid);
			const status = createElement(doc, 'div', classes.gifStatus);
			status.setAttribute('role', 'status');
			status.hidden = true;
			const sentinel = createElement(doc, 'div', classes.gifSentinel);
			const scroll = createElement(doc, 'div', classes.gifScroll);
			scroll.append(grid, status, sentinel);
			body.append(input, scroll);

			let rendered = 0;
			let observer = null;
			const search = new GifSearch({
				fetchJson: deps.fetchJson,
				rule: deps.rule,
				locale: deps.locale,
				setTimer: (fn, ms) => win.setTimeout(fn, ms),
				clearTimer: (id) => win.clearTimeout(id),
				onChange: (state) => render(state),
			});

			/**
			 * 状態を画面へ写す。一覧は増えた分だけ足し、問い合わせが変わって減ったときだけ作り直す。
			 * @param {GifSearchState} state
			 * @returns {void}
			 */
			function render(state) {
				if (state.items.length < rendered) {
					grid.replaceChildren();
					rendered = 0;
				}
				for (const item of state.items.slice(rendered)) {
					grid.append(createTile(doc, classes, text, item, (gif) => {
						safeCall(onPick, gif);
						host.finish();
					}));
				}
				rendered = state.items.length;
				renderStatus(doc, status, state, classes, text, () => search.retry());
				if (observer && !state.loading && !state.failed && state.next) {
					observer.unobserve(sentinel);
					observer.observe(sentinel);
				}
			}

			input.addEventListener('input', () => search.setQuery(input.value.trim()));
			if (typeof win.IntersectionObserver === 'function') {
				try {
					observer = new win.IntersectionObserver((entries) => {
						if (entries.some((entry) => entry.isIntersecting)) search.loadMore();
					});
					observer.observe(sentinel);
				} catch (failure) {
					console.error('[XViewer] GIF の続きの読み込みを仕掛けられませんでした', failure);
					observer = null;
				}
			}
			search.start();
			return () => {
				search.destroy();
				if (observer) observer.disconnect();
			};
		}
	}, opener, options);
}

/**
 * 格子の 1 マス (選ぶボタン)。
 * @param {Document} doc 対象の文書
 * @param {Object} classes クラス名
 * @param {Object} text 文言
 * @param {GifItem} item GIF
 * @param {(gif: GifItem) => void} pick 選んだとき
 * @returns {HTMLButtonElement}
 */
function createTile(doc, classes, text, item, pick) {
	const button = createElement(doc, 'button', classes.gifItem);
	button.type = 'button';
	button.setAttribute('aria-label', formatText(text.gifItem, {title: item.title}));
	const image = createElement(doc, 'img');
	image.setAttribute('src', item.tinyUrl);
	image.setAttribute('alt', '');
	image.setAttribute('loading', 'lazy');
	if (item.tinyWidth > 0 && item.tinyHeight > 0) {
		image.setAttribute('width', String(item.tinyWidth));
		image.setAttribute('height', String(item.tinyHeight));
	}
	button.append(image);
	button.addEventListener('click', () => pick(item));
	return button;
}

/**
 * 状態の 1 行 (失敗と再試行・見つからなかった) を描く。何も言うことが無ければ隠す。
 * @param {Document} doc 対象の文書
 * @param {HTMLElement} status 状態の要素
 * @param {GifSearchState} state 状態
 * @param {Object} classes クラス名
 * @param {Object} text 文言
 * @param {() => void} retry 再試行
 * @returns {void}
 */
function renderStatus(doc, status, state, classes, text, retry) {
	status.replaceChildren();
	if (state.loading) {
		status.hidden = true;
		return;
	}
	if (state.failed) {
		status.append(createElement(doc, 'span', undefined, text.gifFailed));
		const button = createElement(doc, 'button', classes.button, text.gifRetry);
		button.type = 'button';
		button.addEventListener('click', retry);
		status.append(button);
		status.hidden = false;
		return;
	}
	if (state.items.length === 0) {
		status.append(createElement(doc, 'span', undefined, text.gifEmpty));
		status.hidden = false;
		return;
	}
	status.hidden = true;
}
