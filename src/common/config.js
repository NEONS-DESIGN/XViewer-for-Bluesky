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
			timeoutMs: 15000
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
