import {BRIDGE_PROTOCOL} from './bridge-protocol.js';

/**
 * ページ種別。Bluesky のプロフィールタブに対応する。
 * @readonly
 */
export const EXT_VIEWS = {
	POSTS: 'posts',
	MEDIA: 'media',
	VIDEOS: 'videos',
	OTHER: 'other'
};

/**
 * 複数の設定から参照する共通の値。**同じリテラルを 2 か所に書かない**
 * (片方だけ変える事故を防ぐ)
 * @readonly
 */
export const EXT_SHARED = {
	/** 公開 API のオリジン。getAuthorFeed / getProfile / getPosts のフォールバックで使う */
	publicApiOrigin: 'https://public.api.bsky.app',
	/**
	 * 画像ライトボックスのダイアログを指すセレクタ。投稿情報パネルと操作性の調整が
	 * 同じ相手 (その parentElement) に触るため、値も 1 つにする。要素タイプは書かない
	 */
	lightboxDialogSelector: '[role="dialog"][aria-modal="true"]',
	/** タブ要素の data-testid の接頭辞。page-bridge.js と共有する (BRIDGE_PROTOCOL) */
	tabTestIdPrefix: BRIDGE_PROTOCOL.tabTestIdPrefix
};

export const EXT_CONFIG = {
	/** プロフィールページのパス 1 段目 */
	profilePathRoot: 'profile',

	/**
	 * Bluesky 本体 (social-app の src/view/screens/Profile.tsx) と同じ順序・条件でタブ列を組む。
	 * 順序は固定だが、どのタブが存在するかはアカウントによって変わる。
	 * ここを実測なしに書き換えない (設計文書 2.5)。
	 */
	profileTabs: [
		{name: 'labels', when: (c) => c.hasLabeler},
		{name: 'listsForLabeler', when: (c) => c.showLists && c.hasLabeler},
		{name: 'posts', when: () => true, view: EXT_VIEWS.POSTS},
		{name: 'replies', when: (c) => c.hasSession},
		{name: 'media', when: (c) => !c.hasLabeler, view: EXT_VIEWS.MEDIA},
		{name: 'videos', when: (c) => !c.hasLabeler, view: EXT_VIEWS.VIDEOS},
		{name: 'likes', when: (c) => c.isMe},
		{name: 'feeds', when: (c) => c.isMe || c.feedGenCount > 0},
		{name: 'starterPacks', when: (c) => c.isMe || c.starterPackCount > 0},
		{name: 'lists', when: (c) => c.showLists && !c.hasLabeler}
	],

	selectors: {
		pager: '[data-testid="profilePager"]',
		tabPrefix: EXT_SHARED.tabTestIdPrefix,
		tab: `[data-testid^="${EXT_SHARED.tabTestIdPrefix}"]`,
		/**
		 * 選択中タブだけが持つ下線バーのセレクタ。
		 * 実機確認済み:
		 * 選択中タブだけが、インラインスタイルで背景色を持つ下線バーの子要素を
		 * 1 件持つ。非選択タブは 0 件。React Native Web の生成クラス
		 * (.r-1p0dtai 等) は全タブが持つため使えない
		 */
		tabUnderline: '[style*="background-color"]',
		feed: '[data-testid="postsFeed"]',
		/**
		 * 左ナビのプロフィールリンク。実機確認済み:
		 * 単純な a[href^="/profile/"] だとプロフィール本文中のリンク
		 * (フォロワー数・おすすめアカウント等) にも大量にヒットするため、
		 * nav[role="navigation"] 配下に絞り込む (ページ内に一意で、
		 * その中の /profile/ リンクはちょうど 1 件 = 自分のプロフィール)
		 */
		sideNavProfileLink: 'nav[role="navigation"] a[href^="/profile/"]',
		/**
		 * 左ナビ (sideNavProfileLink の絞り込み元と同じ nav) 自体のセレクタ。
		 * DOM の描画が済んだかどうかの判定 (isDomReadyForTabResolution, page.js)
		 * に使う。プロフィールリンクの有無だけで判定すると、未ログインで
		 * 恒久的にリンクが存在しないケースと、単にまだ描画されていない
		 * ケースを区別できないため、コンテナ自体の有無を見る
		 */
		sideNav: 'nav[role="navigation"]'
	},

	/**
	 * Bluesky 本体の画像ライトボックス (モーダル) の扱い (page.js)。
	 * **開閉の判定は DOM 上の実体 (isLightboxVisible) だけで行う。**
	 * history.state のフラグは分離ワールドから見ると古い値のまま残り、
	 * いったん立つと下りないため判定に混ぜない (2.3.0 で実機確認した Critical。
	 * 2026-09-08 以降は本体がフラグ自体を立てなくなった)
	 */
	lightbox: {
		/**
		 * ライトボックス (モーダル) の実体を DOM から探すセレクタ。
		 * Bluesky 本体のモーダルはアクセシビリティ属性を持つ前提で拾う。
		 * 画像ライトボックス以外のモーダル (投稿作成など) にも一致するが、
		 * モーダル表示中にナビボタンを隠すのは意図した挙動なので問題ない
		 */
		selector: '[role="dialog"], [aria-modal="true"]',
		/**
		 * 投稿作成モーダルを見分けるセレクタ。
		 * **ライトボックスと投稿作成モーダルは同時に開くことがある**
		 * (2026-09-09 実測。ダイアログが 2 枚になり、素の querySelector は
		 * 投稿作成モーダルの方を掴む)。**言語非依存の data-testid を使う。**
		 * ダイアログ自身の aria-label は「画像ビューアー」のようにロケールで変わる
		 */
		composerSelector: '[data-testid="composePostView"]',
		/**
		 * ライトボックス表示中に、ナビボタンの表示判定をやり直す間隔 (ms)。
		 * どの閉じ方 (Escape / 閉じるボタン / ブラウザバック / 背景クリック) でも
		 * 確実にボタンを復帰させるための最後の受け皿。閉じたと分かった時点で止める
		 */
		recheckIntervalMs: 400
	},

	/**
	 * ポップアップの保存値 (src/popup/)。
	 * 文言・設定項目の並びといったポップアップ固有の値は src/popup/sections.js の
	 * 定数側に置き、**保存キーと既定値だけ** をここに集約する
	 * (保存キーは content script 側と共有する可能性があるため)。
	 */
	popup: {
		themeStorageKey: 'popupTheme',
		/**
		 * 配色の既定は「OS に従う」。右上のボタンを押すと、その時の配色の反対
		 * (dark / light) を保存する。保存値が themes に無ければここへ倒す
		 */
		defaultTheme: 'system',
		/** 保存してよい配色の値 */
		themes: {system: 'system', dark: 'dark', light: 'light'}
	},

	/**
	 * デバッグモード (debug.js)。ポップアップの 3 つ目のトグルで切り替える。
	 * 既定は OFF で、OFF のあいだ ExtDebug は何もしない
	 * (sync() のような極めて高頻度のコールバックから呼ばれるため、
	 * 無効時に文字列の組み立てや JSON 化を走らせない)。
	 * 出力先は 2 つある:
	 * 1. コンソール (prefix 付き)。時系列で「何が起きたか」を追う用
	 * 2. html 要素の data 属性 (stateAttribute)。「今どうなっているか」を
	 *    DevTools の Elements や MAIN ワールドから一目で読む用。
	 *    content script は分離ワールドで動くため、内部状態を外から覗く
	 *    手段がこれしかない
	 */
	debug: {
		storageKey: 'debugEnabled',
		/** 既定は無効。利用者が明示的に有効にしたときだけ動く */
		defaultEnabled: false,
		/** コンソール出力の接頭辞。通常のエラーログと見分けるため [debug] を足す */
		prefix: '[XViewer][debug]',
		/** 内部状態を書き出す html 要素の属性名 */
		stateAttribute: 'data-bsky-ext-state'
	},

	/**
	 * タブバー (pager) の出現待ちと、タブ列の確定リトライの設定 (page.js)。
	 * 待ち方を 2 段構えにする: まず body の一時監視で描画され次第すぐ気づき、
	 * 一定時間で一時監視を畳んだ後は低頻度のポーリングだけで待ち続ける。
	 * ポーリング側に時間の上限は設けない (タブバーの描画がどれだけ遅れても
	 * 最終的に機能が起動するようにするため)
	 */
	tabResolution: {
		/** body の一時監視を続ける上限時間 (ms)。これを過ぎたら一時監視だけを畳む */
		waitObserverMaxMs: 10000,
		/** タブバーの出現を確認し直す間隔 (ms)。一時監視と併走し、時間の上限は設けない */
		pollIntervalMs: 2000,
		/** タブ列を確定できなかったときに確定を再試行する間隔 (ms)。時間の上限は設けない */
		retryIntervalMs: 2000,
		/**
		 * getProfile が一時的に失敗した (タイムアウト・回線断・5xx) ときに引き直す
		 * 間隔 (ms)。DOM 待ちより長く取り、障害中に 2 秒ごとに叩き続けない
		 */
		errorRetryIntervalMs: 15000
	},

	ui: {
		containerId: 'ext-nav-btn-container',
		columnClass: 'ext-nav-btn-column',
		buttonClass: 'ext-nav-btn',
		/**
		 * 配列順がそのまま表示順になる (上から)。
		 * 「メディアへ」と「投稿へ」を隣り合わせて最後に置くことで、投稿タブの
		 * 「メディアへ」とメディアタブの「投稿へ」が同じ段に出て、往復を同じ位置で押せる
		 */
		navButtons: [
			{id: 'ext-nav-videos', text: 'ビデオへ', view: EXT_VIEWS.VIDEOS},
			{id: 'ext-nav-media', text: 'メディアへ', view: EXT_VIEWS.MEDIA},
			{id: 'ext-nav-posts', text: '投稿へ', view: EXT_VIEWS.POSTS}
		],
		scrollTopButton: {
			id: 'ext-nav-scroll-top',
			text: 'ページ先頭へ',
			showAfterPx: 200
		}
	},

	styles: {
		hiddenClass: 'ext-hidden'
	},

	mediaGrid: {
		storageKey: 'mediaGridEnabled',
		defaultEnabled: true,
		containerId: 'ext-media-grid',
		listClass: 'ext-media-list',
		tileClass: 'ext-media-tile',
		badgeClass: 'ext-media-badge',
		videoBadgeClass: 'ext-media-video-badge',
		blurClass: 'ext-media-blur',
		blurLabelClass: 'ext-media-blur-label',
		statusId: 'ext-media-status',
		hiddenFeedClass: 'ext-feed-hidden',
		columns: 3,
		gapPx: 4,
		/**
		 * グリッドの最大幅 (px)。Bluesky は中央カラムを postsFeed 自身ではなく、
		 * その内側の要素に max-width: 600px を当てて作っている
		 * (実測: 投稿カードから祖先を辿って深さ 4 の無名 div で確認)。
		 * postsFeed 自体は画面幅いっぱいのため、その直下の親にグリッドを prepend すると
		 * 何もしなければ全幅に広がってしまう。ここで Bluesky と同じ実測値に揃える
		 */
		maxWidthPx: 600,
		maxMediaPerPost: 10,
		/**
		 * 動画をグリッドから除外するか。
		 * Bluesky にはメディアタブとは別にビデオタブがあり、動画はそちらで
		 * 一覧できるため、メディアグリッドには画像だけを並べる。
		 * false にすると従来どおり動画タイル (再生バッジ付き・押下で投稿ページへ遷移)
		 * も並ぶ。除外は取得後の解析段階で行う: public API の filter には
		 * 「画像だけ」に相当する値が無いため、posts_with_media のまま取得して落とす
		 */
		excludeVideos: true,
		blurLabels: ['porn', 'sexual', 'nudity', 'graphic-media'],
		/**
		 * NSFW ラベルによるぼかしと警告文の解除 (ポップアップの 2 つ目のトグル)。
		 * 解除してもラベルの判定 (shouldBlur) とタイルの blurClass はそのまま残し、
		 * グリッドのルート要素に containerClass を付けて CSS で打ち消すだけにする。
		 * 描画済みのタイルを作り直さずに切り替えられ、OFF に戻せば即座にぼかしが戻るため
		 */
		unblur: {
			storageKey: 'nsfwUnblurEnabled',
			/** 既定は解除しない (従来どおりぼかす) */
			defaultEnabled: false,
			containerClass: 'ext-media-unblur'
		},
		/**
		 * ぼかしタイルに重ねるラベルの日本語表示名。
		 * ラベラーは自由にラベル値を追加できるため、ここに無い値は
		 * media-grid.js 側で生の値のままフォールバック表示する
		 */
		blurLabelNames: {
			porn: 'ポルノ',
			sexual: '性的な内容',
			nudity: 'ヌード',
			'graphic-media': '生々しい表現'
		},
		text: {
			loading: '読み込み中...',
			end: 'すべて読み込みました',
			empty: 'メディアが見つかりません',
			error: '読み込めませんでした',
			videoBadge: '▶'
		},
		api: {
			origin: EXT_SHARED.publicApiOrigin,
			feedPath: '/xrpc/app.bsky.feed.getAuthorFeed',
			profilePath: '/xrpc/app.bsky.actor.getProfile',
			filter: 'posts_with_media',
			limit: 100,
			cooldownMs: 1000,
			bootstrapLimit: 3,
			maxConsecutiveErrors: 3,
			retryAfterMs: 60000,
			nearEndPx: 600,
			stopStatuses: [429],
			timeoutMs: 12000,
			embedTypes: {
				images: 'app.bsky.embed.images#view',
				gallery: 'app.bsky.embed.gallery#view',
				video: 'app.bsky.embed.video#view',
				recordWithMedia: 'app.bsky.embed.recordWithMedia#view'
			}
		},
		/**
		 * 橋渡しのイベント名・操作名・ルート名。page-bridge.js と共有する値は
		 * BRIDGE_PROTOCOL (common/bridge-protocol.js) に 1 つだけ書いてある
		 */
		bridge: {
			requestEvent: BRIDGE_PROTOCOL.requestEvent,
			resultEvent: BRIDGE_PROTOCOL.resultEvent,
			actions: BRIDGE_PROTOCOL.actions,
			/** navigate で行ける先の白名簿 (post / profile / hashtag) */
			routes: BRIDGE_PROTOCOL.routes,
			/**
			 * openLightbox に添える metricsContext の layout。
			 * 本体がフィードの単独画像を開くときと同じ値 (2026-09-09 実測)
			 */
			lightboxLayout: 'single',
			timeoutMs: 15000,
			/**
			 * upload-blob の応答を待つ上限。画像 (最大 2MB) を PDS へ送り終えるまで
			 * 待つため、ほかの操作の timeoutMs より長くとる
			 */
			uploadTimeoutMs: 60000,
			/** 動画の進み具合のイベント名。page-bridge.js と共有する (BRIDGE_PROTOCOL) */
			progressEvent: BRIDGE_PROTOCOL.progressEvent,
			/**
			 * upload-video で進み具合が止まってから打ち切るまでの待ち時間。
			 * 進み具合が届くたびに掛け直すため、全体の長さには上限がない
			 */
			videoIdleTimeoutMs: 150000
		}
	},

	/**
	 * ライトボックスに重ねる投稿情報パネル (lightbox-panel.js)。
	 * 画像を開いたとき、右側に本文・投稿日時・作者・反応数を並べる。
	 * **メディアグリッド由来かどうかを問わない。** 開いているライトボックスの
	 * activeLightbox.metricsContext.postUri を橋渡しで読み、公開 API の
	 * getPosts で投稿を引く (設計文書 3 節)
	 */
	lightboxPanel: {
		storageKey: 'lightboxPanelEnabled',
		/** 既定は有効。利用者の要望で入れた機能のため */
		defaultEnabled: true,
		collapsedStorageKey: 'lightboxPanelCollapsed',
		/** 既定は展開。畳んだ状態は利用者が選んだときだけ保つ */
		defaultCollapsed: false,
		panelId: 'ext-lightbox-panel',
		collapsedClass: 'ext-lb-collapsed',
		bodyClass: 'ext-lb-body',
		headerClass: 'ext-lb-header',
		toggleClass: 'ext-lb-toggle',
		authorClass: 'ext-lb-author',
		avatarClass: 'ext-lb-avatar',
		nameClass: 'ext-lb-name',
		handleClass: 'ext-lb-handle',
		textClass: 'ext-lb-text',
		dateClass: 'ext-lb-date',
		countsClass: 'ext-lb-counts',
		countClass: 'ext-lb-count',
		countIconClass: 'ext-lb-count-icon',
		openPostClass: 'ext-lb-open-post',
		statusClass: 'ext-lb-status',
		linkClass: 'ext-lb-link',
		/**
		 * パネルの幅 (px)。本体のダイアログの固定親に right としてそのまま当てる。
		 * 2026-09-09 の実測で、この 1 プロパティだけで画像が縦横比を保ったまま
		 * 再レイアウトされることを確認済み (設計文書 2 節)
		 */
		widthPx: 360,
		/**
		 * パネルを出す最小のウィンドウ幅 (px)。これ未満では画像が潰れるため出さない。
		 * 本体の gtMobile (minWidth: 800) に揃えてある。
		 * **本体が「モバイル幅」と見なす境界と一致させるため、独自の数値を置かない**
		 */
		minWindowWidthPx: 800,
		/** #ext-media-grid (9998) < #ext-nav-btn-container (9999) より上に置く */
		zIndex: 10000,
		/**
		 * 画像ライトボックスのダイアログを指すセレクタ。
		 * EXT_CONFIG.lightbox.selector は投稿作成などの別モーダルにも当たる
		 * 緩いものだが、こちらは right を当てる相手 (その parentElement) を
		 * 決めるため厳密に指定する
		 */
		dialogSelector: EXT_SHARED.lightboxDialogSelector,
		/** 日時と数値の表記に使うロケール */
		locale: 'ja-JP',
		/** 投稿日時の表記。本体のフィードは相対表記なので、パネルは絶対表記に徹する */
		dateFormat: {dateStyle: 'long', timeStyle: 'short'},
		/**
		 * 取得済みの投稿を保持する上限。超えたら古いものから捨てる。
		 * ページを離れれば消える (メモリのみ)
		 */
		cacheLimit: 200,
		/**
		 * 本文中のリンクとして押せるようにする URL の scheme。
		 * **facets の uri は投稿者が自由に決められる値**であり、javascript: や
		 * data: をそのまま a の href に入れると、押した利用者の bsky.app 上で
		 * スクリプトが動く (XSS)。ここに無い scheme のリンクは押せる要素にせず、
		 * ただの文字列として出す
		 */
		allowedLinkProtocols: ['http:', 'https:'],
		/**
		 * record.facets の feature の $type と、パネル側での扱いの対応表。
		 * ここに無い $type は普通の文字列として扱う (押せないだけで本文は読める)
		 */
		facets: {
			'app.bsky.richtext.facet#link': {kind: 'link', valueKey: 'uri'},
			'app.bsky.richtext.facet#mention': {kind: 'mention', valueKey: 'did'},
			'app.bsky.richtext.facet#tag': {kind: 'tag', valueKey: 'tag'}
		},
		text: {
			loading: '読み込み中...',
			error: '投稿を読み込めませんでした',
			collapse: 'パネルを畳む',
			expand: 'パネルを開く',
			openPost: '投稿を開く',
			replyCount: '返信',
			repostCount: 'リポスト',
			likeCount: 'いいね',
			quoteCount: '引用'
		},
		api: {
			origin: EXT_SHARED.publicApiOrigin,
			postsPath: '/xrpc/app.bsky.feed.getPosts',
			timeoutMs: 12000
		}
	},

	/**
	 * ライトボックスのパネルからの投稿操作 (post-actions.js / lightbox-panel.js)。
	 *
	 * **この拡張機能で唯一の書き込み機能。** 認証は本体が持つ
	 * agent.fetchHandler を橋渡しで借りるだけで、localStorage の accessJwt には
	 * 触らない。
	 */
	postActions: {
		storageKey: 'postActionsEnabled',
		/** 既定は有効。利用者の要望で入れた機能のため */
		defaultEnabled: true,
		/**
		 * 橋渡しに通す XRPC の NSID。page-bridge.js の白名簿と共有する
		 * (BRIDGE_PROTOCOL)
		 */
		nsid: BRIDGE_PROTOCOL.nsid,
		/** 書き込みを許すコレクション。page-bridge.js の白名簿と共有する */
		collections: BRIDGE_PROTOCOL.collections,
		/** open-composer が受け付けるモード。page-bridge.js と共有する */
		composerModes: BRIDGE_PROTOCOL.composerModes,
		/**
		 * 橋渡しが返す失敗理由のうち、呼び出し側が分岐に使うもの。
		 * page-bridge.js の checkXrpcRequest() が返す値と共有する
		 */
		reasons: BRIDGE_PROTOCOL.reasons,
		/**
		 * 飛行中の操作を覚えるキーの区切り。**投稿の AT URI と種別を
		 * つなぐだけの内部の値で、DOM にも通信にも出ない。**
		 * AT URI 自体が `:` を含むが、種別 (like / repost / bookmark) は
		 * 固定の 3 語のため、末尾で区切れば衝突しない
		 */
		pendingKeySeparator: ':',
		actionsClass: 'ext-lb-actions',
		actionClass: 'ext-lb-action',
		activeClass: 'ext-lb-action-on',
		actionIconClass: 'ext-lb-action-icon',
		/**
		 * 種別ごとのクラス。**色を種別で変えるためだけに使う** (2.8.0)。
		 * 反応済み (activeClass) とホバーのどちらでも同じ色を出す。
		 * 色そのものは content.css の --ext-lb-action-color が持つ。
		 * 利用者の指定で、返信 = 水色 (2.8.1)・リポスト = 緑・
		 * いいね = マゼンタ・ブックマーク = 黄。
		 * **キーは buildActions() の item.kind と同じ 4 語。片方を増やしたら両方直す**
		 */
		kindClass: {
			reply: 'ext-lb-action-reply',
			repost: 'ext-lb-action-repost',
			like: 'ext-lb-action-like',
			bookmark: 'ext-lb-action-bookmark'
		},
		menuClass: 'ext-lb-menu',
		menuItemClass: 'ext-lb-menu-item',
		errorClass: 'ext-lb-action-error',
		text: {
			reply: '返信する',
			repost: 'リポストの操作',
			repostDo: 'リポスト',
			repostUndo: 'リポストを取り消す',
			quote: '引用する',
			like: 'いいね',
			likeUndo: 'いいねを取り消す',
			bookmark: 'ブックマークに追加',
			bookmarkUndo: 'ブックマークから外す',
			failed: '操作できませんでした'
		}
	},

	/**
	 * ライトボックスのパネルの返信欄 (lightbox-replies.js)。
	 * 姉妹プロジェクト XViewer for Pixiv のサイドバーのコメント欄と同じ形で、
	 * 返信の一覧・入力欄・自分の返信の削除を出す。入力欄と削除は postActions も
	 * 有効なときだけ出す (書き込みのため)
	 */
	lightboxReplies: {
		storageKey: 'lightboxRepliesEnabled',
		/** 既定は有効。利用者の要望で入れた機能のため */
		defaultEnabled: true,
		/** 一覧と開いた返信の中で、1 回に出す件数 (「もっと見る」で増やす) */
		pageSize: 20,
		/**
		 * getPostThread の depth。1 段目はこの投稿への直接の返信だけを読む
		 * (2 段目まで読むと大きな投稿で 1 件の下に数十件が付き、応答が重い。
		 * 2026-10-18 実測)。開いた返信の下は Bluesky 本体と同じ深さで読む
		 */
		depth: {root: 1, branch: 6},
		/**
		 * 本文の上限。書記素は app.bsky.feed.post の lexicon の maxGraphemes、
		 * バイトは橋渡しの検査と同じ値
		 */
		limits: {
			maxGraphemes: 300,
			maxBytes: BRIDGE_PROTOCOL.postRecord.maxTextBytes
		},
		/** 残りの文字数がこれ以下になったら残数の表示の色を変える */
		warnRemaining: 20,
		/** 投稿を引き直さずに組み立てるときの、返信の record の collection */
		postCollection: BRIDGE_PROTOCOL.collections.post,
		/**
		 * 返信に付いた画像のサムネイル。押すとライトボックスをその返信の画像で開き直す。
		 * 本体は開いている間の openLightbox を無視するため、閉じてから開く (2026-10-18 実測)
		 */
		media: {
			/** 並べる枚数の上限。超えた分は最後の 1 枚に「+N」を重ねる */
			maxThumbs: 4,
			/**
			 * 1 枚だけのときの縦横比 (幅 / 高さ) の範囲。画像の比をこの範囲に収めて枠を作り、
			 * 縦長の画像で返信欄が間延びしないようにする
			 */
			singleAspect: {min: 3 / 4, max: 16 / 9},
			/**
			 * 閉じたことがパネルとライトボックスの操作性の調整に伝わるまで待つ上限 (ms)。
			 * 開閉の通知は次のフレームで届くため、待たずに開くと古いライトボックスの
			 * 後始末が飛ばされる。上限を過ぎたら待たずに開く
			 */
			closeWaitMs: 1500
		},
		/**
		 * 返信欄の作成部分 (画像の添付・自己ラベル・言語)。
		 * 上限のうち橋渡しと共有するものは BRIDGE_PROTOCOL から引く
		 */
		compose: {
			/** 添付できる枚数の上限 (gallery の上限と同じ) */
			maxImages: BRIDGE_PROTOCOL.postRecord.maxGalleryItems,
			/** この枚数までは app.bsky.embed.images、超えたら app.bsky.embed.gallery にする */
			legacyImagesMax: BRIDGE_PROTOCOL.postRecord.maxImages,
			/** ALT 文の上限 (書記素) */
			maxAltGraphemes: BRIDGE_PROTOCOL.postRecord.maxAltGraphemes,
			/** 選べる言語の上限 */
			maxLanguages: BRIDGE_PROTOCOL.postRecord.maxLangs,
			/** 受け付ける画像の MIME タイプ */
			acceptImageTypes: ['image/gif', 'image/jpeg', 'image/png', 'image/svg+xml', 'image/webp', 'image/avif'],
			/** 画像の縮小の条件 (長辺の上限・バイト数の上限・品質の下限と刻み) */
			image: {
				maxDimension: 4000,
				/** 橋渡しが受け付ける上限と同じ値 (超えると upload-blob で落ちる) */
				maxBytes: BRIDGE_PROTOCOL.upload.maxBytes.default,
				minQuality: 0.13,
				scaleStep: 0.8,
				maxScaleRetries: 4,
				qualitySteps: 7
			},
			/** 切り抜きの枠 (縦横比の選択肢・最小の辺・矢印キーの刻み。ratio が null は自由) */
			crop: {
				aspects: [
					{id: 'free', ratio: null},
					{id: '1:1', ratio: 1},
					{id: '4:3', ratio: 4 / 3},
					{id: '3:4', ratio: 3 / 4},
					{id: '16:9', ratio: 16 / 9}
				],
				minSize: 32,
				keyStep: 8,
				keyStepLarge: 32
			},
			/** 自己ラベル。adult は排他の選択肢、graphic は独立 */
			labels: {
				adult: BRIDGE_PROTOCOL.postRecord.adultLabels.slice(),
				graphic: BRIDGE_PROTOCOL.postRecord.otherLabels[0]
			},
			/** 選べる言語 (ISO 639-1 の 2 文字コード。Bluesky 本体の言語一覧と同じ並び) */
			languageCodes: [
				'aa', 'ab', 'af', 'ak', 'sq', 'am', 'ar', 'an', 'hy', 'as', 'av', 'ae', 'ay', 'az', 'ba', 'bm', 'eu',
				'be', 'bn', 'bh', 'bi', 'bo', 'bs', 'br', 'bg', 'my', 'ca', 'cs', 'ch', 'ce', 'zh', 'cu', 'cv', 'kw',
				'co', 'cr', 'cy', 'da', 'de', 'dv', 'nl', 'dz', 'el', 'en', 'eo', 'et', 'ee', 'fo', 'fa', 'fj', 'fi',
				'fr', 'fy', 'ff', 'ka', 'gd', 'ga', 'gl', 'gv', 'gn', 'gu', 'ht', 'ha', 'he', 'hz', 'hi', 'ho', 'hr',
				'hu', 'ig', 'is', 'io', 'ii', 'iu', 'ie', 'ia', 'id', 'ik', 'it', 'jv', 'ja', 'kl', 'kn', 'ks', 'kr',
				'kk', 'km', 'ki', 'rw', 'ky', 'kv', 'kg', 'ko', 'kj', 'ku', 'lo', 'la', 'lv', 'li', 'ln', 'lt', 'lb',
				'lu', 'lg', 'mk', 'mh', 'ml', 'mi', 'mr', 'ms', 'mg', 'mt', 'mn', 'na', 'nv', 'nr', 'nd', 'ng', 'ne',
				'nn', 'nb', 'no', 'ny', 'oc', 'oj', 'or', 'om', 'os', 'pa', 'pi', 'pl', 'pt', 'ps', 'qu', 'rm', 'ro',
				'rn', 'ru', 'sg', 'sa', 'si', 'sk', 'sl', 'se', 'sm', 'sn', 'sd', 'so', 'st', 'es', 'sc', 'sr', 'ss',
				'su', 'sw', 'sv', 'ty', 'ta', 'tt', 'te', 'tg', 'tl', 'th', 'ti', 'to', 'tn', 'ts', 'tk', 'tr', 'tw',
				'ug', 'uk', 'ur', 'uz', 've', 'vi', 'vo', 'wa', 'wo', 'xh', 'yi', 'yo', 'za', 'zu'
			],
			/** GIF (Klipy。Bluesky 本体と同じ gifs.bsky.app の中継を使う) */
			gif: {
				origin: 'https://gifs.bsky.app',
				paths: {featured: '/klipy/v2/featured', search: '/klipy/v2/search'},
				clientKey: 'bluesky-web',
				limit: 30,
				contentFilter: 'low',
				debounceMs: 750,
				sourceHost: 'static.klipy.com',
				playerHost: 'k.gifs.bsky.app',
				tenor: {sourceHost: 'media.tenor.com', playerHost: 't.gifs.bsky.app'},
				timeoutMs: 12000
			},
			/** リンクカード (本体と同じ cardyb の extract) */
			card: {
				extractUrl: 'https://cardyb.bsky.app/v1/extract',
				timeoutMs: 10000,
				/** bsky.app の URL はカードにせず、引用か本文のリンクとして扱う */
				excludedHosts: ['bsky.app'],
				/** 画像そのものの URL。カードにせず画像として扱う判定に使う */
				imageExtensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg']
			},
			/** 引用にできる投稿の URL のホスト */
			quote: {hosts: ['bsky.app']},
			/** 本文中の長い URL の短縮表示 (残りが maxRestChars を超えたら keepChars で切って … を付ける) */
			links: {maxRestChars: 15, keepChars: 13},
			/** リンクカードのサムネイルの縮小 (橋渡しの maxThumbBytes に収める) */
			thumb: {
				maxDimension: 2000,
				maxBytes: BRIDGE_PROTOCOL.postRecord.external.maxThumbBytes,
				minQuality: 0.13,
				scaleStep: 0.8,
				maxScaleRetries: 4,
				qualitySteps: 7
			},
			/** 選んだ言語を覚える chrome.storage.local のキー */
			languageStorageKey: 'replyLanguages',
			/** 投稿した自分の返信の画像を、取り直さずに描くための CDN の形 */
			cdn: {
				thumb: 'https://cdn.bsky.app/img/feed_thumbnail/plain',
				fullsize: 'https://cdn.bsky.app/img/feed_fullsize/plain',
				video: 'https://video.bsky.app/watch'
			},
			/** 動画 1 本と字幕 (上限は橋渡しの規則と同じ値) */
			video: {
				acceptTypes: BRIDGE_PROTOCOL.video.mimeTypes,
				/** 動画と見なす MIME タイプの接頭辞 (acceptTypes に無い動画を、画像ではなく動画として断るため) */
				typePrefix: 'video/',
				maxBytes: BRIDGE_PROTOCOL.video.maxBytes,
				/** 動画の長さの上限 (ミリ秒) */
				maxDurationMs: 600000,
				/** 動画の寸法と長さを読むのを諦めるまでの時間 (ミリ秒) */
				metaTimeoutMs: 10000,
				/** 寸法が読めないときの縦横比 */
				defaultAspect: {width: 16, height: 9},
				caption: {
					extension: '.vtt',
					mimeType: BRIDGE_PROTOCOL.video.captionMimeType,
					maxBytes: BRIDGE_PROTOCOL.video.captionMaxBytes,
					signature: 'WEBVTT',
					headBytes: 16
				},
				/** 動画サービスが返す英語の文言と日本語の対応 */
				serverMessages: {
					'User is not allowed to upload videos': '動画をアップロードできないアカウントです',
					'Uploading is disabled at the moment': '動画のアップロードは今は使えません',
					"Failed to get user's upload stats": '動画をアップロードできるか確かめられませんでした。もう一度お試しください',
					'User has exceeded daily upload bytes limit': '動画のアップロードが 1 日の上限 (容量) に達しました',
					'User has exceeded daily upload videos limit': '動画のアップロードが 1 日の上限 (本数) に達しました',
					'Account is not old enough to upload videos': 'アカウントが新しいため、まだ動画をアップロードできません',
					'Confirm your email address to upload videos': '動画をアップロードするにはメールアドレスの確認が必要です'
				},
				/** 動画の処理の失敗コードと日本語の対応 */
				failureTexts: {
					video_too_long: '動画が長すぎます',
					bad_aspect_ratio: 'この縦横比の動画は使えません',
					unsupported_codec: 'この形式の動画は使えません',
					encoded_video_too_large: '変換した動画が大きすぎます',
					encoding_failure: '動画を変換できませんでした',
					pds_upload_failure: '動画をサーバに保存できませんでした',
					pds_upload_unsupported_blob_size: 'この大きさの動画はサーバが受け付けません'
				}
			},
			/** 絵文字ピッカー (拡張のページを iframe で出す。通知の型は両側で同じ値を使う) */
			emoji: {
				page: 'emoji/emoji.html',
				selectType: 'ext:emoji-select',
				closeType: 'ext:emoji-close',
				readyType: 'ext:emoji-ready',
				/** 通知を送る先の origin (iframe を載せる bsky.app) */
				parentOrigin: 'https://bsky.app',
				/** 問い合わせ (query) のキーと値 */
				query: {theme: 'theme', locale: 'locale', themeDark: 'dark', themeLight: 'light', localeJa: 'ja'},
				/** 1 行の絵文字数 (パネルの内幅 328px に合わせる) */
				perLine: 8,
				/** 閉じる操作に使うキー */
				closeKey: 'Escape',
				/** ピッカーを差し込む要素の id */
				rootId: 'picker',
				/** 本体がライトテーマのとき html に付けるクラス (ディムとダークは暗い配色のピッカーにする) */
				lightThemeClass: 'theme--light'
			},
			/**
			 * パネルに重ねる画面 (ALT テキスト・切り抜き・ラベル・言語・絵文字) の要素の目印。
			 * data-role の値で、配線とテストはクラス名ではなくこれを見る
			 */
			sheetRoles: {
				layer: 'sheet',
				title: 'sheet-title',
				done: 'sheet-done',
				cancel: 'sheet-cancel',
				/** Tab の順で画面の両端に置き、フォーカスを反対の端へ回す番兵 */
				sentinel: 'sheet-sentinel'
			},
			/** 重ねる画面の中でフォーカスを受ける要素 (開いたときの移り先と Tab の循環に使う) */
			sheetFocusable: 'button, input, textarea, select, iframe, [tabindex="0"]',
			/** 切り抜きの枠の四隅 (crop-box.js の resizeBox の corner と同じ名前) */
			cropCorners: ['nw', 'ne', 'sw', 'se'],
			/** キーで大きさを変えるときに動かす角 */
			cropKeyCorner: 'se',
			/** 切り抜きの枠の role。矢印キーを読み上げソフトに取られず枠へ届かせる */
			cropBoxRole: 'application',
			/** 重ねる画面のクラス名 (content.css と対応する) */
			classes: {
				panelOpen: 'ext-lb-sheet-open',
				sheet: 'ext-lb-sheet',
				sentinel: 'ext-lb-sheet-sentinel',
				wide: 'is-wide',
				header: 'ext-lb-sheet-header',
				title: 'ext-lb-sheet-title',
				body: 'ext-lb-sheet-body',
				foot: 'ext-lb-sheet-foot',
				button: 'ext-lb-sheet-button',
				primary: 'is-primary',
				note: 'ext-lb-sheet-note',
				error: 'ext-lb-sheet-error',
				warn: 'is-warn',
				altPreview: 'ext-lb-sheet-alt-preview',
				altFrame: 'ext-lb-sheet-alt-frame',
				altInput: 'ext-lb-sheet-alt-input',
				altRemaining: 'ext-lb-sheet-alt-remaining',
				cropAspects: 'ext-lb-crop-aspects',
				cropAspect: 'ext-lb-crop-aspect',
				cropStage: 'ext-lb-crop-stage',
				cropFrame: 'ext-lb-crop-frame',
				cropImage: 'ext-lb-crop-image',
				cropBox: 'ext-lb-crop-box',
				cropShadeClip: 'ext-lb-crop-shade-clip',
				cropShade: 'ext-lb-crop-shade',
				cropHandle: 'ext-lb-crop-handle',
				cropSize: 'ext-lb-crop-size',
				cropTools: 'ext-lb-crop-tools',
				labelGroup: 'ext-lb-label-group',
				labelGroupTitle: 'ext-lb-label-group-title',
				option: 'ext-lb-sheet-option',
				langSearch: 'ext-lb-lang-search',
				langList: 'ext-lb-lang-list',
				langCount: 'ext-lb-lang-count',
				emojiFrame: 'ext-lb-emoji-frame',
				gifSearch: 'ext-lb-gif-search',
				gifGrid: 'ext-lb-gif-grid',
				gifItem: 'ext-lb-gif-item',
				gifStatus: 'ext-lb-gif-status',
				gifSentinel: 'ext-lb-gif-sentinel',
				/** 字幕と ALT の画面の字幕の行 */
				captionRow: 'ext-lb-caption-row',
				captionName: 'ext-lb-caption-name',
				/** 以下は入力欄 (reply-composer.js) の部品 */
				composer: 'ext-lb-composer',
				dragOver: 'is-dragover',
				fileInput: 'ext-lb-composer-file',
				attachments: 'ext-lb-composer-attachments',
				attachment: 'ext-lb-composer-attachment',
				attachmentImage: 'ext-lb-composer-attachment-image',
				attachmentTools: 'ext-lb-composer-attachment-tools',
				attachmentButton: 'ext-lb-composer-attachment-button',
				altButton: 'ext-lb-composer-alt',
				altDone: 'is-done',
				labelsButton: 'ext-lb-composer-labels',
				labelsActive: 'is-active',
				suggest: 'ext-lb-composer-suggest',
				suggestText: 'ext-lb-composer-suggest-text',
				suggestAccept: 'ext-lb-composer-suggest-accept',
				suggestDismiss: 'ext-lb-composer-suggest-dismiss',
				toolbar: 'ext-lb-composer-toolbar',
				tool: 'ext-lb-composer-tool',
				languageButton: 'ext-lb-composer-lang',
				languageText: 'ext-lb-composer-lang-text',
				/** 入力欄の中の GIF・リンクカード・引用のプレビューの入れ物 */
				embedPreview: 'ext-lb-composer-embed',
				/** 入力欄の動画のプレビュー・状態の 1 行・再試行・字幕の印 */
				video: 'ext-lb-composer-video',
				videoStatus: 'ext-lb-composer-video-status',
				videoRetry: 'ext-lb-composer-video-retry',
				videoRemove: 'ext-lb-composer-video-remove',
				videoBadge: 'ext-lb-composer-video-badge'
			},
			/** 送信中に押せなくする入力欄の中の要素 */
			busyControls: 'button, textarea',
			/** 画像のドラッグ&ドロップで見せる操作の種類 (dataTransfer.dropEffect) */
			dropEffect: 'copy',
			/** 送信中に画像を重ねたときの dropEffect (受けないことを見せる) */
			noDropEffect: 'none',
			/** 重ねる画面の文言。ラベルの画面は Bluesky 本体と同じ文言 (2026-10-18 実測) */
			text: {
				sheetDone: '完了',
				sheetCancel: 'キャンセル',
				sheetClose: '閉じる',
				altTitle: 'ALT テキストを追加',
				altLabel: 'ALT テキスト',
				altPlaceholder: '画像の内容を説明する',
				altPreview: '添付する画像',
				altRemaining: '残り {count}',
				cropTitle: '画像を切り抜く',
				cropAspects: '縦横比',
				aspectNames: {free: '自由', '1:1': '1:1', '4:3': '4:3', '3:4': '3:4', '16:9': '16:9'},
				cropBox: '切り抜く範囲。矢印キーで移動、Shift+矢印で大きさを変える (Ctrl で大きく動かす)',
				cropCorner: {nw: '左上の角', ne: '右上の角', sw: '左下の角', se: '右下の角'},
				cropSize: '{width} x {height} px',
				cropReset: '元に戻す',
				cropFailed: '画像を表示できませんでした',
				labelTitle: 'コンテンツの警告を追加',
				labelDescription: '投稿するメディアに該当するコンテンツ警告ラベルを追加してください。',
				labelAdult: '成人向けコンテンツ',
				labelNone: 'なし',
				labelOther: 'その他',
				labelNames: {
					sexual: 'きわどい',
					nudity: 'ヌード',
					porn: '成人向け（ポルノ等）',
					'graphic-media': '生々しいメディア（グロ・事故・戦争・災害等）'
				},
				langTitle: '投稿言語を選択',
				langSearch: '言語を検索',
				langCount: '{count}/{max} 個を選択中',
				langEmpty: '該当する言語がありません',
				emojiTitle: '絵文字',
				emojiFrame: '絵文字を選ぶ',
				emojiFailed: '絵文字を読み込めませんでした',
				/** 以下は入力欄 (reply-composer.js) の文言 */
				addImage: '画像・動画を追加',
				videoExclusive: '動画は画像・GIF と同時に付けられません',
				tooManyVideos: '動画は 1 本までです',
				videoUnreadable: 'この動画は読み込めませんでした',
				videoUnsupported: 'この形式の動画は使えません',
				videoReading: '動画を読み込み中…',
				videoTooLarge: '動画は 300MB までです',
				videoTooLong: '動画は 10 分までです',
				videoUploading: '動画を送信中 {percent}%',
				videoProcessing: '動画を処理中 {percent}%',
				videoProcessingPending: '動画を処理中…',
				videoReady: '動画の準備ができました',
				videoFailed: '動画を送れませんでした',
				videoProcessFailed: '動画を処理できませんでした',
				videoRetry: '再試行',
				removeVideo: '動画を外す',
				videoAlt: 'ALT',
				videoAltDone: 'ALT 済み',
				videoCaptionBadge: '字幕',
				video: '添付動画',
				videoSheetTitle: '字幕と ALT',
				captionSection: '字幕 (.vtt)',
				captionPick: '字幕ファイルを選ぶ (.vtt)',
				captionLanguage: '字幕の言語',
				captionRemove: '字幕を外す',
				captionNotVtt: '.vtt のファイルを選んでください',
				captionTooLarge: '字幕は 20KB までです',
				captionUploadFailed: '字幕を送れませんでした',
				videoPlay: '動画を再生',
				videoPause: '動画を止める',
				emoji: '絵文字',
				alt: 'ALT',
				altDone: 'ALT 済み',
				crop: '切り抜き',
				remove: '画像を外す',
				labels: 'ラベル',
				language: '投稿言語を選択',
				languageCurrent: '投稿言語: {names}',
				labelsCurrent: 'コンテンツの警告: {names}',
				suggest: '{言語}で返信しますか？',
				suggestAccept: 'はい',
				suggestDismiss: '提案を閉じる',
				sending: '送信中 {done}/{total}',
				tooManyImages: '画像は 10 枚までです',
				unsupportedImage: 'この形式の画像は添付できません',
				imageLoadFailed: '画像を読み込めませんでした',
				uploadFailed: '画像を送れませんでした',
				attachment: '添付画像 {index}',
				attachments: '添付画像',
				addGif: 'GIF を追加',
				gifExclusive: 'GIF と画像は同時に付けられません',
				gifTitle: 'GIF を選ぶ',
				gifSearch: 'KLIPY を検索',
				gifFailed: 'GIF を読み込めませんでした',
				gifRetry: '再試行',
				gifEmpty: '見つかりませんでした',
				gifItem: 'GIF「{title}」を選ぶ',
				removeGif: 'GIF を外す',
				cardLoading: 'リンクを読み込み中…',
				removeCard: 'リンクカードを外す',
				removeQuote: '引用を外す',
				quoteDisabled: 'この投稿は引用できません',
				/** 複数の知らせを 1 行にまとめるときの区切り */
				noticeSeparator: '。',
				/** 複数の言語・ラベルの名前をボタンに並べるときの区切り */
				listSeparator: '、'
			}
		},
		/**
		 * 返信の一覧と入力欄のプレビューで共通のカード (リンクカード・引用・GIF) の部品。
		 * types は getPostThread の embed の view の $type
		 */
		cards: {
			types: {
				external: 'app.bsky.embed.external#view',
				record: 'app.bsky.embed.record#view',
				recordWithMedia: 'app.bsky.embed.recordWithMedia#view',
				images: 'app.bsky.embed.images#view',
				gallery: 'app.bsky.embed.gallery#view',
				video: 'app.bsky.embed.video#view',
				viewRecord: 'app.bsky.embed.record#viewRecord',
				viewNotFound: 'app.bsky.embed.record#viewNotFound',
				viewBlocked: 'app.bsky.embed.record#viewBlocked',
				viewDetached: 'app.bsky.embed.record#viewDetached'
			},
			classes: {
				cardFrame: 'ext-lb-card-frame',
				linkCard: 'ext-lb-card',
				linkCardThumb: 'ext-lb-card-thumb',
				linkCardBody: 'ext-lb-card-body',
				linkCardTitle: 'ext-lb-card-title',
				linkCardDescription: 'ext-lb-card-description',
				linkCardHost: 'ext-lb-card-host',
				quote: 'ext-lb-quote',
				quoteHead: 'ext-lb-quote-head',
				quoteAvatar: 'ext-lb-quote-avatar',
				quoteName: 'ext-lb-quote-name',
				quoteHandle: 'ext-lb-quote-handle',
				quoteDate: 'ext-lb-quote-date',
				quoteText: 'ext-lb-quote-text',
				quoteImage: 'ext-lb-quote-image',
				quoteUnavailable: 'is-unavailable',
				blurred: 'is-blurred',
				blurLabel: 'ext-lb-card-blur-label',
				remove: 'ext-lb-card-remove',
				gif: 'ext-lb-gif',
				gifVideo: 'ext-lb-gif-video',
				gifPoster: 'ext-lb-gif-poster',
				gifPlay: 'ext-lb-gif-play',
				gifTools: 'ext-lb-gif-tools',
				gifAlt: 'ext-lb-gif-alt',
				gifAltDone: 'is-done',
				video: 'ext-lb-video',
				videoThumb: 'ext-lb-video-thumb',
				videoPlay: 'ext-lb-video-play',
				videoPlayer: 'ext-lb-video-player',
				videoFallback: 'ext-lb-video-fallback'
			},
			text: {
				gifPlay: 'GIF を再生',
				gifPause: 'GIF を止める',
				quoteNotFound: '引用元が見つかりませんでした',
				quoteUnavailable: '引用元を表示できません',
				quoteImage: '引用元の画像',
				gifAlt: 'ALT',
				gifAltDone: 'ALT 済み',
				videoOpenPost: '投稿で見る',
				videoLabel: '動画'
			}
		},
		/** 動画の再生 (hls.js) を載せた束。必要になったときだけ読み込む */
		player: {path: 'video/hls-player.js'},
		api: {
			origin: EXT_SHARED.publicApiOrigin,
			threadPath: '/xrpc/app.bsky.feed.getPostThread',
			resolveHandlePath: '/xrpc/com.atproto.identity.resolveHandle',
			profilePath: '/xrpc/app.bsky.actor.getProfile',
			timeoutMs: 12000
		},
		classes: {
			section: 'ext-lb-replies',
			header: 'ext-lb-replies-header',
			heading: 'ext-lb-replies-heading',
			headingText: 'ext-lb-replies-heading-text',
			toTop: 'ext-lb-replies-top',
			sentinel: 'ext-lb-replies-sentinel',
			status: 'ext-lb-replies-status',
			retry: 'ext-lb-replies-retry',
			list: 'ext-lb-reply-list',
			more: 'ext-lb-replies-more',
			item: 'ext-lb-reply',
			child: 'ext-lb-reply-child',
			avatar: 'ext-lb-reply-avatar',
			body: 'ext-lb-reply-body',
			nameRow: 'ext-lb-reply-name-row',
			name: 'ext-lb-reply-name',
			label: 'ext-lb-reply-label',
			labelSelf: 'ext-lb-reply-label-self',
			replyTo: 'ext-lb-reply-replyto',
			text: 'ext-lb-reply-text',
			embed: 'ext-lb-reply-embed',
			media: 'ext-lb-reply-media',
			mediaItem: 'ext-lb-reply-media-item',
			mediaBlurred: 'is-blurred',
			mediaLabel: 'ext-lb-reply-media-label',
			mediaMore: 'ext-lb-reply-media-more',
			/** 区画に付けると、ぼかしを CSS で打ち消す (NSFW のぼかし解除) */
			unblur: 'ext-lb-replies-unblur',
			meta: 'ext-lb-reply-meta',
			metaButton: 'ext-lb-reply-meta-button',
			toggle: 'ext-lb-reply-toggle',
			deleteButton: 'ext-lb-reply-delete',
			confirming: 'is-confirming',
			showReplies: 'ext-lb-reply-replies',
			date: 'ext-lb-reply-date',
			area: 'ext-lb-reply-replies-area',
			childList: 'ext-lb-reply-child-list',
			error: 'ext-lb-reply-error',
			form: 'ext-lb-reply-form',
			formRow: 'ext-lb-reply-form-row',
			formAvatar: 'ext-lb-reply-form-avatar',
			inputFrame: 'ext-lb-reply-input-frame',
			input: 'ext-lb-reply-input',
			formFoot: 'ext-lb-reply-form-foot',
			remaining: 'ext-lb-reply-remaining',
			warn: 'is-warn',
			submit: 'ext-lb-reply-submit'
		},
		text: {
			heading: '返信',
			toTop: '上部へ',
			placeholder: '返信を書く',
			replyPlaceholder: '返信する',
			submit: '送信',
			remaining: '残り',
			loading: '読み込み中...',
			empty: 'まだ返信はありません',
			error: '返信を読み込めませんでした (押すと再試行)',
			disabled: 'この投稿は返信を受け付けていません',
			more: 'もっと見る',
			moreReplies: '返信をもっと見る',
			showReplies: '返信を表示',
			hideReplies: '返信を隠す',
			reply: '返信',
			delete: '削除',
			confirmDelete: '本当に削除？',
			postFailed: '返信できませんでした',
			deleteFailed: '削除できませんでした',
			labelAuthor: '作者',
			labelSelf: 'あなた',
			replyTo: '返信先',
			hasEmbed: '添付あり',
			openMedia: '画像を開く',
			showBlurred: 'ぼかしを外す'
		}
	},

	/**
	 * ライトボックスの操作性の調整 (lightbox-guard.js、2.5.0 で追加)。
	 * 投稿情報パネル (lightboxPanel) とは独立した機能で、設定も別に持つ。
	 *
	 * Bluesky はダイアログの固定親に閉じるハンドラを置いており、画像はその
	 * 子であるためバブリングで閉じてしまう。同じ固定親のクラス r-1loqt21 が
	 * cursor: pointer だけを持ち、それがライトボックス全域に継承されるため、
	 * 画像の上も半透明の背景も閉じるボタンも見分けが付かない
	 * (2026-09-09 実測)
	 */
	lightboxGuard: {
		storageKey: 'lightboxGuardEnabled',
		/** 既定は有効。誤って閉じてしまう事故を防ぐ側に倒す */
		defaultEnabled: true,
		/**
		 * 固定親に付ける目印の属性。**CSS の起点はこれだけ。**
		 * 本体のクラス名 (css-g5y9jx r-1loqt21 ...) は動的で当てにできないため、
		 * 自分で付けた目印を見る。自分が生やした属性なので、撤去は
		 * removeAttribute で完全に元へ戻る
		 */
		markerAttr: 'data-bsky-ext-lightbox',
		/** 画像ライトボックスのダイアログを指すセレクタ。lightboxPanel と同じ相手に触る */
		dialogSelector: EXT_SHARED.lightboxDialogSelector,
		/**
		 * クリックを素通しする要素のセレクタ。**この除外は必須。**
		 * 左上の「画像オプション」ボタンは実測で (20,20)-(64,64)、画像の描画
		 * 矩形は (50,0)-(1158,661) で**重なっている** (2026-09-09 実測)。
		 * 除外しないとボタンが押せなくなる。
		 * **ローカライズ済みの aria-label には依存しない** (言語で変わるため)
		 */
		interactiveSelector: 'button, [role="button"], [tabindex]:not([tabindex="-1"])'
	}
};
