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

/** 画像として通す MIME (返信の embed の画像と、upload-blob が受け付ける画像) */
const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/** upload-blob が受け付ける画像 1 枚の大きさの上限 (バイト) */
const IMAGE_MAX_BYTES = 2000000;

/** 動画の字幕の MIME と大きさの上限 (バイト) */
const CAPTION_MIME_TYPE = 'text/vtt';
const CAPTION_MAX_BYTES = 20000;

/** http(s) で始まり空白を含まない URL の形 (facet のリンクとリンクカードの uri)。正規表現の文字列 */
const HTTP_URI_PATTERN = '^https?://\\S+$';

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
		getSession: 'get-session',
		/**
		 * 預けた Blob を本体の認証済み fetchHandler でアップロードする。
		 * Blob 本体は postMessage (blobMessageType) で先に預け、payload は blobId だけ
		 */
		uploadBlob: 'upload-blob',
		/** 動画を本体の認証済み fetchHandler でサービス認証つきに動画サービスへ送る (進み具合は progressEvent) */
		uploadVideo: 'upload-video',
		/** 実行中の upload-video を取り消す */
		cancelUploadVideo: 'cancel-upload-video'
	},
	/** upload-video の進み具合を MAIN ワールドから分離ワールドへ知らせる document 上のイベント名 */
	progressEvent: 'ext:bridge-progress',
	/** 分離ワールドから MAIN ワールドへ Blob を預ける postMessage の type */
	blobMessageType: 'ext:bridge-blob',
	/**
	 * 応答を待つ上限と、MAIN ワールドが通信を打ち切るまでの時間。
	 * requestMs は既定、uploadMs は upload-blob、threadMs は applyWrites (返信の連なり) の待ち。
	 * MAIN ワールドの打ち切りはそれぞれ mainMarginMs を引いた時間で、分離ワールドが諦める前に返事が届く。
	 * 書き込みの打ち切りは reasons.timeout で返す (書けているかもしれないものとして扱わせる)
	 */
	timeouts: {
		requestMs: 15000,
		/** 画像 (最大 2MB) を PDS へ送り終えるまで待つため、requestMs より長くとる */
		uploadMs: 60000,
		/** 待ちきれなかったときは書けているかもしれないものとして扱うため、requestMs より長くとる */
		threadMs: 60000,
		mainMarginMs: 2000
	},
	/**
	 * upload-blob が受け付ける Blob の条件と、預かり箱の寸法。
	 * 検査は受け手の page-bridge.js が持つ。maxBytes は MIME ごとの上限で、
	 * default は載っていない MIME の上限。通すのは画像と動画の字幕 (text/vtt) だけ
	 * (動画は upload-video が別の条件 (video) で受け付ける)
	 */
	upload: {
		mimeTypes: [...IMAGE_MIME_TYPES, CAPTION_MIME_TYPE],
		maxBytes: {default: IMAGE_MAX_BYTES, [CAPTION_MIME_TYPE]: CAPTION_MAX_BYTES},
		/** 預けた Blob を取りに来なかったときに捨てるまでの時間 */
		inboxTtlMs: 30000,
		/** 預かり箱の件数の上限。超えたら古いものから捨てる */
		inboxMaxEntries: 12,
		/** upload-blob の要求が、預けた Blob の到着を待つ上限 */
		arriveTimeoutMs: 5000,
		/** Blob を預けるときの id の形 (正規表現の文字列) */
		blobIdPattern: '^[a-z0-9-]{8,64}$'
	},
	/**
	 * 動画のアップロード (upload-video) が受け付ける動画の条件と、返信に付ける動画の embed の上限。
	 * blobMimeType は動画サービスが変換して返す BlobRef の MIME
	 */
	video: {
		mimeTypes: ['video/mp4', 'video/webm', 'video/quicktime', 'video/mpeg'],
		maxBytes: 300000000,
		blobMimeType: 'video/mp4',
		maxCaptions: 1,
		captionMimeType: CAPTION_MIME_TYPE,
		captionMaxBytes: CAPTION_MAX_BYTES,
		/** 字幕の言語タグの形 (正規表現の文字列) */
		langPattern: '^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{1,8})*$',
		/** embed の presentation に置いてよい値 */
		presentation: 'default'
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
		/** パネルの返信の一覧を読む (読み取りのみ) */
		getPostThread: 'app.bsky.feed.getPostThread',
		/** 画像の Blob を PDS へ置く (upload-blob 専用。call-xrpc には通さない) */
		uploadBlob: 'com.atproto.repo.uploadBlob',
		createRecord: 'com.atproto.repo.createRecord',
		/** 返信の連なり (2〜10 件) を 1 回のコミットで作る。通すのは自分の返信の create だけ */
		applyWrites: 'com.atproto.repo.applyWrites',
		deleteRecord: 'com.atproto.repo.deleteRecord',
		createBookmark: 'app.bsky.bookmark.createBookmark',
		deleteBookmark: 'app.bsky.bookmark.deleteBookmark'
	},
	/**
	 * createRecord / deleteRecord で触れてよいコレクション。
	 * ここに無いものは通さないため、フォロー・ブロックはこの橋渡しでは行えない。
	 * 投稿 (post) は**返信だけ**を通す。作成は record の形 (postRecord) を、
	 * 削除は消す相手が返信であることを、受け手の page-bridge.js が確かめる
	 */
	collections: {
		like: 'app.bsky.feed.like',
		repost: 'app.bsky.feed.repost',
		post: 'app.bsky.feed.post'
	},
	/**
	 * 返信として作れる投稿の record の形。
	 * embed は画像 (images / gallery)・動画 (video)・リンクカード (external)・引用 (record / recordWithMedia) だけ、
	 * labels は自己ラベルだけを通す。maxTextBytes は
	 * app.bsky.feed.post の lexicon の text の maxLength (3000 バイト)
	 */
	postRecord: {
		allowedKeys: ['$type', 'text', 'createdAt', 'reply', 'langs', 'facets', 'embed', 'labels'],
		maxTextBytes: 3000,
		maxLangs: 3,
		/** facets の件数の上限 (大量のメンションで通知を撒かせない) */
		maxFacets: 50,
		/** 返信に付けてよい embed の種類 */
		embedTypes: {
			images: 'app.bsky.embed.images',
			gallery: 'app.bsky.embed.gallery',
			external: 'app.bsky.embed.external',
			record: 'app.bsky.embed.record',
			video: 'app.bsky.embed.video',
			recordWithMedia: 'app.bsky.embed.recordWithMedia'
		},
		/** リンクカード (external) の上限。thumb は外部サムネイルの上限 (画像の 2MB より小さい) */
		external: {
			maxUriBytes: 3000, maxTitleGraphemes: 300,
			maxDescriptionGraphemes: 1000, maxThumbBytes: 1000000,
			/** uri の形 (http(s) で始まり、空白を含まない) の正規表現の文字列 */
			uriPattern: HTTP_URI_PATTERN
		},
		/** facet のリンクの uri の形 (リンクカードの uri と同じ)。正規表現の文字列 */
		linkUriPattern: HTTP_URI_PATTERN,
		/** gallery の item の $type */
		galleryImageType: 'app.bsky.embed.gallery#image',
		/** images の枚数の上限 */
		maxImages: 4,
		/** gallery の件数の上限 */
		maxGalleryItems: 10,
		/** ALT 文の書記素数の上限 */
		maxAltGraphemes: 2000,
		/** 画像として通す MIME */
		imageMimeTypes: IMAGE_MIME_TYPES,
		/** 自己ラベルの $type */
		selfLabelsType: 'com.atproto.label.defs#selfLabels',
		/** 成人向けの自己ラベル (同時には 1 つまで) */
		adultLabels: ['sexual', 'nudity', 'porn'],
		/** 成人向け以外に付けてよい自己ラベル */
		otherLabels: ['graphic-media'],
		/** 自己ラベルの個数の上限 */
		maxLabels: 2
	},
	/**
	 * applyWrites で送る返信の連なりの条件。検査は受け手の page-bridge.js が持つ。
	 * tidPattern は rkey (TID, 13 文字) の形の正規表現の文字列
	 */
	thread: {
		minPosts: 2,
		maxPosts: 10,
		createType: 'com.atproto.repo.applyWrites#create',
		writeKeys: ['$type', 'collection', 'rkey', 'value'],
		tidPattern: '^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$'
	},
	/** open-composer が受け付けるモード */
	composerModes: {reply: 'reply', quote: 'quote'},
	/** 橋渡しが返す失敗理由のうち、呼び出し側が分岐に使うもの */
	reasons: {
		/** repo が本人の DID でない = 覚えていた DID が古い (アカウント切り替え) */
		repoNotSelf: 'repo-not-self',
		/** 返信でない投稿を作ろうとした / 返信でない投稿を消そうとした */
		postNotReply: 'post-not-reply',
		/** applyWrites の連なりが条件を満たさない (件数・種類・rkey・つながり) */
		threadNotAllowed: 'thread-not-allowed',
		/** 返信の record に許していないキー・形が含まれていた */
		postRecordNotAllowed: 'post-record-not-allowed',
		/** 預けたはずの Blob が箱に無い (期限切れ・取り違え) */
		blobNotFound: 'blob-not-found',
		/** MIME・サイズが許した範囲に無い Blob */
		blobNotAllowed: 'blob-not-allowed',
		/** アップロードが成功しなかった (どの段階でも呼び出し側は同じ扱い) */
		uploadFailed: 'upload-failed',
		/** 利用者の操作で取り消された */
		canceled: 'canceled',
		/** 動画サービスへの送信を本体の認証で許されなかった */
		uploadForbidden: 'upload-forbidden',
		/** 動画の処理 (変換) が失敗した */
		videoFailed: 'video-failed',
		/**
		 * 応答を待ちきれなかった (MAIN ワールドの打ち切り・分離ワールドの待ちの上限のどちらも同じ値)。
		 * 書き込みでは届いたかもしれないため、失敗と決めつけて送り直さない
		 */
		timeout: 'timeout'
	}
});
