/**
 * ライトボックスの操作性の調整 (2.5.0 で追加)。
 *
 * Bluesky は画像ライトボックスの「閉じる」を**ダイアログの固定親**に置いて
 * おり、画像はその子であるためバブリングで閉じてしまう。同じ固定親に付く
 * クラス r-1loqt21 は中身が cursor: pointer だけで、それがライトボックス
 * 全域に継承されるため、画像の上も半透明の背景も閉じるボタンも見分けが
 * 付かない (2026-09-09 実測)。
 *
 * この 2 つを次のように直す:
 *
 * - 画像が実際に描かれている矩形の内側でのクリックだけを capture フェーズで
 *   止める。**半透明の余白は素通しする**ので、背景を押せば従来どおり閉じる
 * - 固定親に目印の属性を付け、content.css 側でカーソルを既定に戻す。
 *   押せるもの (ボタン・ALT 文の帯) にだけ pointer を戻す
 *
 * 依存:
 *   debug.js   (ExtDebug)
 *   sync-settings.js (loadSyncSettings, watchSyncSettings)
 *   page.js    (subscribeLightboxVisibility, isLightboxVisible, findVisibleLightboxDialog)
 *   設定 (EXT_CONFIG.lightboxGuard) は起動する側 (main.js) がコンストラクタに渡す
 *
 * **本体 DOM への介入は「目印の属性」と「capture の click リスナー」の 2 つだけ。**
 * どちらも自分が生やしたもので、撤去すれば完全に元へ戻る。当てた要素そのものを
 * 参照として保持し、撤去はその参照に対して行う (閉じた後はセレクタで引けない)。
 */
import {ExtDebug} from '../common/debug.js';
import {loadSyncSettings, watchSyncSettings} from '../common/sync-settings.js';
import {subscribeLightboxVisibility, isLightboxVisible, findVisibleLightboxDialog} from './page.js';

/** 設定の読み込みの失敗をログに出すときの名前 */
const SETTINGS_LABEL = 'ライトボックスの操作性の調整';

/**
 * @typedef {Object} ExtRect
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */

/**
 * object-fit: contain で実際に画像が描かれる矩形を求める。
 *
 * ライトボックスの img は領域いっぱい (実測 1208x661) に広がっており、
 * 絵そのものはその中央に縦横比を保って収まる。**余った左右 (または上下) は
 * 透明で、後ろの半透明の背景が見えている場所**であり、利用者から見れば
 * 「画像」ではなく「背景」になる。
 *
 * @param {ExtRect|null} elementRect img 要素の矩形
 * @param {{width: number, height: number}|null} naturalSize 画像の原寸
 * @returns {ExtRect|null} 描画矩形。原寸が未確定 (読み込み前) なら null
 */
export function computeContainRect(elementRect, naturalSize) {
	try {
		if (!elementRect || !naturalSize) {
			return null;
		}
		const {x, y, width, height} = elementRect;
		const natural = naturalSize;
		if (!(width > 0) || !(height > 0)) {
			return null;
		}
		if (!(natural.width > 0) || !(natural.height > 0)) {
			return null;
		}
		const scale = Math.min(width / natural.width, height / natural.height);
		const drawnWidth = natural.width * scale;
		const drawnHeight = natural.height * scale;
		return {
			x: x + (width - drawnWidth) / 2,
			y: y + (height - drawnHeight) / 2,
			width: drawnWidth,
			height: drawnHeight
		};
	} catch (error) {
		console.error('[XViewer] 画像の描画矩形の計算に失敗しました', error);
		return null;
	}
}

/**
 * このクリックを止める (= ライトボックスを閉じさせない) かどうかを決める。
 *
 * **押せる要素の上では必ず素通しする。** 左上の「画像オプション」ボタンは
 * 実測で (20,20)-(64,64)、画像の描画矩形は (50,0)-(1158,661) で重なっており、
 * ここを止めるとボタンが押せなくなる (2026-09-09 実測)。
 *
 * @param {{x: number, y: number}} point クリック位置 (client 座標)
 * @param {ExtRect|null} drawnRect computeContainRect() の結果
 * @param {boolean} isInteractive 押せる要素の上か
 * @returns {boolean} true なら止める
 */
export function shouldBlockLightboxClick(point, drawnRect, isInteractive) {
	try {
		if (isInteractive === true) {
			return false;
		}
		// 原寸が取れない間 (読み込み前) は従来どおり閉じられる側に倒す
		if (!drawnRect || !point) {
			return false;
		}
		return point.x >= drawnRect.x
			&& point.x <= drawnRect.x + drawnRect.width
			&& point.y >= drawnRect.y
			&& point.y <= drawnRect.y + drawnRect.height;
	} catch (error) {
		console.error('[XViewer] クリックの判定に失敗しました', error);
		return false;
	}
}

/**
 * `closest()` のヒットを「押せる要素」とみなしてよいかを決める。
 *
 * **固定親そのものは押せる要素ではない。** Bluesky は固定親に
 * `tabindex="0"` を付けており (2026-09-09 実測)、
 * `interactiveSelector` の `[tabindex]:not([tabindex="-1"])` に必ずヒットする。
 * これを除外しないと**すべてのクリックが素通しになり、機能そのものが働かない**
 * (実機で実際に踏んだ。閉じるのを止められなかった)。
 *
 * @param {Element|null} hit closest() の結果
 * @param {Element|null} container 固定親 (この内側にあるものだけ数える)
 * @returns {boolean}
 */
export function isInteractiveHit(hit, container) {
	try {
		if (!hit || !container || hit === container) {
			return false;
		}
		return container.contains(hit) === true;
	} catch (error) {
		console.error('[XViewer] 押せる要素の判定に失敗しました', error);
		// 判定できないときは素通しに倒す (押せなくなるより閉じるほうがまし)
		return true;
	}
}

/**
 * ライトボックスが開いている間だけ、固定親に目印と click リスナーを付ける。
 *
 * 開閉の検知は page.js の subscribeLightboxVisibility() を購読するだけで、
 * **新しい document.body の監視は足していない** (投稿情報パネルと同じ仕組みに
 * 相乗りしている)。
 */
export class LightboxGuard {
	/**
	 * @param {Object} config EXT_CONFIG.lightboxGuard
	 */
	constructor(config) {
		this.config = config;
		this.enabled = config.defaultEnabled;
		/** @type {HTMLElement|null} 目印とリスナーを付けた本体の要素。撤去時に戻す相手 */
		this.attachedEl = null;
		/** リスナーの登録と解除で同じ参照を使う */
		this.handleClick = this.handleClick.bind(this);
	}

	/**
	 * 設定を読み、ライトボックスの開閉を購読する。
	 * @returns {Promise<void>}
	 */
	async init() {
		const config = this.config;
		const defaults = {[config.storageKey]: config.defaultEnabled};
		const values = await loadSyncSettings(defaults, SETTINGS_LABEL);
		// setEnabled() と同じく boolean に正規化する (壊れた保存値を真偽値のまま入れない)
		const saved = values[config.storageKey];
		this.enabled = typeof saved === 'boolean' ? saved : config.defaultEnabled;
		watchSyncSettings(defaults, (changed) => this.setEnabled(changed[config.storageKey]), SETTINGS_LABEL);
		try {
			subscribeLightboxVisibility((visible) => {
				if (visible) {
					this.attach();
				} else {
					this.detach();
				}
			});
			// タブを閉じる・遷移で離れるときにも本体への介入を必ず戻す
			window.addEventListener('pagehide', () => this.detach());
		} catch (error) {
			console.error('[XViewer] ライトボックス調整の起動に失敗しました', error);
		}
	}

	/**
	 * ポップアップのトグルを反映する。OFF にした瞬間に撤去する。
	 * @param {boolean} enabled
	 * @returns {void}
	 */
	setEnabled(enabled) {
		this.enabled = enabled === true;
		ExtDebug.log('ライトボックス調整の設定が変わった', {有効: this.enabled});
		if (!this.enabled) {
			this.detach();
			return;
		}
		// ライトボックスが開いたままなら、その場で効かせる
		if (isLightboxVisible()) {
			this.attach();
		}
	}

	/**
	 * 固定親に目印と click リスナーを付ける。
	 * 見つからなければ何もしない (従来どおりの操作に落ちるだけ)。
	 * 相手の探し方は投稿情報パネルと同じ (page.js の findVisibleLightboxDialog())。
	 * @returns {void}
	 */
	attach() {
		try {
			// 「見える / 見えない」の変化しか届かないため、閉じて別のライトボックスが
			// 開いた場合は DOM から外れた古い固定親を掴んだままになる。外れていたら
			// 先に外して、新しい固定親に付け直す
			if (this.attachedEl && !this.attachedEl.isConnected) {
				this.detach();
			}
			if (!this.enabled || this.attachedEl) {
				return;
			}
			const dialog = findVisibleLightboxDialog(this.config.dialogSelector);
			const parent = dialog && dialog.parentElement;
			if (!parent) {
				return;
			}
			this.attachedEl = parent;
			parent.setAttribute(this.config.markerAttr, '');
			// capture で受けて、本体のハンドラ (固定親) へ届く前に止める
			parent.addEventListener('click', this.handleClick, true);
			ExtDebug.log('ライトボックスの調整を適用', {});
		} catch (error) {
			console.error('[XViewer] ライトボックスの調整の適用に失敗しました', error);
		}
	}

	/**
	 * 目印と click リスナーを外す。**保持している参照に対して行う**
	 * (閉じた後はセレクタで引けない)。要素が既に消えていれば害は無い。
	 * @returns {void}
	 */
	detach() {
		try {
			if (this.attachedEl) {
				this.attachedEl.removeAttribute(this.config.markerAttr);
				this.attachedEl.removeEventListener('click', this.handleClick, true);
			}
		} catch (error) {
			console.error('[XViewer] ライトボックスの調整の撤去に失敗しました', error);
		} finally {
			this.attachedEl = null;
		}
	}

	/**
	 * 判定に使う画像を選ぶ。
	 * クリックされたのが img ならそれを、そうでなければクリック位置を矩形に含む
	 * img を使う (複数枚の送りでは隣のスライドの img が同寸で画面外にあるため、
	 * 「最も大きい img」では前のスライドを選びかねない)。
	 * どの矩形にも入らなければ表示中で最も大きい img に落とす (保険)
	 * @param {EventTarget|null} target
	 * @param {number} x clientX
	 * @param {number} y clientY
	 * @returns {HTMLImageElement|null}
	 */
	resolveImage(target, x, y) {
		if (target && target.tagName === 'IMG') {
			return /** @type {HTMLImageElement} */ (target);
		}
		if (!this.attachedEl) {
			return null;
		}
		const images = this.attachedEl.querySelectorAll('img');
		let best = null;
		let bestArea = 0;
		for (let i = 0; i < images.length; i += 1) {
			const rect = images[i].getBoundingClientRect();
			if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
				return images[i];
			}
			const area = rect.width * rect.height;
			if (area > bestArea) {
				best = images[i];
				bestArea = area;
			}
		}
		return best;
	}

	/**
	 * capture フェーズの click。画像の描画矩形の内側だけ止める。
	 * @param {MouseEvent} event
	 * @returns {void}
	 */
	handleClick(event) {
		try {
			if (!this.enabled) {
				return;
			}
			const target = event.target;
			const hit = (target && typeof target.closest === 'function')
				? target.closest(this.config.interactiveSelector)
				: null;
			// **固定親自身は数えない** (実測で tabindex="0" を持つため、
			// 除外しないと全てのクリックが素通しになる)
			const interactive = isInteractiveHit(hit, this.attachedEl);
			const image = this.resolveImage(target, event.clientX, event.clientY);
			const rect = image && image.getBoundingClientRect();
			const drawn = image ? computeContainRect(
				{x: rect.x, y: rect.y, width: rect.width, height: rect.height},
				{width: image.naturalWidth, height: image.naturalHeight}
			) : null;
			if (!shouldBlockLightboxClick(
				{x: event.clientX, y: event.clientY}, drawn, interactive
			)) {
				return;
			}
			// 本体の「閉じる」は固定親のハンドラなので、伝播を止めれば届かない。
			// 既定動作 (画像のドラッグなど) には触らないため preventDefault はしない
			event.stopPropagation();
			ExtDebug.log('画像の上のクリックを止めた', {
				x: event.clientX,
				y: event.clientY
			});
		} catch (error) {
			console.error('[XViewer] ライトボックスのクリックの処理に失敗しました', error);
		}
	}
}
