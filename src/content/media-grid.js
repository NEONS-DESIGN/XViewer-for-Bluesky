/**
 * サムネイル格子の描画層。
 * 取得 (MediaFetcher) も蓄積 (MediaStore) も起動判断も知らず、
 * 渡された MediaEntry の配列を並べることだけを行う。
 */
import {EXT_VIEWS, EXT_CONFIG} from '../common/config.js';
import {ExtDebug} from '../common/debug.js';
import {callBridge} from './bridge-client.js';
import {
	currentTabs, getPageInfo, getSelectedTabIndex, isLightboxVisible, isLightboxStatePushed,
	subscribeTabStateChange
} from './page.js';
import {shouldBlur, MediaStore, MediaFetcher} from './media-source.js';

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
		console.error('[Bluesky拡張] マウント先の探索に失敗しました', error);
		return null;
	}
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
		/** 何件描画済みか。render() の差分描画に使う */
		this.renderedCount = 0;
		/** window の scroll イベントで控える window.scrollY。isMounted の時点で読み直さない */
		this.lastScrollTop = 0;
		/** 末尾に近づいたときに Controller が差し込むコールバック */
		this.onNearEnd = null;
		/** NSFW のぼかしを解除するか。Controller が設定を読んで setUnblur() で渡す */
		this.unblurEnabled = EXT_CONFIG.mediaGrid.unblur.defaultEnabled;
		/** removeEventListener で使い回すための束縛済みハンドラ */
		this.boundHandleScroll = () => this.handleScroll();
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

			const statusEl = document.createElement('div');
			statusEl.id = config.statusId;

			containerEl.appendChild(listEl);
			containerEl.appendChild(statusEl);
			container.prepend(containerEl);

			this.containerEl = containerEl;
			this.listEl = listEl;
			this.statusEl = statusEl;
			this.renderedCount = 0;
			this.lastScrollTop = window.scrollY;
			// 要素を作り直したので、現在のぼかし解除設定を入れ直す
			this.applyUnblur();

			window.addEventListener('scroll', this.boundHandleScroll, {passive: true});
			return true;
		} catch (error) {
			console.error('[Bluesky拡張] グリッドのマウントに失敗しました', error);
			return false;
		}
	}

	/** 購読を外して要素を除去し、内部状態を初期化する。 */
	unmount() {
		try {
			window.removeEventListener('scroll', this.boundHandleScroll);
			if (this.containerEl && this.containerEl.parentElement) {
				this.containerEl.remove();
			}
		} catch (error) {
			console.error('[Bluesky拡張] グリッドの解除に失敗しました', error);
		} finally {
			this.containerEl = null;
			this.listEl = null;
			this.statusEl = null;
			this.renderedCount = 0;
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
			console.error('[Bluesky拡張] ぼかし解除の反映に失敗しました', error);
		}
	}

	/**
	 * scroll のたびに、スクロール位置の控えを更新して末尾判定を行う。
	 */
	handleScroll() {
		this.lastScrollTop = window.scrollY;
		this.checkNearEnd();
	}

	/**
	 * renderedCount からの差分だけを描く。
	 * 1 件の描画に失敗しても renderedCount は進める
	 * (据え置くと以後の描画が毎回同じ件で止まるため)。
	 * 状態表示 (読み込み中 / すべて読み込みました など) はここでは扱わない。
	 * @param {MediaEntry[]} entries
	 */
	render(entries) {
		if (!this.isMounted || !Array.isArray(entries)) {
			return;
		}
		// 組み直しでは蓄積全件 (数百枚) を一度に描くため、接続済みの listEl へ
		// 1 個ずつ足さず、fragment にまとめて 1 回で入れる
		const fragment = document.createDocumentFragment();
		for (let i = this.renderedCount; i < entries.length; i += 1) {
			try {
				fragment.appendChild(this.createTile(entries[i]));
			} catch (error) {
				console.error('[Bluesky拡張] タイルの描画に失敗しました', error);
			} finally {
				this.renderedCount += 1;
			}
		}
		this.listEl.appendChild(fragment);
	}

	/**
	 * 1 件ぶんのタイルを組み立てる。
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
		// 読み込めない画像はタイルごと除去する (代替表示は持たない)
		img.addEventListener('error', () => {
			tile.remove();
		});
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
			const matched = entry.labels.filter((value) => config.blurLabels.includes(value));
			// マップに無いラベル値 (ラベラーが独自追加したもの) は生の値のまま出す。空表示にはしない
			label.textContent = matched
				.map((value) => (config.blurLabelNames && config.blurLabelNames[value]) || value)
				.join('・');
			tile.appendChild(label);
		}

		tile.addEventListener('click', (event) => this.handleTileClick(event, entry, tile));
		return tile;
	}

	/**
	 * 複数枚の投稿であることを示すアイコンを生成する。
	 * 旧 X の複数枚アイコンは現存しないため、重なった 2 枚の四角形で近似する
	 * (姉妹プロジェクト X-Custom-Extension-API の photo-grid.js の考え方を借りた)。
	 * @returns {SVGSVGElement}
	 */
	createMultiBadge() {
		const config = EXT_CONFIG.mediaGrid;
		const ns = 'http://www.w3.org/2000/svg';
		const svg = document.createElementNS(ns, 'svg');
		svg.setAttribute('viewBox', '0 0 24 24');
		svg.setAttribute('aria-hidden', 'true');
		svg.classList.add(config.badgeClass);
		const path = document.createElementNS(ns, 'path');
		path.setAttribute('d', 'M7 3h11a3 3 0 0 1 3 3v11h-2V6a1 1 0 0 0-1-1H7V3zm-1 4h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z');
		svg.appendChild(path);
		return svg;
	}

	/**
	 * タイルの押下。画像はライトボックス、動画は投稿ページへ SPA 遷移する。
	 * ぼかし中は解除するだけで、2 回目の押下で初めて開く。
	 *
	 * 動画タイルは a の既定動作 (フルリロード) に任せていたが、実機で確認したところ
	 * 拡張機能が作った a 要素は Bluesky のルーター (React Navigation) の管理外で、
	 * フルリロードになることが判明した。
	 * そのため bridge の navigate アクションでルーターの push を直接呼ぶ。
	 * @param {MouseEvent} event
	 * @param {MediaEntry} entry
	 * @param {HTMLElement} tile
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
			if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) {
				return;
			}
			// a の href は失敗時の行き先として張ったままにしておき、既定動作だけ止める
			event.preventDefault();

			if (entry.type !== 'image') {
				this.navigateToPost(entry);
				return;
			}
			callBridge(config.bridge.actions.openLightbox, {
				images: entry.siblings,
				// 1 投稿 1 タイルのため、開くのは常に先頭画像から
				index: 0,
				/*
				 * 本体が自分でライトボックスを開くときと同じ形の metricsContext を
				 * 添える。これが入っていると投稿情報パネル (lightbox-panel.js) が
				 * postUri を読めるようになり、パネル側は「グリッド由来かどうか」を
				 * 知らずに済む (設計文書 3 節)
				 */
				metricsContext: {
					postUri: entry.postUri,
					// authorDid は欠けうる付加情報。無ければ本体と同じ「省略」の形に揃える
					postAuthorDid: entry.authorDid || undefined,
					layout: config.bridge.lightboxLayout
				}
			}).then((result) => {
				if (!result || !result.ok) {
					// ライトボックスが開けなければ SPA 遷移を試し、それも駄目なら通常遷移に落ちる
					this.navigateToPost(entry);
				}
			}).catch((error) => {
				console.error('[Bluesky拡張] ライトボックスの呼び出しに失敗しました', error);
				this.navigateToPost(entry);
			});
		} catch (error) {
			console.error('[Bluesky拡張] タイル押下の処理に失敗しました', error);
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
	 */
	navigateToPost(entry) {
		try {
			const config = EXT_CONFIG.mediaGrid;
			callBridge(config.bridge.actions.navigate, {
				route: config.bridge.routes.post,
				params: {name: entry.authorHandle, rkey: entry.postId}
			}).then((result) => {
				if (!result || !result.ok) {
					window.location.href = entry.postHref;
				}
			}).catch((error) => {
				console.error('[Bluesky拡張] 投稿ページへの SPA 遷移に失敗しました', error);
				window.location.href = entry.postHref;
			});
		} catch (error) {
			console.error('[Bluesky拡張] 投稿ページへの遷移処理に失敗しました', error);
			if (entry && entry.postHref) {
				window.location.href = entry.postHref;
			}
		}
	}

	/**
	 * 状態表示の文言を差し替える。
	 * @param {string} text
	 */
	setStatus(text) {
		if (this.statusEl) {
			this.statusEl.textContent = text;
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
	 */
	setScrollTop(top) {
		try {
			window.scrollTo(0, top);
		} catch (error) {
			console.error('[Bluesky拡張] スクロール位置の復元に失敗しました', error);
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
	 */
	checkNearEnd() {
		try {
			const remaining = document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
			if (remaining <= EXT_CONFIG.mediaGrid.api.nearEndPx && typeof this.onNearEnd === 'function') {
				this.onNearEnd();
			}
		} catch (error) {
			console.error('[Bluesky拡張] 末尾判定に失敗しました', error);
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

		this.fetcher.onBatchEnd = () => this.handleBatchEnd();
		this.grid.onNearEnd = () => this.handleNearEnd();
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
		try {
			const stored = await chrome.storage.sync.get([cfg.storageKey, cfg.unblur.storageKey]);
			this.enabled = stored[cfg.storageKey] ?? cfg.defaultEnabled;
			this.grid.setUnblur(stored[cfg.unblur.storageKey] ?? cfg.unblur.defaultEnabled);
		} catch (error) {
			console.error('[Bluesky拡張] 設定の読み込みに失敗しました', error);
		}
		try {
			// ポップアップでの変更をリロードなしで反映する
			chrome.storage.onChanged.addListener((changes, area) => {
				if (area !== 'sync') {
					return;
				}
				// ぼかし解除はクラスの付け外しだけで済み、グリッドの組み直しは要らない
				if (changes[cfg.unblur.storageKey]) {
					this.grid.setUnblur(
						changes[cfg.unblur.storageKey].newValue ?? cfg.unblur.defaultEnabled
					);
				}
				if (!changes[cfg.storageKey]) {
					return;
				}
				this.enabled = changes[cfg.storageKey].newValue ?? cfg.defaultEnabled;
				this.sync();
			});
		} catch (error) {
			console.error('[Bluesky拡張] 設定変更の監視開始に失敗しました', error);
		}
		this.initialized = true;
		this.sync();
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
			// (2.3.0 で実機確認した Critical。page.js の
			// isLightboxStatePushed のコメントを参照)
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
			console.error('[Bluesky拡張] グリッドの状態同期に失敗しました', error);
			this.pendingEnable = false;
			// 握り潰すとフィードが隠れたまま復帰できなくなるため、必ず撤去を試みる
			try {
				this.disable();
			} catch (disableError) {
				console.error('[Bluesky拡張] グリッドの撤去に失敗しました', disableError);
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
		this.grid.render(this.store.getAll());
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
	 * 蓄積の状態に応じて表示を差し替える。
	 * @returns {void}
	 */
	updateStatus() {
		const cfg = this.config;
		if (this.store.size === 0) {
			if (this.fetcher.failed) {
				this.grid.setStatus(cfg.text.error);
				return;
			}
			if (this.fetcher.exhausted) {
				this.grid.setStatus(cfg.text.empty);
				return;
			}
			this.grid.setStatus(cfg.text.loading);
			return;
		}
		if (this.finished || this.fetcher.exhausted) {
			this.grid.setStatus(cfg.text.end);
			return;
		}
		if (this.fetcher.failed) {
			this.grid.setStatus(cfg.text.error);
			return;
		}
		this.grid.setStatus(cfg.text.loading);
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
		this.grid.render(this.store.getAll());
		this.updateStatus();
	}

	/**
	 * グリッドが末尾に近づいたときの処理。
	 * @returns {void}
	 */
	handleNearEnd() {
		if (this.finished) {
			this.updateStatus();
			return;
		}
		// canRetry() は再試行を許可するとき副作用として failed を戻す
		if (this.fetcher.failed && !this.fetcher.canRetry()) {
			this.updateStatus();
			return;
		}
		if (this.fetcher.exhausted) {
			this.updateStatus();
			return;
		}
		this.fetcher.fetchNext();
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
			自前で読み進めた回数: this.bootstrapCount
		});
		this.updateStatus();
		if (this.fetcher.exhausted || this.fetcher.failed || this.finished) {
			return;
		}
		// まだ 1 件も取れていない = 対象アカウントの 1 ページ目が入っていない。
		// enable() が撃った checkNearEnd() は running やクールダウンで弾かれることがあり、
		// 弾かれると呼び直す者がいないまま「読み込み中...」で永久に固まる。
		// 打ち切りは MediaFetcher 側 (maxConsecutiveErrors) が持つので、ここでは無制限に見えてよい
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
 * @returns {void}
 */
export function initMediaGrid() {
	try {
		mediaGridController = new MediaGridController();
		// タブ列の確定・選択タブの変化 (page.js の TabObserver) に追従する
		subscribeTabStateChange(() => mediaGridController.sync());
		mediaGridController.init();

		// SPA 遷移とセルの遅延描画の双方に追従する
		const observer = new MutationObserver(() => mediaGridController.sync());
		observer.observe(document.body, {childList: true, subtree: true});

		window.addEventListener('popstate', () => mediaGridController.sync());
	} catch (error) {
		console.error('[Bluesky拡張] メディアグリッドの初期化に失敗しました', error);
	}
}
