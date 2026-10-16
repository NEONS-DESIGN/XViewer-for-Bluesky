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
	 * call-xrpc が通す XRPC の白名簿。キーの NSID は BRIDGE_PROTOCOL.nsid から取る。
	 *
	 * ここを緩めると、この橋渡しは「本体のセッションで任意の XRPC を
	 * 呼べる汎用の穴」になる。ext:bridge-request は document 上の
	 * CustomEvent であり、bsky.app 上で動く誰でも撃てる
	 */
	xrpc: {
		[NSID.getPosts]: {target: 'appview', method: 'GET'},
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
	 * ここに無いものは通さないため、投稿・削除・フォロー・ブロックは
	 * この橋渡しでは行えない
	 */
	recordCollections: Object.freeze(Object.values(BRIDGE_PROTOCOL.collections)),
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
 * call-xrpc の要求を検査する。**通らないものはここで落とす。**
 * NSID の白名簿、レコード書き込みの collection、repo が本人かの 3 段。
 * @param {Object} payload {nsid, params, body}
 * @param {string|null} sessionDid ログイン中の DID
 * @returns {{ok: true, rule: {target: string, method: string}, body: Object|null}
 *   |{ok: false, reason: string}} body は白名簿のキーだけを写した送信用の body
 *   (GET なら null)
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
		return {ok: true, rule, body: null};
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
		return {ok: true, rule, body};
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
	return {ok: true, rule, body: sanitized};
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
		reply(detail.id, closeLightbox());
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
