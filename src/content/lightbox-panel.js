/**
 * ライトボックスに重ねる投稿情報パネル。
 * 画像を開いたとき、右側に本文・投稿日時・作者・反応数を並べる。
 *
 * **メディアグリッド由来かどうかを知らない。** 開いているライトボックスの
 * activeLightbox.metricsContext.postUri を橋渡し (get-lightbox) で読み、
 * getPosts で投稿を引くだけ。グリッド側は openLightbox に
 * 本体と同じ metricsContext を添えるため、経路が 1 本で済む。
 * **取得はまず橋渡し経由の認証付き getPosts を試し、失敗したときだけ
 * 公開 API に落ちる** (viewer は認証付きでしか返らないため)。
 *
 * 依存: config.js (EXT_CONFIG) / debug.js (ExtDebug) /
 *       bridge-client.js (callBridge) / icons.js (createIcon) /
 *       page.js (subscribeLightboxVisibility, isLightboxVisible,
 *       findVisibleLightboxDialog) /
 *       post-actions.js (PostActions, readViewerState, toggleActionState,
 *       mergeActionKind, isActionApplied)
 */
import {EXT_CONFIG} from '../common/config.js';
import {ExtDebug} from '../common/debug.js';
import {createIcon} from '../common/icons.js';
import {callBridge} from './bridge-client.js';
import {subscribeLightboxVisibility, isLightboxVisible, findVisibleLightboxDialog} from './page.js';
import {installPanelFocusGuard} from './panel-focus-guard.js';
import {LightboxReplies} from './lightbox-replies.js';
import {
	PostActions, readViewerState, toggleActionState, mergeActionKind, isActionApplied
} from './post-actions.js';

/**
 * 本文を facets で区切った断片。
 * @typedef {Object} PanelSegment
 * @property {string} text 表示する文字列
 * @property {'text'|'link'|'mention'|'tag'} kind 断片の種別
 * @property {string|null} value link: URL / mention: DID / tag: タグ名。text は null
 */

/**
 * パネルに描くための投稿。
 * @typedef {Object} PanelPost
 * @property {string} postUri AT URI
 * @property {string} cid 投稿の CID。いいね・リポスト・ブックマークに要る
 * @property {Object} raw getPosts が返す `post` オブジェクトそのもの。
 *   **本体の投稿作成モーダル (openComposer) に渡すためだけの生データで、
 *   整形しない。** `quote` は完全な PostView を要求し、整形した部分
 *   オブジェクトを渡すと本体の React ツリーがアンマウントされる
 *   (2026-09-09 実機で確認)
 * @property {Object|null} viewer getPosts の viewer をそのまま。
 *   **未認証の取得では付かない。** 解釈は post-actions.js の readViewerState() が行う
 * @property {string} handle 作者のハンドル
 * @property {string} displayName 表示名 (無ければハンドル)
 * @property {string|null} avatarUrl
 * @property {string} text 本文 (生のまま)
 * @property {PanelSegment[]} segments facets を当てた本文の断片
 * @property {string} createdAt ISO 8601。空文字なら不明
 * @property {string} rkey 投稿ページへの遷移に使う
 * @property {{reply: number, repost: number, like: number, quote: number}} counts
 */

/** AT URI から投稿の did と rkey を取り出す正規表現 */
const PANEL_POST_URI_PATTERN = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/;

/**
 * 投稿の AT URI を分解する。投稿以外のコレクションは弾く。
 * @param {string} uri
 * @returns {{did: string, rkey: string}|null} 形が違えば null
 */
export function parsePostUri(uri) {
	try {
		if (typeof uri !== 'string') {
			return null;
		}
		const matched = PANEL_POST_URI_PATTERN.exec(uri);
		if (!matched) {
			return null;
		}
		return {did: matched[1], rkey: matched[2]};
	} catch (error) {
		console.error('[XViewer] 投稿 URI の解析に失敗しました', error);
		return null;
	}
}

/**
 * facet 1 件を、本文のバイト範囲と種別に直す。
 * 扱えない形 (範囲外・逆順・未知の $type) はすべて null にして捨てる。
 * @param {Object} facet record.facets の 1 要素
 * @param {number} byteLength 本文の UTF-8 バイト長
 * @param {Object} config EXT_CONFIG.lightboxPanel
 * @returns {{start: number, end: number, kind: string, value: string}|null}
 */
function toFacetRange(facet, byteLength, config) {
	const index = facet && facet.index;
	const features = facet && facet.features;
	if (!index || !Array.isArray(features)) {
		return null;
	}
	const start = index.byteStart;
	const end = index.byteEnd;
	if (!Number.isInteger(start) || !Number.isInteger(end)) {
		return null;
	}
	if (start < 0 || end > byteLength || start >= end) {
		return null;
	}
	for (const feature of features) {
		// $type は投稿者が自由に書ける値。"constructor" などプロトタイプのキーで
		// 関数を拾わないよう、自前のキーだけを引く
		const type = feature && feature.$type;
		const mapping = (typeof type === 'string'
			&& Object.prototype.hasOwnProperty.call(config.facets, type))
			? config.facets[type]
			: null;
		if (!mapping) {
			continue;
		}
		const value = feature[mapping.valueKey];
		if (typeof value !== 'string' || !value) {
			continue;
		}
		return {start, end, kind: mapping.kind, value};
	}
	return null;
}

/**
 * 本文に facets を当てて断片の配列にする。
 * **byteStart / byteEnd は UTF-8 のバイト位置**で、JS の文字列インデックスとは
 * 一致しない (日本語・絵文字で必ずズレる)。TextEncoder でバイト列に直してから
 * 切り出す。壊れた facet は捨てて素通しにする (本文が読めなくなるより良い)。
 * @param {string} text 本文
 * @param {Object[]|undefined} facets record.facets
 * @param {Object} config EXT_CONFIG.lightboxPanel
 * @returns {PanelSegment[]} 空文字なら空の配列
 */
export function applyFacets(text, facets, config) {
	try {
		if (typeof text !== 'string' || text === '') {
			return [];
		}
		const bytes = new TextEncoder().encode(text);
		const decoder = new TextDecoder();
		const ranges = (Array.isArray(facets) ? facets : [])
			.map((facet) => toFacetRange(facet, bytes.length, config))
			.filter((range) => range !== null)
			.sort((a, b) => a.start - b.start);

		const segments = [];
		let cursor = 0;
		for (const range of ranges) {
			// 直前の断片と重なるものは捨てる (先に来たほうを残す)
			if (range.start < cursor) {
				continue;
			}
			if (range.start > cursor) {
				segments.push({
					text: decoder.decode(bytes.slice(cursor, range.start)),
					kind: 'text',
					value: null
				});
			}
			segments.push({
				text: decoder.decode(bytes.slice(range.start, range.end)),
				kind: range.kind,
				value: range.value
			});
			cursor = range.end;
		}
		if (cursor < bytes.length) {
			segments.push({
				text: decoder.decode(bytes.slice(cursor)),
				kind: 'text',
				value: null
			});
		}
		return segments;
	} catch (error) {
		console.error('[XViewer] 本文の装飾の解析に失敗しました', error);
		// 装飾が落ちても本文は読めるようにする
		return typeof text === 'string' && text !== ''
			? [{text, kind: 'text', value: null}]
			: [];
	}
}

/**
 * 数値を反応数として取り込む。欠けていれば 0。
 * @param {*} value
 * @returns {number}
 */
function toPanelCount(value) {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0
		? value
		: 0;
}

/**
 * getPosts のレスポンスをパネルに描ける形にする。
 * @param {Object|null} json getPosts のレスポンス
 * @param {Object} config EXT_CONFIG.lightboxPanel
 * @returns {PanelPost|null} 読めなければ null
 */
export function parsePostForPanel(json, config) {
	try {
		const post = json && Array.isArray(json.posts) ? json.posts[0] : null;
		if (!post) {
			return null;
		}
		const parsed = parsePostUri(post.uri);
		if (!parsed) {
			return null;
		}
		const author = post.author || {};
		const record = post.record || {};
		const handle = typeof author.handle === 'string' ? author.handle : '';
		if (!handle) {
			return null;
		}
		const text = typeof record.text === 'string' ? record.text : '';
		return {
			postUri: post.uri,
			cid: typeof post.cid === 'string' ? post.cid : '',
			raw: post,
			viewer: (post.viewer && typeof post.viewer === 'object') ? post.viewer : null,
			handle,
			displayName: (typeof author.displayName === 'string' && author.displayName)
				? author.displayName
				: handle,
			avatarUrl: typeof author.avatar === 'string' ? author.avatar : null,
			text,
			segments: applyFacets(text, record.facets, config),
			createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
			rkey: parsed.rkey,
			counts: {
				reply: toPanelCount(post.replyCount),
				repost: toPanelCount(post.repostCount),
				like: toPanelCount(post.likeCount),
				quote: toPanelCount(post.quoteCount)
			}
		};
	} catch (error) {
		console.error('[XViewer] 投稿の解析に失敗しました', error);
		return null;
	}
}

/**
 * 投稿日時を絶対表記にする。
 * 本体のフィードは相対表記 (「3日」) なので、パネルは本体で見られない
 * 情報を補う役に徹する。
 * @param {string} iso ISO 8601
 * @param {Object} config EXT_CONFIG.lightboxPanel
 * @returns {string|null} 読めなければ null
 */
export function formatPostDate(iso, config) {
	try {
		if (typeof iso !== 'string' || !iso) {
			return null;
		}
		const date = new Date(iso);
		if (Number.isNaN(date.getTime())) {
			return null;
		}
		return new Intl.DateTimeFormat(config.locale, config.dateFormat).format(date);
	} catch (error) {
		console.error('[XViewer] 投稿日時の整形に失敗しました', error);
		return null;
	}
}

/**
 * 反応数を桁区切りの文字列にする。
 * @param {*} value
 * @param {Object} config EXT_CONFIG.lightboxPanel
 * @returns {string}
 */
export function formatCount(value, config) {
	const count = toPanelCount(value);
	try {
		return new Intl.NumberFormat(config.locale).format(count);
	} catch (error) {
		console.error('[XViewer] 反応数の整形に失敗しました', error);
		return String(count);
	}
}

/**
 * パネルを出してよいかを判定する。
 * 狭いウィンドウでは画像が潰れるため出さない。
 * @param {{enabled: boolean, innerWidth: number}|null} state
 * @param {Object} config EXT_CONFIG.lightboxPanel
 * @returns {boolean}
 */
export function shouldShowPanel(state, config) {
	if (!state || state.enabled !== true) {
		return false;
	}
	const width = state.innerWidth;
	if (typeof width !== 'number' || !Number.isFinite(width)) {
		return false;
	}
	return width >= config.minWindowWidthPx;
}

/**
 * 本文中のリンクを a の href に入れてよいかを判定する。
 * **facets の uri は投稿者が自由に決められる値**のため、許可した scheme
 * (config.allowedLinkProtocols) 以外は押せる要素にしない。
 * @param {string} uri facets の feature が持つ URL
 * @param {Object} config EXT_CONFIG.lightboxPanel
 * @returns {string|null} 安全な絶対 URL。押させてはいけないものは null
 */
export function toSafeLinkHref(uri, config) {
	try {
		if (typeof uri !== 'string' || !uri) {
			return null;
		}
		const parsed = new URL(uri);
		if (config.allowedLinkProtocols.indexOf(parsed.protocol) === -1) {
			return null;
		}
		return parsed.href;
	} catch (error) {
		// 相対 URL や壊れた文字列は URL の解析で例外になる。押させない
		return null;
	}
}

/**
 * 成功した操作の結果を、覚えている投稿へ書き戻す。
 * **その種別 (kind) に対応するフィールドだけを書き、他の種別には触れない。**
 * `this.pending` は投稿と種別の組でしか操作を弾かないため、別種の操作
 * (例: いいねとブックマーク) が同時に飛行中になり得る。全フィールドを
 * まるごと書き戻すと、後から書き戻った側が先に書き戻した側の結果を
 * 消してしまう (2026-09-09 実機の手前で見つかった不具合)。
 * 書き戻す先は自前で作った `PanelPost` (キャッシュに入っているものと
 * 同じ参照) で、本体 DOM にも本体のキャッシュにも触れない。
 * **`post.raw` (本体の openComposer にそのまま渡す生の PostView) にも
 * 同じ書き戻しを行う。** トップレベルの `viewer` / `counts` とは別に
 * 持っているデータのため、書き込み口を 1 つに保つにはここで両方を
 * 更新する必要がある (書き戻しを 2 か所に分けると、片方だけ更新される
 * 事故を繰り返す。過去 4 回この機能を壊した原因と同じパターン)
 * @param {PanelPost} post 書き戻す先
 * @param {'like'|'repost'|'bookmark'} kind
 * @param {ActionState} state 反映する状態。kind に対応するフィールドだけを読む
 * @returns {void}
 */
export function syncPostViewer(post, kind, state) {
	try {
		const viewer = Object.assign({}, post.viewer);
		const counts = Object.assign({}, post.counts);
		if (kind === 'like') {
			viewer.like = state.likeUri;
			counts.like = state.counts.like;
		} else if (kind === 'repost') {
			viewer.repost = state.repostUri;
			counts.repost = state.counts.repost;
		} else if (kind === 'bookmark') {
			viewer.bookmarked = state.bookmarked;
		}
		post.viewer = viewer;
		post.counts = counts;

		// raw (getPosts の post そのもの) にも、その種別のフィールドだけを書く。
		// raw が無い・raw.viewer が無い場合は何もしない (落とすより後回しにする)
		if (post.raw && typeof post.raw === 'object' && post.raw.viewer
			&& typeof post.raw.viewer === 'object') {
			const rawViewer = Object.assign({}, post.raw.viewer);
			if (kind === 'like') {
				rawViewer.like = state.likeUri;
				post.raw.likeCount = state.counts.like;
			} else if (kind === 'repost') {
				rawViewer.repost = state.repostUri;
				post.raw.repostCount = state.counts.repost;
			} else if (kind === 'bookmark') {
				rawViewer.bookmarked = state.bookmarked;
			}
			post.raw.viewer = rawViewer;
		}
	} catch (error) {
		console.error('[XViewer] 投稿の状態の書き戻しに失敗しました', error);
	}
}

/**
 * 失敗した操作を、その種別だけ押す前へ戻した新しい状態にする。
 * **他の種別 (別の操作が同時に飛行中でも) には触れない。**
 * トグルで打ち消すのではなく、`previous` からその種別のフィールドを
 * **値で写す** (`mergeActionKind()`)。`this.state` が押した時点のものでも、
 * 設定の ON/OFF や開き直しで `post.viewer` から作り直された古いものでも、
 * 同じ結果になる (トグルだと作り直された状態を逆に倒し、
 * 「いいね済みなのに URI が無い」幽霊の反応を作る)
 * @param {ActionState} state 戻す元になる、今の状態
 * @param {'like'|'repost'|'bookmark'} kind
 * @param {ActionState} previous 押す前の状態
 * @returns {ActionState} 戻した後の新しい状態
 */
export function revertActionState(state, kind, previous) {
	return mergeActionKind(state, kind, previous);
}

/**
 * 飛行中の操作を覚えるキーを作る。
 *
 * **投稿と種別の両方で弾く。** 種別だけをキーにすると、応答を待つ間に
 * ライトボックスを閉じて同じ画像を開き直したときに、キャッシュの `PanelPost`
 * がまだ更新前 (`viewer.like === null`) のためボタンが押せる状態で描かれ、
 * 2 本目の `createRecord` が飛ぶ。`viewer.like` は 1 本しか指せないため
 * 1 本目のレコードは孤児になり、パネルからも本体 UI からも取り消せなくなる
 * (2026-09-09 の最終レビューで見つかった Critical)。
 * 逆に投稿をキーへ含めておけば、**別の**投稿を開いたときのボタンが
 * 巻き添えで `disabled` のまま残ることもない
 * @param {string} postUri 対象の投稿の AT URI
 * @param {'like'|'repost'|'bookmark'} kind
 * @param {Object} config EXT_CONFIG.postActions
 * @returns {string} 飛行中の印のキー
 */
export function buildPendingKey(postUri, kind, config) {
	return `${postUri}${config.pendingKeySeparator}${kind}`;
}

/**
 * ライトボックスの右側に投稿情報を出す。
 *
 * **本体 DOM への介入は、ダイアログの固定親に当てるインラインの right
 * 1 プロパティだけ。** 当てた要素そのものを覚えておき、撤去時はその参照に
 * 対して**上書き前に控えておいた元のインラインの値**を書き戻す。
 * Bluesky 自身が right: 0px をインラインで書いているため、空文字に戻すと
 * その指定ごと消えて固定親の幅が shrink-to-fit で 0 に潰れる
 * (2026-09-09 実機で確認した Critical)。セレクタで引き直さない
 * (閉じた後は引けない)。要素が既に消えていれば何もしない (設計文書 8 節)
 */
export class LightboxPanel {
	/**
	 * @param {Object} config EXT_CONFIG.lightboxPanel
	 */
	constructor(config) {
		this.config = config;
		this.enabled = config.defaultEnabled;
		this.collapsed = config.defaultCollapsed;
		/** @type {HTMLElement|null} 生成したパネル */
		this.panelEl = null;
		/** @type {HTMLElement|null} 畳む / 開くボタン (mountPanel() で生える) */
		this.toggleEl = null;
		/** @type {HTMLElement|null} 本文の入れ物 (mountPanel() で生える) */
		this.bodyEl = null;
		/** @type {HTMLElement|null} right を当てた本体の要素。撤去時に戻す相手 */
		this.shrunkEl = null;
		/**
		 * right を当てる前に本体が持っていたインラインの値。
		 * **Bluesky 自身が right: 0px をインラインで書いている** (2026-09-09 実測)。
		 * 空文字で消すと本体の値ごと消え、固定親の幅が shrink-to-fit になって
		 * 0 に潰れる。撤去時はここへ戻す
		 */
		this.shrunkPreviousRight = '';
		/** @type {Map<string, PanelPost>} postUri をキーにした取得済みの投稿 */
		this.cache = new Map();
		/**
		 * 取得の世代。応答待ちの間にライトボックスが閉じたり別の投稿に
		 * 変わったりしたら、その応答は丸ごと捨てる (MediaFetcher.generation と同じ考え方)
		 */
		this.generation = 0;
		/**
		 * 投稿操作の呼び出し層。**取得を認証付きにするためにも使う**
		 * (viewer は認証付きの getPosts でしか返らない)
		 */
		this.actions = new PostActions(EXT_CONFIG.postActions);
		/** @type {ActionState|null} 描画中の投稿の反応状態 */
		this.state = null;
		/** @type {PanelPost|null} 描画中の投稿 */
		this.post = null;
		/**
		 * 飛行中の操作。**連打を弾くために要る。**
		 * createRecord が 2 本飛ぶと、いいねレコードが 2 つできて
		 * 片方が取り消せなくなる。
		 * **キーは buildPendingKey() が作る「投稿 + 種別」** で、
		 * ライトボックスを閉じて開き直しても消さない (teardown() 参照)
		 * @type {Set<string>}
		 */
		this.pending = new Set();
		/** 投稿操作を出すか。ポップアップのトグル */
		this.actionsEnabled = EXT_CONFIG.postActions.defaultEnabled;
		/** @type {HTMLElement|null} 開いているリポストのメニュー */
		this.menuEl = null;
		/** @type {Function|null} メニューの外側の押下を受けるリスナー。外すのに要る */
		this.onOutsideClick = null;
		/**
		 * @type {HTMLElement|null} メニューを開いたボタン。
		 * 閉じるときに aria-expanded を戻すのに要る
		 */
		this.menuAnchor = null;
		/**
		 * パネルに付けたフォーカスとキーのリスナーを外す関数。
		 * mountPanel() で付け、unmountPanel() で外す
		 * @type {(() => void)|null}
		 */
		this.releaseFocusGuard = null;
		/** 返信欄を出すか。ポップアップのトグル */
		this.repliesEnabled = EXT_CONFIG.lightboxReplies.defaultEnabled;
		/**
		 * 返信欄 (lightbox-replies.js)。パネルを import させないため、
		 * 本文の描画・遷移・返信数の更新はここから口として渡す
		 * @type {LightboxReplies}
		 */
		this.replies = new LightboxReplies(EXT_CONFIG.lightboxReplies, {
			toSegments: (text, facets) => applyFacets(text, facets, this.config),
			buildSegment: (segment) => this.buildSegment(segment),
			leaveTo: (target) => this.leaveTo(target),
			adjustReplyCount: (delta) => this.adjustReplyCount(delta),
			openMedia: (request) => this.openReplyMedia(request),
			actions: this.actions
		});
		/**
		 * ライトボックスが閉じたと伝わるのを待っている関数。
		 * 開閉の通知が「閉じた」を伝えたときにまとめて呼ぶ
		 * @type {Set<() => void>}
		 */
		this.closeWaiters = new Set();
	}

	/**
	 * 設定を読み、ライトボックスの開閉を購読する。
	 * @returns {Promise<void>}
	 */
	async init() {
		const config = this.config;
		try {
			const stored = await chrome.storage.sync.get([
				config.storageKey,
				config.collapsedStorageKey,
				EXT_CONFIG.postActions.storageKey,
				EXT_CONFIG.lightboxReplies.storageKey,
				EXT_CONFIG.mediaGrid.unblur.storageKey
			]);
			this.enabled = stored[config.storageKey] ?? config.defaultEnabled;
			this.collapsed = stored[config.collapsedStorageKey] ?? config.defaultCollapsed;
			this.actionsEnabled = stored[EXT_CONFIG.postActions.storageKey]
				?? EXT_CONFIG.postActions.defaultEnabled;
			this.repliesEnabled = stored[EXT_CONFIG.lightboxReplies.storageKey]
				?? EXT_CONFIG.lightboxReplies.defaultEnabled;
			this.replies.setUnblur(stored[EXT_CONFIG.mediaGrid.unblur.storageKey]
				?? EXT_CONFIG.mediaGrid.unblur.defaultEnabled);
		} catch (error) {
			console.error('[XViewer] パネルの設定の読み込みに失敗しました', error);
		}
		try {
			chrome.storage.onChanged.addListener((changes, area) => {
				if (area !== 'sync') {
					return;
				}
				const unblurKey = EXT_CONFIG.mediaGrid.unblur.storageKey;
				if (changes[unblurKey]) {
					this.replies.setUnblur(changes[unblurKey].newValue
						?? EXT_CONFIG.mediaGrid.unblur.defaultEnabled);
				}
				const repliesKey = EXT_CONFIG.lightboxReplies.storageKey;
				if (changes[EXT_CONFIG.postActions.storageKey] || changes[repliesKey]) {
					if (changes[EXT_CONFIG.postActions.storageKey]) {
						this.actionsEnabled = changes[EXT_CONFIG.postActions.storageKey].newValue
							?? EXT_CONFIG.postActions.defaultEnabled;
					}
					if (changes[repliesKey]) {
						this.repliesEnabled = changes[repliesKey].newValue
							?? EXT_CONFIG.lightboxReplies.defaultEnabled;
					}
					// 描画済みのパネルにその場で反映する (リロードを求めない)
					if (this.post) {
						this.renderPost(this.post);
					}
				}
				if (!changes[config.storageKey]) {
					return;
				}
				this.setEnabled(
					changes[config.storageKey].newValue ?? config.defaultEnabled
				);
			});
		} catch (error) {
			console.error('[XViewer] パネルの設定の購読に失敗しました', error);
		}
		try {
			subscribeLightboxVisibility((visible) => {
				if (visible) {
					this.open();
				} else {
					this.teardown();
					this.releaseCloseWaiters();
				}
			});
			// タブを閉じる・遷移で離れるときにも本体の変更を必ず戻す
			window.addEventListener('pagehide', () => this.teardown());
		} catch (error) {
			console.error('[XViewer] パネルの起動に失敗しました', error);
		}
	}

	/**
	 * ポップアップのトグルを反映する。OFF にした瞬間に撤去する。
	 * @param {boolean} enabled
	 * @returns {void}
	 */
	setEnabled(enabled) {
		this.enabled = enabled === true;
		ExtDebug.log('パネルの設定が変わった', {有効: this.enabled});
		if (!this.enabled) {
			this.teardown();
			return;
		}
		// ライトボックスが開いたままなら、その場で出す
		if (isLightboxVisible()) {
			this.open();
		}
	}

	/**
	 * パネルを出す。開いているのが画像ライトボックスでなければ何もしない。
	 * @returns {Promise<void>}
	 */
	async open() {
		try {
			if (this.panelEl) {
				return;
			}
			if (!shouldShowPanel(
				{enabled: this.enabled, innerWidth: window.innerWidth},
				this.config
			)) {
				return;
			}
			const generation = this.generation;
			const result = await callBridge(
				EXT_CONFIG.mediaGrid.bridge.actions.getLightbox, {}
			);
			if (generation !== this.generation) {
				return;
			}
			if (!result || !result.ok || !result.open || !result.postUri) {
				ExtDebug.log('パネルを出さない', {
					理由: result && result.ok
						? (result.open ? 'postUri が無い' : '画像ライトボックスではない')
						: (result && result.reason) || '応答なし'
				});
				return;
			}
			// 応答を待つ間に閉じられている可能性がある
			if (!isLightboxVisible()) {
				return;
			}
			// 本体のアカウント切り替えはリロードを伴わない。覚えている投稿の
			// viewer (いいね済みか等) は人ごとに違うため、DID が変わっていたら捨てる
			const session = await this.actions.refreshSessionDid();
			if (generation !== this.generation) {
				return;
			}
			if (session.changed) {
				this.cache.clear();
			}

			const postUri = result.postUri;
			this.mountPanel();
			this.applyShrink();

			const cached = this.cache.get(postUri);
			if (cached) {
				this.renderPost(cached);
				return;
			}
			this.renderStatus(this.config.text.loading);
			ExtDebug.log('パネルの取得を開始', {postUri});
			const post = await this.fetchPost(postUri);
			if (generation !== this.generation || !this.panelEl) {
				return;
			}
			if (!post) {
				this.renderStatus(this.config.text.error);
				return;
			}
			this.remember(postUri, post);
			this.renderPost(post);
			ExtDebug.log('パネルの取得が終了', {postUri, 本文の長さ: post.text.length});
		} catch (error) {
			console.error('[XViewer] パネルの表示に失敗しました', error);
		}
	}

	/**
	 * パネルを撤去し、本体に当てた変更を戻す。
	 * **どの閉じ方をされても必ずここを通る。**
	 * @returns {void}
	 */
	teardown() {
		this.closeRepostMenu();
		this.replies.destroy();
		// 飛行中の取得の応答を捨てる
		this.generation += 1;
		this.releaseShrink();
		this.post = null;
		this.state = null;
		// **this.pending は消さない。** 飛行中の createRecord の印まで消すと、
		// 同じ画像をすぐ開き直したときにボタンが押せる状態に戻り、2 本目の
		// レコードができて片方が取り消せなくなる (2.6.6 で塞いだ Critical)。
		// runAction() は成功・失敗・例外のいずれの経路でも印を消すため、
		// ここで消さなくても印が残り続けることはない
		this.unmountPanel();
	}

	/**
	 * 取得済みの投稿を覚える。上限を超えたら古いものから捨てる。
	 * @param {string} postUri
	 * @param {PanelPost} post
	 * @returns {void}
	 */
	remember(postUri, post) {
		this.cache.set(postUri, post);
		while (this.cache.size > this.config.cacheLimit) {
			const oldest = this.cache.keys().next();
			if (oldest.done) {
				break;
			}
			this.cache.delete(oldest.value);
		}
	}

	/**
	 * 投稿を 1 件引く。
	 *
	 * **まず橋渡し経由の認証付き getPosts を試す。** viewer (いいね済みか等) は
	 * 認証付きでしか返らないため。橋渡しが使えない・未ログインのときは
	 * 公開 API に落ちる。その場合 viewer が無く、操作ボタンは出ない
	 * @param {string} postUri
	 * @returns {Promise<PanelPost|null>} 読めなければ null
	 */
	async fetchPost(postUri) {
		const authed = await this.actions.fetchPost(postUri);
		if (authed) {
			const post = parsePostForPanel(authed, this.config);
			if (post) {
				return post;
			}
		}
		return this.fetchPostPublic(postUri);
	}

	/**
	 * 公開 API から投稿を 1 件引く。**未認証のため viewer は付かない。**
	 * @param {string} postUri
	 * @returns {Promise<PanelPost|null>} 読めなければ null
	 */
	async fetchPostPublic(postUri) {
		const api = this.config.api;
		const url = `${api.origin}${api.postsPath}?uris=${encodeURIComponent(postUri)}`;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), api.timeoutMs);
		try {
			const response = await fetch(url, {signal: controller.signal});
			if (!response.ok) {
				console.error('[XViewer] 投稿の取得に失敗しました', response.status);
				return null;
			}
			return parsePostForPanel(await response.json(), this.config);
		} catch (error) {
			console.error('[XViewer] 投稿の取得に失敗しました', error);
			return null;
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * 本体のダイアログの固定親を狭める。
	 * **見つからなければ何もしない** (パネルは重なる表示に落ちる)。
	 * **上書きする前に元のインラインの値を控える。** Bluesky 自身が
	 * right: 0px をインラインで書いているため (2026-09-09 実測)、
	 * 空文字で戻すと本体の指定ごと消えてしまう
	 * @returns {void}
	 */
	applyShrink() {
		try {
			// 閉じて別のライトボックスが開いていた場合、古い固定親を掴んだままだと
			// 新しい方に right が当たらない。外れていたら先に戻して掴み直す
			if (this.shrunkEl && !this.shrunkEl.isConnected) {
				this.releaseShrink();
			}
			if (this.collapsed || this.shrunkEl) {
				return;
			}
			const dialog = findVisibleLightboxDialog(this.config.dialogSelector);
			const parent = dialog && dialog.parentElement;
			if (!parent) {
				return;
			}
			this.shrunkEl = parent;
			// 上書きする前に本体の値を控える (空文字で消すと本体の指定ごと消える)
			this.shrunkPreviousRight = parent.style.right;
			parent.style.right = `${this.config.widthPx}px`;
		} catch (error) {
			console.error('[XViewer] ライトボックスの幅の調整に失敗しました', error);
		}
	}

	/**
	 * 本体に当てた right を戻す。**保持している参照に対して書く。**
	 * **空文字ではなく、控えておいた元の値に戻す。** Bluesky 自身が
	 * right: 0px をインラインで書いており、空文字にすると right の指定が
	 * どこにも無くなって固定親が shrink-to-fit の幅 (0px) に潰れる
	 * (2026-09-09 実機で確認した Critical)
	 * @returns {void}
	 */
	releaseShrink() {
		try {
			if (this.shrunkEl) {
				this.shrunkEl.style.right = this.shrunkPreviousRight;
			}
		} catch (error) {
			console.error('[XViewer] ライトボックスの幅の復帰に失敗しました', error);
		} finally {
			this.shrunkEl = null;
			this.shrunkPreviousRight = '';
		}
	}

	/**
	 * パネルの外枠を作って body 直下に置く。**既存のものは必ず消してから足す。**
	 * @returns {void}
	 */
	mountPanel() {
		const config = this.config;
		this.unmountPanel();
		const panel = document.createElement('aside');
		panel.id = config.panelId;
		panel.style.width = `${config.widthPx}px`;
		panel.style.zIndex = String(config.zIndex);
		if (this.collapsed) {
			panel.classList.add(config.collapsedClass);
		}

		const header = document.createElement('div');
		header.className = config.headerClass;
		const toggle = document.createElement('button');
		toggle.type = 'button';
		toggle.className = config.toggleClass;
		toggle.addEventListener('click', () => this.setCollapsed(!this.collapsed));
		header.appendChild(toggle);
		panel.appendChild(header);

		const body = document.createElement('div');
		body.className = config.bodyClass;
		panel.appendChild(body);

		document.body.appendChild(panel);
		this.panelEl = panel;
		this.toggleEl = toggle;
		this.bodyEl = body;
		try {
			this.releaseFocusGuard = installPanelFocusGuard(panel, () => (this.replies
				? this.replies.readKeyState()
				: {hasDraft: false, confirming: false}));
		} catch (error) {
			console.error('[XViewer] パネルのフォーカスの扱いを付けられませんでした', error);
		}
		this.updateToggle();
		ExtDebug.log('パネルを生成', {畳んでいる: this.collapsed});
	}

	/** パネルを DOM から外す。 */
	unmountPanel() {
		try {
			const existing = document.getElementById(this.config.panelId);
			if (existing) {
				existing.remove();
			}
		} catch (error) {
			console.error('[XViewer] パネルの撤去に失敗しました', error);
		} finally {
			if (this.releaseFocusGuard) {
				try {
					this.releaseFocusGuard();
				} catch (error) {
					console.error('[XViewer] パネルのフォーカスの扱いを外せませんでした', error);
				}
				this.releaseFocusGuard = null;
			}
			this.panelEl = null;
			this.toggleEl = null;
			this.bodyEl = null;
		}
	}

	/**
	 * 畳む / 開くを切り替える。状態は保存する。
	 * @param {boolean} collapsed
	 * @returns {void}
	 */
	setCollapsed(collapsed) {
		this.collapsed = collapsed === true;
		try {
			if (this.panelEl) {
				this.panelEl.classList.toggle(
					this.config.collapsedClass, this.collapsed
				);
			}
			this.updateToggle();
			if (this.collapsed) {
				this.releaseShrink();
			} else {
				this.applyShrink();
			}
		} catch (error) {
			console.error('[XViewer] パネルの折り畳みに失敗しました', error);
		}
		try {
			chrome.storage.sync.set({
				[this.config.collapsedStorageKey]: this.collapsed
			});
		} catch (error) {
			console.error('[XViewer] 折り畳み状態の保存に失敗しました', error);
		}
	}

	/** 畳む / 開くボタンのアイコンとラベルを今の状態に合わせる。 */
	updateToggle() {
		if (!this.toggleEl) {
			return;
		}
		const text = this.config.text;
		const label = this.collapsed ? text.expand : text.collapse;
		this.toggleEl.textContent = '';
		this.toggleEl.setAttribute('aria-label', label);
		this.toggleEl.title = label;
		this.toggleEl.appendChild(createIcon(
			document, this.collapsed ? 'chevronLeft' : 'chevronRight'
		));
	}

	/**
	 * 本文の代わりに 1 行の文言を出す (読み込み中・失敗)。
	 * @param {string} message
	 * @returns {void}
	 */
	renderStatus(message) {
		if (!this.bodyEl) {
			return;
		}
		this.bodyEl.textContent = '';
		const status = document.createElement('p');
		status.className = this.config.statusClass;
		status.textContent = message;
		this.bodyEl.appendChild(status);
	}

	/**
	 * 投稿をパネルに描く。
	 * @param {PanelPost} post
	 * @returns {void}
	 */
	renderPost(post) {
		try {
			if (!this.bodyEl) {
				return;
			}
			// bodyEl をまるごと作り直すため、メニューが宙に浮く前に片付ける
			// (chrome.storage.onChanged からの再描画は mountPanel() を経由せず
			// ここへ直接来るため、renderActions() の片付けだけでは足りない)
			this.closeRepostMenu();
			const config = this.config;
			this.post = post;
			this.state = readViewerState(post.viewer, post.counts);
			this.bodyEl.textContent = '';
			this.bodyEl.appendChild(this.buildAuthor(post));

			const text = document.createElement('p');
			text.className = config.textClass;
			for (const segment of post.segments) {
				text.appendChild(this.buildSegment(segment));
			}
			this.bodyEl.appendChild(text);

			const formatted = formatPostDate(post.createdAt, config);
			if (formatted) {
				const date = document.createElement('time');
				date.className = config.dateClass;
				date.setAttribute('datetime', post.createdAt);
				date.textContent = formatted;
				this.bodyEl.appendChild(date);
			}

			this.bodyEl.appendChild(this.shouldShowActions(post)
				? this.buildActions()
				: this.buildCounts(post));
			this.bodyEl.appendChild(this.buildOpenPost(post));
			if (this.repliesEnabled) {
				this.replies.mount(this.bodyEl, post, {canWrite: this.shouldShowActions(post)});
			} else {
				this.replies.destroy();
			}
		} catch (error) {
			console.error('[XViewer] パネルの描画に失敗しました', error);
			this.renderStatus(this.config.text.error);
		}
	}

	/**
	 * 作者の行を作る。
	 * @param {PanelPost} post
	 * @returns {HTMLElement}
	 */
	buildAuthor(post) {
		const config = this.config;
		const author = document.createElement('div');
		author.className = config.authorClass;
		if (post.avatarUrl) {
			const avatar = document.createElement('img');
			avatar.className = config.avatarClass;
			avatar.src = post.avatarUrl;
			// 名前は隣に文字で出ているので、画像は装飾として扱う
			avatar.alt = '';
			author.appendChild(avatar);
		}
		const names = document.createElement('div');
		const name = document.createElement('span');
		name.className = config.nameClass;
		name.textContent = post.displayName;
		const handle = document.createElement('span');
		handle.className = config.handleClass;
		handle.textContent = `@${post.handle}`;
		names.appendChild(name);
		names.appendChild(handle);
		author.appendChild(names);
		return author;
	}

	/**
	 * 本文の断片 1 つを要素にする。
	 * リンクだけは a の既定動作 (新しいタブ) に任せる。外部サイトへの遷移は
	 * 本体のルーターの管轄外のため、SPA 遷移にする必要が無い。
	 * @param {PanelSegment} segment
	 * @returns {Node}
	 */
	buildSegment(segment) {
		const config = this.config;
		const routes = EXT_CONFIG.mediaGrid.bridge.routes;
		if (segment.kind === 'link') {
			const href = toSafeLinkHref(segment.value, config);
			// 許可した scheme でなければ押せる要素にしない。本文は文字列として残す
			if (!href) {
				return document.createTextNode(segment.text);
			}
			const link = document.createElement('a');
			link.className = config.linkClass;
			link.href = href;
			link.target = '_blank';
			link.rel = 'noopener noreferrer';
			link.textContent = segment.text;
			return link;
		}
		if (segment.kind === 'mention' || segment.kind === 'tag') {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = config.linkClass;
			button.textContent = segment.text;
			const params = segment.kind === 'mention'
				? {route: routes.profile, params: {name: segment.value}}
				: {route: routes.hashtag, params: {tag: segment.value}};
			button.addEventListener('click', () => this.leaveTo(params));
			return button;
		}
		return document.createTextNode(segment.text);
	}

	/**
	 * 反応数の行を作る。0 の項目も出す (欠けると横並びの位置がずれて読みにくい)。
	 * @param {PanelPost} post
	 * @returns {HTMLElement}
	 */
	buildCounts(post) {
		const config = this.config;
		const row = document.createElement('div');
		row.className = config.countsClass;
		const items = [
			{icon: 'chatBubble', label: config.text.replyCount, value: post.counts.reply},
			{icon: 'repeat', label: config.text.repostCount, value: post.counts.repost},
			{icon: 'favorite', label: config.text.likeCount, value: post.counts.like},
			{icon: 'formatQuote', label: config.text.quoteCount, value: post.counts.quote}
		];
		for (const item of items) {
			const cell = document.createElement('span');
			cell.className = config.countClass;
			cell.setAttribute('aria-label', item.label);
			cell.title = item.label;
			const icon = createIcon(document, item.icon);
			icon.classList.add(config.countIconClass);
			cell.appendChild(icon);
			const number = document.createElement('span');
			number.textContent = formatCount(item.value, config);
			cell.appendChild(number);
			row.appendChild(cell);
		}
		return row;
	}

	/**
	 * 操作ボタンを出せるかどうか。
	 * **viewer が無い取得 (未ログイン・橋渡し失敗) では出さない。**
	 * 出しても押した瞬間に必ず失敗するため、数値の表示に留める
	 * @param {PanelPost} post
	 * @returns {boolean}
	 */
	shouldShowActions(post) {
		return this.actionsEnabled === true
			&& post.viewer !== null
			&& post.cid !== '';
	}

	/**
	 * 押せる操作行を作る。反応数の行 (buildCounts) と入れ替わりで出す。
	 * **0 の項目も出す** (欠けると横並びの位置がずれて読みにくい)。
	 * @returns {HTMLElement}
	 */
	buildActions() {
		const config = EXT_CONFIG.postActions;
		const state = this.state;
		const row = document.createElement('div');
		row.className = config.actionsClass;
		const items = [
			{
				kind: 'reply',
				icon: 'chatBubble',
				label: config.text.reply,
				active: false,
				count: state.counts.reply
			},
			{
				kind: 'repost',
				icon: 'repeat',
				label: config.text.repost,
				active: state.reposted,
				count: state.counts.repost
			},
			{
				kind: 'like',
				icon: 'favorite',
				label: state.liked ? config.text.likeUndo : config.text.like,
				active: state.liked,
				count: state.counts.like
			},
			{
				kind: 'bookmark',
				icon: 'bookmark',
				label: state.bookmarked ? config.text.bookmarkUndo : config.text.bookmark,
				active: state.bookmarked,
				count: null
			}
		];
		for (const item of items) {
			row.appendChild(this.buildActionButton(item));
		}
		return row;
	}

	/**
	 * 操作ボタンを 1 つ作る。
	 * @param {{kind: string, icon: string, label: string, active: boolean,
	 *   count: number|null}} item
	 * @returns {HTMLElement}
	 */
	buildActionButton(item) {
		const config = EXT_CONFIG.postActions;
		const button = document.createElement('button');
		button.type = 'button';
		// 種別のクラスは色を決めるためだけのもの (2.8.0)。
		// 未知の種別でも落とさず、色の無い既定の見た目にする
		const kindClass = config.kindClass[item.kind] ?? '';
		button.className = [
			config.actionClass,
			kindClass,
			item.active ? config.activeClass : ''
		].filter(Boolean).join(' ');
		// アイコンだけでは意味が伝わらないので、読み上げ用と マウス用の両方を付ける
		button.setAttribute('aria-label', item.label);
		button.title = item.label;
		// 飛行中かどうかは「投稿 + 種別」で見る (runAction() と同じキー)
		const pendingKey = this.post
			? buildPendingKey(this.post.postUri, item.kind, config)
			: null;
		button.disabled = pendingKey !== null && this.pending.has(pendingKey);
		// メニューを持つのはリポストだけ。他の 3 つには付けない
		if (item.kind === 'repost') {
			button.setAttribute('aria-haspopup', 'menu');
			button.setAttribute('aria-expanded', 'false');
		}
		const icon = createIcon(document, item.icon);
		icon.classList.add(config.actionIconClass);
		button.appendChild(icon);
		if (item.count !== null) {
			const number = document.createElement('span');
			number.textContent = formatCount(item.count, this.config);
			button.appendChild(number);
		}
		button.addEventListener('click', () => {
			if (item.kind === 'reply') {
				// 返信欄の入力欄があればそこで書く。無ければ (返信欄が無効・返信不可など)
				// 従来どおり本体の投稿作成モーダルを開く
				if (!this.repliesEnabled || !this.replies.focusComposer()) {
					this.openComposerFor(EXT_CONFIG.postActions.composerModes.reply);
				}
				return;
			}
			if (item.kind === 'repost') {
				this.toggleRepostMenu(button);
				return;
			}
			this.runAction(item.kind);
		});
		return button;
	}

	/**
	 * 操作を 1 つ実行する。
	 *
	 * **楽観的更新。** 押した瞬間に見た目を変え、失敗したら押す前の状態へ戻す。
	 * 飛行中の同じ操作は `buildPendingKey()` のキー (投稿 + 種別) で弾く
	 * (連打でも、閉じて開き直しても、同じレコードが 2 つできると片方が
	 * 取り消せなくなるため)。
	 *
	 * **状態への反映は、成功なら `next` から・失敗なら `previous` から、
	 * その種別のフィールドを値で写す** (`mergeActionKind()`)。`this.state` は
	 * 応答を待つ間に開き直し・設定の ON/OFF で `post.viewer` から作り直される
	 * ことがあり、トグルや URI だけの書き込みでは古い状態と食い違う
	 * (二重いいねの 5 回目の経路)。
	 *
	 * **失敗したときは覚えている投稿を捨て、サーバから引き直す。** 橋渡しは
	 * 15 秒でタイムアウトして失敗を返すが、そのときサーバ側では成功している
	 * ことがある。押す前へ戻しただけだと利用者がもう一度押して 2 本目が飛ぶため、
	 * 印を残したまま引き直し、引けたらその真実で描き直す。引き直しは、この投稿に
	 * 別種の操作が飛行中でないときだけ行う (その結果を上書きしないため)
	 * @param {'like'|'repost'|'bookmark'} kind
	 * @returns {Promise<void>}
	 */
	async runAction(kind) {
		// catch でも巻き戻し・飛行中の印の後始末ができるよう、
		// try の外のスコープに出しておく
		let previous = null;
		let post = null;
		let key = null;
		try {
			if (!this.post || !this.state) {
				return;
			}
			post = this.post;
			// 投稿と種別の両方で弾く。閉じて開き直しても飛行中は押させない
			key = buildPendingKey(post.postUri, kind, EXT_CONFIG.postActions);
			if (this.pending.has(key)) {
				return;
			}
			previous = this.state;
			const next = toggleActionState(previous, kind);
			this.pending.add(key);
			this.state = next;
			this.renderActions();

			const result = await this.callAction(kind, post, previous, next);
			let refreshed = null;
			if (result.ok) {
				// createRecord の応答の URI を取り込む。取り込まないと取り消せない
				if (kind === 'like' && next.liked) {
					next.likeUri = result.recordUri;
				}
				if (kind === 'repost' && next.reposted) {
					next.repostUri = result.recordUri;
				}
				// 覚えている投稿にも反映する。**この種別のフィールドだけを書く**
				// (別種の操作が同時に飛行中の場合がある。全フィールドを書くと
				// 互いの結果を消し合う)。post はこの呼び出しがローカルに掴んでいる
				// キャッシュ内のオブジェクトなので、応答待ちの間に閉じられていても
				// 書き戻して構わない
				syncPostViewer(post, kind, next);
			} else {
				// **失敗しても「押す前の状態」を覚え込まない。** サーバ側では
				// 成功していることがあり、覚えたままにすると recordUri を永久に失い、
				// 次の押下で 2 本目のレコードができる
				this.cache.delete(post.postUri);
				if (!this.hasOtherPending(post.postUri, key)) {
					// 印を残したまま、**認証付きの取得だけ**で引き直す (公開 API に
					// 落ちると viewer 無しの投稿を覚え込み、開き直しても操作行が
					// 出なくなる)。この種別のボタンはこの間押せない
					const authed = await this.actions.fetchPost(post.postUri);
					refreshed = authed ? parsePostForPanel(authed, this.config) : null;
					if (refreshed && refreshed.viewer === null) {
						refreshed = null;
					}
					// 引き直している間に別種の操作が押されていたら、その結果を
					// 上書きしないよう引き直した内容は捨てる (renderPost() で
					// this.post が差し替わると、後から返る別種の成功が破棄ガードで
					// 捨てられ、開き直すと未反応のまま押せて 2 本目が飛ぶ)
					if (refreshed && this.hasOtherPending(post.postUri, key)) {
						refreshed = null;
					}
					if (refreshed) {
						this.remember(post.postUri, refreshed);
					}
				}
			}
			this.pending.delete(key);

			// 応答を待つ間に別の投稿へ移った・閉じたままなら、画面への反映は捨てる
			// (書き戻しは上で完了しているので、次に開いたときは正しい状態から描かれる)
			if (this.post !== post) {
				return;
			}
			// ここから先は同じ投稿を表示中 (閉じて同じ投稿を開き直した場合を含む。
			// その場合 this.state は書き戻し前の post.viewer から作り直されているが、
			// 値で写すため結果は同じ)
			if (result.ok) {
				this.state = mergeActionKind(this.state, kind, next);
				this.renderActions();
				return;
			}
			if (refreshed) {
				// サーバの真実で描き直す。意図した状態になっていれば、実は成功していた
				this.renderPost(refreshed);
				if (!isActionApplied(this.state, kind, next)) {
					this.showActionError();
				}
				return;
			}
			// 引き直せなかった (または別種が飛行中): その種別だけ押す前へ戻す
			this.state = revertActionState(this.state, kind, previous);
			this.renderActions();
			this.showActionError();
		} catch (error) {
			console.error('[XViewer] 投稿操作に失敗しました', error);
			if (key) {
				this.pending.delete(key);
			}
			// 成功経路と同じ破棄ガード。**別の投稿を開いた後に例外が来ると、
			// previous (前の投稿の URI) を今の投稿の状態へ書き込んでしまい、
			// 次の押下で別の投稿のいいねを消す**経路になる
			if (!post || this.post !== post) {
				return;
			}
			// 通信していないのに見た目だけ変わったままにしない。その種別だけを
			// 押す前へ戻す (this.state が既に無ければ何もしない)
			if (previous && this.state) {
				this.state = revertActionState(this.state, kind, previous);
				this.renderActions();
				this.showActionError();
			}
		}
	}

	/**
	 * 同じ投稿に、指定したキー以外の飛行中の操作があるか。
	 * @param {string} postUri
	 * @param {string} ownKey 自分の飛行中の印
	 * @returns {boolean}
	 */
	hasOtherPending(postUri, ownKey) {
		const prefix = buildPendingKey(postUri, '', EXT_CONFIG.postActions);
		for (const pendingKey of this.pending) {
			if (pendingKey !== ownKey && pendingKey.startsWith(prefix)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * 種別に応じた通信を 1 回行う。
	 * @param {'like'|'repost'|'bookmark'} kind
	 * @param {PanelPost} post
	 * @param {ActionState} previous 押す前の状態 (取り消しの URI を持つ)
	 * @param {ActionState} next 押した後の状態
	 * @returns {Promise<{ok: boolean, recordUri: string|null}>}
	 */
	async callAction(kind, post, previous, next) {
		if (kind === 'like') {
			return next.liked
				? this.actions.createLike(post.postUri, post.cid)
				: Object.assign(
					{recordUri: null},
					await this.actions.deleteLike(previous.likeUri)
				);
		}
		if (kind === 'repost') {
			return next.reposted
				? this.actions.createRepost(post.postUri, post.cid)
				: Object.assign(
					{recordUri: null},
					await this.actions.deleteRepost(previous.repostUri)
				);
		}
		if (kind === 'bookmark') {
			const result = next.bookmarked
				? await this.actions.createBookmark(post.postUri, post.cid)
				: await this.actions.deleteBookmark(post.postUri);
			return {ok: result.ok, recordUri: null};
		}
		return {ok: false, recordUri: null};
	}

	/**
	 * 操作行だけを描き直す。**パネル全体は作り直さない**
	 * (本文のスクロール位置と、開いているメニューが失われるため)。
	 * @returns {void}
	 */
	renderActions() {
		try {
			if (!this.bodyEl || !this.state) {
				return;
			}
			this.closeRepostMenu();
			const current = this.bodyEl.querySelector(
				`.${EXT_CONFIG.postActions.actionsClass}`
			);
			if (!current) {
				return;
			}
			current.replaceWith(this.buildActions());
			const stale = this.bodyEl.querySelector(`.${EXT_CONFIG.postActions.errorClass}`);
			if (stale) {
				stale.remove();
			}
		} catch (error) {
			console.error('[XViewer] 操作行の描き直しに失敗しました', error);
		}
	}

	/**
	 * 返信欄で返信を投稿・削除したときに、投稿の返信数を合わせる。
	 * 覚えている投稿 (キャッシュ) と本体へ渡す生データ (raw) も同じ値にする。0 未満にしない
	 * @param {number} delta
	 * @returns {void}
	 */
	adjustReplyCount(delta) {
		try {
			const post = this.post;
			if (!post) {
				return;
			}
			const next = Math.max(0, (post.counts.reply || 0) + delta);
			post.counts.reply = next;
			if (post.raw && typeof post.raw === 'object') {
				post.raw.replyCount = next;
			}
			if (this.state) {
				this.state.counts.reply = next;
			}
			if (!this.bodyEl) {
				return;
			}
			if (this.bodyEl.querySelector(`.${EXT_CONFIG.postActions.actionsClass}`)) {
				this.renderActions();
				return;
			}
			const counts = this.bodyEl.querySelector(`.${this.config.countsClass}`);
			if (counts) {
				counts.replaceWith(this.buildCounts(post));
			}
		} catch (error) {
			console.error('[XViewer] 返信数の更新に失敗しました', error);
		}
	}

	/**
	 * 本体の投稿作成モーダルを開く。**ライトボックスは閉じない**
	 * (2026-09-09 実測で同時に開けることを確認済み。CSS で前面に出している)。
	 * @param {'reply'|'quote'} mode
	 * @returns {Promise<void>}
	 */
	async openComposerFor(mode) {
		try {
			if (!this.post) {
				return;
			}
			this.closeRepostMenu();
			// 本体の openComposer は quote に完全な PostView を要求する
			// (部分オブジェクトを渡すと本体の React ツリーが落ちる。
			// 2026-09-09 実機で確認)。replyTo も同じ形で動くことを確認済みのため、
			// 返信・引用のどちらでも raw (getPosts の post をそのまま) を渡し、
			// 経路を 1 本にする。raw が無ければ本体を落とすより何もしないほうが良い
			if (!this.post.raw) {
				this.showActionError();
				return;
			}
			const result = await this.actions.openComposer(mode, this.post.raw);
			if (!result.ok) {
				this.showActionError();
			}
		} catch (error) {
			console.error('[XViewer] 投稿作成モーダルを開けませんでした', error);
		}
	}

	/**
	 * リポストのメニューを開閉する。
	 * **本体のリポストボタンと同じく「リポスト / 引用」の 2 つを出す。**
	 * 外を押したら閉じる。Escape はライトボックスを閉じるため受けない
	 * (メニューだけ閉じる挙動にすると、閉じたつもりが閉じない誤解を生む)
	 * @param {HTMLElement} anchor 押されたボタン
	 * @returns {void}
	 */
	toggleRepostMenu(anchor) {
		try {
			if (this.menuEl) {
				this.closeRepostMenu();
				return;
			}
			if (!this.state) {
				return;
			}
			const config = EXT_CONFIG.postActions;
			const menu = document.createElement('div');
			menu.className = config.menuClass;
			menu.setAttribute('role', 'menu');
			const items = [
				{
					label: this.state.reposted ? config.text.repostUndo : config.text.repostDo,
					run: () => this.runAction('repost')
				},
				{
					label: config.text.quote,
					run: () => this.openComposerFor(config.composerModes.quote)
				}
			];
			for (const item of items) {
				const button = document.createElement('button');
				button.type = 'button';
				button.className = config.menuItemClass;
				button.setAttribute('role', 'menuitem');
				button.textContent = item.label;
				button.addEventListener('click', () => {
					this.closeRepostMenu();
					item.run();
				});
				menu.appendChild(button);
			}
			// ボタンの真上に出す。行の左端からの位置で置く
			menu.style.left = `${anchor.offsetLeft}px`;
			menu.style.bottom = `${anchor.offsetHeight + 4}px`;
			anchor.parentElement.appendChild(menu);
			this.menuEl = menu;
			this.menuAnchor = anchor;
			anchor.setAttribute('aria-expanded', 'true');
			// 開いた押下自体で閉じないよう、次の周回から外側の押下を受ける
			this.onOutsideClick = (event) => {
				// ボタン自身の押下はここで無視する。**capture 段のため、この
				// リスナーはボタンの click より先に走る。** ここで閉じてしまうと
				// 続く click が「閉じている」と見て開き直し、実質トグルが
				// 死ぬ (押しても閉じられない)
				if (!this.menuEl
					|| this.menuEl.contains(event.target)
					|| anchor.contains(event.target)) {
					return;
				}
				this.closeRepostMenu();
			};
			setTimeout(() => {
				document.addEventListener('click', this.onOutsideClick, true);
			}, 0);
		} catch (error) {
			console.error('[XViewer] リポストのメニューを開けませんでした', error);
		}
	}

	/**
	 * リポストのメニューを閉じる。**登録と同じ関数参照でリスナーを外す。**
	 * 既に閉じていれば何もしない
	 * @returns {void}
	 */
	closeRepostMenu() {
		try {
			if (this.onOutsideClick) {
				document.removeEventListener('click', this.onOutsideClick, true);
				this.onOutsideClick = null;
			}
			if (this.menuEl) {
				this.menuEl.remove();
				this.menuEl = null;
			}
			if (this.menuAnchor) {
				this.menuAnchor.setAttribute('aria-expanded', 'false');
				this.menuAnchor = null;
			}
		} catch (error) {
			console.error('[XViewer] リポストのメニューを閉じられませんでした', error);
		}
	}

	/**
	 * 操作の失敗を 1 行で伝える。**alert は使わない**
	 * (ライトボックスの操作が止まるため)。次の操作が成功したら消える
	 * @returns {void}
	 */
	showActionError() {
		try {
			if (!this.bodyEl) {
				return;
			}
			const config = EXT_CONFIG.postActions;
			let line = this.bodyEl.querySelector(`.${config.errorClass}`);
			if (!line) {
				line = document.createElement('p');
				line.className = config.errorClass;
				line.setAttribute('role', 'alert');
				this.bodyEl.appendChild(line);
			}
			line.textContent = config.text.failed;
		} catch (error) {
			console.error('[XViewer] 失敗の表示に失敗しました', error);
		}
	}

	/**
	 * 「投稿を開く」ボタンを作る。
	 * @param {PanelPost} post
	 * @returns {HTMLElement}
	 */
	buildOpenPost(post) {
		const config = this.config;
		const routes = EXT_CONFIG.mediaGrid.bridge.routes;
		const button = document.createElement('button');
		button.type = 'button';
		button.className = config.openPostClass;
		button.appendChild(createIcon(document, 'openInNew'));
		const label = document.createElement('span');
		label.textContent = config.text.openPost;
		button.appendChild(label);
		button.addEventListener('click', () => this.leaveTo({
			route: routes.post,
			params: {name: post.handle, rkey: post.rkey}
		}));
		return button;
	}

	/**
	 * ライトボックスを閉じてから SPA 遷移する。
	 * 閉じるのに失敗しても遷移は試みる (本体が遷移で畳むため)。
	 * @param {{route: string, params: Object}} target
	 * @returns {Promise<void>}
	 */
	async leaveTo(target) {
		const actions = EXT_CONFIG.mediaGrid.bridge.actions;
		try {
			await callBridge(actions.closeLightbox, {});
			await callBridge(actions.navigate, target);
		} catch (error) {
			console.error('[XViewer] パネルからの遷移に失敗しました', error);
		} finally {
			// callBridge は仕様上 reject しないが、finally にしておくことで
			// 「遷移に失敗したのに right が戻らない」経路を構造的に無くす
			this.teardown();
		}
	}

	/**
	 * ライトボックスを返信の画像で開き直す。パネルは開き直したライトボックスの
	 * postUri (返信) で引き直す。
	 *
	 * 本体は開いている間の openLightbox を無視するため、閉じてから開く
	 * (2026-10-18 実測)。開閉の通知は次のフレームで届くので、閉じたと伝わるのを
	 * 待ってから開く。待たずに開くと通知が「開いたまま」に見え、パネルと
	 * 操作性の調整が閉じたライトボックスの後始末を飛ばす。
	 * 開けなかったときは返信の投稿ページへ移る
	 * @param {import('./lightbox-replies.js').ReplyMediaRequest} request
	 * @returns {Promise<void>}
	 */
	async openReplyMedia(request) {
		const bridge = EXT_CONFIG.mediaGrid.bridge;
		try {
			const closed = this.waitForClose(EXT_CONFIG.lightboxReplies.media.closeWaitMs);
			await callBridge(bridge.actions.closeLightbox, {});
			await closed;
			const result = await callBridge(bridge.actions.openLightbox, {
				images: request.images,
				index: request.index,
				metricsContext: {
					postUri: request.postUri,
					postAuthorDid: request.authorDid || undefined,
					layout: bridge.lightboxLayout
				}
			});
			if (result && result.ok) {
				return;
			}
			ExtDebug.log('返信の画像を開けなかった', {理由: result && result.reason});
			await callBridge(bridge.actions.navigate, {
				route: bridge.routes.post,
				params: {name: request.handle, rkey: request.rkey}
			});
		} catch (error) {
			console.error('[XViewer] 返信の画像を開けませんでした', error);
		}
	}

	/**
	 * ライトボックスが閉じたと伝わるまで待つ。上限を過ぎたら待たずに解決する。
	 * @param {number} timeoutMs
	 * @returns {Promise<void>}
	 */
	waitForClose(timeoutMs) {
		return new Promise((resolve) => {
			let timer = null;
			const done = () => {
				clearTimeout(timer);
				this.closeWaiters.delete(done);
				resolve();
			};
			this.closeWaiters.add(done);
			timer = setTimeout(done, timeoutMs);
		});
	}

	/** 閉じたと伝わるのを待っている呼び出しをすべて解決する。 */
	releaseCloseWaiters() {
		for (const done of [...this.closeWaiters]) {
			done();
		}
	}
}
