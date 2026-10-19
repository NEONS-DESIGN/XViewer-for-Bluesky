/**
 * ライトボックスのパネルに重ねる小さな画面 (ALT テキスト・切り抜き・ラベル・言語・絵文字)。
 *
 * 画面はパネルの要素の中に 1 枚だけ置き、パネル全体を覆う (絵文字と GIF は開いたボタンに付く吹き出しにし、
 * 入力欄を隠さない)。パネルの中なので、
 * フォーカスとキーの扱い (panel-focus-guard.js) がそのまま効き、入力欄に文字が入る。
 * 画面の keydown はすべて画面で止める。Escape はこの画面だけを閉じ、
 * ライトボックス (本体) には届かせない。そのためフォーカスは画面の外へ出さない
 * (外へ出ると keydown が画面を通らず、Escape で本体のライトボックスが閉じる)。
 *
 * 依存: sheet-dom.js、reply-text.js (countGraphemes)、
 *       crop-sheet.js (openCropSheet)・language-sheet.js (openLanguageSheet ほか) を再び公開する
 */
import {countGraphemes} from './reply-text.js';
import {createElement, createButton, createAlert, createOption, formatText, safeCall, browserLocale} from './sheet-dom.js';

export {formatText} from './sheet-dom.js';
export {openCropSheet} from './crop-sheet.js';
export {
	openLanguageSheet, languageName, orderLanguages, filterLanguages, isLanguageLocked
} from './language-sheet.js';

/**
 * パネルに重ねる画面の定義。
 * build は本文の要素に中身を組む。done を呼ぶと「完了」と同じ扱いになる。
 * 後始末 (リスナーの解除・object URL の破棄など) が要るなら関数を返す。閉じるときに 1 回だけ呼ぶ
 * @typedef {Object} SheetSpec
 * @property {string} title 見出し
 * @property {(body: HTMLElement, done: () => void) => (void|(() => void))} build 中身を組む
 * @property {() => void} [onDone] 「完了」で閉じたとき
 * @property {() => void} [onCancel] 「キャンセル」・Escape・別の画面を開いたことで閉じたとき
 * @property {PopoverSize} [popover] パネルを覆わず、開いたボタンに付く吹き出しにする (絵文字・GIF)。
 *   見出しとボタンの行を持たず、外を押す・外へフォーカスが移る・同じボタンをもう一度押すと閉じる
 */

/**
 * 吹き出しの寸法 (px)。EXT_CONFIG.lightboxReplies.compose.popover の形。
 * @typedef {Object} PopoverSize
 * @property {number} preferredHeight 収まるときの高さ
 * @property {number} minHeight これを切るときはパネルを送って場所を空け、なお足りなければ広いほうへ出す
 * @property {number} gap ボタンとの隙間
 * @property {number} margin パネルの端との隙間
 * @property {number} arrowInset 矢印を吹き出しの左右の端からこれ以上離す
 */

/**
 * 矩形 (getBoundingClientRect の値のうち使うものだけ)。
 * @typedef {{top: number, bottom: number, left: number, right: number}} Box
 */

/**
 * 吹き出しの置き場所。top / left は画面 (viewport) の座標。
 * @typedef {Object} PopoverPlacement
 * @property {number} top
 * @property {number} left
 * @property {number} width
 * @property {number} height
 * @property {boolean} above ボタンの上に出すか
 * @property {number} arrowX 矢印の横位置 (吹き出しの左端から)
 */

/**
 * 吹き出しの置き場所を決める。幅は置き場の幅から両端の隙間を引いたもの。
 * ボタンの下に minHeight 以上あるか、上より下が広ければ下、そうでなければ上に出し、
 * 高さはその側の空きと preferredHeight の小さいほう。矢印はボタンの中央を指す。
 * @param {Box} anchor 開いたボタン
 * @param {Box} bounds 置き場 (パネルと画面の重なり)
 * @param {PopoverSize} size 寸法
 * @returns {PopoverPlacement}
 */
export function placePopover(anchor, bounds, size) {
	const width = Math.max(0, bounds.right - bounds.left - size.margin * 2);
	const below = bounds.bottom - size.margin - (anchor.bottom + size.gap);
	const aboveSpace = anchor.top - size.gap - (bounds.top + size.margin);
	const above = below < size.minHeight && aboveSpace > below;
	const height = Math.max(0, Math.min(size.preferredHeight, above ? aboveSpace : below));
	const top = above ? anchor.top - size.gap - height : anchor.bottom + size.gap;
	const center = (anchor.left + anchor.right) / 2;
	const minLeft = bounds.left + size.margin;
	const left = Math.max(minLeft, Math.min(center - width / 2, bounds.right - size.margin - width));
	const arrowX = Math.max(size.arrowInset, Math.min(center - left, width - size.arrowInset));
	return {top, left, width, height, above, arrowX};
}

/**
 * ボタンの下の空きが minHeight を切るとき、吹き出しを preferredHeight で出すためにパネルを下へ送る量。
 * 空きが minHeight 以上なら送らない (開くたびにパネルが動かないように)。
 * 送れる残り (room) と、持ち主 (入力欄) の上端がパネルの上の隙間に届くまで (keep) を超えない。
 * @param {Box} anchor 開いたボタン
 * @param {Box} bounds 置き場
 * @param {PopoverSize} size 寸法
 * @param {number} room パネルを下へ送れる残り
 * @param {number} keep 持ち主を隠さずに送れる量 (持ち主が無ければ Infinity)
 * @returns {number} 0 以上
 */
export function popoverScrollDelta(anchor, bounds, size, room, keep) {
	const below = bounds.bottom - size.margin - (anchor.bottom + size.gap);
	if (!(below < size.minHeight)) return 0;
	const need = size.preferredHeight - below;
	const delta = Math.max(0, Math.min(need, room, keep));
	return Number.isFinite(delta) ? delta : 0;
}

/**
 * 画面を開く側が添える情報。
 * @typedef {Object} SheetOptions
 * @property {Node|null} [owner] 画面の持ち主 (入力欄の外枠)。開いたボタンが描き直されて
 *   入れ替わっても、持ち主を外すときに画面を閉じられるようにする
 * @property {() => void} [restoreFocus] 閉じるときに開いたボタンがもうパネルに無ければ呼び、
 *   代わりの要素へフォーカスを移す (onDone で一覧を描き直した場合など)。
 *   無いか、呼んでもパネルの中へ移らなければ、パネルの最初の操作要素へ移す
 */

/** 見出しの id とラジオの組の名前を重ならないようにする連番 */
let sheetSerial = 0;

/**
 * パネルに重ねる画面を 1 枚だけ持つ役。開くと前の画面を閉じる。
 */
export class SheetHost {
	/**
	 * @param {HTMLElement} panelEl パネルの外枠 (画面はこの子として置く)
	 * @param {Object} config EXT_CONFIG.lightboxReplies.compose
	 */
	constructor(panelEl, config) {
		this.panelEl = panelEl;
		this.config = config;
		this.doc = panelEl.ownerDocument;
		/** @type {{spec: SheetSpec, layer: HTMLElement, doneButton: HTMLButtonElement|null, opener: HTMLElement|null, owner: (Node|null), restoreFocus: (Function|undefined), cleanup: (Function|null)}|null} */
		this.current = null;
		this.onKeyDown = this.onKeyDown.bind(this);
		this.onPanelFocusIn = this.onPanelFocusIn.bind(this);
		this.onOutsidePointerDown = this.onOutsidePointerDown.bind(this);
		this.onPanelScroll = this.onPanelScroll.bind(this);
		this.scheduleReposition = this.scheduleReposition.bind(this);
		/** 置き直しを待っている requestAnimationFrame の番号 (無ければ null) */
		this.repositionFrame = null;
		this.panelEl.addEventListener('focusin', this.onPanelFocusIn, true);
	}

	/**
	 * 画面を開く。開いている画面があれば、その onCancel を呼んで閉じてから開く。
	 * 開いたら画面の最初の操作要素へフォーカスを移す。
	 * 吹き出しを開いたボタンでもう一度開こうとしたときは、閉じるだけにする (押すたびに開閉する)。
	 * @param {SheetSpec} spec 画面の定義
	 * @param {HTMLElement|null} opener 開いたボタン (閉じたらここへフォーカスを返す)
	 * @param {SheetOptions} [options] 持ち主とフォーカスの戻し先
	 * @returns {void}
	 */
	open(spec, opener, options) {
		if (spec.popover && opener && this.current?.spec.popover && this.current.opener === opener) {
			this.cancel(true);
			return;
		}
		if (this.current) this.cancel(false);
		try {
			const {layer, body, doneButton, cancelButton} = this.buildLayer(spec);
			const restoreFocus = options && typeof options.restoreFocus === 'function'
				? options.restoreFocus
				: undefined;
			const entry = {
				spec, layer, doneButton, opener: opener || null,
				owner: (options && options.owner) || null, restoreFocus, cleanup: null
			};
			this.current = entry;
			doneButton?.addEventListener('click', () => {
				if (this.current === entry && !doneButton.disabled) this.finish();
			});
			cancelButton?.addEventListener('click', () => {
				if (this.current === entry) this.cancel(true);
			});
			layer.addEventListener('keydown', this.onKeyDown);
			this.panelEl.append(layer);
			if (spec.popover) this.startPopover();
			else this.panelEl.classList.add(this.config.classes.panelOpen);
			const cleanup = spec.build(body, () => {
				if (this.current === entry) this.finish();
			});
			if (typeof cleanup === 'function') entry.cleanup = cleanup;
			if (this.current === entry) this.focusFirst();
		} catch (error) {
			console.error('[XViewer] 重ねる画面を開けませんでした', error);
			this.close(true);
		}
	}

	/**
	 * 画面の外枠・見出し・本文・ボタンと、両端の番兵を組む。
	 * 外枠は tabindex="-1" で、余白を押してもフォーカスが外枠に残る (body へ落ちない)。
	 * 吹き出しは見出しとボタンの行を持たず、題は aria-label で読ませる。
	 * @param {SheetSpec} spec 画面の定義
	 * @returns {{layer: HTMLElement, body: HTMLElement, doneButton: HTMLButtonElement|null, cancelButton: HTMLButtonElement|null}}
	 */
	buildLayer(spec) {
		const {classes, text, sheetRoles} = this.config;
		const doc = this.doc;
		const layer = createElement(doc, 'div', classes.sheet);
		layer.dataset.role = sheetRoles.layer;
		layer.setAttribute('role', 'dialog');
		layer.setAttribute('tabindex', '-1');
		if (spec.popover) {
			layer.classList.add(classes.popover);
			layer.setAttribute('aria-label', spec.title);
			const popoverBody = createElement(doc, 'div', classes.body);
			layer.append(this.buildSentinel(false), popoverBody, this.buildSentinel(true));
			return {layer, body: popoverBody, doneButton: null, cancelButton: null};
		}
		sheetSerial += 1;
		const titleId = `${classes.title}-${sheetSerial}`;
		layer.setAttribute('aria-labelledby', titleId);

		const header = createElement(doc, 'div', classes.header);
		const title = createElement(doc, 'h2', classes.title, spec.title);
		title.setAttribute('id', titleId);
		title.dataset.role = sheetRoles.title;
		header.append(title);

		const body = createElement(doc, 'div', classes.body);
		const foot = createElement(doc, 'div', classes.foot);
		const cancelButton = createButton(doc, classes.button, text.sheetCancel);
		cancelButton.dataset.role = sheetRoles.cancel;
		const doneButton = createButton(doc, `${classes.button} ${classes.primary}`, text.sheetDone);
		doneButton.dataset.role = sheetRoles.done;
		foot.append(cancelButton, doneButton);
		layer.append(this.buildSentinel(false), header, body, foot, this.buildSentinel(true));
		return {layer, body, doneButton, cancelButton};
	}

	/**
	 * Tab の順で画面の端に置く番兵。フォーカスが来たら反対の端の操作要素へ回す。
	 * Shift+Tab で前へ戻った先 (選ばれていないラジオを飛ばした場合・iframe の中から出た場合を含む) も
	 * 画面の外へ出さない。
	 * @param {boolean} atEnd 末尾の番兵か (末尾は先頭の要素へ、先頭は末尾の要素へ回す)
	 * @returns {HTMLElement}
	 */
	buildSentinel(atEnd) {
		const sentinel = createElement(this.doc, 'span', this.config.classes.sentinel);
		sentinel.dataset.role = this.config.sheetRoles.sentinel;
		sentinel.setAttribute('tabindex', '0');
		sentinel.addEventListener('focus', () => {
			const items = this.focusableItems();
			const target = atEnd ? items[0] : items[items.length - 1];
			if (target) target.focus();
			else this.current?.layer.focus();
		});
		return sentinel;
	}

	/**
	 * 画面の keydown。本体とパネルのキーの扱いへ届かせない。Escape で閉じる (変換中を除く)。
	 * @param {KeyboardEvent} event
	 * @returns {void}
	 */
	onKeyDown(event) {
		event.stopPropagation();
		try {
			if (event.key === 'Escape' && !event.isComposing) {
				event.preventDefault();
				this.cancel(true);
			}
		} catch (error) {
			console.error('[XViewer] 重ねる画面のキーの処理に失敗しました', error);
		}
	}

	/**
	 * 画面が開いているあいだに、パネルの画面の外の要素へフォーカスが移ったら画面へ引き戻す
	 * (画面の下に隠れたボタンで Escape や矢印キーが本体へ届くのを防ぐ)。
	 * @param {FocusEvent} event
	 * @returns {void}
	 */
	onPanelFocusIn(event) {
		const entry = this.current;
		if (!entry) return;
		try {
			if (entry.layer.contains(event.target)) return;
			if (entry.spec.popover) {
				// 吹き出しは入力欄を隠さないので、外へ移ったフォーカスは引き戻さずに閉じる。
				// 開いたボタンへ移ったときは、続く click で開閉させる
				if (!(entry.opener && entry.opener.contains(event.target))) this.cancel(false);
				return;
			}
			this.focusFirst();
		} catch (error) {
			console.error('[XViewer] フォーカスを重ねる画面へ戻せませんでした', error);
		}
	}

	/**
	 * 吹き出しが開いているあいだに外 (吹き出しと開いたボタンの外) を押したら閉じる。
	 * 押した先がフォーカスを受けない所でも body へ落ちないよう、開いたボタンへ一度フォーカスを返す
	 * (押した先が入力欄なら、続く既定の動作でそちらへ移る)。iframe の中の押下はここへ届かない。
	 * @param {PointerEvent} event
	 * @returns {void}
	 */
	onOutsidePointerDown(event) {
		const entry = this.current;
		if (!entry || !entry.spec.popover) return;
		try {
			const target = event.target;
			if (entry.layer.contains(target)) return;
			if (entry.opener && entry.opener.contains(target)) return;
			this.cancel(true);
		} catch (error) {
			console.error('[XViewer] 吹き出しを閉じられませんでした', error);
		}
	}

	/**
	 * 吹き出しを置き、開いているあいだの監視 (外の押下・パネルや入力欄の送り・窓の大きさ) を始める。
	 * 外の押下は本体のどこでも拾えるよう html 要素の capture で、送りの scroll は泡立たないため
	 * パネルの capture で受ける。送りと窓の大きさの変化は 1 フレームに 1 回にまとめて置き直す。
	 * @returns {void}
	 */
	startPopover() {
		this.placeCurrentPopover(true);
		this.doc.documentElement.addEventListener('pointerdown', this.onOutsidePointerDown, true);
		this.panelEl.addEventListener('scroll', this.onPanelScroll, true);
		const win = this.doc.defaultView;
		if (win && typeof win.addEventListener === 'function') win.addEventListener('resize', this.scheduleReposition);
	}

	/**
	 * 吹き出しの監視をやめる。
	 * @returns {void}
	 */
	stopPopover() {
		this.doc.documentElement.removeEventListener('pointerdown', this.onOutsidePointerDown, true);
		this.panelEl.removeEventListener('scroll', this.onPanelScroll, true);
		const win = this.doc.defaultView;
		if (win && typeof win.removeEventListener === 'function') win.removeEventListener('resize', this.scheduleReposition);
		this.cancelReposition();
	}

	/**
	 * パネルの中の送り。吹き出しの中 (GIF の格子など) の送りでは開いたボタンは動かないので置き直さない。
	 * @param {Event} event
	 * @returns {void}
	 */
	onPanelScroll(event) {
		const entry = this.current;
		if (!entry) return;
		try {
			const target = event.target;
			if (target && target.nodeType === 1 && entry.layer.contains(target)) return;
		} catch (error) {
			// 送った先を調べられなくても、置き直しは続ける
		}
		this.scheduleReposition();
	}

	/**
	 * 次のフレームで吹き出しを置き直す。待っているあいだに重ねて呼ばれても 1 回にまとめる。
	 * requestAnimationFrame が無い環境ではすぐ置き直す。
	 * @returns {void}
	 */
	scheduleReposition() {
		if (this.repositionFrame !== null) return;
		const win = this.doc.defaultView;
		if (!win || typeof win.requestAnimationFrame !== 'function') {
			this.reposition();
			return;
		}
		try {
			this.repositionFrame = win.requestAnimationFrame(() => {
				this.repositionFrame = null;
				this.reposition();
			});
		} catch (error) {
			this.repositionFrame = null;
			this.reposition();
		}
	}

	/**
	 * 待っている置き直しを取り消す。
	 * @returns {void}
	 */
	cancelReposition() {
		const frame = this.repositionFrame;
		if (frame === null) return;
		this.repositionFrame = null;
		const win = this.doc.defaultView;
		try {
			if (win && typeof win.cancelAnimationFrame === 'function') win.cancelAnimationFrame(frame);
		} catch (error) {
			// 取り消せなくても、閉じた後の置き直しは placeCurrentPopover が何もしない
		}
	}

	/**
	 * 開いている吹き出しを、開いたボタンの今の位置に合わせて置き直す
	 * (入力欄が伸びた・パネルが送られた・窓の大きさが変わったとき)。吹き出しでなければ何もしない。
	 * @returns {void}
	 */
	reposition() {
		try {
			this.placeCurrentPopover(false);
		} catch (error) {
			console.error('[XViewer] 吹き出しを置き直せませんでした', error);
		}
	}

	/**
	 * 吹き出しを開いたボタンの下 (入らなければ上) に置く。
	 * allowScroll のときは、下の空きが足りなければ先にパネルを送って場所を空ける (入力欄は隠さない)。
	 * 開いたボタンが描き直しで外れた・寸法を測れないときは前の位置のままにする。
	 * @param {boolean} allowScroll パネルを送ってよいか (開いたときだけ)
	 * @returns {void}
	 */
	placeCurrentPopover(allowScroll) {
		const entry = this.current;
		if (!entry || !entry.spec.popover) return;
		const opener = entry.opener;
		if (!opener || !opener.isConnected || typeof opener.getBoundingClientRect !== 'function') return;
		const size = entry.spec.popover;
		const measure = () => {
			const panelRect = this.panelEl.getBoundingClientRect();
			const viewHeight = this.doc.defaultView?.innerHeight || panelRect.bottom;
			return {
				anchor: opener.getBoundingClientRect(),
				bounds: {
					top: Math.max(panelRect.top, 0),
					bottom: Math.min(panelRect.bottom, viewHeight),
					left: panelRect.left,
					right: panelRect.right
				}
			};
		};
		let {anchor, bounds} = measure();
		if (!anchor.width && !anchor.height) return;
		if (allowScroll) {
			const panel = this.panelEl;
			const room = panel.scrollHeight - panel.clientHeight - panel.scrollTop;
			const owner = entry.owner && typeof entry.owner.getBoundingClientRect === 'function' ? entry.owner : null;
			const keep = owner ? owner.getBoundingClientRect().top - (bounds.top + size.margin) : Infinity;
			const delta = popoverScrollDelta(anchor, bounds, size, room, keep);
			if (delta > 0) {
				panel.scrollTop += delta;
				({anchor, bounds} = measure());
			}
		}
		const place = placePopover(anchor, bounds, size);
		const {classes} = this.config;
		const style = entry.layer.style;
		style.top = `${place.top}px`;
		style.left = `${place.left}px`;
		style.width = `${place.width}px`;
		style.height = `${place.height}px`;
		style.setProperty(classes.popoverArrowVar, `${place.arrowX}px`);
		entry.layer.classList.toggle(classes.popoverAbove, place.above);
	}

	/**
	 * 要素がフォーカスを受けられるか (disabled・hidden でない)。
	 * @param {HTMLElement} item
	 * @returns {boolean}
	 */
	isFocusable(item) {
		return !item.disabled && !item.hidden && !item.closest?.('[hidden]');
	}

	/**
	 * 画面の中でフォーカスを受けられる要素 (番兵を除く)。
	 * @returns {HTMLElement[]}
	 */
	focusableItems() {
		if (!this.current) return [];
		const sentinelRole = this.config.sheetRoles.sentinel;
		return Array.from(this.current.layer.querySelectorAll(this.config.sheetFocusable))
			.filter((item) => item.dataset?.role !== sentinelRole && this.isFocusable(item));
	}

	/**
	 * 画面の最初の操作要素へフォーカスを移す。無ければ外枠へ移す。
	 * @returns {void}
	 */
	focusFirst() {
		const first = this.focusableItems()[0];
		if (first) first.focus();
		else this.current?.layer.focus();
	}

	/**
	 * 「完了」の押せる / 押せないを切り替える。
	 * @param {boolean} disabled 押せなくするか
	 * @returns {void}
	 */
	setDoneDisabled(disabled) {
		const button = this.current?.doneButton;
		if (button) button.disabled = !!disabled;
	}

	/**
	 * 「完了」として閉じる (onDone を呼んでから閉じる)。
	 * @returns {void}
	 */
	finish() {
		const entry = this.current;
		if (!entry) return;
		safeCall(entry.spec.onDone);
		if (this.current === entry) this.close(true);
	}

	/**
	 * 「キャンセル」として閉じる (onCancel を呼んでから閉じる)。
	 * @param {boolean} [restoreFocus] 開いたボタンへフォーカスを返すか。既定は返す
	 * @returns {void}
	 */
	cancel(restoreFocus = true) {
		const entry = this.current;
		if (!entry) return;
		safeCall(entry.spec.onCancel);
		if (this.current === entry) this.close(restoreFocus);
	}

	/**
	 * 閉じる画面のフォーカスの戻し先へ移す。開いたボタン → restoreFocus (開くときの options) →
	 * パネルの (画面の外の) 最初の操作要素の順に試し、body へ落とさない。
	 * @param {{spec: SheetSpec, layer: HTMLElement, opener: HTMLElement|null, restoreFocus: (Function|undefined)}} entry 閉じる画面
	 * @returns {void}
	 */
	returnFocus(entry) {
		const inPanel = (node) => !!node && this.panelEl.contains(node) && !entry.layer.contains(node);
		if (inPanel(entry.opener) && typeof entry.opener.focus === 'function') {
			entry.opener.focus();
			return;
		}
		safeCall(entry.restoreFocus);
		if (inPanel(this.doc.activeElement)) return;
		const fallback = Array.from(this.panelEl.querySelectorAll(this.config.sheetFocusable))
			.find((item) => inPanel(item) && this.isFocusable(item));
		if (fallback) fallback.focus();
	}

	/**
	 * 画面を閉じる。onDone / onCancel は呼ばない。
	 * フォーカスは画面を外す前に返す (外した後だと本体のダイアログへ引き戻される)。
	 * @param {boolean} restoreFocus フォーカスを戻すか
	 * @returns {void}
	 */
	close(restoreFocus) {
		const entry = this.current;
		if (!entry) return;
		this.current = null;
		if (restoreFocus) {
			try {
				this.returnFocus(entry);
			} catch (error) {
				console.error('[XViewer] 開いたボタンへフォーカスを戻せませんでした', error);
			}
		}
		if (entry.cleanup) safeCall(entry.cleanup);
		try {
			if (entry.spec.popover) this.stopPopover();
			entry.layer.removeEventListener('keydown', this.onKeyDown);
			entry.layer.remove();
			this.panelEl.classList.remove(this.config.classes.panelOpen);
		} catch (error) {
			console.error('[XViewer] 重ねる画面を外せませんでした', error);
		}
	}

	/**
	 * 画面が開いているか。
	 * @returns {boolean}
	 */
	isOpen() {
		return this.current !== null;
	}

	/**
	 * 開いている画面が container のものか (入力欄を外すときに閉じるかの判断に使う)。
	 * 開くときに渡した持ち主が container (かその中) であるか、開いたボタンが container の中にあれば真。
	 * 開いたボタンが描き直しで外れていても、持ち主で判断できる。
	 * @param {Node|null} container 入力欄などの外枠
	 * @returns {boolean}
	 */
	isOpenedFrom(container) {
		const entry = this.current;
		if (!entry || !container || typeof container.contains !== 'function') return false;
		try {
			if (entry.owner && (entry.owner === container || container.contains(entry.owner))) return true;
			return !!entry.opener && container.contains(entry.opener);
		} catch (error) {
			return false;
		}
	}

	/**
	 * 後始末。開いている画面をコールバック無しで閉じ、パネルのリスナーを外す (パネルの撤去で呼ぶ)。
	 * @returns {void}
	 */
	destroy() {
		this.close(false);
		this.panelEl.removeEventListener('focusin', this.onPanelFocusIn, true);
	}
}

/**
 * ALT テキストの残りと、上限を超えたか。
 * @param {string} text 入力中の文
 * @param {number} max 上限 (書記素)
 * @returns {{remaining: number, over: boolean}}
 */
export function altState(text, max) {
	const remaining = max - countGraphemes(text || '');
	return {remaining, over: remaining < 0};
}

/**
 * ALT の上限 (書記素) を決める。渡された値が正の整数ならそれ、そうでなければ既定の上限。
 * GIF のように送る先の上限が短いものは呼び出し側が渡す。
 * @param {*} given 渡された上限
 * @param {number} fallback 既定の上限 (compose.maxAltGraphemes)
 * @returns {number}
 */
export function resolveMaxAlt(given, fallback) {
	return Number.isInteger(given) && given > 0 ? given : fallback;
}

/**
 * ALT テキストの欄 (枠・入力欄・残りの数) を組む。書記素で残りを数え、上限を超えたら「完了」を押せなくする。
 * Ctrl+Enter (Mac は Command+Enter) は、上限を超えていなければ「完了」と同じ扱いにする。
 * @param {SheetHost} host 重ねる画面の持ち主
 * @param {Document} doc 対象の文書
 * @param {{value?: string, max: number, placeholder?: string, done: () => void}} input
 *   今の ALT・上限・入力欄の placeholder・「完了」と同じ扱いにする処理
 * @returns {{frame: HTMLElement, field: HTMLTextAreaElement, remaining: HTMLElement, sync: () => void}}
 *   frame と remaining を本文へ足し、組み終えたら sync を呼ぶ
 */
export function buildAltField(host, doc, input) {
	const {classes, text} = host.config;
	const frame = createElement(doc, 'div', classes.altFrame);
	const field = createElement(doc, 'textarea', classes.altInput);
	field.setAttribute('aria-label', text.altLabel);
	if (input.placeholder) field.setAttribute('placeholder', input.placeholder);
	field.value = input.value || '';
	frame.append(field);
	const remaining = createElement(doc, 'p', classes.altRemaining);
	remaining.setAttribute('aria-live', 'polite');
	const sync = () => {
		const state = altState(field.value, input.max);
		remaining.textContent = formatText(text.altRemaining, {count: state.remaining});
		remaining.classList.toggle(classes.warn, state.over);
		host.setDoneDisabled(state.over);
	};
	field.addEventListener('input', sync);
	field.addEventListener('keydown', (event) => {
		if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
			event.preventDefault();
			if (!altState(field.value, input.max).over) input.done();
		}
	});
	return {frame, field, remaining, sync};
}

/**
 * ALT テキストの画面を開く。画像の縮小表示と入力欄を出し、書記素で残りを数える。
 * 上限を超えたら「完了」を押せなくする。Ctrl+Enter でも「完了」と同じ扱いにする。
 * @param {SheetHost} host 重ねる画面の持ち主
 * @param {{previewUrl: string, alt: string, maxGraphemes?: number}} input 画像の URL と今の ALT テキスト。
 *   maxGraphemes は ALT の上限 (書記素)。省略すると compose.maxAltGraphemes
 * @param {HTMLElement} opener 開いたボタン
 * @param {(alt: string) => void} onSave 「完了」で、前後の空白を除いた文を受け取る
 * @param {SheetOptions} [options] 持ち主とフォーカスの戻し先
 * @returns {void}
 */
export function openAltSheet(host, input, opener, onSave, options) {
	const {classes, text} = host.config;
	const maxAltGraphemes = resolveMaxAlt(input?.maxGraphemes, host.config.maxAltGraphemes);
	let field = null;
	host.open({
		title: text.altTitle,
		build: (body, done) => {
			const doc = body.ownerDocument;
			if (input?.previewUrl) {
				const preview = createElement(doc, 'img', classes.altPreview);
				preview.setAttribute('src', input.previewUrl);
				preview.setAttribute('alt', text.altPreview);
				body.append(preview);
			}
			const alt = buildAltField(host, doc, {
				value: input?.alt, max: maxAltGraphemes, placeholder: text.altPlaceholder, done
			});
			field = alt.field;
			body.append(alt.frame, alt.remaining);
			alt.sync();
		},
		onDone: () => safeCall(onSave, (field?.value || '').trim())
	}, opener, options);
}

/**
 * コンテンツの警告ラベルの画面を開く。文言は Bluesky 本体と同じ。
 * 成人向けは「なし」を含む 4 つから 1 つ、生々しいメディアは独立のチェック。
 * @param {SheetHost} host 重ねる画面の持ち主
 * @param {{adult: string|null, graphic: boolean}} input 今の選択
 * @param {HTMLElement} opener 開いたボタン
 * @param {(selection: {adult: string|null, graphic: boolean}) => void} onSave 「完了」で選択を受け取る
 * @param {SheetOptions} [options] 持ち主とフォーカスの戻し先
 * @returns {void}
 */
export function openLabelSheet(host, input, opener, onSave, options) {
	const {classes, text, labels} = host.config;
	const selection = {
		adult: labels.adult.indexOf(input?.adult) !== -1 ? input.adult : null,
		graphic: input?.graphic === true
	};
	host.open({
		title: text.labelTitle,
		build: (body) => {
			const doc = body.ownerDocument;
			sheetSerial += 1;
			const groupName = `${classes.labelGroup}-${sheetSerial}`;
			const adultGroup = createElement(doc, 'fieldset', classes.labelGroup);
			adultGroup.append(createElement(doc, 'legend', classes.labelGroupTitle, text.labelAdult));
			[null, ...labels.adult].forEach((value) => {
				const label = value === null ? text.labelNone : text.labelNames[value] || value;
				const {row, control} = createOption(doc, classes.option, 'radio', groupName, label, selection.adult === value);
				control.addEventListener('change', () => {
					if (control.checked) selection.adult = value;
				});
				adultGroup.append(row);
			});
			const otherGroup = createElement(doc, 'fieldset', classes.labelGroup);
			otherGroup.append(createElement(doc, 'legend', classes.labelGroupTitle, text.labelOther));
			const graphicLabel = text.labelNames[labels.graphic] || labels.graphic;
			const {row, control} = createOption(doc, classes.option, 'checkbox', '', graphicLabel, selection.graphic);
			control.addEventListener('change', () => {
				selection.graphic = control.checked;
			});
			otherGroup.append(row);
			body.append(createElement(doc, 'p', classes.note, text.labelDescription), adultGroup, otherGroup);
		},
		onDone: () => safeCall(onSave, {adult: selection.adult, graphic: selection.graphic})
	}, opener, options);
}

/**
 * 拡張機能のページの origin。chrome.runtime.getURL('') の末尾の / を除いたもの。
 * (Firefox の moz-extension: では new URL(...).origin が "null" になるため、URL から切り出す)
 * @param {string} rootUrl chrome.runtime.getURL('') の値
 * @returns {string}
 */
export function extensionOrigin(rootUrl) {
	return String(rootUrl || '').replace(/\/+$/, '');
}

/**
 * 絵文字のページからの通知か。送り主の window・origin・型をすべて確かめる。
 * @param {MessageEvent|{source: *, origin: string, data: *}} event 受け取った通知
 * @param {Window|null} frameWindow iframe の contentWindow
 * @param {string} origin 拡張機能のページの origin
 * @param {Object} emoji EXT_CONFIG.lightboxReplies.compose.emoji
 * @returns {boolean}
 */
export function isEmojiMessage(event, frameWindow, origin, emoji) {
	if (!event || !frameWindow || !origin || event.source !== frameWindow || event.origin !== origin) return false;
	const data = event.data;
	if (!data || typeof data !== 'object') return false;
	return [emoji.selectType, emoji.closeType, emoji.readyType].indexOf(data.type) !== -1;
}

/**
 * 絵文字のページの URL に配色と言語を付ける。言語は日本語のときだけ付ける。
 * @param {string} base chrome.runtime.getURL で得たページの URL
 * @param {string} theme 配色 (query.themeDark / query.themeLight)
 * @param {string} locale ブラウザの言語
 * @param {Object} emoji EXT_CONFIG.lightboxReplies.compose.emoji
 * @returns {string}
 */
export function buildEmojiUrl(base, theme, locale, emoji) {
	const url = new URL(base);
	const query = emoji.query;
	url.searchParams.set(query.theme, theme === query.themeLight ? query.themeLight : query.themeDark);
	if (String(locale || '').toLowerCase().split('-')[0] === query.localeJa) {
		url.searchParams.set(query.locale, query.localeJa);
	}
	return url.toString();
}

/**
 * 本体の今の配色から、絵文字のページの配色を決める。ライトのテーマクラスがあるときだけ light。
 * @param {Document} doc 本体の文書
 * @param {Object} emoji EXT_CONFIG.lightboxReplies.compose.emoji
 * @returns {string}
 */
export function pickEmojiTheme(doc, emoji) {
	try {
		return doc.documentElement.classList.contains(emoji.lightThemeClass)
			? emoji.query.themeLight : emoji.query.themeDark;
	} catch (error) {
		return emoji.query.themeDark;
	}
}

/**
 * 絵文字のページの通知を受ける処理を作る。準備ができたら読み込み中の 1 行を外し、選んだら onPick、
 * 閉じる通知で画面を閉じ、失敗の通知なら iframe と読み込み中の 1 行を隠して失敗の 1 行を出す。
 * @param {SheetHost} host 重ねる画面の持ち主
 * @param {HTMLIFrameElement} frame 絵文字のページの iframe
 * @param {{error: HTMLElement, loading: HTMLElement}} lines 失敗の 1 行と読み込み中の 1 行
 * @param {string} origin 拡張機能のページの origin
 * @param {(native: string) => void} onPick 選んだ絵文字
 * @returns {(event: MessageEvent) => void}
 */
function createEmojiListener(host, frame, lines, origin, onPick) {
	const emoji = host.config.emoji;
	const {error, loading} = lines;
	return (event) => {
		try {
			if (!isEmojiMessage(event, frame.contentWindow, origin, emoji)) return;
			const data = event.data;
			if (data.type === emoji.readyType) {
				loading.hidden = true;
			} else if (data.type === emoji.selectType && typeof data.native === 'string' && data.native) {
				safeCall(onPick, data.native);
				// 絵文字が入って入力欄が伸びると開いたボタンが下がるため、吹き出しを付け直す
				host.reposition();
			} else if (data.type === emoji.closeType) {
				if (data.error) {
					frame.hidden = true;
					loading.hidden = true;
					error.hidden = false;
				} else {
					host.cancel(true);
				}
			}
		} catch (failure) {
			console.error('[XViewer] 絵文字のページの通知を扱えませんでした', failure);
		}
	};
}

/**
 * 絵文字の画面を開く。開いたボタンに付く吹き出しに拡張機能のページを iframe で出し、選んだ絵文字を
 * onPick へ渡す (吹き出しは開いたままにする)。ページが準備できたと知らせるまでは読み込み中の 1 行を重ねる。
 * ページが閉じる通知を出したら閉じ、失敗を知らせたら 1 行出す。
 * @param {SheetHost} host 重ねる画面の持ち主
 * @param {HTMLElement} opener 開いたボタン
 * @param {(native: string) => void} onPick 選んだ絵文字 (文字そのもの)
 * @param {SheetOptions} [options] 持ち主とフォーカスの戻し先
 * @returns {void}
 */
export function openEmojiSheet(host, opener, onPick, options) {
	const {classes, text, emoji} = host.config;
	host.open({
		title: text.emojiTitle,
		popover: host.config.popover,
		build: (body) => {
			const doc = body.ownerDocument;
			const win = doc.defaultView;
			const error = createAlert(doc, classes.error, text.emojiFailed);
			body.append(error);
			let page = '';
			let origin = '';
			try {
				const locale = browserLocale(emoji.query.localeJa);
				page = buildEmojiUrl(chrome.runtime.getURL(emoji.page), pickEmojiTheme(doc, emoji), locale, emoji);
				origin = extensionOrigin(chrome.runtime.getURL(''));
			} catch (failure) {
				console.error('[XViewer] 絵文字のページの場所を得られませんでした', failure);
				error.hidden = false;
				return undefined;
			}
			const frame = createElement(doc, 'iframe', classes.emojiFrame);
			frame.setAttribute('title', text.emojiFrame);
			const loading = createElement(doc, 'p', classes.emojiLoading, text.emojiLoading);
			loading.setAttribute('role', 'status');
			const onMessage = createEmojiListener(host, frame, {error, loading}, origin, onPick);
			win.addEventListener('message', onMessage);
			frame.setAttribute('src', page);
			body.append(frame, loading);
			return () => win.removeEventListener('message', onMessage);
		}
	}, opener, options);
}
