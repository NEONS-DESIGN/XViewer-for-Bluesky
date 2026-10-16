/**
 * 分離ワールド (content) と MAIN ワールド (inject/page-bridge.js) の橋渡しで
 * 両側が同じ値を使う定数。**ここ 1 か所にだけ書く。**
 *
 * content と inject は別の束になるため、実行時に値を共有するわけではない
 * (両方の束に同じ値が焼き込まれる)。ブラウザ API に触れない純粋なデータだけを置く。
 * 白名簿の検査 (checkXrpcRequest) は受け手の page-bridge.js が持つ。
 */

/**
 * 入れ子のオブジェクトまで凍結する。
 * @template T
 * @param {T} value 凍結する値
 * @returns {Readonly<T>} 同じ参照 (凍結済み)
 */
function deepFreeze(value) {
	if (value && typeof value === 'object') {
		for (const child of Object.values(value)) {
			deepFreeze(child);
		}
		Object.freeze(value);
	}
	return value;
}

/**
 * 橋渡しのイベント名・操作名・白名簿の値。
 * @readonly
 */
export const BRIDGE_PROTOCOL = deepFreeze({
	requestEvent: 'ext:bridge-request',
	resultEvent: 'ext:bridge-result',
	actions: {
		openLightbox: 'open-lightbox',
		switchTab: 'switch-tab',
		navigate: 'navigate',
		/** 開いているライトボックスの postUri を読む (lightbox-panel.js) */
		getLightbox: 'get-lightbox',
		/** 遷移の前にライトボックスを確実に閉じる (lightbox-panel.js) */
		closeLightbox: 'close-lightbox',
		/**
		 * 本体の認証済み agent.fetchHandler を借りて XRPC を呼ぶ
		 * (post-actions.js)。**白名簿の検査は page-bridge.js が持つ**
		 */
		callXrpc: 'call-xrpc',
		/** 本体の投稿作成モーダルを返信・引用モードで開く (post-actions.js) */
		openComposer: 'open-composer',
		/**
		 * ログイン状態と自分の DID を読む (post-actions.js)。
		 * **トークンは返さない**
		 */
		getSession: 'get-session'
	},
	/** タブ要素の data-testid の接頭辞 */
	tabTestIdPrefix: 'profilePager-selector-',
	/**
	 * navigate で行ける先の白名簿。**分離ワールドから任意のルートを
	 * 叩けるようにしない。** 2026-09-09 に実機で push() の成功を確認した
	 * 3 つだけを載せる
	 */
	routes: {
		post: 'PostThread',       // {name: <handle>, rkey}
		profile: 'Profile',       // {name: <handle または did>}
		hashtag: 'Hashtag'        // {tag}
	},
	/**
	 * call-xrpc に通す XRPC の NSID。
	 * どの NSID をどの宛先・メソッドで通すかの規則は page-bridge.js が持つ
	 */
	nsid: {
		getPosts: 'app.bsky.feed.getPosts',
		createRecord: 'com.atproto.repo.createRecord',
		deleteRecord: 'com.atproto.repo.deleteRecord',
		createBookmark: 'app.bsky.bookmark.createBookmark',
		deleteBookmark: 'app.bsky.bookmark.deleteBookmark'
	},
	/**
	 * createRecord / deleteRecord で触れてよいコレクション。
	 * ここに無いものは通さないため、投稿・削除・フォロー・ブロックは
	 * この橋渡しでは行えない
	 */
	collections: {
		like: 'app.bsky.feed.like',
		repost: 'app.bsky.feed.repost'
	},
	/** open-composer が受け付けるモード */
	composerModes: {reply: 'reply', quote: 'quote'},
	/** 橋渡しが返す失敗理由のうち、呼び出し側が分岐に使うもの */
	reasons: {
		/** repo が本人の DID でない = 覚えていた DID が古い (アカウント切り替え) */
		repoNotSelf: 'repo-not-self'
	}
});
