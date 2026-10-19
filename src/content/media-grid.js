/**
 * サムネイル格子の描画層と、その起動・停止を決める制御層。
 * 描画層 (MediaGrid) は取得 (MediaFetcher) も蓄積 (MediaStore) も起動判断も知らず、
 * 渡された MediaEntry の配列を並べることだけを行う。
 */
import {EXT_VIEWS, EXT_CONFIG} from '../common/config.js';
import {ExtDebug} from '../common/debug.js';
import {createIcon} from '../common/icons.js';
import {loadSyncSettings, watchSyncSettings} from '../common/sync-settings.js';
import {callBridge} from './bridge-client.js';
import {
	currentTabs, getPageInfo, getSelectedTabIndex, isLightboxVisible, isLightboxStatePushed,
	subscribeTabStateChange
} from './page.js';
import {openLightboxPayload, postRoute} from './routes.js';
import {
	shouldBlur, matchBlurLabels, formatBlurLabels, MediaStore, MediaFetcher
} from './media-source.js';

/** 複数枚の投稿に付けるアイコンの名前 (ICON_SHAPES のキー) */
const MULTI_BADGE_ICON = 'filterNone';

/** 設定の読み込みの失敗をログに出すときの名前 */
const SETTINGS_LABEL = 'メディアグリッド';

/**
 * グリッドを差し込む場所を探す。
 *
 * Bluesky はプロフィールのタブごとのページを全部 DOM に保持しており、
 * [data-testid="postsFeed"] はページ内に複数 (投稿 / 返信 / メディア / ビデオの
 * タブ数ぶん) 存在する。非アクティブなページは祖先が display: none になっていて
 * 矩形が 0×0 になるため、素の querySelector で先頭の 1 件を掴むと表示中でない
 * ページを選んでしまい、グリッドが 0×0 に潰れる (実機で確認済み)。
 *
 * そのため getBoundingClientRect().width > 0 (実際に表示中) のものを選ぶ。
 * 組み直し (remount) のときも、enable() の前に disable() が .ext-feed-hidden を
 * 剥がしてから来るため、可視判定だけで同じページを選び直せる
 * @returns {{container: Element, feed: Element}|null} 該当なしなら null
 */
export function findFeedParts() {
	try {
		const feeds = document.querySelectorAll(EXT_CONFIG.selectors.feed);

		let feed = null;
		for (const candidate of feeds) {
			// offsetParent は position: fixed で null になるため使わない
			if (candidate.getBoundingClientRect().width > 0) {
				feed = candidate;
				break;
			}
		}
		if (!feed) {
			// 可視なものが無いときの最終手段: 前の content script (拡張機能を
			// リロードしてタブを再読み込みしなかった開発時) が隠したままの feed を
			// 選び直して復帰できるようにする
			const hiddenClass = EXT_CONFIG.mediaGrid.hiddenFeedClass;
			for (const candidate of feeds) {
				if (candidate.classList.contains(hiddenClass)) {
					feed = candidate;
					break;
				}
			}
		}

		if (!feed || !feed.parentElement) {
			return null;
		}
		return {container: feed.parentElement, feed};
	} catch (error) {
		console.error('[XViewer] マウント先の探索に失敗しました', error);
		return null;
	}
}

/**
 * 取得と蓄積の状態。gridStatus() の入力。
 * @typedef {Object} GridStatusState
 * @property {number} size        蓄積の件数
 * @property {boolean} failed     取得が失敗で止まっているか
 * @property {boolean} exhausted  フィードの最後まで読んだか
 * @property {boolean} finished   自前で読み進める回数の上限に達したか
 * @property {boolean} stalled    中身 0 件のページが続いて自動では読み進めないか
 */

/**
 * 状態表示の文言と、「さらに読み込む」ボタンを出すかを決める。
 * @param {GridStatusState} state
 * @param {Object} text EXT_CONFIG.mediaGrid.text
 * @returns {{text: string, loadMore: boolean}}
 */
export function gridStatus(state, text) {
	if (state.size === 0) {
		if (state.failed) {
			return {text: text.error, loadMore: false};
		}
		if (state.exhausted) {
			return {text: text.empty, loadMore: false};
		}
		if (state.stalled) {
			return {text: text.empty, loadMore: true};
		}
		return {text: text.loading, loadMore: false};
	}
	if (state.finished || state.exhausted) {
		return {text: text.end, loadMore: false};
	}
	if (state.failed) {
		return {text: text.error, loadMore: false};
	}
	if (state.stalled) {
		return {text: text.stalled, loadMore: true};
	}
	return {text: text.loading, loadMore: false};
}

/**
 * MediaEntry の配列をタイル格子として描画する。
 * スクロールはページ全体 (window / documentElement) を見る。グリッド自身はスクロールを持たない。
 */
export class MediaGrid {
	constructor() {
		/** @type {HTMLElement|null} グリッドのルート要素 */
		this.containerEl = null;
		/** @type {HTMLElement|null} タイルを並べる要素 */
		this.listEl = null;
		/** @type {HTMLElement|null} 状態表示の要素 */
		this.statusEl = null;
		/** @type {HTMLButtonElement|null} 中身 0 件のページが続いて止めたときに出す「さらに読み込む」 */
		this.loadMoreEl = null;
		/** 蓄積の何件目まで描画に回したか。render() の差分描画に使う */
		this.renderedCount = 0;
		/** window の scroll イベントで控える window.scrollY。isMounted の時点で読み直さない */
		this.lastScrollTop = 0;
		/** 末尾に近づいたときに Controller が差し込むコールバック */
		this.onNearEnd = null;
		/** 「さらに読み込む」を押したときに Controller が差し込むコールバック */
		this.onLoadMore = null;
		/** NSFW のぼかしを解除するか。Controller が設定を読んで setUnblur() で渡す */
		this.unblurEnabled = EXT_CONFIG.mediaGrid.unblur.defaultEnabled;
		/** @type {WeakMap<Element, MediaEntry>} タイルから entry を引く。押下は listEl で一括して受ける */
		this.tileEntries = new WeakMap();
		/** @type {SVGSVGElement|null} 複数枚アイコンの雛形。タイルごとに cloneNode で使い回す */
		this.multiBadgeTemplate = null;
		/** scroll の末尾判定を 1 フレームに 1 回へまとめるための requestAnimationFrame の id */
		this.scrollFrameId = null;
		/** removeEventListener で使い回すための束縛済みハンドラ */
		this.boundHandleScroll = () => this.handleScroll();
		this.boundHandleListClick = (event) => this.handleListClick(event);
		this.boundHandleImageError = (event) => this.handleImageError(event);
		this.boundHandleLoadMore = () => {
			if (typeof this.onLoadMore === 'function') {
				this.onLoadMore();
			}
		};
	}

	/**
	 * グリッド要素を作り、コンテナの先頭に prepend する。
	 * @param {Element} container findFeedParts() が返した container
	 * @returns {boolean} マウントできたら true
	 */
	mount(container) {
		try {
			if (!container) {
				return false;
			}
			this.unmount();

			const config = EXT_CONFIG.mediaGrid;

			const containerEl = document.createElement('div');
			containerEl.id = config.containerId;
			containerEl.style.setProperty('--ext-media-columns', String(config.columns));
			containerEl.style.setProperty('--ext-media-gap', `${config.gapPx}px`);
			containerEl.style.setProperty('--ext-media-max-width', `${config.maxWidthPx}px`);

			const listEl = document.createElement('div');
			listEl.className = config.listClass;
			listEl.addEventListener('click', this.boundHandleListClick);
			// img の error はバブリングしないため capture で受ける
			listEl.addEventListener('error', this.boundHandleImageError, true);

			const statusEl = document.createElement('div');
			statusEl.id = config.statusId;

			const loadMoreEl = document.createElement('button');
			loadMoreEl.type = 'button';
			loadMoreEl.className = config.loadMoreClass;
			loadMoreEl.textContent = config.text.loadMore;
			loadMoreEl.hidden = true;
			loadMoreEl.addEventListener('click', this.boundHandleLoadMore);

			containerEl.appendChild(listEl);
			containerEl.appendChild(statusEl);
			containerEl.appendChild(loadMoreEl);
			container.prepend(containerEl);

			this.containerEl = containerEl;
			this.listEl = listEl;
			this.statusEl = statusEl;
			this.loadMoreEl = loadMoreEl;
			this.renderedCount = 0;
			this.tileEntries = new WeakMap();
			this.lastScrollTop = window.scrollY;
			// 要素を作り直したので、現在のぼかし解除設定を入れ直す
			this.applyUnblur();

			window.addEventListener('scroll', this.boundHandleScroll, {passive: true});
			return true;
		} catch (error) {
			console.error('[XViewer] グリッドのマウントに失敗しました', error);
			return false;
		}
	}

	/** 購読を外して要素を除去し、内部状態を初期化する。 */
	unmount() {
		try {
			window.removeEventListener('scroll', this.boundHandleScroll);
			if (this.scrollFrameId !== null) {
				cancelAnimationFrame(this.scrollFrameId);
			}
			if (this.containerEl && this.containerEl.parentElement) {
				this.containerEl.remove();
			}
		} catch (error) {
			console.error('[XViewer] グリッドの解除に失敗しました', error);
		} finally {
			this.scrollFrameId = null;
			this.containerEl = null;
			this.listEl = null;
			this.statusEl = null;
			this.loadMoreEl = null;
			this.renderedCount = 0;
			this.tileEntries = new WeakMap();
		}
	}

	/**
	 * NSFW のぼかし解除を切り替える。
	 * タイル側の blurClass とラベル判定はそのまま残し、ルート要素のクラスだけで
	 * 見せ方を変える。描画済みのタイルを作り直さずに済み、OFF に戻せば元に戻る。
	 * @param {boolean} enabled
	 * @returns {void}
	 */
	setUnblur(enabled) {
		this.unblurEnabled = !!enabled;
		this.applyUnblur();
	}

	/**
	 * 現在のぼかし解除設定をルート要素のクラスに反映する。
	 * まだマウントしていなければ何もしない (mount() 側で入れ直す)。
	 * @returns {void}
	 */
	applyUnblur() {
		try {
			if (!this.containerEl) {
				return;
			}
			this.containerEl.classList.toggle(
				EXT_CONFIG.mediaGrid.unblur.containerClass,
				this.unblurEnabled
			);
		} catch (error) {
			console.error('[XViewer] ぼかし解除の反映に失敗しました', error);
		}
	}

	/**
	 * scroll のたびにスクロール位置を控え、末尾判定は 1 フレームに 1 回だけ行う。
	 * 末尾判定は scrollHeight を読む (レイアウトを起こしうる) ため、scroll ごとには読まない。
	 * @returns {void}
	 */
	handleScroll() {
		this.lastScrollTop = window.scrollY;
		if (this.scrollFrameId !== null) {
			return;
		}
		this.scrollFrameId = requestAnimationFrame(() => {
			this.scrollFrameId = null;
			if (this.isMounted) {
				this.checkNearEnd();
			}
		});
	}

	/**
	 * 新しく増えた entry を描き足す。呼び出し側は描画済みの件数 (renderedCount) より
	 * 後ろの entry だけを渡す。
	 * 1 件の描画に失敗しても renderedCount は進める
	 * (据え置くと以後の描画が毎回同じ件で止まるため)。
	 * 状態表示 (読み込み中 / すべて読み込みました など) はここでは扱わない。
	 * @param {MediaEntry[]} entries
	 * @returns {void}
	 */
	render(entries) {
		if (!this.isMounted || !Array.isArray(entries) || entries.length === 0) {
			return;
		}
		// 組み直しでは蓄積全件 (数百枚) を一度に描くため、接続済みの listEl へ
		// 1 個ずつ足さず、fragment にまとめて 1 回で入れる
		const fragment = document.createDocumentFragment();
		for (const entry of entries) {
			try {
				fragment.appendChild(this.createTile(entry));
			} catch (error) {
				console.error('[XViewer] タイルの描画に失敗しました', error);
			} finally {
				this.renderedCount += 1;
			}
		}
		this.listEl.appendChild(fragment);
	}

	/**
	 * 1 件ぶんのタイルを組み立てる。押下と読み込みの失敗は listEl が一括して受ける。
	 * @param {MediaEntry} entry
	 * @returns {HTMLAnchorElement}
	 */
	createTile(entry) {
		const config = EXT_CONFIG.mediaGrid;

		const tile = document.createElement('a');
		tile.className = config.tileClass;
		tile.href = entry.postHref;

		const img = document.createElement('img');
		img.loading = 'lazy';
		img.alt = entry.alt || '';
		img.src = entry.thumbUrl;
		tile.appendChild(img);

		if (entry.mediaCount > 1) {
			tile.appendChild(this.createMultiBadge());
		}

		if (entry.type === 'video') {
			const videoBadge = document.createElement('span');
			videoBadge.className = config.videoBadgeClass;
			videoBadge.textContent = config.text.videoBadge;
			tile.appendChild(videoBadge);
		}

		if (shouldBlur(entry, config)) {
			tile.classList.add(config.blurClass);
			const label = document.createElement('span');
			label.className = config.blurLabelClass;
			label.textContent = formatBlurLabels(matchBlurLabels(entry.labels, config), config);
			tile.appendChild(label);
		}

		this.tileEntries.set(tile, entry);
		return tile;
	}

	/**
	 * 複数枚の投稿であることを示すアイコンを返す。雛形を 1 度だけ作り、写しを渡す。
	 * @returns {SVGSVGElement}
	 */
	createMultiBadge() {
		if (!this.multiBadgeTemplate) {
			const svg = createIcon(document, MULTI_BADGE_ICON);
			svg.classList.add(EXT_CONFIG.mediaGrid.badgeClass);
			this.multiBadgeTemplate = svg;
		}
		return /** @type {SVGSVGElement} */ (this.multiBadgeTemplate.cloneNode(true));
	}

	/**
	 * listEl の click。押されたタイルを探し、その entry で handleTileClick() を呼ぶ。
	 * @param {MouseEvent} event
	 * @returns {void}
	 */
	handleListClick(event) {
		try {
			const target = event.target;
			if (!target || typeof target.closest !== 'function' || !this.listEl) {
				return;
			}
			const tile = target.closest('.' + EXT_CONFIG.mediaGrid.tileClass);
			if (!tile || !this.listEl.contains(tile)) {
				return;
			}
			const entry = this.tileEntries.get(tile);
			if (entry) {
				this.handleTileClick(event, entry, tile);
			}
		} catch (error) {
			console.error('[XViewer] タイル押下の振り分けに失敗しました', error);
		}
	}

	/**
	 * 読み込めない画像はタイルごと除去する (代替表示は持たない)。listEl の capture で受ける。
	 * @param {Event} event
	 * @returns {void}
	 */
	handleImageError(event) {
		try {
			const target = event.target;
			if (!target || target.tagName !== 'IMG' || typeof target.closest !== 'function') {
				return;
			}
			const tile = target.closest('.' + EXT_CONFIG.mediaGrid.tileClass);
			if (tile && this.listEl && tile.parentElement === this.listEl) {
				tile.remove();
			}
		} catch (error) {
			console.error('[XViewer] 読み込めない画像の除去に失敗しました', error);
		}
	}

	/**
	 * タイルの押下。画像はライトボックス、動画は投稿ページへ SPA 遷移する。
	 * ぼかし中は解除するだけで、2 回目の押下で初めて開く。
	 *
	 * 拡張機能が作った a 要素は Bluesky のルーター (React Navigation) の管理外で、
	 * 既定動作に任せるとフルリロードになる (実機で確認した)。
	 * そのため bridge の navigate アクションでルーターの push を直接呼ぶ。
	 * @param {MouseEvent} event
	 * @param {MediaEntry} entry
	 * @param {Element} tile
	 * @returns {void}
	 */
	handleTileClick(event, entry, tile) {
		try {
			const config = EXT_CONFIG.mediaGrid;
			// 解除が有効なときは二段階を挟まず、1 回目の押下でそのまま開く。
			// ぼかし中は修飾キー付きでも解除だけにする (二段階を飛ばして開かせない)
			if (!this.unblurEnabled && tile.classList.contains(config.blurClass)) {
				event.preventDefault();
				tile.classList.remove(config.blurClass);
				return;
			}
			// 修飾キー付き (新しいタブで開く) は a の href に任せる。
			// フルリロードになるが別タブなので害は無い
			if (event.ctrlKey || event.metaKey || event.shiftKey) {
				return;
			}
			// a の href は失敗時の行き先として張ったままにしておき、既定動作だけ止める
			event.preventDefault();

			if (entry.type !== 'image') {
				this.navigateToPost(entry);
				return;
			}
			// 1 投稿 1 タイルのため、開くのは常に先頭画像から
			callBridge(config.bridge.actions.openLightbox, openLightboxPayload({
				images: entry.siblings,
				index: 0,
				postUri: entry.postUri,
				authorDid: entry.authorDid
			})).then((result) => {
				if (!result || !result.ok) {
					// ライトボックスが開けなければ SPA 遷移を試し、それも駄目なら通常遷移に落ちる
					this.navigateToPost(entry);
				}
			}).catch((error) => {
				console.error('[XViewer] ライトボックスの呼び出しに失敗しました', error);
				this.navigateToPost(entry);
			});
		} catch (error) {
			console.error('[XViewer] タイル押下の処理に失敗しました', error);
			// 失敗しても最低限、投稿ページへは落とす
			if (entry && entry.postHref) {
				window.location.href = entry.postHref;
			}
		}
	}

	/**
	 * 投稿ページへ SPA 遷移する。ブリッジが使えない・失敗した場合は通常遷移
	 * (フルリロード) に落とす。代替ビューアは持たない。
	 * @param {MediaEntry} entry
	 * @returns {void}
	 */
	navigateToPost(entry) {
		try {
			callBridge(
				EXT_CONFIG.mediaGrid.bridge.actions.navigate,
				postRoute(entry.authorHandle, entry.postId)
			).then((result) => {
				if (!result || !result.ok) {
					window.location.href = entry.postHref;
				}
			}).catch((error) => {
				console.error('[XViewer] 投稿ページへの SPA 遷移に失敗しました', error);
				window.location.href = entry.postHref;
			});
		} catch (error) {
			console.error('[XViewer] 投稿ページへの遷移処理に失敗しました', error);
			if (entry && entry.postHref) {
				window.location.href = entry.postHref;
			}
		}
	}

	/**
	 * 状態表示の文言と「さらに読み込む」の表示を差し替える。
	 * @param {string} text
	 * @param {boolean} [showLoadMore=false]
	 * @returns {void}
	 */
	setStatus(text, showLoadMore = false) {
		if (this.statusEl) {
			this.statusEl.textContent = text;
		}
		if (this.loadMoreEl) {
			this.loadMoreEl.hidden = !showLoadMore;
		}
	}

	/**
	 * @returns {number} 控えている window.scrollY。その場で読み直さない
	 * (組み直しの時点ではグリッドが既に外れてページが縮んでいることがあるため)
	 */
	getScrollTop() {
		return this.lastScrollTop;
	}

	/**
	 * スクロール位置を引き継ぐ。タイルは aspect-ratio で高さが決まり、
	 * 蓄積の件数ぶんは render() が同期的に描き終えているため、画像の読み込みを待たずに戻せる。
	 * @param {number} top
	 * @returns {void}
	 */
	setScrollTop(top) {
		try {
			window.scrollTo(0, top);
		} catch (error) {
			console.error('[XViewer] スクロール位置の復元に失敗しました', error);
		}
	}

	/** @returns {boolean} グリッドが DOM に接続されているか */
	get isMounted() {
		return !!(this.containerEl && this.containerEl.isConnected);
	}

	/** @returns {boolean} ページ全体がスクロールできる高さを持つか */
	get isScrollable() {
		return document.documentElement.scrollHeight > window.innerHeight;
	}

	/**
	 * ページの残り距離が nearEndPx 以下なら onNearEnd を呼ぶ。
	 * グリッド要素のスクロールではなく、ページ全体 (documentElement) を見る。
	 * @returns {void}
	 */
	checkNearEnd() {
		try {
			const remaining = document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
			if (remaining <= EXT_CONFIG.mediaGrid.api.nearEndPx && typeof this.onNearEnd === 'function') {
				this.onNearEnd();
			}
		} catch (error) {
			console.error('[XViewer] 末尾判定に失敗しました', error);
		}
	}
}

/**
 * ページとタブの状態に応じて、グリッドの起動・停止を合わせる制御層。
 * MediaStore / MediaFetcher / MediaGrid の中身には手を出さず、
 * 「いつ起動し、いつ畳むか」だけを判断する。
 */
export class MediaGridController {
	constructor() {
		const cfg = EXT_CONFIG.mediaGrid;
		this.config = cfg;
		this.store = new MediaStore();
		this.fetcher = new MediaFetcher(this.store, cfg);
		this.grid = new MediaGrid();

		this.enabled = cfg.defaultEnabled;
		/** 保存済みの設定を読み終えたか。読み終える前は既定値しか持っていない */
		this.initialized = false;
		this.active = false;

		/** isIntact の判定対象。グリッドを差し込んだフィードのコンテナ */
		this.feedContainer = null;
		/** .ext-feed-hidden を付ける対象。findFeedParts() が返す feed そのもの */
		this.feedElement = null;

		/** 早期 return の判定に使う直近の値 */
		this.lastUrl = null;
		this.lastEnabled = null;
		this.lastTabIndex = null;
		/**
		 * 前回評価したときの currentTabs (page.js) の参照。タブ列の確定・
		 * リセットのたびに配列の実体が変わるため、参照比較 1 回で
		 * 「確定前に評価した回」を見分けられる。URL・タブ index・設定が変わらなくても
		 * 確定で view が OTHER → MEDIA に変わるので、比較に含めないと
		 * 確定前にメディアタブを押した場合に起動しない
		 */
		this.lastTabs = null;

		/** 起動条件を満たすがセルが未描画で起動できていない状態。このときだけ早期 return を外す */
		this.pendingEnable = false;

		/** 蓄積を捨てる判断に使う。対象アカウントが変わったときだけクリアする */
		this.lastActor = null;

		/** グリッドがスクロールできるようになるまでに自前で読み進めた回数と、その打ち切り */
		this.bootstrapCount = 0;
		this.finished = false;

		/** 組み直しで引き継ぐページのスクロール位置。失敗した回は次の sync() まで持ち越す */
		this.pendingScrollTop = 0;

		/** body 全体の監視からの sync() を 1 フレームに 1 回へまとめるための控え */
		this.syncFramePending = false;
		/** 失敗で止まった後、retryAfterMs が過ぎたら末尾判定をやり直すタイマーの id */
		this.failedRetryTimerId = null;

		this.fetcher.onBatchEnd = () => this.handleBatchEnd();
		this.grid.onNearEnd = () => this.handleNearEnd();
		this.grid.onLoadMore = () => this.handleLoadMore();
		// 解除できるよう参照を保持する (disable() では解除しない。handleHarvest() 側で active を確認する)
		this.onHarvest = () => this.handleHarvest();
		this.store.subscribe(this.onHarvest);
	}

	/**
	 * グリッドとマウント先が生きているか。
	 * isConnected の参照のみ。document.body 全体の監視から高頻度で呼ばれるため、重い処理は足さない。
	 * @returns {boolean}
	 */
	get isIntact() {
		return this.grid.isMounted && this.feedContainer?.isConnected === true;
	}

	/**
	 * 保存済みの設定を読み込み、変更の監視を始める。
	 * 読み込みに失敗しても initialized を立てて既定値で動き出す (ここを通さないと永久に起動しない)。
	 * @returns {Promise<void>}
	 */
	async init() {
		const cfg = this.config;
		const defaults = {
			[cfg.storageKey]: cfg.defaultEnabled,
			[cfg.unblur.storageKey]: cfg.unblur.defaultEnabled
		};
		try {
			const values = await loadSyncSettings(defaults, SETTINGS_LABEL);
			this.enabled = values[cfg.storageKey];
			this.grid.setUnblur(values[cfg.unblur.storageKey]);
			// ポップアップでの変更をリロードなしで反映する
			watchSyncSettings(defaults, (changed) => {
				// ぼかし解除はクラスの付け外しだけで済み、グリッドの組み直しは要らない
				if (cfg.unblur.storageKey in changed) {
					this.grid.setUnblur(changed[cfg.unblur.storageKey]);
				}
				if (cfg.storageKey in changed) {
					this.enabled = changed[cfg.storageKey];
					this.sync();
				}
			}, SETTINGS_LABEL);
		} catch (error) {
			console.error('[XViewer] メディアグリッドの設定の反映に失敗しました', error);
		}
		this.initialized = true;
		this.sync();
	}

	/**
	 * 次のフレームで sync() を 1 回だけ呼ぶ。document.body 全体の監視は変化のまとまりごとに
	 * 発火し、そのたびに sync() の先頭でタブバーを走査することになるため、ここでまとめる。
	 * @returns {void}
	 */
	scheduleSync() {
		if (this.syncFramePending) {
			return;
		}
		this.syncFramePending = true;
		requestAnimationFrame(() => {
			this.syncFramePending = false;
			this.sync();
		});
	}

	/**
	 * 現在のページ・タブと設定に応じて、グリッドの起動・停止を合わせる。
	 * document.body 全体の監視から極めて高頻度で呼ばれるため、早期 return が多い。
	 * 順序は入れ替えない。
	 * @returns {void}
	 */
	sync() {
		if (!this.initialized) {
			return;
		}
		if (!this.enabled && !this.active) {
			return;
		}
		const tabIndex = getSelectedTabIndex();
		if (this.active && this.enabled && this.isIntact
			&& location.href === this.lastUrl && tabIndex === this.lastTabIndex
			&& currentTabs === this.lastTabs) {
			return;
		}
		if (!this.active && !this.pendingEnable
			&& this.enabled === this.lastEnabled
			&& location.href === this.lastUrl && tabIndex === this.lastTabIndex
			&& currentTabs === this.lastTabs) {
			return;
		}
		try {
			// 起動中のグリッドをライトボックス表示中に畳むと、グリッドも
			// スクロール位置も失われ、閉じても戻ってこない。
			// 守るものが無い (active でない) ときは保護そのものが不要で、
			// むしろ起動を阻むだけなので条件に this.active を入れる。
			// 判定は必ず DOM の実体 (isLightboxVisible) で行う。履歴フラグは
			// 分離ワールドで古い値のまま残り、いったん立つと二度と下りない
			// (2.3.0 で実機確認した。論理和に含めていたためグリッドが二度と起動しなくなった)
			if (this.active && isLightboxVisible()) {
				// last* を記録せずに抜ける。ここで記録すると「判定済み」として
				// 早期 return の対象になり、ライトボックスを閉じた後も
				// URL とタブ index が変わらない限り二度と再評価されない。
				// Bluesky のプロフィールはタブを切り替えても URL が変わらないため
				// (実測)、記録してしまうと復帰の機会が丸ごと失われる
				ExtDebug.log('sync 中断', {理由: 'ライトボックス表示中', tabIndex});
				return;
			}

			this.lastUrl = location.href;
			this.lastEnabled = this.enabled;
			this.lastTabIndex = tabIndex;
			this.lastTabs = currentTabs;

			// タブ index は上で求めた値を渡し、document 全体のタブ走査を 2 回しない
			const pageInfo = getPageInfo(tabIndex);
			// ページ情報が取れない場所 (プロフィール以外) では蓄積を捨てない。
			// 対象アカウントが変わったときだけクリアする
			if (pageInfo && pageInfo.actor !== this.lastActor) {
				this.lastActor = pageInfo.actor;
				if (this.active) {
					this.disable();
				}
				this.store.clear();
				this.fetcher.setActor(pageInfo.actor);
			}

			const shouldRun = this.enabled && !!pageInfo && pageInfo.view === EXT_VIEWS.MEDIA;
			if (!shouldRun) {
				this.pendingEnable = false;
				if (this.active) {
					this.disable();
				}
				this.publishDebugState('対象外', pageInfo, tabIndex);
				return;
			}

			// フィードは Bluesky 側の差し替えでグリッドごと消えることがある。
			// active のままだと組み直せないので、切れていたら一度畳む。
			// スクロール位置はこの直後の enable() が入れ直すため、ここでは戻さない
			let remount = false;
			if (this.active && !this.isIntact) {
				this.pendingScrollTop = this.grid.getScrollTop();
				this.disable(false);
				remount = true;
			}
			// 起動条件を満たすがセルが未描画の場合、enable() は何もせず次の呼び出しで再試行される
			if (!this.active) {
				this.enable(remount);
			}
			// 起動できたところで入れ直す。失敗した回は持ち越して次の sync() で戻す
			if (this.active && this.pendingScrollTop > 0) {
				this.grid.setScrollTop(this.pendingScrollTop);
				this.pendingScrollTop = 0;
			}
			this.pendingEnable = !this.active;
			this.publishDebugState(this.active ? '起動中' : 'マウント先待ち', pageInfo, tabIndex);
		} catch (error) {
			console.error('[XViewer] グリッドの状態同期に失敗しました', error);
			this.pendingEnable = false;
			// 握り潰すとフィードが隠れたまま復帰できなくなるため、必ず撤去を試みる
			try {
				this.disable();
			} catch (disableError) {
				console.error('[XViewer] グリッドの撤去に失敗しました', disableError);
			}
		}
	}

	/**
	 * デバッグモードのときだけ、現在の内部状態を書き出す。
	 * sync() から高頻度で呼ばれるため、無効時に値を組み立てないよう
	 * 先頭で打ち切る (ExtDebug 側にも同じ判定はあるが、ここで抜けないと
	 * 引数のオブジェクトを毎回作ることになる)。
	 * @param {string} reason この回の sync() がどう判断したか
	 * @param {PageInfo|null} pageInfo 現在のページ情報
	 * @param {number} tabIndex 選択中タブの index
	 * @returns {void}
	 */
	publishDebugState(reason, pageInfo, tabIndex) {
		if (!ExtDebug.enabled) {
			return;
		}
		ExtDebug.publishState({
			判断: reason,
			起動中: this.active,
			設定: this.enabled,
			起動待ち: this.pendingEnable,
			タブ: tabIndex,
			画面: (pageInfo && pageInfo.view) || null,
			対象: (pageInfo && pageInfo.actor) || null,
			蓄積: this.store.size,
			中身0件の連続: this.fetcher.emptyPageStreak,
			ライトボックス実体: isLightboxVisible(),
			ライトボックス履歴フラグ: isLightboxStatePushed()
		});
	}

	/**
	 * グリッドを起動する。
	 * @param {boolean} isRemount 組み直しか (総量の歯止め (bootstrapCount / finished) を引き継ぐ)
	 * @returns {void}
	 */
	enable(isRemount) {
		const parts = findFeedParts();
		if (!parts) {
			// マウント先がまだ描画されていない。次の sync() で再試行される
			ExtDebug.log('起動見送り', {理由: 'マウント先が未描画'});
			return;
		}
		this.feedContainer = parts.container;
		this.feedElement = parts.feed;
		// 組み直しの途中で失敗しても、持ち越しているスクロール位置は捨てない
		// (次の sync() で組み直しをやり直したときに戻すため)
		if (!this.grid.mount(parts.container)) {
			this.disable(!isRemount);
			return;
		}
		// mount() の戻り値は DOM に置けたことしか保証しない
		if (!document.getElementById(this.config.containerId)) {
			this.disable(!isRemount);
			return;
		}
		// 起動が確実になってから初めてフィードを隠す
		this.feedElement.classList.add(this.config.hiddenFeedClass);

		if (!isRemount) {
			this.bootstrapCount = 0;
			this.finished = false;
		}
		this.active = true;
		ExtDebug.log('起動', {組み直し: isRemount === true, 蓄積: this.store.size});
		this.renderNew();
		this.updateStatus();
		// 初期状態ではグリッドがスクロールできず scroll が発生しないため、ここで 1 回キックする
		this.grid.checkNearEnd();
	}

	/**
	 * グリッドを撤去して Bluesky 本来の表示に戻す。
	 * @param {boolean} [restoreScroll=true] pendingScrollTop も捨てるか (組み直しでは false)
	 * @returns {void}
	 */
	disable(restoreScroll = true) {
		ExtDebug.log('撤去', {スクロール位置を捨てる: restoreScroll});
		this.grid.unmount();
		// 参照が差し替わっていても取りこぼさないよう総ざらいする
		document.querySelectorAll('.' + this.config.hiddenFeedClass).forEach((element) => {
			element.classList.remove(this.config.hiddenFeedClass);
		});
		this.feedContainer = null;
		this.feedElement = null;
		this.active = false;
		if (restoreScroll) {
			this.pendingScrollTop = 0;
		}
		this.updateStatus();
	}

	/**
	 * 蓄積のうち、まだ描画に回していない分だけをグリッドへ渡す。
	 * @returns {void}
	 */
	renderNew() {
		this.grid.render(this.store.getFrom(this.grid.renderedCount));
	}

	/**
	 * 蓄積と取得の状態に応じて表示を差し替える。
	 * @returns {void}
	 */
	updateStatus() {
		const status = gridStatus({
			size: this.store.size,
			failed: this.fetcher.failed,
			exhausted: this.fetcher.exhausted,
			finished: this.finished,
			stalled: this.fetcher.stalled
		}, this.config.text);
		this.grid.setStatus(status.text, status.loadMore);
	}

	/**
	 * 蓄積が増えたときの処理。描画と表示更新のみ。
	 * 購読は initMediaGrid() で 1 度だけ張られ disable() では解除されないため、
	 * 取得が飛行中にメディアタブから離脱すると撤去後のグリッドに描画が走りうる。
	 * それを防ぐため、先頭で active を確認して抜ける。
	 * @returns {void}
	 */
	handleHarvest() {
		if (!this.active) {
			return;
		}
		this.renderNew();
		this.updateStatus();
	}

	/**
	 * グリッドが末尾に近づいたときの処理。
	 * @returns {void}
	 */
	handleNearEnd() {
		if (this.finished || this.fetcher.stalled) {
			this.updateStatus();
			return;
		}
		// canRetry() は再試行を許可するとき副作用として failed を戻す
		if (this.fetcher.failed && !this.fetcher.canRetry()) {
			this.updateStatus();
			this.scheduleFailedRetry();
			return;
		}
		if (this.fetcher.exhausted) {
			this.updateStatus();
			return;
		}
		this.fetcher.fetchNext();
	}

	/**
	 * 「さらに読み込む」の押下。中身 0 件の連続を数え直し、間隔を守って次の 1 ページを取る。
	 * @returns {void}
	 */
	handleLoadMore() {
		if (!this.active || !this.fetcher.stalled) {
			return;
		}
		this.fetcher.resumeAfterEmptyPages();
		this.updateStatus();
		window.setTimeout(() => {
			if (this.active) {
				this.fetcher.fetchNext();
			}
		}, this.fetcher.cooldownRemainingMs);
	}

	/**
	 * 1 回の取得が終わったときの処理。グリッドが埋まるまでは自動で読み進める。
	 * @returns {void}
	 */
	handleBatchEnd() {
		ExtDebug.log('取得の 1 回が終了', {
			蓄積: this.store.size,
			打ち切り: this.fetcher.exhausted,
			失敗: this.fetcher.failed,
			中身0件の連続: this.fetcher.emptyPageStreak,
			自前で読み進めた回数: this.bootstrapCount
		});
		this.updateStatus();
		if (this.fetcher.exhausted || this.finished) {
			return;
		}
		if (this.fetcher.failed) {
			this.scheduleFailedRetry();
			return;
		}
		// 中身 0 件のページが続いた。「さらに読み込む」が押されるまで自動では進めない
		if (this.fetcher.stalled) {
			return;
		}
		// まだ 1 件も取れていない = 対象アカウントの 1 ページ目が入っていない。
		// enable() が撃った checkNearEnd() は running やクールダウンで弾かれることがあり、
		// 弾かれると呼び直す者がいないまま「読み込み中...」で永久に固まる。
		// 打ち切りは MediaFetcher 側 (maxConsecutiveErrors・emptyPageLimit) が持つ
		if (this.store.size === 0) {
			this.scheduleRetry();
			return;
		}
		// ページ全体がスクロールできるようになったら、以降はユーザーのスクロールに任せる
		if (this.grid.isScrollable) {
			return;
		}
		this.bootstrapCount += 1;
		if (this.bootstrapCount > this.config.api.bootstrapLimit) {
			this.finished = true;
			this.updateStatus();
			return;
		}
		this.scheduleRetry();
	}

	/**
	 * クールダウンの残り時間を待ってから末尾判定をやり直す。
	 * 要求間隔を cooldownMs に保つため、即座に呼び直さない。
	 * @returns {void}
	 */
	scheduleRetry() {
		window.setTimeout(() => {
			if (this.active) {
				this.grid.checkNearEnd();
			}
		}, this.fetcher.cooldownRemainingMs);
	}

	/**
	 * 失敗で止まった後、retryAfterMs が過ぎたところで 1 回だけ末尾判定をやり直す。
	 * グリッドが短くスクロールできないと scroll が起きず、再試行の機会が来ないため。
	 * canRetry() と同じ時刻を待つだけで、要求の間隔は縮めない。予約済みなら何もしない。
	 * @returns {void}
	 */
	scheduleFailedRetry() {
		if (this.failedRetryTimerId !== null) {
			return;
		}
		this.failedRetryTimerId = window.setTimeout(() => {
			this.failedRetryTimerId = null;
			if (!this.active || !this.fetcher.failed) {
				return;
			}
			// タイマーの誤差で早く起きたら、残りを待ち直す
			if (this.fetcher.retryRemainingMs > 0) {
				this.scheduleFailedRetry();
				return;
			}
			this.grid.checkNearEnd();
		}, this.fetcher.retryRemainingMs);
	}
}

/**
 * メディアグリッドの制御層インスタンス。initMediaGrid() が 1 度だけ作る
 * @type {MediaGridController|null}
 */
let mediaGridController = null;

/**
 * 拡張機能のメディアグリッド機能のエントリポイント。
 * MediaGridController を起動し、SPA 遷移・セルの遅延描画・タブ切替のいずれからも
 * sync() が呼ばれるようにする。起動は content/main.js が page.js の main() の後に呼ぶ。
 * @returns {Promise<void>} 設定の読み込みが終わったら解決する
 */
export function initMediaGrid() {
	try {
		mediaGridController = new MediaGridController();
		// タブ列の確定・選択タブの変化 (page.js の TabObserver) に追従する
		subscribeTabStateChange(() => mediaGridController.sync());
		const ready = mediaGridController.init();

		// SPA 遷移とセルの遅延描画の双方に追従する。発火は 1 フレームに 1 回へまとめる
		const observer = new MutationObserver(() => mediaGridController.scheduleSync());
		observer.observe(document.body, {childList: true, subtree: true});

		window.addEventListener('popstate', () => mediaGridController.sync());
		return ready;
	} catch (error) {
		console.error('[XViewer] メディアグリッドの初期化に失敗しました', error);
		return Promise.resolve();
	}
}
