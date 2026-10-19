/**
 * MAIN ワールドで動く橋渡し。
 * 分離ワールドから見えない React の内部状態 (ライトボックス制御) を扱う。
 * イベント名・操作名・白名簿の値は common/bridge-protocol.js の BRIDGE_PROTOCOL を
 * content 側 (config.js) と共有する。**白名簿の検査 (checkXrpcRequest) は受け手の
 * ここが持つ。**
 *
 * content script とは別の束 (inject.js) になる。chrome.* や EXT_CONFIG は使えないため、
 * ブラウザ API に触れない bridge-protocol.js 以外を import しないこと。
 * (同じ束に入る ./video-upload.js だけは例外で、動画のアップロードの流れを持つ)
 */
import {BRIDGE_PROTOCOL} from '../common/bridge-protocol.js';
import {VIDEO_UPLOAD, runVideoUpload} from './video-upload.js';

/** XRPC の NSID。白名簿の規則 (EXT_BRIDGE.xrpc) のキーに使う */
const NSID = BRIDGE_PROTOCOL.nsid;

export const EXT_BRIDGE = {
	requestEvent: BRIDGE_PROTOCOL.requestEvent,
	resultEvent: BRIDGE_PROTOCOL.resultEvent,
	actions: BRIDGE_PROTOCOL.actions,
	rootId: 'root',
	containerKeyPrefix: '__reactContainer$',
	tabTestIdPrefix: BRIDGE_PROTOCOL.tabTestIdPrefix,
	/**
	 * navigate で行ける先の白名簿。**ここに無いルート名は受け付けない。**
	 * 2026-09-09 に実機で push() の成功を確認した 3 つだけ
	 */
	routeNames: Object.freeze(Object.values(BRIDGE_PROTOCOL.routes)),
	maxWalkNodes: 60000,
	/** 子方向の深さの上限。兄弟はループで辿るため、実測 (232 ノード目) より十分に余裕がある */
	maxWalkDepth: 250,
	/**
	 * ライトボックスを閉じた後、本体が履歴を戻し終える (popstate) のを待つ上限。
	 * 実測では閉じてから約 0.3 秒で戻った (2026-10-18)
	 */
	lightboxHistoryTimeoutMs: 1500,
	/**
	 * call-xrpc が通す XRPC の白名簿。キーの NSID は BRIDGE_PROTOCOL.nsid から取る。
	 *
	 * ここを緩めると、この橋渡しは「本体のセッションで任意の XRPC を
	 * 呼べる汎用の穴」になる。ext:bridge-request は document 上の
	 * CustomEvent であり、bsky.app 上で動く誰でも撃てる
	 */
	xrpc: {
		[NSID.getPosts]: {target: 'appview', method: 'GET'},
		[NSID.getPostThread]: {target: 'appview', method: 'GET'},
		/**
		 * recordWrite: true は checkXrpcRequest() が collection / repo の
		 * 検査を課す目印。**文字列リテラルで別置きしない。**
		 * ここに新しく repo 書き込み系の NSID を足すときは必ず recordWrite か threadWrite
		 * (返信の連なりの applyWrites) のどちらかを付けること。
		 * bodyKeys は POST の body に通すキーの白名簿。ここに無いキー
		 * (validate / swapCommit など) は落として送る。threadWrite でない POST に
		 * bodyKeys が無ければ通さない (invalid-rule)。record を持つものは
		 * record.$type が collection と一致することも要求する
		 */
		[NSID.createRecord]: {
			target: 'pds', method: 'POST', recordWrite: true,
			bodyKeys: ['repo', 'collection', 'record']
		},
		/**
		 * threadWrite: true は自分の返信の連なり (create の 2〜10 件) だけを通す目印。
		 * checkXrpcRequest() が repo と checkThreadWrites() の検査を課し、body を
		 * {repo, writes: 検査で写した writes, validate: true} に組み直すため bodyKeys を持たない。
		 * recordWrite と同じく文字列リテラルで別置きしない
		 */
		[NSID.applyWrites]: {
			target: 'pds', method: 'POST', threadWrite: true
		},
		/**
		 * replyCheck: true は、投稿 (postCollection) を消す前に、消す相手が返信であることを
		 * appview から引いて確かめさせる目印
		 */
		[NSID.deleteRecord]: {
			target: 'pds', method: 'POST', recordWrite: true, replyCheck: true,
			bodyKeys: ['repo', 'collection', 'rkey']
		},
		[NSID.createBookmark]: {
			target: 'appview', method: 'POST', bodyKeys: ['uri', 'cid']
		},
		[NSID.deleteBookmark]: {
			target: 'appview', method: 'POST', bodyKeys: ['uri']
		}
	},
	/**
	 * createRecord / deleteRecord で触れるコレクション。
	 * ここに無いものは通さないため、フォロー・ブロックはこの橋渡しでは行えない。
	 * 投稿 (postCollection) は返信だけを通す (checkPostRecord / isReplyPostResponse)
	 */
	recordCollections: Object.freeze(Object.values(BRIDGE_PROTOCOL.collections)),
	postCollection: BRIDGE_PROTOCOL.collections.post,
	postRecord: BRIDGE_PROTOCOL.postRecord,
	thread: BRIDGE_PROTOCOL.thread,
	/** 返信の root / parent に置ける投稿の AT URI */
	postUriPattern: /^at:\/\/[^/]+\/app\.bsky\.feed\.post\/[^/]+$/,
	/** open-composer が受け付けるモード */
	composerModes: Object.freeze(Object.values(BRIDGE_PROTOCOL.composerModes))
};

/** 本文などの UTF-8 のバイト数を数える符号器。1 つだけ作って使い回す */
const textEncoder = new TextEncoder();

/** facet のリンクとリンクカードの uri の形 (http(s) で始まり空白を含まない) */
const LINK_URI_REGEX = new RegExp(BRIDGE_PROTOCOL.postRecord.linkUriPattern);
const EXTERNAL_URI_REGEX = new RegExp(BRIDGE_PROTOCOL.postRecord.external.uriPattern);

/** facet のメンションの行き先 (DID) の形 */
const MENTION_DID_REGEX = /^did:[a-z]+:\S+$/;

/** 字幕の言語タグの形 */
const CAPTION_LANG_REGEX = new RegExp(BRIDGE_PROTOCOL.video.langPattern);

/** 返信の連なりの rkey (TID) の形 */
const TID_REGEX = new RegExp(BRIDGE_PROTOCOL.thread.tidPattern);

/**
 * MAIN ワールドが本体の fetchHandler の通信を打ち切るまでの時間。
 * 分離ワールドの待ちの上限より mainMarginMs だけ短く、打ち切った返事が先に届く
 */
const TIMEOUTS = BRIDGE_PROTOCOL.timeouts;
export const MAIN_TIMEOUTS = Object.freeze({
	requestMs: TIMEOUTS.requestMs - TIMEOUTS.mainMarginMs,
	uploadMs: TIMEOUTS.uploadMs - TIMEOUTS.mainMarginMs,
	threadMs: TIMEOUTS.threadMs - TIMEOUTS.mainMarginMs
});

let lightboxControls = null;
let navigationControls = null;

/**
 * React の fiber ツリーを深さ優先で辿り、述語に合う Context の value を返す。
 * findLightboxControls / findNavigationControls / findLightboxState の共通部分。
 * @param {(value: Object) => boolean} predicate
 * @returns {Object|null}
 */
function findContextValue(predicate) {
	try {
		const rootEl = document.getElementById(EXT_BRIDGE.rootId)
			|| document.body.firstElementChild;
		if (!rootEl) {
			return null;
		}
		const containerKey = Object.keys(rootEl)
			.find((key) => key.startsWith(EXT_BRIDGE.containerKeyPrefix));
		if (!containerKey) {
			return null;
		}

		let found = null;
		let visited = 0;
		// 兄弟はループで辿る (再帰にすると兄弟の数だけ呼び出しが積まれる)。
		// 子だけ再帰するため、深さ = ツリーの深さになる
		const walk = (first, depth) => {
			if (depth > EXT_BRIDGE.maxWalkDepth) {
				return;
			}
			for (let node = first; node && !found; node = node.sibling) {
				if (visited > EXT_BRIDGE.maxWalkNodes) {
					return;
				}
				visited += 1;
				const value = node.memoizedProps && node.memoizedProps.value;
				if (value && typeof value === 'object' && predicate(value)) {
					found = value;
					return;
				}
				walk(node.child, depth + 1);
			}
		};
		// __reactContainer$ が指すのは createRoot 時点の HostRoot fiber で、
		// React はコミットごとに root.current を 2 本の alternate の間で
		// 入れ替える。そのまま起点にすると半分の確率で 1 描画前のツリーを
		// 読む (開いた直後の activeLightbox・切り替え直後のクライアントが古い)。
		// HostRoot の stateNode (FiberRootNode) の current が常に最新のコミット済みツリー
		const hostRoot = rootEl[containerKey];
		const start = (hostRoot && hostRoot.stateNode && hostRoot.stateNode.current)
			|| hostRoot;
		walk(start, 0);
		return found;
	} catch (error) {
		return null;
	}
}

/**
 * ライトボックスの開閉制御 (openLightbox / closeLightbox) を探す。
 * @returns {Object|null}
 */
function findLightboxControls() {
	return findContextValue((value) => typeof value.openLightbox === 'function');
}

/**
 * Bluesky のナビゲーションオブジェクトを探す。
 * @returns {Object|null}
 */
function findNavigationControls() {
	return findContextValue((value) => typeof value.push === 'function'
		&& typeof value.navigate === 'function'
		&& typeof value.getState === 'function');
}

/**
 * 本体のルーターで SPA 遷移する (history.pushState は使わない)。
 * route は白名簿 (EXT_BRIDGE.routeNames) のものだけを受け付ける。
 * @param {{route: string, params: Object}} payload
 * @returns {{ok: boolean, reason: string|null}}
 */
function navigate(payload) {
	const route = payload && payload.route;
	if (typeof route !== 'string' || EXT_BRIDGE.routeNames.indexOf(route) === -1) {
		return {ok: false, reason: 'unknown-route'};
	}
	const params = payload && payload.params;
	if (!params || typeof params !== 'object') {
		return {ok: false, reason: 'invalid-payload'};
	}
	for (let attempt = 0; attempt < 2; attempt += 1) {
		if (!navigationControls) {
			navigationControls = findNavigationControls();
		}
		if (!navigationControls) {
			return {ok: false, reason: 'no-router'};
		}
		try {
			navigationControls.push(route, params);
			return {ok: true, reason: null};
		} catch (error) {
			// 制御が古くなっている可能性があるので 1 度だけ取り直して再試行する
			navigationControls = null;
		}
	}
	return {ok: false, reason: 'navigate-failed'};
}

/**
 * ライトボックスを開く。制御が見つからなければ ok:false を返す。
 * @param {{images: Object[], index: number}} payload
 * @returns {{ok: boolean, reason: string|null}}
 */
function openLightbox(payload) {
	if (!payload || !Array.isArray(payload.images) || payload.images.length === 0) {
		return {ok: false, reason: 'invalid-payload'};
	}
	for (let attempt = 0; attempt < 2; attempt += 1) {
		if (!lightboxControls) {
			lightboxControls = findLightboxControls();
		}
		if (!lightboxControls) {
			return {ok: false, reason: 'no-lightbox'};
		}
		try {
			lightboxControls.openLightbox({
				images: payload.images,
				index: payload.index || 0,
				// 本体が自分で開くときと同じ形。パネルはこれを読んで投稿を引く
				metricsContext: payload.metricsContext || undefined
			});
			return {ok: true, reason: null};
		} catch (error) {
			// 制御が古くなっている可能性があるので 1 度だけ取り直して再試行する
			lightboxControls = null;
		}
	}
	return {ok: false, reason: 'open-failed'};
}

/**
 * いま開いているライトボックスの情報を返す。
 *
 * **走査結果をキャッシュしない。** React は状態が変わるたび Context の
 * value オブジェクトを作り直すため、lightboxControls と同じ要領で
 * 覚えておくと古い activeLightbox を返し続ける。実測で到達は 100 ノードなので
 * 毎回歩いて構わない。
 * @returns {{ok: boolean, open?: boolean, postUri?: string|null,
 *   postAuthorDid?: string|null, index?: number, count?: number, reason?: string}}
 */
function getLightbox() {
	const holder = findContextValue((value) => 'activeLightbox' in value);
	if (!holder) {
		return {ok: false, reason: 'no-lightbox-state'};
	}
	const active = holder.activeLightbox;
	if (!active || !Array.isArray(active.images)) {
		// 投稿作成などの別モーダルが出ているだけ
		return {ok: true, open: false};
	}
	const metrics = active.metricsContext || {};
	return {
		ok: true,
		open: true,
		postUri: typeof metrics.postUri === 'string' ? metrics.postUri : null,
		postAuthorDid: typeof metrics.postAuthorDid === 'string'
			? metrics.postAuthorDid
			: null,
		index: typeof active.index === 'number' ? active.index : 0,
		count: active.images.length
	};
}

/**
 * ライトボックスを閉じた後、本体がライトボックスの履歴を戻し終えるのを待つ。
 *
 * 本体は画像を開くと history.state に {lightbox: true} を積み、closeLightbox() の後で
 * history.back() を呼ぶ (2026-10-18 実測)。戻りは非同期で、終わる前に次の遷移
 * (pushState) を入れると、戻りの完了 (popstate) で本体のルーターが元の URL へ
 * 書き戻し、遷移が打ち消される。閉じる前に履歴が積まれていたときだけ、popstate を待つ
 * @param {Window} win popstate を受ける window
 * @param {boolean} hadLightboxHistory 閉じる前に history.state.lightbox が立っていたか
 * @param {number} timeoutMs 待つ上限。来なければ諦める (遷移は試みる)
 * @returns {Promise<boolean>} popstate を見届けたら true
 */
export function waitForLightboxHistory(win, hadLightboxHistory, timeoutMs) {
	if (!hadLightboxHistory) {
		return Promise.resolve(false);
	}
	return new Promise((resolve) => {
		let timer = null;
		const finish = (value) => {
			clearTimeout(timer);
			win.removeEventListener('popstate', onPopState);
			resolve(value);
		};
		const onPopState = () => finish(true);
		win.addEventListener('popstate', onPopState);
		timer = setTimeout(() => finish(false), timeoutMs);
	});
}

/**
 * history.state にライトボックスの履歴が積まれているか。
 * @returns {boolean}
 */
function hasLightboxHistory() {
	try {
		const state = window.history.state;
		return !!state && typeof state === 'object' && state.lightbox === true;
	} catch (error) {
		return false;
	}
}

/**
 * ライトボックスを閉じ、本体が履歴を戻し終えるまで待ってから返す。
 * 返事の後に遷移 (navigate) が来ても打ち消されないようにするため
 * @returns {Promise<{ok: boolean, reason: string|null}>}
 */
async function closeLightboxAndSettle() {
	const hadHistory = hasLightboxHistory();
	const result = closeLightbox();
	if (result.ok) {
		await waitForLightboxHistory(window, hadHistory, EXT_BRIDGE.lightboxHistoryTimeoutMs);
	}
	return result;
}

/**
 * ライトボックスを閉じる。遷移の前に確実に畳むために使う。
 * @returns {{ok: boolean, reason: string|null}}
 */
function closeLightbox() {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		if (!lightboxControls) {
			lightboxControls = findLightboxControls();
		}
		if (!lightboxControls || typeof lightboxControls.closeLightbox !== 'function') {
			lightboxControls = null;
			if (attempt === 1) {
				return {ok: false, reason: 'no-lightbox'};
			}
			continue;
		}
		try {
			lightboxControls.closeLightbox();
			return {ok: true, reason: null};
		} catch (error) {
			lightboxControls = null;
		}
	}
	return {ok: false, reason: 'close-failed'};
}

/**
 * 候補のうち、実際に描画されている (矩形の幅と高さがともに 0 より大きい) 最初の要素を返す。
 * @param {ArrayLike<Element>} nodes 候補 (文書順)
 * @returns {Element|null} 描画中のものが無ければ null
 */
export function pickRenderedElement(nodes) {
	for (let i = 0; i < nodes.length; i += 1) {
		try {
			const rect = nodes[i].getBoundingClientRect();
			if (rect.width > 0 && rect.height > 0) {
				return nodes[i];
			}
		} catch (error) {
			// 読めない要素は飛ばす
		}
	}
	return null;
}

/**
 * プロフィールのタブを切り替える。
 * SPA で別のプロフィールへ移ると前の画面のタブも矩形 0 のまま残り、同じ data-testid が
 * 複数になる。素の querySelector は前の画面のタブを掴むことがあるため、描画中のものを押す
 * @param {{index: number}} payload
 * @returns {{ok: boolean, reason: string|null}}
 */
function switchTab(payload) {
	try {
		const index = payload && payload.index;
		if (typeof index !== 'number' || index < 0) {
			return {ok: false, reason: 'invalid-payload'};
		}
		const tab = pickRenderedElement(document.querySelectorAll(
			`[data-testid="${EXT_BRIDGE.tabTestIdPrefix}${index}"]`
		));
		if (!tab) {
			return {ok: false, reason: 'no-tab'};
		}
		tab.click();
		return {ok: true, reason: null};
	} catch (error) {
		return {ok: false, reason: 'click-failed'};
	}
}

/**
 * 本体の認証済みクライアント一式を探す。
 *
 * **走査結果をキャッシュしない。** getLightbox と同じ理由で、React は
 * 状態が変わるたび Context の value を作り直す。アカウントを切り替えたあとも
 * 古いクライアントを返し続けると、別人の repo へ書き込む事故になる。
 * 走査は利用者が押したときにしか走らないため、毎回歩いて構わない
 * @returns {Object|null} {session, appviewClient, pdsClient, ...}
 */
function findClients() {
	return findContextValue((value) => typeof value.pdsClient === 'object'
		&& value.pdsClient !== null
		&& typeof value.appviewClient === 'object'
		&& value.appviewClient !== null);
}

/**
 * 投稿作成モーダルの開閉制御を探す。
 * @returns {Object|null} {openComposer, closeComposer}
 */
function findComposerControls() {
	return findContextValue((value) => typeof value.openComposer === 'function');
}

/**
 * NSID の白名簿の規則に従って、repo の検査に使う DID を読むクライアントを選ぶ
 * (callXrpc() が送る agent と同じ宛先)。
 * 白名簿に無い NSID なら appview 側を返す (その要求は checkXrpcRequest() が落とす)
 * @param {Object|null} clients findClients() の結果
 * @param {*} nsid payload.nsid (検査前の値)
 * @returns {Object|null} {agent} を持つクライアント
 */
function pickClient(clients, nsid) {
	if (!clients) {
		return null;
	}
	const rule = (typeof nsid === 'string'
		&& Object.prototype.hasOwnProperty.call(EXT_BRIDGE.xrpc, nsid))
		? EXT_BRIDGE.xrpc[nsid]
		: null;
	return rule && rule.target === 'pds' ? clients.pdsClient : clients.appviewClient;
}

/**
 * ログイン中の DID を読む。**トークンには触らない。**
 * repo の検査に使う DID と、書き込みを送る agent が別物にならないよう、
 * 実際に使うクライアントから読む
 * @param {Object|null} client pickClient() の結果
 * @returns {string|null} 未ログインなら null
 */
function readSessionDid(client) {
	try {
		const did = client && client.agent && client.agent.did;
		return typeof did === 'string' && did ? did : null;
	} catch (error) {
		return null;
	}
}

/**
 * 返信の root / parent の 1 つが {uri: 投稿の AT URI, cid: 空でない文字列} の形か。
 * @param {*} ref
 * @returns {boolean}
 */
function isPostStrongRef(ref) {
	return !!ref && typeof ref === 'object'
		&& typeof ref.uri === 'string' && EXT_BRIDGE.postUriPattern.test(ref.uri)
		&& typeof ref.cid === 'string' && ref.cid.length > 0;
}

/**
 * facets の feature 1 つが、返信欄が作る 3 種 (リンク・メンション・タグ) の
 * 正しい形か。リンクは http(s) だけ、メンションは DID だけを通す
 * (本文と行き先の違う隠しリンクや javascript: を作らせない)
 * @param {*} feature
 * @returns {boolean}
 */
function isAllowedFacetFeature(feature) {
	if (!feature || typeof feature !== 'object') {
		return false;
	}
	switch (feature.$type) {
		case 'app.bsky.richtext.facet#link':
			return typeof feature.uri === 'string' && LINK_URI_REGEX.test(feature.uri);
		case 'app.bsky.richtext.facet#mention':
			return typeof feature.did === 'string' && MENTION_DID_REGEX.test(feature.did);
		case 'app.bsky.richtext.facet#tag':
			return typeof feature.tag === 'string' && feature.tag.length > 0;
		default:
			return false;
	}
}

/**
 * record.facets が、本文の範囲に収まる正しい形の facet だけでできているか。
 * @param {*} facets
 * @param {number} textBytes 本文の UTF-8 のバイト数
 * @returns {boolean}
 */
function areAllowedFacets(facets, textBytes) {
	if (!Array.isArray(facets) || facets.length > EXT_BRIDGE.postRecord.maxFacets) {
		return false;
	}
	return facets.every((facet) => {
		const index = facet && typeof facet === 'object' ? facet.index : null;
		return !!index && typeof index === 'object'
			&& Number.isInteger(index.byteStart) && Number.isInteger(index.byteEnd)
			&& index.byteStart >= 0 && index.byteStart < index.byteEnd
			&& index.byteEnd <= textBytes
			&& Array.isArray(facet.features) && facet.features.length > 0
			&& facet.features.every(isAllowedFacetFeature);
	});
}

/** 書記素の区切り器。初めて要るときに 1 つだけ作る */
let graphemeSegmenter = null;

/**
 * 文字列の書記素 (ユーザーが 1 文字と感じる単位) の数が上限を超えるか。
 * 書記素の数は UTF-16 の長さを超えないため、長さが上限以下なら数えずに通す。
 * 数えるときも上限を超えた時点で打ち切る
 * @param {string} text
 * @param {number} max 書記素の数の上限
 * @returns {boolean} 上限を超えるなら true
 */
export function exceedsGraphemes(text, max) {
	if (text.length <= max) {
		return false;
	}
	if (graphemeSegmenter === null) {
		graphemeSegmenter = new Intl.Segmenter();
	}
	let count = 0;
	for (const unused of graphemeSegmenter.segment(text)) {
		count += 1;
		if (count > max) {
			return true;
		}
	}
	return false;
}

/**
 * 値が余分なキーを持たない素のオブジェクトで、キーが許した集合に収まるか。
 * @param {*} value
 * @param {string[]} allowed 許すキー
 * @returns {boolean}
 */
function hasOnlyKeys(value, allowed) {
	return !!value && typeof value === 'object' && !Array.isArray(value)
		&& Object.keys(value).every((key) => allowed.includes(key));
}

/**
 * aspectRatio が {width, height} の正の整数だけの形か。
 * @param {*} ratio
 * @returns {boolean}
 */
function isAspectRatio(ratio) {
	return hasOnlyKeys(ratio, ['width', 'height'])
		&& Number.isSafeInteger(ratio.width) && ratio.width > 0
		&& Number.isSafeInteger(ratio.height) && ratio.height > 0;
}

/**
 * 埋め込む Blob が、余分なキーを持たない厳密な BlobRef で、サイズが
 * 上限に収まるか。
 * @param {*} blob
 * @param {number} [maxBytes] サイズの上限 (既定はアップロードの上限)
 * @param {string[]} [mimeTypes] 許す MIME (既定は画像)
 * @returns {boolean}
 */
function isStrictEmbedBlob(blob, maxBytes = BRIDGE_PROTOCOL.upload.maxBytes.default,
	mimeTypes = EXT_BRIDGE.postRecord.imageMimeTypes) {
	return hasOnlyKeys(blob, ['$type', 'ref', 'mimeType', 'size'])
		&& hasOnlyKeys(blob.ref, ['$link'])
		&& isBlobRef(blob, mimeTypes)
		&& blob.size <= maxBytes;
}

/**
 * 画像 1 件 ({image, alt, aspectRatio?}) が正しい形か。
 * @param {*} item
 * @param {boolean} requireRatio aspectRatio を必須にするか
 * @param {string[]} extraKeys 画像 1 件に加えて許すキー ($type など)
 * @returns {boolean}
 */
function isEmbedImage(item, requireRatio, extraKeys) {
	const rule = EXT_BRIDGE.postRecord;
	if (!hasOnlyKeys(item, ['image', 'alt', 'aspectRatio'].concat(extraKeys))) {
		return false;
	}
	if (!isStrictEmbedBlob(item.image)
		|| typeof item.alt !== 'string'
		|| exceedsGraphemes(item.alt, rule.maxAltGraphemes)) {
		return false;
	}
	if (item.aspectRatio === undefined) {
		return !requireRatio;
	}
	return isAspectRatio(item.aspectRatio);
}

/**
 * images の embed (1〜4 件) の形か。
 * @param {*} embed
 * @returns {boolean}
 */
function isImagesEmbed(embed) {
	const rule = EXT_BRIDGE.postRecord;
	return !!embed && embed.$type === rule.embedTypes.images
		&& hasOnlyKeys(embed, ['$type', 'images'])
		&& Array.isArray(embed.images)
		&& embed.images.length >= 1 && embed.images.length <= rule.maxImages
		&& embed.images.every((item) => isEmbedImage(item, false, []));
}

/**
 * gallery の embed (1〜10 件) の形か。
 * @param {*} embed
 * @returns {boolean}
 */
function isGalleryEmbed(embed) {
	const rule = EXT_BRIDGE.postRecord;
	return !!embed && embed.$type === rule.embedTypes.gallery
		&& hasOnlyKeys(embed, ['$type', 'items'])
		&& Array.isArray(embed.items)
		&& embed.items.length >= 1 && embed.items.length <= rule.maxGalleryItems
		&& embed.items.every((item) => isEmbedImage(item, true, ['$type'])
			&& item.$type === rule.galleryImageType);
}

/**
 * external (リンクカード) の embed の形か。uri は http(s) だけ、thumb は
 * 無いか、上限内の画像の BlobRef だけを通す。
 * @param {*} embed
 * @returns {boolean}
 */
function isExternalEmbed(embed) {
	const rule = EXT_BRIDGE.postRecord;
	if (!embed || embed.$type !== rule.embedTypes.external
		|| !hasOnlyKeys(embed, ['$type', 'external'])) {
		return false;
	}
	const card = embed.external;
	if (!hasOnlyKeys(card, ['uri', 'title', 'description', 'thumb'])
		|| typeof card.uri !== 'string' || typeof card.title !== 'string'
		|| typeof card.description !== 'string') {
		return false;
	}
	if (textEncoder.encode(card.uri).length > rule.external.maxUriBytes
		|| !EXTERNAL_URI_REGEX.test(card.uri)
		|| exceedsGraphemes(card.title, rule.external.maxTitleGraphemes)
		|| exceedsGraphemes(card.description, rule.external.maxDescriptionGraphemes)) {
		return false;
	}
	return card.thumb === undefined
		|| isStrictEmbedBlob(card.thumb, rule.external.maxThumbBytes);
}

/**
 * record (引用) の embed の形か。引用先は投稿の AT URI と CID だけを通す。
 * @param {*} embed
 * @returns {boolean}
 */
function isRecordEmbed(embed) {
	return !!embed && embed.$type === EXT_BRIDGE.postRecord.embedTypes.record
		&& hasOnlyKeys(embed, ['$type', 'record'])
		&& hasOnlyKeys(embed.record, ['uri', 'cid'])
		&& isPostStrongRef(embed.record);
}

/**
 * 字幕 1 件 ({lang, file}) が正しい形か。file は text/vtt の厳密な BlobRef
 * @param {*} caption
 * @returns {boolean}
 */
function isVideoCaption(caption) {
	const rule = BRIDGE_PROTOCOL.video;
	return hasOnlyKeys(caption, ['lang', 'file'])
		&& typeof caption.lang === 'string'
		&& CAPTION_LANG_REGEX.test(caption.lang)
		&& isStrictEmbedBlob(caption.file, rule.captionMaxBytes, [rule.captionMimeType]);
}

/**
 * video の embed の形か。video は動画サービスが返す MIME の厳密な BlobRef、
 * captions は無いか 1〜maxCaptions 件、余分なキーは拒む。
 * @param {*} embed
 * @returns {boolean}
 */
function isVideoEmbed(embed) {
	const rule = BRIDGE_PROTOCOL.video;
	if (!embed || embed.$type !== EXT_BRIDGE.postRecord.embedTypes.video
		|| !hasOnlyKeys(embed, ['$type', 'video', 'alt', 'captions', 'aspectRatio', 'presentation'])
		|| !isStrictEmbedBlob(embed.video, rule.maxBytes, [rule.blobMimeType])) {
		return false;
	}
	if (embed.alt !== undefined && (typeof embed.alt !== 'string'
		|| exceedsGraphemes(embed.alt, EXT_BRIDGE.postRecord.maxAltGraphemes))) {
		return false;
	}
	if (embed.captions !== undefined && (!Array.isArray(embed.captions)
		|| embed.captions.length < 1 || embed.captions.length > rule.maxCaptions
		|| !embed.captions.every(isVideoCaption))) {
		return false;
	}
	if (embed.aspectRatio !== undefined && !isAspectRatio(embed.aspectRatio)) {
		return false;
	}
	return embed.presentation === undefined || embed.presentation === rule.presentation;
}

/**
 * recordWithMedia の media に置いてよい embed (images / gallery / video / external) か。
 * @param {*} embed
 * @returns {boolean}
 */
function isMediaEmbed(embed) {
	return isImagesEmbed(embed) || isGalleryEmbed(embed) || isVideoEmbed(embed)
		|| isExternalEmbed(embed);
}

/**
 * record.embed が、返信に付けてよい embed (images / gallery / video / external / record /
 * recordWithMedia) か。余分なキーは拒む
 * @param {*} embed
 * @returns {boolean}
 */
export function checkPostEmbed(embed) {
	try {
		if (!embed || typeof embed !== 'object') {
			return false;
		}
		if (embed.$type === EXT_BRIDGE.postRecord.embedTypes.recordWithMedia) {
			return hasOnlyKeys(embed, ['$type', 'record', 'media'])
				&& isRecordEmbed(embed.record) && isMediaEmbed(embed.media);
		}
		return isMediaEmbed(embed) || isRecordEmbed(embed);
	} catch (error) {
		return false;
	}
}

/**
 * record.labels が、自己ラベルの規則 (成人向けは高々 1 つ + graphic-media、
 * 計 2 つまで) に収まるか。
 * @param {*} labels
 * @returns {boolean}
 */
export function checkSelfLabels(labels) {
	try {
		const rule = EXT_BRIDGE.postRecord;
		if (!hasOnlyKeys(labels, ['$type', 'values']) || labels.$type !== rule.selfLabelsType
			|| !Array.isArray(labels.values)
			|| labels.values.length < 1 || labels.values.length > rule.maxLabels) {
			return false;
		}
		const seen = [];
		for (const entry of labels.values) {
			if (!hasOnlyKeys(entry, ['val']) || typeof entry.val !== 'string'
				|| seen.includes(entry.val)
				|| (!rule.adultLabels.includes(entry.val) && !rule.otherLabels.includes(entry.val))) {
				return false;
			}
			seen.push(entry.val);
		}
		return seen.filter((val) => rule.adultLabels.includes(val)).length <= 1;
	} catch (error) {
		return false;
	}
}

/**
 * 橋渡しから作ってよい投稿 (返信) の record かを検査する。
 * **返信でない投稿は通さず、embed は画像・動画・リンクカード・引用だけ、labels は
 * 自己ラベルだけを通す。** 作れる投稿を返信に絞ることで、ページ上の誰かが
 * この橋渡しを撃っても返信でない投稿を作れないようにする
 * @param {*} record createRecord の body.record
 * @returns {{ok: true}|{ok: false, reason: string}}
 */
export function checkPostRecord(record) {
	const reasons = BRIDGE_PROTOCOL.reasons;
	const rule = EXT_BRIDGE.postRecord;
	if (!record || typeof record !== 'object' || Array.isArray(record)) {
		return {ok: false, reason: reasons.postRecordNotAllowed};
	}
	const keys = Object.keys(record);
	for (let i = 0; i < keys.length; i += 1) {
		if (rule.allowedKeys.indexOf(keys[i]) === -1) {
			return {ok: false, reason: reasons.postRecordNotAllowed};
		}
	}
	const reply = record.reply;
	if (!reply || typeof reply !== 'object'
		|| !isPostStrongRef(reply.root) || !isPostStrongRef(reply.parent)) {
		return {ok: false, reason: reasons.postNotReply};
	}
	const textBytes = typeof record.text === 'string'
		? textEncoder.encode(record.text).length
		: -1;
	if (textBytes < 0 || textBytes > rule.maxTextBytes) {
		return {ok: false, reason: reasons.postRecordNotAllowed};
	}
	if (typeof record.createdAt !== 'string') {
		return {ok: false, reason: reasons.postRecordNotAllowed};
	}
	if (record.langs !== undefined && (!Array.isArray(record.langs)
		|| record.langs.length > rule.maxLangs
		|| record.langs.some((lang) => typeof lang !== 'string'))) {
		return {ok: false, reason: reasons.postRecordNotAllowed};
	}
	if (record.facets !== undefined && !areAllowedFacets(record.facets, textBytes)) {
		return {ok: false, reason: reasons.postRecordNotAllowed};
	}
	if (record.embed !== undefined && !checkPostEmbed(record.embed)) {
		return {ok: false, reason: reasons.postRecordNotAllowed};
	}
	if (record.labels !== undefined && !checkSelfLabels(record.labels)) {
		return {ok: false, reason: reasons.postRecordNotAllowed};
	}
	return {ok: true};
}

/**
 * getPosts の応答から、指定の投稿が返信 (record.reply を持つ) かを読む。
 * 投稿の削除の前に受け手側で確かめるために使う
 * @param {*} json getPosts の応答
 * @param {string} uri 消そうとしている投稿の AT URI
 * @returns {boolean} 見つからない・形が違うときは false
 */
export function isReplyPostResponse(json, uri) {
	try {
		const posts = json && Array.isArray(json.posts) ? json.posts : [];
		const post = posts.find((item) => item && item.uri === uri);
		const reply = post && post.record && post.record.reply;
		return !!reply && typeof reply === 'object';
	} catch (error) {
		return false;
	}
}

/**
 * applyWrites の writes (返信の連なり) を検査する。
 * 通すのは app.bsky.feed.post の create だけで、各 value は checkPostRecord() を通り、
 * 1 件目の root を全員が共有し、2 件目以降の parent は直前の件 (自分の repo) を指す。
 * @param {*} writes body.writes
 * @param {string} repo 本人の DID
 * @returns {{ok: true, writes: Object[]}|{ok: false, reason: string}} writes は
 *   4 つのキーだけを写したもの
 */
export function checkThreadWrites(writes, repo) {
	const fail = {ok: false, reason: BRIDGE_PROTOCOL.reasons.threadNotAllowed};
	const rule = EXT_BRIDGE.thread;
	try {
		if (!Array.isArray(writes) || writes.length < rule.minPosts || writes.length > rule.maxPosts) {
			return fail;
		}
		const seen = new Set();
		const checked = [];
		for (let i = 0; i < writes.length; i += 1) {
			const write = writes[i];
			if (!write || typeof write !== 'object' || Array.isArray(write)) {
				return fail;
			}
			const keys = Object.keys(write);
			if (keys.length !== rule.writeKeys.length
				|| keys.some((key) => rule.writeKeys.indexOf(key) === -1)) {
				return fail;
			}
			if (write.$type !== rule.createType || write.collection !== EXT_BRIDGE.postCollection
				|| typeof write.rkey !== 'string' || !TID_REGEX.test(write.rkey) || seen.has(write.rkey)) {
				return fail;
			}
			seen.add(write.rkey);
			const value = write.value;
			if (!value || typeof value !== 'object' || value.$type !== write.collection) {
				return fail;
			}
			const postCheck = checkPostRecord(value);
			if (!postCheck.ok) {
				return postCheck;
			}
			checked.push({
				$type: write.$type, collection: write.collection, rkey: write.rkey, value
			});
		}
		const root = checked[0].value.reply.root;
		for (let i = 1; i < checked.length; i += 1) {
			const reply = checked[i].value.reply;
			const previousUri = `at://${repo}/${EXT_BRIDGE.postCollection}/${checked[i - 1].rkey}`;
			if (reply.parent.uri !== previousUri
				|| reply.root.uri !== root.uri || reply.root.cid !== root.cid) {
				return fail;
			}
		}
		return {ok: true, writes: checked};
	} catch (error) {
		return fail;
	}
}

/**
 * call-xrpc の要求を検査する。**通らないものはここで落とす。**
 * NSID の白名簿、レコード書き込みの collection、repo が本人かの 3 段。
 * 投稿の作成は返信の record だけを通し、replyCheck の規則 (deleteRecord) で投稿を消すときは
 * needsReplyCheck を付けて返す (消す相手が返信であることの確認は通信を伴うため callXrpc() が行う)。
 * threadWrite でない POST の規則に bodyKeys が無ければ invalid-rule で落とす。
 * applyWrites (threadWrite) は repo が本人かを確かめ、writes を checkThreadWrites() で
 * 検査し (#create の app.bsky.feed.post の返信の連なり 2〜10 件だけ)、body を
 * {repo, writes: 検査で写した writes, validate: true} に組み直して返す (bodyKeys は使わない)
 * @param {Object} payload {nsid, params, body}
 * @param {string|null} sessionDid ログイン中の DID
 * @returns {{ok: true, rule: {target: string, method: string}, body: Object|null,
 *   needsReplyCheck: boolean}|{ok: false, reason: string}} body は白名簿の
 *   キーだけを写した送信用の body (GET なら null)
 */
export function checkXrpcRequest(payload, sessionDid) {
	if (!payload || typeof payload !== 'object') {
		return {ok: false, reason: 'invalid-payload'};
	}
	if (typeof payload.nsid !== 'string') {
		// hasOwnProperty はプロパティキーの ToString 変換で照合するため、
		// 配列 (["com.atproto.repo.createRecord"] 等) を渡すと白名簿には
		// hit しつつ、下の rule.recordWrite が undefined になり
		// collection / repo の検査を素通りしてしまう
		return {ok: false, reason: 'invalid-nsid'};
	}
	const rule = Object.prototype.hasOwnProperty.call(EXT_BRIDGE.xrpc, payload.nsid)
		? EXT_BRIDGE.xrpc[payload.nsid]
		: null;
	if (!rule) {
		return {ok: false, reason: 'nsid-not-allowed'};
	}
	// 白名簿 (rule.recordWrite) から導く。文字列リテラルを別置きすると
	// 白名簿に NSID を足しても検査が追随しない事故が起きる
	const isRecordWrite = rule.recordWrite === true;
	const isThreadWrite = rule.threadWrite === true;
	if (rule.method !== 'POST') {
		return {ok: true, rule, body: null, needsReplyCheck: false};
	}
	const body = payload.body;
	if (!body || typeof body !== 'object') {
		return {ok: false, reason: 'invalid-body'};
	}
	if (isThreadWrite) {
		if (!sessionDid || body.repo !== sessionDid) {
			return {ok: false, reason: BRIDGE_PROTOCOL.reasons.repoNotSelf};
		}
		const thread = checkThreadWrites(body.writes, body.repo);
		if (!thread.ok) {
			return thread;
		}
		// validate は常に true で送る。swapCommit などの余分な指定は落とす
		return {
			ok: true,
			rule,
			body: {repo: body.repo, writes: thread.writes, validate: true},
			needsReplyCheck: false
		};
	}
	if (isRecordWrite) {
		if (EXT_BRIDGE.recordCollections.indexOf(body.collection) === -1) {
			return {ok: false, reason: 'collection-not-allowed'};
		}
		if (!sessionDid || body.repo !== sessionDid) {
			return {ok: false, reason: BRIDGE_PROTOCOL.reasons.repoNotSelf};
		}
	}
	// 白名簿のキーだけを写して送る (validate: false などの余分な指定を通さない)。
	// bodyKeys の無い POST の規則は、何を通すかが決まっていないため通さない
	if (!Array.isArray(rule.bodyKeys)) {
		return {ok: false, reason: 'invalid-rule'};
	}
	const sanitized = {};
	for (let i = 0; i < rule.bodyKeys.length; i += 1) {
		const key = rule.bodyKeys[i];
		if (Object.prototype.hasOwnProperty.call(body, key)) {
			sanitized[key] = body[key];
		}
	}
	const hasRecord = rule.bodyKeys.includes('record');
	if (hasRecord) {
		// レコードの $type は collection と一致させる (別コレクション形の
		// レコードを自分の like コレクションに置けないようにする)
		const record = sanitized.record;
		if (!record || typeof record !== 'object' || record.$type !== body.collection) {
			return {ok: false, reason: 'record-type-mismatch'};
		}
	}
	if (rule.bodyKeys.includes('rkey')
		&& (typeof sanitized.rkey !== 'string' || !sanitized.rkey)) {
		return {ok: false, reason: 'invalid-rkey'};
	}
	const isPost = isRecordWrite && body.collection === EXT_BRIDGE.postCollection;
	if (isPost && hasRecord) {
		const postCheck = checkPostRecord(sanitized.record);
		if (!postCheck.ok) {
			return postCheck;
		}
	}
	return {
		ok: true,
		rule,
		body: sanitized,
		needsReplyCheck: isPost && rule.replyCheck === true
	};
}

/**
 * 本体のクライアント一式から、宛先 (pds / appview) の agent を取り出す。
 * @param {Object|null} clients findClients() の結果
 * @param {'pds'|'appview'} target 宛先
 * @returns {Object|null} fetchHandler を持つ agent。無ければ null
 */
function getAgent(clients, target) {
	const client = clients
		? (target === 'pds' ? clients.pdsClient : clients.appviewClient)
		: null;
	const agent = client && client.agent;
	return agent && typeof agent.fetchHandler === 'function' ? agent : null;
}

/**
 * 応答の本文を JSON として読む。読めなければ null。
 * @param {{json: function(): Promise<any>}} response fetch / fetchHandler の応答
 * @returns {Promise<any>}
 */
async function readJsonSafely(response) {
	try {
		return await response.json();
	} catch (error) {
		return null;
	}
}

/**
 * 文字列を JSON として読む。読めなければ null。
 * @param {string} text
 * @returns {any}
 */
function parseJsonSafely(text) {
	try {
		return JSON.parse(text);
	} catch (error) {
		return null;
	}
}

/**
 * 消そうとしている投稿が返信であることを、本体の appview から引いて確かめる。
 * @param {Object|null} clients findClients() の結果
 * @param {{repo: string, rkey: string}} body 検査済みの deleteRecord の body
 * @param {AbortSignal} signal 打ち切り (削除の要求全体の上限)
 * @returns {Promise<boolean>} 確かめられなかったときも false (消さない側に倒す)
 */
async function confirmReplyPost(clients, body, signal) {
	try {
		const agent = getAgent(clients, 'appview');
		if (!agent) {
			return false;
		}
		const uri = `at://${body.repo}/${EXT_BRIDGE.postCollection}/${body.rkey}`;
		const response = await agent.fetchHandler(
			`/xrpc/${NSID.getPosts}${buildQuery({uris: [uri]})}`,
			{method: 'GET', headers: {accept: 'application/json'}, signal}
		);
		if (response.ok !== true) {
			return false;
		}
		return isReplyPostResponse(await response.json(), uri);
	} catch (error) {
		return false;
	}
}

/**
 * GET の問い合わせ文字列を組み立てる。
 * 配列は同じ名前を繰り返す (uris=a&uris=b。XRPC の約束)。
 * @param {Object|undefined} params
 * @returns {string} 先頭の ? を含む。空なら空文字
 */
export function buildQuery(params) {
	if (!params || typeof params !== 'object') {
		return '';
	}
	const search = new URLSearchParams();
	Object.keys(params).forEach((key) => {
		const value = params[key];
		if (Array.isArray(value)) {
			value.forEach((item) => search.append(key, String(item)));
			return;
		}
		if (value !== undefined && value !== null) {
			search.append(key, String(value));
		}
	});
	const query = search.toString();
	return query ? `?${query}` : '';
}

/**
 * 本体の認証済み fetchHandler を借りて XRPC を 1 回呼ぶ。
 * **白名簿を通ったものだけが実際に飛ぶ。**
 * 分離ワールドが待ちを諦める前に通信を打ち切る (applyWrites は threadMs、ほかは requestMs。
 * 投稿の削除の前の確認もこの上限に含む)。打ち切ったら reason は timeout
 * (書き込みは届いたかもしれないため、呼び出し側は送り直さない)
 * @param {Object} payload {nsid, params, body}
 * @param {function(): (Object|null)} [lookupClients] 本体のクライアント一式を探す (テストで差し替える)
 * @returns {Promise<{ok: boolean, status?: number, json?: Object|null,
 *   reason: string|null}>}
 */
export async function callXrpc(payload, lookupClients = findClients) {
	const clients = lookupClients();
	if (!clients) {
		return {ok: false, reason: 'no-client'};
	}
	// repo の検査に使う DID は、書き込みを送るのと同じクライアントから読む
	const checked = checkXrpcRequest(payload, readSessionDid(pickClient(clients, payload && payload.nsid)));
	if (!checked.ok) {
		return {ok: false, reason: checked.reason};
	}
	const agent = getAgent(clients, checked.rule.target);
	if (!agent) {
		return {ok: false, reason: 'no-agent'};
	}
	const signal = AbortSignal.timeout(checked.rule.threadWrite === true
		? MAIN_TIMEOUTS.threadMs
		: MAIN_TIMEOUTS.requestMs);
	if (checked.needsReplyCheck && !(await confirmReplyPost(clients, checked.body, signal))) {
		return {
			ok: false,
			reason: signal.aborted ? BRIDGE_PROTOCOL.reasons.timeout : BRIDGE_PROTOCOL.reasons.postNotReply
		};
	}
	const init = {
		method: checked.rule.method,
		headers: {accept: 'application/json'},
		signal
	};
	let path = `/xrpc/${payload.nsid}`;
	if (checked.rule.method === 'GET') {
		path += buildQuery(payload.params);
	} else {
		init.headers['content-type'] = 'application/json';
		// 検査で白名簿のキーだけに組み直した body を送る
		init.body = JSON.stringify(checked.body || {});
	}
	try {
		const response = await agent.fetchHandler(path, init);
		const json = await readJsonSafely(response);
		return {
			ok: response.ok === true,
			status: response.status,
			json,
			reason: response.ok === true ? null : 'http-error'
		};
	} catch (error) {
		return {ok: false, reason: signal.aborted ? BRIDGE_PROTOCOL.reasons.timeout : 'fetch-failed'};
	}
}

/**
 * 本体の投稿作成モーダルを返信・引用モードで開く。
 *
 * **findComposerControls() の結果をキャッシュしない。** findClients() と
 * 同じ理由 (React が状態が変わるたび Context の value を作り直すこと) に加え、
 * アンマウント済みのツリー由来の openComposer は例外を投げずに何もしない
 * ことがあり、キャッシュを取り直すきっかけ (throw) が来ないまま
 * 「押しても何も起きないのに成功扱い」になる事故を防ぐ。
 * 押下時にしか走らないため、毎回歩くコストは findClients() と同様に許容する
 * @param {{mode: string, post: Object}} payload
 * @returns {{ok: boolean, reason: string|null}}
 */
function openComposer(payload) {
	const mode = payload && payload.mode;
	if (EXT_BRIDGE.composerModes.indexOf(mode) === -1) {
		return {ok: false, reason: 'unknown-mode'};
	}
	const post = payload && payload.post;
	if (!post || typeof post !== 'object'
		|| typeof post.uri !== 'string' || typeof post.cid !== 'string') {
		return {ok: false, reason: 'invalid-payload'};
	}
	const controls = findComposerControls();
	if (!controls) {
		return {ok: false, reason: 'no-composer'};
	}
	try {
		controls.openComposer(
			mode === 'reply' ? {replyTo: post} : {quote: post}
		);
		return {ok: true, reason: null};
	} catch (error) {
		return {ok: false, reason: 'open-failed'};
	}
}

/**
 * ログイン状態と自分の DID を返す。**トークンは絶対に返さない。**
 * @returns {{ok: boolean, hasSession: boolean, did: string|null}}
 */
function getSession() {
	const clients = findClients();
	const did = readSessionDid(clients && clients.appviewClient);
	return {ok: true, hasSession: did !== null, did};
}

/** アップロードの許可範囲と預かり箱の寸法 (BRIDGE_PROTOCOL.upload) */
const UPLOAD = BRIDGE_PROTOCOL.upload;

/** 預ける Blob の id の形。1 回だけ作って使い回す */
const BLOB_ID_REGEX = new RegExp(UPLOAD.blobIdPattern);

/**
 * upload-blob に預けられた Blob の MIME・サイズが許した範囲かを確かめる。
 * @param {{type: string, size: number}} info Blob の type と size
 * @returns {{ok: true}|{ok: false, reason: string}}
 */
export function checkUploadBlob(info) {
	const notAllowed = {ok: false, reason: BRIDGE_PROTOCOL.reasons.blobNotAllowed};
	if (!info || typeof info.type !== 'string' || !UPLOAD.mimeTypes.includes(info.type)) {
		return notAllowed;
	}
	if (!Number.isSafeInteger(info.size) || info.size <= 0) {
		return notAllowed;
	}
	const limits = UPLOAD.maxBytes;
	const limit = Object.prototype.hasOwnProperty.call(limits, info.type)
		? limits[info.type]
		: limits.default;
	return info.size <= limit ? {ok: true} : notAllowed;
}

/**
 * upload-video に渡される動画の MIME・サイズが許した範囲かを確かめる。
 * @param {{type: string, size: number}} info 動画の type と size
 * @returns {{ok: true}|{ok: false, reason: string}}
 */
export function checkUploadVideo(info) {
	const rule = BRIDGE_PROTOCOL.video;
	const notAllowed = {ok: false, reason: BRIDGE_PROTOCOL.reasons.blobNotAllowed};
	if (!info || typeof info.type !== 'string' || !rule.mimeTypes.includes(info.type)) {
		return notAllowed;
	}
	if (!Number.isSafeInteger(info.size) || info.size <= 0 || info.size > rule.maxBytes) {
		return notAllowed;
	}
	return {ok: true};
}

/**
 * 値が PDS の返す BlobRef の形か。
 * @param {*} value uploadBlob の応答の blob
 * @param {string[]} mimeTypes 許す MIME
 * @returns {boolean} {$type: 'blob', ref: {$link}, mimeType, size} の形なら true
 */
export function isBlobRef(value, mimeTypes) {
	try {
		return Boolean(value)
			&& value.$type === 'blob'
			&& Boolean(value.ref)
			&& typeof value.ref.$link === 'string'
			&& value.ref.$link !== ''
			&& mimeTypes.includes(value.mimeType)
			&& Number.isSafeInteger(value.size)
			&& value.size > 0;
	} catch (error) {
		return false;
	}
}

/**
 * 検査済みの BlobRef を、想定したキーだけで組み直す (応答の余計なキーを渡さない)。
 * @param {Object} ref isBlobRef() を通った値
 * @returns {{$type: string, ref: {$link: string}, mimeType: string, size: number}}
 */
export function toBlobRef(ref) {
	return {$type: 'blob', ref: {$link: ref.ref.$link}, mimeType: ref.mimeType, size: ref.size};
}

/**
 * 分離ワールドから postMessage で預けられた Blob の一時置き場。
 * 取りに来ないものは ttl で捨て、件数が上限を超えたら古いものから捨てる。
 */
export class BlobInbox {
	/**
	 * @param {{ttlMs: number, maxEntries: number,
	 *   setTimer: Function, clearTimer: Function}} options
	 */
	constructor({ttlMs, maxEntries, setTimer, clearTimer}) {
		this.ttlMs = ttlMs;
		this.maxEntries = maxEntries;
		this.setTimer = setTimer;
		this.clearTimer = clearTimer;
		/** @type {Map<string, {blob: Blob, timer: *}>} 挿入順が古い順 */
		this.entries = new Map();
		/** @type {Map<string, Array<Function>>} 到着待ちの resolve */
		this.waiters = new Map();
	}

	/**
	 * Blob を預かる。同じ id が既にあれば最初のものを守り、後からのものは無視する
	 * (ページ上のスクリプトも id を見られるため、差し替えさせない)。
	 * @param {string} id
	 * @param {Blob} blob
	 * @returns {boolean} 預かれたら true。既にある id なら false
	 */
	put(id, blob) {
		if (this.entries.has(id)) {
			return false;
		}
		const timer = this.setTimer(() => this.discard(id), this.ttlMs);
		this.entries.set(id, {blob, timer});
		while (this.entries.size > this.maxEntries) {
			this.discard(this.entries.keys().next().value);
		}
		const waiting = this.waiters.get(id);
		if (waiting) {
			this.waiters.delete(id);
			const taken = this.take(id);
			for (const resolve of waiting) {
				resolve(taken);
			}
		}
		return true;
	}

	/**
	 * Blob の到着を待って取り出す。既にあれば直ちに取り出す。
	 * 分離ワールドの postMessage は後から届くため、要求のほうが先に着くことがある。
	 * @param {string} id
	 * @param {number} timeoutMs 待つ上限
	 * @param {AbortSignal} [signal] 取り消し。鳴ったら待ちをやめて null
	 * @returns {Promise<Blob|null>} 上限までに届かない・取り消されたら null
	 */
	waitFor(id, timeoutMs, signal) {
		if (this.entries.has(id)) {
			return Promise.resolve(this.take(id));
		}
		if (signal && signal.aborted) {
			return Promise.resolve(null);
		}
		return new Promise((resolve) => {
			let timer = null;
			const settle = (blob) => {
				this.clearTimer(timer);
				if (signal) {
					signal.removeEventListener('abort', onAbort);
				}
				resolve(blob);
			};
			// put() は待ちの一覧を外してから done を呼ぶ。期限切れと取り消しは自分で外す
			const done = (blob) => settle(blob);
			const giveUp = () => {
				const rest = (this.waiters.get(id) || []).filter((fn) => fn !== done);
				if (rest.length > 0) {
					this.waiters.set(id, rest);
				} else {
					this.waiters.delete(id);
				}
				settle(null);
			};
			const onAbort = () => giveUp();
			timer = this.setTimer(giveUp, timeoutMs);
			if (signal) {
				signal.addEventListener('abort', onAbort, {once: true});
			}
			const list = this.waiters.get(id) || [];
			list.push(done);
			this.waiters.set(id, list);
		});
	}

	/**
	 * Blob を取り出して箱から消す。
	 * @param {string} id
	 * @returns {Blob|null} 無ければ null
	 */
	take(id) {
		const entry = this.entries.get(id);
		if (!entry) {
			return null;
		}
		this.discard(id);
		return entry.blob;
	}

	/**
	 * 箱を空にする (ページを離れるとき)。到着を待っている要求は null で解く。
	 * @returns {void}
	 */
	clear() {
		for (const id of [...this.entries.keys()]) {
			this.discard(id);
		}
		const waiting = [...this.waiters.values()];
		this.waiters.clear();
		for (const list of waiting) {
			for (const resolve of list) {
				resolve(null);
			}
		}
	}

	/**
	 * 1 件を捨てる (タイマーも止める)。
	 * @param {string} id
	 * @returns {void}
	 */
	discard(id) {
		const entry = this.entries.get(id);
		if (entry) {
			this.clearTimer(entry.timer);
			this.entries.delete(id);
		}
	}
}

/**
 * window の message イベントが、自分のページ自身から預けられた Blob かを確かめて読む。
 * @param {MessageEvent} event
 * @param {Window} win 自分の window
 * @returns {{id: string, blob: Blob}|null} 条件を満たさなければ null
 */
export function readBlobMessage(event, win) {
	try {
		if (!event || event.source !== win || event.origin !== win.location.origin) {
			return null;
		}
		const data = event.data;
		if (!data || typeof data !== 'object' || data.type !== BRIDGE_PROTOCOL.blobMessageType) {
			return null;
		}
		if (typeof data.id !== 'string' || !BLOB_ID_REGEX.test(data.id)) {
			return null;
		}
		if (!(data.blob instanceof Blob)) {
			return null;
		}
		return {id: data.id, blob: data.blob};
	} catch (error) {
		return null;
	}
}

/** 起動部が作る預かり箱。Node のテストでは作られない */
let blobInbox = null;

/**
 * テストから預かり箱を差し替える。
 * @param {{waitFor: function(string, number): Promise<Blob|null>}|null} inbox
 */
export function setBlobInboxForTest(inbox) {
	blobInbox = inbox;
}

/**
 * 預かった Blob を本体の認証済み fetchHandler で PDS へアップロードする。
 * **MIME・サイズの検査を通ったものだけが飛ぶ。** 認証は本体に任せ、トークンには触らない。
 * Blob の到着の待ちも含めて、分離ワールドが待ちを諦める前 (uploadMs) に打ち切り、reason は timeout
 * @param {{blobId: string}} payload 預けたときの id
 * @param {function(): (Object|null)} [lookupClients] 本体のクライアント一式を探す (テストで差し替える)
 * @returns {Promise<{ok: boolean, blob?: Object, reason: string|null}>}
 */
export async function uploadBlobAction(payload, lookupClients = findClients) {
	const signal = AbortSignal.timeout(MAIN_TIMEOUTS.uploadMs);
	const id = payload && payload.blobId;
	const blob = (blobInbox && typeof id === 'string' && BLOB_ID_REGEX.test(id))
		? await blobInbox.waitFor(id, UPLOAD.arriveTimeoutMs, signal)
		: null;
	if (!blob) {
		return {
			ok: false,
			reason: signal.aborted ? BRIDGE_PROTOCOL.reasons.timeout : BRIDGE_PROTOCOL.reasons.blobNotFound
		};
	}
	const checked = checkUploadBlob({type: blob.type, size: blob.size});
	if (!checked.ok) {
		return {ok: false, reason: checked.reason};
	}
	const clients = lookupClients();
	if (!clients) {
		return {ok: false, reason: 'no-client'};
	}
	const agent = getAgent(clients, 'pds');
	if (!agent) {
		return {ok: false, reason: 'no-agent'};
	}
	try {
		const response = await agent.fetchHandler(`/xrpc/${NSID.uploadBlob}`, {
			method: 'POST',
			headers: {'content-type': blob.type, accept: 'application/json'},
			body: blob,
			signal
		});
		if (response.ok !== true) {
			return {ok: false, reason: 'http-error'};
		}
		const json = await readJsonSafely(response);
		if (!json || !isBlobRef(json.blob, UPLOAD.mimeTypes)) {
			return {ok: false, reason: signal.aborted ? BRIDGE_PROTOCOL.reasons.timeout : 'bad-response'};
		}
		return {ok: true, blob: toBlobRef(json.blob), reason: null};
	} catch (error) {
		return {ok: false, reason: signal.aborted ? BRIDGE_PROTOCOL.reasons.timeout : 'fetch-failed'};
	}
}

/** upload-video の失敗の message を返事に載せるときの文字数の上限 */
const VIDEO_MESSAGE_MAX_CHARS = 300;

/** upload-video の進み具合のイベントに載せてよい phase */
const PROGRESS_PHASES = Object.freeze(['upload', 'processing']);

/** 取り消しの後に送る abortUpload を打ち切るまでの時間。共有の signal は既に鳴っているため別に持つ */
const ABORT_UPLOAD_TIMEOUT_MS = 10000;

/** 走っている upload-video の取り消し口。キーは blobId */
const videoUploads = new Map();

/** 動画の名前の乱数に使う文字 */
const RANDOM_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * 進み具合を、分離ワールドへ送る形 {id, phase, progress} に絞る。トークンなど余分なキーは載せない。
 * @param {number} id 要求の id
 * @param {{phase: string, progress: number|null}} progress runVideoUpload の onProgress の値
 * @returns {{id: number, phase: string, progress: number|null}|null} phase が不明なら null
 */
export function toProgressDetail(id, progress) {
	if (!progress || !PROGRESS_PHASES.includes(progress.phase)) {
		return null;
	}
	const value = typeof progress.progress === 'number' && Number.isFinite(progress.progress)
		? Math.min(Math.max(progress.progress, 0), 1)
		: null;
	return {id, phase: progress.phase, progress: value};
}

/**
 * サーバが返した文言を、返事に載せる長さへ切る。
 * @param {*} message
 * @returns {string|undefined} 空でない文字列でなければ undefined
 */
export function truncateMessage(message) {
	if (typeof message !== 'string' || message === '') {
		return undefined;
	}
	return message.slice(0, VIDEO_MESSAGE_MAX_CHARS);
}

/**
 * 取り消しの signal に、1 回の要求ごとの打ち切り (requestTimeoutMs) を合わせる。
 * @param {AbortSignal} [signal]
 * @returns {AbortSignal}
 */
function withRequestTimeout(signal) {
	const timeout = AbortSignal.timeout(VIDEO_UPLOAD.requestTimeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * 本体の認証済み fetchHandler で GET し、JSON を返す。失敗・打ち切りは throw。
 * @param {Object} clients findClients() の結果
 * @param {string} nsid
 * @param {Object} [params]
 * @param {AbortSignal} [signal] 取り消し。1 回ごとの打ち切りと合わせて渡す
 * @returns {Promise<any>}
 */
async function getWithAgent(clients, nsid, params, signal) {
	const agent = getAgent(clients, 'pds');
	if (!agent) {
		throw new Error('no-agent');
	}
	const response = await agent.fetchHandler(`/xrpc/${nsid}${buildQuery(params)}`, {
		method: 'GET',
		headers: {accept: 'application/json'},
		signal: withRequestTimeout(signal)
	});
	if (response.ok !== true) {
		throw new Error('http-error');
	}
	return response.json();
}

/**
 * 英数字の乱数を nameLength 文字作る。
 * @returns {string}
 */
function randomName() {
	const bytes = new Uint8Array(VIDEO_UPLOAD.nameLength);
	crypto.getRandomValues(bytes);
	let out = '';
	for (const byte of bytes) {
		out += RANDOM_ALPHABET[byte % RANDOM_ALPHABET.length];
	}
	return out;
}

/**
 * signal が鳴ったら早く解ける待ち。解けた後の中断の扱いは呼び出し側が決める。
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function abortableSleep(ms, signal) {
	return new Promise((resolve) => {
		if (signal && signal.aborted) {
			resolve();
			return;
		}
		const done = () => {
			clearTimeout(timer);
			if (signal) {
				signal.removeEventListener('abort', done);
			}
			resolve();
		};
		const timer = setTimeout(done, ms);
		if (signal) {
			signal.addEventListener('abort', done, {once: true});
		}
	});
}

/**
 * 動画サービスへの XRPC を 1 回呼ぶ。通信の失敗・打ち切りは throw。
 * @param {AbortSignal} signal 取り消し。1 回ごとの打ち切りと合わせて渡す
 * @param {'GET'|'POST'} method
 * @param {string} nsid
 * @param {{token?: string, params?: Object, body?: Object}} opts
 * @returns {Promise<{status: number, json: any}>}
 */
async function videoRequestJson(signal, method, nsid, opts) {
	const headers = {accept: 'application/json'};
	if (opts.token) {
		headers.authorization = `Bearer ${opts.token}`;
	}
	// abortUpload は取り消しの後に送られるため、鳴っている共有の signal を渡すと何も送らずに落ちる
	const requestSignal = nsid === VIDEO_UPLOAD.nsid.abortUpload
		? AbortSignal.timeout(ABORT_UPLOAD_TIMEOUT_MS)
		: withRequestTimeout(signal);
	const init = {method, headers, signal: requestSignal};
	if (opts.body !== undefined) {
		headers['content-type'] = 'application/json';
		init.body = JSON.stringify(opts.body);
	}
	const response = await fetch(`${VIDEO_UPLOAD.origin}/xrpc/${nsid}${buildQuery(opts.params)}`, init);
	return {status: response.status, json: await readJsonSafely(response)};
}

/**
 * 部品 1 本を XMLHttpRequest で送る (fetch は送信の進み具合を取れないため)。
 * 通信の失敗・時間切れ・中断は reject。
 * @param {AbortSignal} signal
 * @param {{jobId: string, partNumber: number, chunk: Blob, token: string, onBytes: function(number): void}} args
 * @returns {Promise<{status: number, json: any}>}
 */
function sendVideoPart(signal, args) {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		const onAbort = () => xhr.abort();
		const cleanup = () => signal.removeEventListener('abort', onAbort);
		const query = buildQuery({jobId: args.jobId, partNumber: args.partNumber});
		xhr.open('POST', `${VIDEO_UPLOAD.origin}/xrpc/${VIDEO_UPLOAD.nsid.uploadPart}${query}`);
		xhr.timeout = VIDEO_UPLOAD.partTimeoutMs;
		xhr.setRequestHeader('Content-Type', 'application/octet-stream');
		xhr.setRequestHeader('Authorization', `Bearer ${args.token}`);
		xhr.upload.onprogress = (event) => {
			if (event.lengthComputable) {
				args.onBytes(event.loaded);
			}
		};
		xhr.onload = () => {
			cleanup();
			resolve({status: xhr.status, json: parseJsonSafely(xhr.responseText)});
		};
		const fail = () => {
			cleanup();
			reject(new Error('part-failed'));
		};
		xhr.onerror = fail;
		xhr.ontimeout = fail;
		xhr.onabort = fail;
		if (signal.aborted) {
			fail();
			return;
		}
		signal.addEventListener('abort', onAbort, {once: true});
		xhr.send(args.chunk);
	});
}

/**
 * runVideoUpload に渡す通信の口を作る。トークンは口の中だけで扱い、ログに出さない。
 * @param {Object} clients findClients() の結果
 * @param {AbortSignal} signal 取り消し。sendPart・requestJson・getServiceAuth・getSession が同じものを見る
 *   (sleep は runVideoUpload が渡す signal を見る)
 * @param {function({phase: string, progress: number|null}): void} onProgress
 * @returns {Object} VideoUploadDeps
 */
export function createVideoDeps(clients, signal, onProgress) {
	return {
		getServiceAuth: async (aud, lxm, exp) => {
			const json = await getWithAgent(clients, VIDEO_UPLOAD.nsid.getServiceAuth, {aud, lxm, exp}, signal);
			if (!json || typeof json.token !== 'string' || json.token === '') {
				throw new Error('no-token');
			}
			return json.token;
		},
		getSession: () => getWithAgent(clients, VIDEO_UPLOAD.nsid.getSession, undefined, signal),
		// getSession を送るのと同じ PDS 側のクライアントの DID (PDS の DID を覚えるキー)
		sessionDid: () => readSessionDid(clients && clients.pdsClient),
		requestJson: (method, nsid, opts) => videoRequestJson(signal, method, nsid, opts || {}),
		// ほかの部品が諦めたときの args.signal と、取り消しの signal のどちらでも止める
		sendPart: (args) => sendVideoPart(args && args.signal ? AbortSignal.any([signal, args.signal]) : signal, args),
		sleep: abortableSleep,
		now: () => Date.now(),
		random: randomName,
		onProgress
	};
}

/**
 * 預かった動画を動画サービスへ送り、変換し終えた BlobRef を返す。進み具合は progressEvent で知らせる。
 * @param {{blobId: string}} payload 預けたときの id
 * @param {number} requestId 進み具合の宛先になる要求の id
 * @returns {Promise<{ok: boolean, blob?: Object, reason?: string, message?: string}>}
 */
export async function uploadVideoAction(payload, requestId) {
	const id = payload && payload.blobId;
	if (!blobInbox || typeof id !== 'string' || !BLOB_ID_REGEX.test(id)) {
		return {ok: false, reason: BRIDGE_PROTOCOL.reasons.blobNotFound};
	}
	// 動画の到着を待つあいだの取り消しも拾えるよう、待つ前に登録する
	const controller = new AbortController();
	videoUploads.set(id, controller);
	try {
		return await runUploadVideo(id, controller, requestId);
	} finally {
		if (videoUploads.get(id) === controller) {
			videoUploads.delete(id);
		}
	}
}

/**
 * 動画の到着を待ち、検査を通ったものを送る。
 * @param {string} id blobId
 * @param {AbortController} controller
 * @param {number} requestId
 * @returns {Promise<{ok: boolean, blob?: Object, reason?: string, message?: string}>}
 */
async function runUploadVideo(id, controller, requestId) {
	const blob = await blobInbox.waitFor(id, UPLOAD.arriveTimeoutMs, controller.signal);
	if (controller.signal.aborted) {
		return {ok: false, reason: BRIDGE_PROTOCOL.reasons.canceled};
	}
	if (!blob) {
		return {ok: false, reason: BRIDGE_PROTOCOL.reasons.blobNotFound};
	}
	const checked = checkUploadVideo({type: blob.type, size: blob.size});
	if (!checked.ok) {
		return {ok: false, reason: checked.reason};
	}
	const clients = findClients();
	if (!clients) {
		return {ok: false, reason: BRIDGE_PROTOCOL.reasons.uploadFailed};
	}
	const onProgress = (progress) => {
		const detail = toProgressDetail(requestId, progress);
		if (detail) {
			document.dispatchEvent(new CustomEvent(BRIDGE_PROTOCOL.progressEvent, {detail: JSON.stringify(detail)}));
		}
	};
	const result = await runVideoUpload(blob, createVideoDeps(clients, controller.signal, onProgress), controller.signal);
	if (result.ok) {
		return {ok: true, blob: result.blob};
	}
	const failed = {ok: false, reason: result.reason};
	const message = truncateMessage(result.message);
	if (message !== undefined) {
		failed.message = message;
	}
	return failed;
}

/**
 * 走っている upload-video を取り消す。
 * @param {{blobId: string}} payload
 * @returns {{ok: boolean}} 走っていなければ false
 */
export function cancelUploadVideo(payload) {
	const id = payload && payload.blobId;
	const controller = typeof id === 'string' ? videoUploads.get(id) : undefined;
	if (!controller) {
		return {ok: false};
	}
	controller.abort();
	return {ok: true};
}

/**
 * 分離ワールドへ応答を返す。detail は JSON 文字列 (bridge-client.js が parse する)。
 * @param {number} id 要求の id
 * @param {Object} payload {ok, ...}
 * @returns {void}
 */
function reply(id, payload) {
	try {
		document.dispatchEvent(new CustomEvent(EXT_BRIDGE.resultEvent, {
			detail: JSON.stringify(Object.assign({id}, payload))
		}));
	} catch (error) {
		// 返せない場合は分離ワールド側のタイムアウトに回収させる
	}
}

/**
 * 分離ワールドからの要求を 1 件さばく。
 * **ハンドラが投げても必ず返事をする。** 返事が無いと呼び出し側は
 * タイムアウト (15 秒) まで解決せず、押下からの経路がそのあいだ固まる
 * @param {CustomEvent} event ext:bridge-request
 * @returns {void}
 */
function handleRequest(event) {
	let detail = null;
	try {
		detail = JSON.parse(event.detail);
	} catch (error) {
		return;
	}
	if (!detail || typeof detail.id !== 'number') {
		return;
	}
	try {
		dispatchRequest(detail);
	} catch (error) {
		reply(detail.id, {ok: false, reason: HANDLER_FAILED_REASON});
	}
}

/** ハンドラが投げた・失敗したときに返す既定の理由 */
const HANDLER_FAILED_REASON = 'handler-failed';

/**
 * action ごとのハンドラと、ハンドラが投げたときに返す理由。
 * run は結果か、結果に解ける Promise を返す (同期の操作も同じ経路で返事をする)
 * @type {Object<string, {run: function(Object, number): (Object|Promise<Object>), failReason: string}>}
 */
const REQUEST_HANDLERS = Object.freeze({
	[EXT_BRIDGE.actions.openLightbox]: {run: (payload) => openLightbox(payload), failReason: HANDLER_FAILED_REASON},
	[EXT_BRIDGE.actions.switchTab]: {run: (payload) => switchTab(payload), failReason: HANDLER_FAILED_REASON},
	[EXT_BRIDGE.actions.navigate]: {run: (payload) => navigate(payload), failReason: HANDLER_FAILED_REASON},
	[EXT_BRIDGE.actions.getLightbox]: {run: () => getLightbox(), failReason: HANDLER_FAILED_REASON},
	[EXT_BRIDGE.actions.closeLightbox]: {run: () => closeLightboxAndSettle(), failReason: 'close-failed'},
	[EXT_BRIDGE.actions.callXrpc]: {run: (payload) => callXrpc(payload), failReason: 'call-failed'},
	[EXT_BRIDGE.actions.openComposer]: {run: (payload) => openComposer(payload), failReason: HANDLER_FAILED_REASON},
	[EXT_BRIDGE.actions.getSession]: {run: () => getSession(), failReason: HANDLER_FAILED_REASON},
	[EXT_BRIDGE.actions.uploadBlob]: {
		run: (payload) => uploadBlobAction(payload),
		failReason: BRIDGE_PROTOCOL.reasons.uploadFailed
	},
	[EXT_BRIDGE.actions.uploadVideo]: {
		run: (payload, id) => uploadVideoAction(payload, id),
		failReason: BRIDGE_PROTOCOL.reasons.uploadFailed
	},
	[EXT_BRIDGE.actions.cancelUploadVideo]: {
		run: (payload) => cancelUploadVideo(payload),
		failReason: HANDLER_FAILED_REASON
	}
});

/**
 * action ごとのハンドラを呼び、結果を reply() で返す。
 * ハンドラが投げても、Promise が reject しても、その操作の failReason で必ず返事をする
 * @param {{id: number, action: string, payload: Object}} detail
 * @returns {Promise<void>}
 */
export function dispatchRequest(detail) {
	const handler = typeof detail.action === 'string'
		&& Object.prototype.hasOwnProperty.call(REQUEST_HANDLERS, detail.action)
		? REQUEST_HANDLERS[detail.action]
		: null;
	if (!handler) {
		reply(detail.id, {ok: false, reason: 'unknown-action'});
		return Promise.resolve();
	}
	return new Promise((resolve) => resolve(handler.run(detail.payload, detail.id))).then(
		(result) => reply(detail.id, result),
		() => reply(detail.id, {ok: false, reason: handler.failReason})
	);
}

// export はテストから import するためのもの。束 (inject.js) は globalName を持たない IIFE なので、
// export した値はページ側のどこにも置かれない。**白名簿を含む EXT_BRIDGE をページ側へ
// 渡さないため、束ね方に globalName を足さないこと**

// 橋渡しとしての起動。Node のテストからは document が無いため実行されない
if (typeof document !== 'undefined') {
	try {
		document.addEventListener(EXT_BRIDGE.requestEvent, handleRequest);
		blobInbox = new BlobInbox({
			ttlMs: UPLOAD.inboxTtlMs,
			maxEntries: UPLOAD.inboxMaxEntries,
			setTimer: (fn, ms) => setTimeout(fn, ms),
			clearTimer: (handle) => clearTimeout(handle)
		});
		window.addEventListener('message', (event) => {
			const message = readBlobMessage(event, window);
			if (message) {
				const info = {type: message.blob.type, size: message.blob.size};
				if (checkUploadBlob(info).ok || checkUploadVideo(info).ok) {
					blobInbox.put(message.id, message.blob);
				}
			}
		});
		// ページを離れるときは預かった Blob (動画は最大 300MB) を手放す
		window.addEventListener('pagehide', () => blobInbox.clear());
	} catch (error) {
		console.error('[XViewer] 橋渡しの起動に失敗しました', error);
	}
}
