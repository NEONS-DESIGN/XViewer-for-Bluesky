/**
 * ライトボックスに重ねる投稿情報パネル。
 * 画像を開いたとき、右側に本文・投稿日時・作者・反応数を並べる。
 *
 * **メディアグリッド由来かどうかを知らない。** 開いているライトボックスの
 * activeLightbox.metricsContext.postUri を橋渡し (get-lightbox) で読み、
 * 投稿を引くだけ。グリッド側は openLightbox に
 * 本体と同じ metricsContext を添えるため、経路が 1 本で済む。
 *
 * **取得は getPostThread の 1 回で、投稿と返信の一覧 (1 段目) を一緒に読む**
 * (本体の投稿画面も 1 回で投稿と返信を読む)。返信欄にはその応答をそのまま渡す。
 * まず橋渡し経由の認証付きを試し、失敗したときだけ公開 API に落ちる
 * (viewer は認証付きでしか返らないため)。スレッドとして読めない投稿 (ブロックなど) は
 * getPosts に落ちる。**取得した投稿は開いている間しか覚えない。**
 *
 * 依存: config.js (EXT_CONFIG) / debug.js (ExtDebug) / at-uri.js /
 *       bridge-client.js (callBridge) / icons.js (createIcon) / routes.js /
 *       page.js (subscribeLightboxVisibility, isLightboxVisible,
 *       findVisibleLightboxDialog) /
 *       post-actions.js (PostActions, readViewerState, toggleActionState,
 *       mergeActionKind, isActionApplied)
 */
import {EXT_CONFIG} from '../common/config.js';
import {ExtDebug} from '../common/debug.js';
import {createIcon} from '../common/icons.js';
import {parsePostAtUri} from '../common/at-uri.js';
import {buildUrl, fetchOkJson} from '../common/http.js';
import {loadSyncSettings, watchSyncSettings} from '../common/sync-settings.js';
import {callBridge} from './bridge-client.js';
import {postRoute, profileRoute, hashtagRoute, openLightboxPayload} from './routes.js';
import {subscribeLightboxVisibility, isLightboxVisible, findVisibleLightboxDialog} from './page.js';
import {installPanelFocusGuard} from './panel-focus-guard.js';
import {installPanelDropGuard} from './panel-drop-guard.js';
import {LightboxReplies} from './lightbox-replies.js';
import {threadPostView} from './reply-text.js';
import {SheetHost} from './reply-sheets.js';
import {
	PostActions, readViewerState, toggleActionState, mergeActionKind, isActionApplied, toCount, parseRecordUri
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
 * @property {Object} raw 取得した PostView (getPostThread の thread.post / getPosts の posts[0]) そのもの。
 *   **本体の投稿作成モーダル (openComposer) に渡すためだけの生データで、
 *   整形しない。** `quote` は完全な PostView を要求し、整形した部分
 *   オブジェクトを渡すと本体の React ツリーがアンマウントされる
 *   (2026-09-09 実機で確認)
 * @property {Object|null} viewer PostView の viewer をそのまま。
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

/**
 * パネルが開いた後に読み込む投稿の手がかり。返信の画像から開き直すとき、
 * 返信欄が手元に持つ投稿 (と、返信の一覧が揃っていればその応答) を渡し、引き直しを省く。
 * @typedef {Object} PanelSeed
 * @property {string} postUri
 * @property {Object} view PostView
 * @property {import('./lightbox-replies.js').ThreadResult|null} thread 返信の一覧まで揃っていれば
 */

/**
 * 投稿の AT URI を分解する。投稿以外のコレクションは弾く。
 * @param {string} uri
 * @returns {{did: string, rkey: string}|null} 形が違えば null
 */
export function parsePostUri(uri) {
	return parsePostAtUri(uri);
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
 * getPosts のレスポンスをパネルに描ける形にする。
 * @param {Object|null} json getPosts のレスポンス
 * @param {Object} config EXT_CONFIG.lightboxPanel
 * @returns {PanelPost|null} 読めなければ null
 */
export function parsePostForPanel(json, config) {
	return parsePostView(json && Array.isArray(json.posts) ? json.posts[0] : null, config);
}

/**
 * PostView 1 件をパネルに描ける形にする。
 * @param {Object|null} post PostView (getPosts の posts[0]・getPostThread の thread.post)
 * @param {Object} config EXT_CONFIG.lightboxPanel
 * @returns {PanelPost|null} 読めなければ null
 */
export function parsePostView(post, config) {
	try {
		if (!post || typeof post !== 'object') {
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
				reply: toCount(post.replyCount),
				repost: toCount(post.repostCount),
				like: toCount(post.likeCount),
				quote: toCount(post.quoteCount)
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
	const count = toCount(value);
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
 * 反応を書いた (消した) アカウントの DID。いいね・リポストはレコードの URI の持ち主
 * (覚えていた DID が古くて書き直したときも、実際に書いた先を指す)、ブックマークは押した時点の DID。
 * @param {'like'|'repost'|'bookmark'} kind
 * @param {ActionState} previous 押す前
 * @param {ActionState} next 押した後 (成功なら作ったレコードの URI を持つ)
 * @param {string|null} pressedDid 押した時点のログイン中の DID
 * @returns {string|null}
 */
export function actionOwnerDid(kind, previous, next, pressedDid) {
	const recordUri = kind === 'like'
		? (next.likeUri || previous.likeUri)
		: (kind === 'repost' ? (next.repostUri || previous.repostUri) : null);
	const parsed = recordUri ? parseRecordUri(recordUri) : null;
	return parsed ? parsed.did : pressedDid;
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
 * (閉じた後は引けない)。要素が既に消えていれば何もしない
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
		/**
		 * 次に開くライトボックスで使う投稿の手がかり (返信の画像から開き直すとき)。
		 * 開いたときに postUri が合えば使い、合わなくても捨てる
		 * @type {PanelSeed|null}
		 */
		this.seed = null;
		/**
		 * 自分の反応の結果。キーは buildPendingKey() と同じ「投稿 + 種別」。
		 * 取得した投稿は開いている間しか覚えないため、反応の直後に開き直したときに
		 * AppView の反映の遅れで未反応に戻って見えないよう、actionShadowMs のあいだ引き直した投稿に重ねる
		 * @type {Map<string, {kind: 'like'|'repost'|'bookmark', state: ActionState, did: string, at: number}>}
		 */
		this.shadows = new Map();
		/** @type {Promise<void>|null} 飛行中の open()。開く処理を二重に走らせない */
		this.opening = null;
		/**
		 * 書きかけがあるときに 1 回目の押下で止めた移動先と時刻。同じ先をもう一度押すと通す
		 * @type {{key: string, at: number}|null}
		 */
		this.leaveArmed = null;
		/** @type {HTMLElement|null} 投稿の部分 (本文・操作行)。返信欄はこの外に置き、描き直しで消さない */
		this.postEl = null;
		/** @type {HTMLElement|null} 返信欄の置き場 */
		this.repliesSlot = null;
		/**
		 * 取得の世代。応答待ちの間にライトボックスが閉じたり別の投稿に
		 * 変わったりしたら、その応答は丸ごと捨てる (MediaFetcher.generation と同じ考え方)
		 */
		this.generation = 0;
		/**
		 * 投稿操作の呼び出し層。**取得を認証付きにするためにも使う**
		 * (viewer は認証付きの取得でしか返らない)
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
		/**
		 * パネルに付けたファイルのドロップを止めるリスナーを外す関数。
		 * mountPanel() で付け、unmountPanel() で外す
		 * @type {(() => void)|null}
		 */
		this.releaseDropGuard = null;
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
			safeHref: (uri) => toSafeLinkHref(uri, this.config),
			formatDate: (iso) => formatPostDate(iso, this.config),
			actions: this.actions,
			getSheets: () => this.sheetHost
		});
		/**
		 * パネルに重ねる画面 (返信の入力欄の ALT・切り抜き・ラベル・言語・絵文字) の持ち主。
		 * パネルの要素ごとに 1 つ作り、パネルを外すときに後始末する
		 * @type {SheetHost|null}
		 */
		this.sheetHost = null;
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
		const keys = {
			enabled: config.storageKey,
			actions: EXT_CONFIG.postActions.storageKey,
			replies: EXT_CONFIG.lightboxReplies.storageKey,
			unblur: EXT_CONFIG.mediaGrid.unblur.storageKey
		};
		const defaults = {
			[keys.enabled]: config.defaultEnabled,
			[config.collapsedStorageKey]: config.defaultCollapsed,
			[keys.actions]: EXT_CONFIG.postActions.defaultEnabled,
			[keys.replies]: EXT_CONFIG.lightboxReplies.defaultEnabled,
			[keys.unblur]: EXT_CONFIG.mediaGrid.unblur.defaultEnabled
		};
		const stored = await loadSyncSettings(defaults, 'パネル');
		this.enabled = stored[keys.enabled];
		this.collapsed = stored[config.collapsedStorageKey];
		this.actionsEnabled = stored[keys.actions];
		this.repliesEnabled = stored[keys.replies];
		this.replies.setUnblur(stored[keys.unblur]);
		// 畳んだ状態はパネル自身が書き込むだけで、外からの変更は追わない
		delete defaults[config.collapsedStorageKey];
		watchSyncSettings(defaults, (changed) => {
			if (keys.unblur in changed) {
				this.replies.setUnblur(changed[keys.unblur]);
			}
			if (keys.actions in changed || keys.replies in changed) {
				if (keys.actions in changed) {
					this.actionsEnabled = changed[keys.actions];
				}
				if (keys.replies in changed) {
					this.repliesEnabled = changed[keys.replies];
				}
				// 描画済みのパネルにその場で反映する (リロードを求めない)。
				// 返信欄は同じ投稿なら作り直さず、書き込めるかだけを合わせる (書きかけを消さない)
				if (this.post) {
					this.renderPost(this.post);
				}
			}
			if (keys.enabled in changed) {
				this.setEnabled(changed[keys.enabled]);
			}
		}, 'パネル');
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
	open() {
		// 開く処理の途中 (橋渡しの往復待ち) にもう一度呼ばれても、同じ世代のうちは二重に組まない
		if (this.opening && this.opening.generation === this.generation) {
			return this.opening.promise;
		}
		const generation = this.generation;
		const promise = this.openOnce(generation).finally(() => {
			if (this.opening && this.opening.promise === promise) {
				this.opening = null;
			}
		});
		this.opening = {generation, promise};
		return promise;
	}

	/**
	 * パネルを 1 回組む。open() からだけ呼ぶ。
	 * @param {number} generation 呼んだ時点の世代
	 * @returns {Promise<void>}
	 */
	async openOnce(generation) {
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
			// 互いに依存しない 2 つの往復は並べて待つ。
			// 本体のアカウント切り替えはリロードを伴わないため、開くたびに DID を問い合わせ直す
			const [result, session] = await Promise.all([
				callBridge(EXT_CONFIG.mediaGrid.bridge.actions.getLightbox, {}),
				this.actions.refreshSessionDid()
			]);
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
			if (session.changed) {
				// viewer (いいね済みか等) は人ごとに違う。前の人の手がかり・反応の結果は使わない
				this.seed = null;
				this.shadows.clear();
			}

			const postUri = result.postUri;
			this.mountPanel();
			this.applyShrink();

			const seed = this.takeSeed(postUri);
			let loaded = seed ? {post: parsePostView(seed.view, this.config), thread: seed.thread} : null;
			if (!loaded || !loaded.post) {
				this.renderStatus(this.config.text.loading);
				ExtDebug.log('パネルの取得を開始', {postUri});
				loaded = await this.loadPost(postUri);
			}
			if (generation !== this.generation || !this.panelEl) {
				return;
			}
			if (!loaded || !loaded.post) {
				this.renderStatus(this.config.text.error);
				return;
			}
			this.applyShadows(loaded.post);
			this.renderPost(loaded.post, loaded.thread);
			ExtDebug.log('パネルの取得が終了', {
				postUri, 本文の長さ: loaded.post.text.length, 返信も読んだ: !!loaded.thread, 手がかり: !!seed
			});
		} catch (error) {
			console.error('[XViewer] パネルの表示に失敗しました', error);
		}
	}

	/**
	 * 手がかりを取り出して消す。postUri が違えば使わない。
	 * @param {string} postUri
	 * @returns {PanelSeed|null}
	 */
	takeSeed(postUri) {
		const seed = this.seed;
		this.seed = null;
		return seed && seed.postUri === postUri && seed.view ? seed : null;
	}

	/**
	 * 自分の反応の結果のうち、まだ新しいものを引き直した投稿に重ねる。古いものは捨てる。
	 * @param {PanelPost} post
	 * @returns {void}
	 */
	applyShadows(post) {
		const now = Date.now();
		for (const [key, shadow] of Array.from(this.shadows)) {
			if (now - shadow.at > this.config.actionShadowMs) {
				this.shadows.delete(key);
				continue;
			}
			// 別のアカウントで付けた反応は重ねない (viewer は人ごとに違う)
			if (shadow.did === this.actions.sessionDid
				&& key === buildPendingKey(post.postUri, shadow.kind, EXT_CONFIG.postActions)) {
				syncPostViewer(post, shadow.kind, shadow.state);
			}
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
		this.leaveArmed = null;
		// **this.pending は消さない。** 飛行中の createRecord の印まで消すと、
		// 同じ画像をすぐ開き直したときにボタンが押せる状態に戻り、2 本目の
		// レコードができて片方が取り消せなくなる (2.6.6 で塞いだ Critical)。
		// runAction() は成功・失敗・例外のいずれの経路でも印を消すため、
		// ここで消さなくても印が残り続けることはない
		this.unmountPanel();
	}

	/**
	 * 投稿を引く。**getPostThread の 1 回で投稿と返信の 1 段目を一緒に読む**
	 * (返信欄が OFF なら depth 0 で投稿だけ)。認証付きを先に試し、だめなら公開 API。
	 * スレッドとして読めない (ブロック・形の違う応答) ときだけ getPosts に落ちる。
	 * 見つからないと分かった投稿は getPosts で引き直さない (同じ答えになるため)
	 * @param {string} postUri
	 * @returns {Promise<{post: PanelPost, thread: import('./lightbox-replies.js').ThreadResult|null}|null>}
	 *   読めなければ null。thread は返信の一覧まで読めたときだけ
	 */
	async loadPost(postUri) {
		const depth = this.repliesEnabled ? EXT_CONFIG.lightboxReplies.depth.root : 0;
		const thread = await this.replies.fetchThread(postUri, depth);
		const post = parsePostView(threadPostView(thread.json), this.config);
		if (post && thread.fromPublic) {
			// 認証付きのスレッドが一時的に読めなかった。viewer (操作行に要る) だけは認証付きの getPosts で取り直す
			const authed = parsePostForPanel(await this.actions.fetchPost(postUri), this.config);
			if (authed && authed.viewer) {
				return {post: authed, thread: depth > 0 ? thread : null};
			}
		}
		if (post) {
			return {post, thread: depth > 0 ? thread : null};
		}
		if (thread.notFound) {
			return null;
		}
		const fallback = await this.fetchPost(postUri);
		return fallback ? {post: fallback, thread: null} : null;
	}

	/**
	 * getPosts で投稿を 1 件引く。認証付きを先に試し、だめなら公開 API
	 * (viewer が無いので操作ボタンは出ない)。
	 * @param {string} postUri
	 * @returns {Promise<PanelPost|null>} 読めなければ null
	 */
	async fetchPost(postUri) {
		const authed = parsePostForPanel(await this.actions.fetchPost(postUri), this.config);
		if (authed) {
			return authed;
		}
		const api = this.config.api;
		const json = await fetchOkJson(buildUrl(api.origin, api.postsPath, {uris: postUri}), api.timeoutMs);
		return parsePostForPanel(json, this.config);
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
			this.sheetHost = new SheetHost(panel, EXT_CONFIG.lightboxReplies.compose);
		} catch (error) {
			this.sheetHost = null;
			console.error('[XViewer] パネルに重ねる画面を用意できませんでした', error);
		}
		try {
			this.releaseFocusGuard = installPanelFocusGuard(panel, () => (this.replies
				? this.replies.readKeyState()
				: {hasDraft: false, confirming: false}));
		} catch (error) {
			console.error('[XViewer] パネルのフォーカスの扱いを付けられませんでした', error);
		}
		try {
			this.releaseDropGuard = installPanelDropGuard(panel, EXT_CONFIG.lightboxReplies.compose.noDropEffect);
		} catch (error) {
			console.error('[XViewer] パネルのドロップの扱いを付けられませんでした', error);
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
			if (this.sheetHost) {
				try {
					this.sheetHost.destroy();
				} catch (error) {
					console.error('[XViewer] パネルに重ねる画面の後始末に失敗しました', error);
				}
				this.sheetHost = null;
			}
			if (this.releaseFocusGuard) {
				try {
					this.releaseFocusGuard();
				} catch (error) {
					console.error('[XViewer] パネルのフォーカスの扱いを外せませんでした', error);
				}
				this.releaseFocusGuard = null;
			}
			if (this.releaseDropGuard) {
				try {
					this.releaseDropGuard();
				} catch (error) {
					console.error('[XViewer] パネルのドロップの扱いを外せませんでした', error);
				}
				this.releaseDropGuard = null;
			}
			this.panelEl = null;
			this.toggleEl = null;
			this.bodyEl = null;
			this.postEl = null;
			this.repliesSlot = null;
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
			if (this.collapsed && this.sheetHost && this.sheetHost.isOpen()) {
				// 畳んだパネルでは重ねる画面が見えないまま開いた扱いになるため、取り消して閉じる
				this.sheetHost.cancel(false);
			}
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
		this.postEl = null;
		this.repliesSlot = null;
		const status = document.createElement('p');
		status.className = this.config.statusClass;
		status.textContent = message;
		this.bodyEl.appendChild(status);
	}

	/**
	 * 本文の入れ物の中に、投稿の部分と返信欄の置き場を用意する (無ければ作る)。
	 * 2 つとも display: contents で、本文の入れ物の並び (gap) はそのまま効く
	 * @returns {void}
	 */
	ensureBodyParts() {
		if (this.postEl && this.postEl.parentNode === this.bodyEl
			&& this.repliesSlot && this.repliesSlot.parentNode === this.bodyEl) {
			return;
		}
		this.bodyEl.textContent = '';
		this.postEl = document.createElement('div');
		this.postEl.className = this.config.postPartClass;
		this.repliesSlot = document.createElement('div');
		this.repliesSlot.className = this.config.postPartClass;
		this.bodyEl.appendChild(this.postEl);
		this.bodyEl.appendChild(this.repliesSlot);
	}

	/**
	 * 投稿をパネルに描く。**返信欄は同じ投稿なら作り直さない** (設定の切り替えや、
	 * 操作の失敗の後の引き直しで描き直しても、返信の書きかけと動画のアップロードを消さない)。
	 * @param {PanelPost} post
	 * @param {import('./lightbox-replies.js').ThreadResult|null} [thread] 一緒に読んだ返信の一覧
	 * @returns {void}
	 */
	renderPost(post, thread = null) {
		try {
			if (!this.bodyEl) {
				return;
			}
			// 投稿の部分をまるごと作り直すため、メニューが宙に浮く前に片付ける
			// (chrome.storage.onChanged からの再描画は mountPanel() を経由せず
			// ここへ直接来るため、renderActions() の片付けだけでは足りない)
			this.closeRepostMenu();
			const config = this.config;
			this.post = post;
			this.state = readViewerState(post.viewer, post.counts);
			this.ensureBodyParts();
			const part = this.postEl;
			part.textContent = '';
			part.appendChild(this.buildAuthor(post));

			const text = document.createElement('p');
			text.className = config.textClass;
			for (const segment of post.segments) {
				text.appendChild(this.buildSegment(segment));
			}
			part.appendChild(text);

			const formatted = formatPostDate(post.createdAt, config);
			if (formatted) {
				const date = document.createElement('time');
				date.className = config.dateClass;
				date.setAttribute('datetime', post.createdAt);
				date.textContent = formatted;
				part.appendChild(date);
			}

			part.appendChild(this.shouldShowActions(post)
				? this.buildActions()
				: this.buildCounts(post));
			part.appendChild(this.buildOpenPost(post));
			if (this.repliesEnabled) {
				this.replies.mount(this.repliesSlot, post, {canWrite: this.shouldShowActions(post), thread});
			} else {
				this.replies.destroy();
			}
		} catch (error) {
			console.error('[XViewer] パネルの描画に失敗しました', error);
			// 本文の入れ物ごと消すため、外れた入力欄 (動画のアップロードを含む) も後始末する
			this.replies.destroy();
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
			const target = segment.kind === 'mention'
				? profileRoute(segment.value)
				: hashtagRoute(segment.value);
			button.addEventListener('click', () => this.leaveTo(target));
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
			// 押した時点のアカウント。応答を待つ間に本体でアカウントを切り替えたら、結果を今の人の画面へ写さない
			const did = this.actions.sessionDid;
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
				// 掴んでいる投稿に反映する。**この種別のフィールドだけを書く**
				// (別種の操作が同時に飛行中の場合がある。全フィールドを書くと
				// 互いの結果を消し合う)。開き直した後の投稿にも重ねられるよう、結果を控える
				syncPostViewer(post, kind, next);
				const actor = actionOwnerDid(kind, previous, next, did);
				if (actor !== null && actor === this.actions.sessionDid) {
					this.shadows.set(key, {kind, state: next, did: actor, at: Date.now()});
				}
			} else {
				// **失敗しても「押す前の状態」を覚え込まない。** サーバ側では
				// 成功していることがあり、覚えたままにすると recordUri を永久に失い、
				// 次の押下で 2 本目のレコードができる。控えた結果も捨ててサーバの真実に任せる
				this.shadows.delete(key);
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
				}
			}
			this.pending.delete(key);

			// 応答を待つ間に別の投稿へ移った・閉じたままなら、画面への反映は捨てる
			// (成功の結果は控えたので、次に開いたときは引き直した投稿に重ねて描かれる)。
			// **比べるのは投稿の URI。** 閉じて同じ投稿を開き直すと this.post は引き直した別の
			// オブジェクトになり、参照で比べると成功を描けず、押せる状態に戻って 2 本目が飛ぶ
			if (!this.post || !this.state || this.post.postUri !== post.postUri
				|| actionOwnerDid(kind, previous, next, did) !== this.actions.sessionDid) {
				return;
			}
			// ここから先は同じ投稿を表示中 (閉じて同じ投稿を開き直した場合を含む。
			// その場合 this.state は書き戻し前の viewer から作り直されているが、
			// 値で写すため結果は同じ)
			if (result.ok) {
				if (this.post !== post) {
					syncPostViewer(this.post, kind, next);
				}
				this.state = mergeActionKind(this.state, kind, next);
				this.renderActions();
				return;
			}
			if (refreshed) {
				// サーバの真実で描き直す。意図した状態になっていれば、実は成功していた。
				// 少し前に成功した別の種別の結果は、AppView の反映が遅れていても残す (この種別の控えは上で捨てた)
				this.applyShadows(refreshed);
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
			if (!post || !this.post || this.post.postUri !== post.postUri) {
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
	 * (ライトボックスの操作が止まるため)。次の操作が成功したら消える。
	 * 返信欄より上 (投稿の部分の末尾) に出し、長い一覧の下に隠れないようにする
	 * @param {string} [message] 省けば「操作できませんでした」
	 * @returns {void}
	 */
	showActionError(message) {
		try {
			const container = this.postEl || this.bodyEl;
			if (!container) {
				return;
			}
			const config = EXT_CONFIG.postActions;
			let line = container.querySelector(`.${config.errorClass}`);
			if (!line) {
				line = document.createElement('p');
				line.className = config.errorClass;
				line.setAttribute('role', 'alert');
				container.appendChild(line);
			}
			line.textContent = message || config.text.failed;
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
		const button = document.createElement('button');
		button.type = 'button';
		button.className = config.openPostClass;
		button.appendChild(createIcon(document, 'openInNew'));
		const label = document.createElement('span');
		label.textContent = config.text.openPost;
		button.appendChild(label);
		button.addEventListener('click', () => this.leaveTo(postRoute(post.handle, post.rkey)));
		return button;
	}

	/**
	 * 書きかけの返信があるとき、移動の 1 回目の押下を止めて聞き返す。
	 * leaveConfirmMs のうちに同じ先をもう一度押したら通す。
	 * @param {string} key 移動先を表す文字列
	 * @returns {boolean} 移動してよいなら true
	 */
	confirmLeave(key) {
		const draft = this.repliesEnabled && this.replies.readKeyState().hasDraft;
		if (!draft) {
			this.leaveArmed = null;
			return true;
		}
		const armed = this.leaveArmed;
		if (armed && armed.key === key && Date.now() - armed.at < this.config.leaveConfirmMs) {
			this.leaveArmed = null;
			return true;
		}
		this.leaveArmed = {key, at: Date.now()};
		this.showActionError(this.config.text.leaveDraft);
		return false;
	}

	/**
	 * ライトボックスを閉じてから SPA 遷移する。
	 * 閉じるのに失敗しても遷移は試みる (本体が遷移で畳むため)。
	 * 書きかけの返信があれば、1 回目の押下では移らずに聞き返す (閉じると書きかけが消えるため)
	 * @param {import('./routes.js').RouteTarget} target
	 * @returns {Promise<void>}
	 */
	async leaveTo(target) {
		const actions = EXT_CONFIG.mediaGrid.bridge.actions;
		if (!this.confirmLeave(JSON.stringify(target))) {
			return;
		}
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
		if (!this.confirmLeave(`media:${request.postUri}:${request.index}`)) {
			return;
		}
		try {
			const closed = this.waitForClose(EXT_CONFIG.lightboxReplies.media.closeWaitMs);
			await callBridge(bridge.actions.closeLightbox, {});
			await closed;
			// 返信の投稿 (と、揃っていれば返信の一覧) は手元にある。開き直した後に引き直さない
			this.seed = request.seed && request.seed.view
				? {postUri: request.postUri, view: request.seed.view, thread: request.seed.thread || null}
				: null;
			const result = await callBridge(bridge.actions.openLightbox, openLightboxPayload(request));
			if (result && result.ok) {
				return;
			}
			this.seed = null;
			ExtDebug.log('返信の画像を開けなかった', {理由: result && result.reason});
			await callBridge(bridge.actions.navigate, postRoute(request.handle, request.rkey));
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
