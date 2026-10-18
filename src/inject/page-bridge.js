/**
 * MAIN ワールドで動く橋渡し。
 * 分離ワールドから見えない React の内部状態 (ライトボックス制御) を扱う。
 * イベント名・操作名・白名簿の値は common/bridge-protocol.js の BRIDGE_PROTOCOL を
 * content 側 (config.js) と共有する。**白名簿の検査 (checkXrpcRequest) は受け手の
 * ここが持つ。**
 *
 * content script とは別の束 (inject.js) になる。chrome.* や EXT_CONFIG は使えないため、
 * ブラウザ API に触れない bridge-protocol.js 以外を import しないこと。
 */
import {BRIDGE_PROTOCOL} from '../common/bridge-protocol.js';

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
		 * ここに新しく repo 書き込み系の NSID を足すときは必ず付けること。
		 * bodyKeys は POST の body に通すキーの白名簿。ここに無いキー
		 * (validate / swapCommit など) は落として送る。record を持つものは
		 * record.$type が collection と一致することも要求する
		 */
		[NSID.createRecord]: {
			target: 'pds', method: 'POST', recordWrite: true,
			bodyKeys: ['repo', 'collection', 'record']
		},
		[NSID.deleteRecord]: {
			target: 'pds', method: 'POST', recordWrite: true,
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
	/** 返信の root / parent に置ける投稿の AT URI */
	postUriPattern: /^at:\/\/[^/]+\/app\.bsky\.feed\.post\/[^/]+$/,
	/** open-composer が受け付けるモード */
	composerModes: Object.freeze(Object.values(BRIDGE_PROTOCOL.composerModes))
};

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
 * NSID の白名簿の規則に従って、実際に呼ぶクライアントを選ぶ。
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
			return typeof feature.uri === 'string' && /^https?:\/\/\S+$/.test(feature.uri);
		case 'app.bsky.richtext.facet#mention':
			return typeof feature.did === 'string' && /^did:[a-z]+:\S+$/.test(feature.did);
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

/**
 * 橋渡しから作ってよい投稿 (返信) の record かを検査する。
 * **返信でない投稿と、embed などを持つ投稿は通さない。** 作れる投稿を
 * 「本文だけの返信」に絞ることで、ページ上の誰かがこの橋渡しを撃っても
 * 単独の投稿や画像付きの投稿を作れないようにする
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
		? new TextEncoder().encode(record.text).length
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
 * call-xrpc の要求を検査する。**通らないものはここで落とす。**
 * NSID の白名簿、レコード書き込みの collection、repo が本人かの 3 段。
 * 投稿の作成は返信の record だけを通し、投稿の削除には needsReplyCheck を
 * 付けて返す (消す相手が返信であることの確認は通信を伴うため callXrpc() が行う)
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
	if (rule.method !== 'POST') {
		return {ok: true, rule, body: null, needsReplyCheck: false};
	}
	const body = payload.body;
	if (!body || typeof body !== 'object') {
		return {ok: false, reason: 'invalid-body'};
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
	// bodyKeys が無い規則は body をそのまま通す (recordWrite の検査は上で済んでいる)
	if (!Array.isArray(rule.bodyKeys)) {
		return {ok: true, rule, body, needsReplyCheck: false};
	}
	const sanitized = {};
	for (let i = 0; i < rule.bodyKeys.length; i += 1) {
		const key = rule.bodyKeys[i];
		if (Object.prototype.hasOwnProperty.call(body, key)) {
			sanitized[key] = body[key];
		}
	}
	if (rule.bodyKeys.indexOf('record') !== -1) {
		// レコードの $type は collection と一致させる (別コレクション形の
		// レコードを自分の like コレクションに置けないようにする)
		const record = sanitized.record;
		if (!record || typeof record !== 'object' || record.$type !== body.collection) {
			return {ok: false, reason: 'record-type-mismatch'};
		}
	}
	if (rule.bodyKeys.indexOf('rkey') !== -1
		&& (typeof sanitized.rkey !== 'string' || !sanitized.rkey)) {
		return {ok: false, reason: 'invalid-rkey'};
	}
	const isPost = isRecordWrite && body.collection === EXT_BRIDGE.postCollection;
	if (isPost && rule.bodyKeys.indexOf('record') !== -1) {
		const postCheck = checkPostRecord(sanitized.record);
		if (!postCheck.ok) {
			return postCheck;
		}
	}
	return {
		ok: true,
		rule,
		body: sanitized,
		needsReplyCheck: isPost && rule.bodyKeys.indexOf('rkey') !== -1
	};
}

/**
 * 消そうとしている投稿が返信であることを、本体の appview から引いて確かめる。
 * @param {Object|null} clients findClients() の結果
 * @param {{repo: string, rkey: string}} body 検査済みの deleteRecord の body
 * @returns {Promise<boolean>} 確かめられなかったときも false (消さない側に倒す)
 */
async function confirmReplyPost(clients, body) {
	try {
		const agent = clients && clients.appviewClient && clients.appviewClient.agent;
		if (!agent || typeof agent.fetchHandler !== 'function') {
			return false;
		}
		const uri = `at://${body.repo}/${EXT_BRIDGE.postCollection}/${body.rkey}`;
		const response = await agent.fetchHandler(
			`/xrpc/${NSID.getPosts}${buildQuery({uris: [uri]})}`,
			{method: 'GET', headers: {accept: 'application/json'}}
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
 * @param {Object} payload {nsid, params, body}
 * @returns {Promise<{ok: boolean, status?: number, json?: Object|null,
 *   reason: string|null}>}
 */
async function callXrpc(payload) {
	const clients = findClients();
	if (!clients) {
		return {ok: false, reason: 'no-client'};
	}
	// repo の検査に使う DID は、書き込みを送るのと同じクライアントから読む
	const client = pickClient(clients, payload && payload.nsid);
	const checked = checkXrpcRequest(payload, readSessionDid(client));
	if (!checked.ok) {
		return {ok: false, reason: checked.reason};
	}
	const agent = client && client.agent;
	if (!agent || typeof agent.fetchHandler !== 'function') {
		return {ok: false, reason: 'no-agent'};
	}
	if (checked.needsReplyCheck && !(await confirmReplyPost(clients, checked.body))) {
		return {ok: false, reason: BRIDGE_PROTOCOL.reasons.postNotReply};
	}
	const init = {
		method: checked.rule.method,
		headers: {accept: 'application/json'}
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
		let json = null;
		try {
			json = await response.json();
		} catch (error) {
			json = null;
		}
		return {
			ok: response.ok === true,
			status: response.status,
			json,
			reason: response.ok === true ? null : 'http-error'
		};
	} catch (error) {
		return {ok: false, reason: 'fetch-failed'};
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
		reply(detail.id, {ok: false, reason: 'handler-failed'});
	}
}

/**
 * action ごとのハンドラを呼び、結果を reply() で返す。
 * @param {{id: number, action: string, payload: Object}} detail
 * @returns {void}
 */
function dispatchRequest(detail) {
	if (detail.action === EXT_BRIDGE.actions.openLightbox) {
		reply(detail.id, openLightbox(detail.payload));
		return;
	}
	if (detail.action === EXT_BRIDGE.actions.switchTab) {
		reply(detail.id, switchTab(detail.payload));
		return;
	}
	if (detail.action === EXT_BRIDGE.actions.navigate) {
		reply(detail.id, navigate(detail.payload));
		return;
	}
	if (detail.action === EXT_BRIDGE.actions.getLightbox) {
		reply(detail.id, getLightbox());
		return;
	}
	if (detail.action === EXT_BRIDGE.actions.closeLightbox) {
		closeLightboxAndSettle().then(
			(result) => reply(detail.id, result),
			() => reply(detail.id, {ok: false, reason: 'close-failed'})
		);
		return;
	}
	if (detail.action === EXT_BRIDGE.actions.callXrpc) {
		callXrpc(detail.payload).then(
			(result) => reply(detail.id, result),
			() => reply(detail.id, {ok: false, reason: 'call-failed'})
		);
		return;
	}
	if (detail.action === EXT_BRIDGE.actions.openComposer) {
		reply(detail.id, openComposer(detail.payload));
		return;
	}
	if (detail.action === EXT_BRIDGE.actions.getSession) {
		reply(detail.id, getSession());
		return;
	}
	reply(detail.id, {ok: false, reason: 'unknown-action'});
}

// export はテストから import するためのもの。束 (inject.js) は globalName を持たない IIFE なので、
// export した値はページ側のどこにも置かれない。**白名簿を含む EXT_BRIDGE をページ側へ
// 渡さないため、束ね方に globalName を足さないこと**

// 橋渡しとしての起動。Node のテストからは document が無いため実行されない
if (typeof document !== 'undefined') {
	try {
		document.addEventListener(EXT_BRIDGE.requestEvent, handleRequest);
	} catch (error) {
		console.error('[XViewer] 橋渡しの起動に失敗しました', error);
	}
}
