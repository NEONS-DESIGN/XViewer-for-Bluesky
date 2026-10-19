/**
 * ライトボックスのパネルからの投稿操作。
 *
 * **この拡張機能で唯一の書き込み機能。** 認証は Bluesky 本体が React context に
 * 持つ agent.fetchHandler を橋渡し (call-xrpc) 経由で借りるだけで、
 * localStorage の accessJwt には触らない。
 *
 * **DOM を知らない。** 見た目は lightbox-panel.js が持つ。
 *
 * 依存: config.js (EXT_CONFIG) / bridge-client.js (callBridge)
 */
import {EXT_CONFIG} from '../common/config.js';
import {ExtDebug} from '../common/debug.js';
import {callBridge} from './bridge-client.js';

/**
 * 投稿への反応の状態。パネルが手元に持ち、押すたびに作り直す。
 * @typedef {Object} ActionState
 * @property {boolean} liked いいね済みか
 * @property {string|null} likeUri いいねレコードの AT URI。取り消しに要る
 * @property {boolean} reposted リポスト済みか
 * @property {string|null} repostUri リポストレコードの AT URI
 * @property {boolean} bookmarked ブックマーク済みか
 * @property {{reply: number, repost: number, like: number, quote: number}} counts
 */

/**
 * レコードの AT URI を分解する正規表現。
 * **コレクションを問わない。** lightbox-panel.js の PANEL_POST_URI_PATTERN は
 * app.bsky.feed.post に限定しているため、いいね・リポストのレコードには使えない
 */
const POST_ACTION_RECORD_URI_PATTERN = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/;

/** 橋渡しの応答を待ちきれなかったときの理由 (bridge-client.js の callBridge が返す) */
const BRIDGE_TIMEOUT = 'timeout';

/**
 * レコードの AT URI を分解する。
 * @param {string} uri at://<did>/<collection>/<rkey>
 * @returns {{did: string, collection: string, rkey: string}|null} 形が違えば null
 */
export function parseRecordUri(uri) {
	try {
		if (typeof uri !== 'string') {
			return null;
		}
		const matched = POST_ACTION_RECORD_URI_PATTERN.exec(uri);
		if (!matched) {
			return null;
		}
		return {did: matched[1], collection: matched[2], rkey: matched[3]};
	} catch (error) {
		console.error('[XViewer] レコード URI の解析に失敗しました', error);
		return null;
	}
}

/**
 * getPosts の viewer から反応の状態を読む。
 * **viewer は未認証の取得では付かない。** 無い場合はすべて未反応として扱う。
 * @param {Object|null|undefined} viewer post.viewer
 * @param {{reply: number, repost: number, like: number, quote: number}|null|undefined} counts
 * @returns {ActionState}
 */
export function readViewerState(viewer, counts) {
	const likeUri = (viewer && typeof viewer.like === 'string' && viewer.like)
		? viewer.like
		: null;
	const repostUri = (viewer && typeof viewer.repost === 'string' && viewer.repost)
		? viewer.repost
		: null;
	const normalizedCounts = counts || {};
	return {
		liked: likeUri !== null,
		likeUri,
		reposted: repostUri !== null,
		repostUri,
		bookmarked: !!(viewer && viewer.bookmarked === true),
		counts: {
			reply: typeof normalizedCounts.reply === 'number' ? normalizedCounts.reply : 0,
			repost: typeof normalizedCounts.repost === 'number' ? normalizedCounts.repost : 0,
			like: typeof normalizedCounts.like === 'number' ? normalizedCounts.like : 0,
			quote: typeof normalizedCounts.quote === 'number' ? normalizedCounts.quote : 0
		}
	};
}

/**
 * 反応の状態を 1 つ切り替えた新しい状態を返す。
 *
 * **押した直後に描くための値であって、通信の結果ではない** (楽観的更新)。
 * 失敗したら呼び出し側が控えておいた元の状態へ戻す。そのため
 * **元の状態を書き換えない** (counts も作り直す)。
 * 付ける方向ではレコードの URI がまだ分からないため null のままにし、
 * createRecord の応答が返ってから呼び出し側が埋める。
 * @param {ActionState} state 今の状態
 * @param {'like'|'repost'|'bookmark'} kind 切り替える種別
 * @returns {ActionState} 新しい状態。知らない種別なら中身の同じものを返す
 */
export function toggleActionState(state, kind) {
	const next = {
		liked: state.liked,
		likeUri: state.likeUri,
		reposted: state.reposted,
		repostUri: state.repostUri,
		bookmarked: state.bookmarked,
		counts: {
			reply: state.counts.reply,
			repost: state.counts.repost,
			like: state.counts.like,
			quote: state.counts.quote
		}
	};
	if (kind === 'like') {
		next.liked = !state.liked;
		next.likeUri = null;
		next.counts.like = Math.max(0, state.counts.like + (next.liked ? 1 : -1));
		return next;
	}
	if (kind === 'repost') {
		next.reposted = !state.reposted;
		next.repostUri = null;
		next.counts.repost = Math.max(0, state.counts.repost + (next.reposted ? 1 : -1));
		return next;
	}
	if (kind === 'bookmark') {
		next.bookmarked = !state.bookmarked;
		return next;
	}
	return next;
}

/**
 * ある種別のフィールドだけを `source` から取り込んだ新しい状態を返す。
 *
 * 応答を待つ間にライトボックスを閉じて**同じ投稿を開き直した**とき、
 * 開き直した側の状態は書き戻し前の `viewer` から作られているため、
 * その種別だけが古い。まるごと差し替えると、開き直した側で飛行中の
 * 別種の楽観的更新を消してしまうので、対象の種別だけを写す。
 * **元の状態を書き換えない** (counts も作り直す)。
 * @param {ActionState} state 開き直した側の今の状態
 * @param {'like'|'repost'|'bookmark'} kind 取り込む種別
 * @param {ActionState} source 飛行が終わった側の状態 (URI まで埋まっている)
 * @returns {ActionState} 新しい状態。知らない種別なら中身の同じものを返す
 */
export function mergeActionKind(state, kind, source) {
	const next = {
		liked: state.liked,
		likeUri: state.likeUri,
		reposted: state.reposted,
		repostUri: state.repostUri,
		bookmarked: state.bookmarked,
		counts: {
			reply: state.counts.reply,
			repost: state.counts.repost,
			like: state.counts.like,
			quote: state.counts.quote
		}
	};
	if (kind === 'like') {
		next.liked = source.liked;
		next.likeUri = source.likeUri;
		next.counts.like = source.counts.like;
	} else if (kind === 'repost') {
		next.reposted = source.reposted;
		next.repostUri = source.repostUri;
		next.counts.repost = source.counts.repost;
	} else if (kind === 'bookmark') {
		next.bookmarked = source.bookmarked;
	}
	return next;
}

/**
 * applyWrites の応答を読み、書いた順の {uri, cid} の並びにする。
 * 件数・uri (自分の repo の collection と書いた rkey) ・cid のどれかが
 * 合わなければ、書けたと言い切れないため null を返す。
 * @param {any} json applyWrites の応答
 * @param {Object[]} writes 送った writes (rkey を持つ)
 * @param {string} repo 書いた先の DID
 * @param {string} collection 書いたコレクション
 * @returns {Array<{uri: string, cid: string}>|null}
 */
export function readThreadResults(json, writes, repo, collection) {
	try {
		if (!json || !Array.isArray(json.results) || !Array.isArray(writes)) {
			return null;
		}
		if (json.results.length !== writes.length) {
			return null;
		}
		const out = [];
		for (let i = 0; i < writes.length; i += 1) {
			const item = json.results[i];
			const write = writes[i];
			if (!item || !write || typeof item.uri !== 'string') {
				return null;
			}
			if (item.uri !== 'at://' + repo + '/' + collection + '/' + write.rkey) {
				return null;
			}
			if (typeof item.cid !== 'string' || item.cid === '') {
				return null;
			}
			out.push({uri: item.uri, cid: item.cid});
		}
		return out;
	} catch (error) {
		return null;
	}
}

/**
 * 投稿操作の呼び出し層。橋渡し (call-xrpc / open-composer / get-session) を
 * 意味のある単位に包む。**DOM を知らない。**
 *
 * どのメソッドも例外を投げない。失敗は {ok: false, reason} に潰す
 * (クラッシュより非表示を優先する方針)。
 */
export class PostActions {
	/**
	 * @param {Object} config EXT_CONFIG.postActions
	 */
	constructor(config) {
		this.config = config;
		/**
		 * ログイン中の DID。**成功したときだけ覚える。**
		 * 失敗 (タイムアウトなど) まで覚えると、一度の通信の乱れでそのタブが
		 * 以後ずっと未ログイン扱いに固定されてしまうため、取れなかった場合は
		 * 次回の呼び出しでもう一度問い合わせる。
		 * アカウントを切り替えるとページが作り直されるため、
		 * ここで古い値を持ち続ける経路は無い
		 * @type {string|null}
		 */
		this.sessionDid = null;
		/**
		 * refreshSessionDid() が最後に見た DID (未ログインなら null)。
		 * 一度も問い合わせていないあいだは undefined。
		 * アカウントの切り替えを見分けるためだけに持つ
		 * @type {string|null|undefined}
		 */
		this.knownDid = undefined;
	}

	/**
	 * ログイン中の DID を問い合わせ直し、前回から変わったかを返す。
	 * **本体のアカウント切り替えはリロードを伴わない**ため、覚えていた DID と
	 * 投稿のキャッシュ (viewer は人ごとに違う) が古くなり得る。ライトボックスを
	 * 開くたびに呼び、変わっていたら呼び出し側がキャッシュを捨てる。
	 * 走査は約 100 ノードで、押下時の問い合わせと同じ程度の負荷
	 * @returns {Promise<{did: string|null, changed: boolean}>} 初回は changed: false
	 */
	async refreshSessionDid() {
		const actions = EXT_CONFIG.mediaGrid.bridge.actions;
		const result = await callBridge(actions.getSession, {});
		if (!result || !result.ok) {
			// 橋渡しの一時的な不調は「DID が変わった」とみなさない
			// (毎回キャッシュを捨てて取得が増えるだけで益が無い)
			return {did: this.sessionDid, changed: false};
		}
		const did = typeof result.did === 'string' ? result.did : null;
		const previous = this.knownDid;
		const changed = previous !== undefined && previous !== did;
		this.knownDid = did;
		this.sessionDid = did;
		if (changed) {
			ExtDebug.log('ログイン中の DID が変わった', {前: previous, 後: did});
		}
		return {did, changed};
	}

	/**
	 * ログイン中の DID を返す。
	 * **失敗は覚えない。** `sessionDid` が付いた (= 成功した) ときだけキャッシュとして
	 * 使い、取れなかった場合は次回の呼び出しで再度 get-session を試す。
	 * 未ログインの利用者は押すたびに問い合わせが走るが、押下時にしか走らないため許容する
	 * @returns {Promise<string|null>} 未ログイン・橋渡し失敗なら null
	 */
	async getSessionDid() {
		if (this.sessionDid !== null) {
			return this.sessionDid;
		}
		const actions = EXT_CONFIG.mediaGrid.bridge.actions;
		const result = await callBridge(actions.getSession, {});
		const did = (result && result.ok && typeof result.did === 'string')
			? result.did
			: null;
		if (did !== null) {
			this.sessionDid = did;
		}
		return did;
	}

	/**
	 * 橋渡し経由で XRPC を 1 回呼ぶ。
	 * @param {string} nsid EXT_CONFIG.postActions.nsid のいずれか
	 * @param {{params?: Object, body?: Object, timeoutMs?: number}} options timeoutMs は橋渡しの応答を待つ上限
	 *   (省けば橋渡しの既定)
	 * @returns {Promise<{ok: boolean, json: Object|null, reason: string|null}>}
	 */
	async call(nsid, options) {
		const actions = EXT_CONFIG.mediaGrid.bridge.actions;
		const timeoutMs = options && options.timeoutMs;
		const result = await callBridge(actions.callXrpc, {
			nsid,
			params: options && options.params,
			body: options && options.body
		}, Number.isFinite(timeoutMs) && timeoutMs > 0 ? {timeoutMs} : {});
		if (!result || !result.ok) {
			const reason = (result && result.reason) || 'no-result';
			ExtDebug.log('投稿操作の呼び出しが失敗', {nsid, 理由: reason});
			if (reason === this.config.reasons.repoNotSelf) {
				// 橋渡しが「本人の repo ではない」と言った = 覚えていた DID が古い
				// (アカウント切り替え)。次の問い合わせで引き直す
				this.sessionDid = null;
			}
			return {ok: false, json: null, reason};
		}
		return {ok: true, json: result.json || null, reason: null};
	}

	/**
	 * 認証付きで投稿を 1 件引く。**viewer を得るのが目的。**
	 * @param {string} postUri
	 * @returns {Promise<Object|null>} getPosts のレスポンス。失敗なら null
	 */
	async fetchPost(postUri) {
		const result = await this.call(this.config.nsid.getPosts, {
			params: {uris: [postUri]}
		});
		return result.ok ? result.json : null;
	}

	/**
	 * 返信の一覧のために、投稿のスレッドを認証付きで引く。
	 * 認証付きで引くのは viewer.replyDisabled とミュート・ブロックを反映させるため
	 * @param {string} uri 起点の投稿の AT URI
	 * @param {number} depth 下へ辿る深さ
	 * @returns {Promise<Object|null>} getPostThread の応答。失敗なら null
	 */
	async fetchThread(uri, depth) {
		const result = await this.call(this.config.nsid.getPostThread, {
			params: {uri, depth, parentHeight: 0}
		});
		return result.ok ? result.json : null;
	}

	/**
	 * 自分の repo にレコードを 1 件書く。
	 * 覚えていた DID が古かった (repo-not-self) ときだけ、引き直して 1 回やり直す
	 * @param {string} collection
	 * @param {Object} record $type を含む record
	 * @returns {Promise<{ok: boolean, json: Object|null, reason: string|null}>}
	 */
	async writeRecord(collection, record) {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const did = await this.getSessionDid();
			if (!did) {
				return {ok: false, json: null, reason: 'no-session'};
			}
			const result = await this.call(this.config.nsid.createRecord, {
				body: {repo: did, collection, record}
			});
			if (result.ok || result.reason !== this.config.reasons.repoNotSelf) {
				return result;
			}
		}
		return {ok: false, json: null, reason: this.config.reasons.repoNotSelf};
	}

	/**
	 * レコードを 1 件作る。
	 * @param {string} collection app.bsky.feed.like など
	 * @param {string} uri 対象の投稿の AT URI
	 * @param {string} cid 対象の投稿の CID
	 * @returns {Promise<{ok: boolean, recordUri: string|null, reason: string|null}>}
	 */
	async createRecord(collection, uri, cid) {
		const result = await this.writeRecord(collection, {
			// 本体 (agent.like()) と同じく $type を明示する。橋渡しの検査も
			// collection との一致を要求する
			$type: collection,
			subject: {uri, cid},
			createdAt: new Date().toISOString()
		});
		if (!result.ok) {
			return {ok: false, recordUri: null, reason: result.reason};
		}
		const recordUri = (result.json && typeof result.json.uri === 'string')
			? result.json.uri
			: null;
		if (recordUri === null) {
			// 応答から URI が読めないと、付けた反応を取り消せない。
			// 「付いたが URI 不明」を正として覚え込むと次の押下で 2 本目が
			// 飛ぶため失敗扱いにし、呼び出し側にサーバから引き直させる
			return {ok: false, recordUri: null, reason: 'no-record-uri'};
		}
		return {ok: true, recordUri, reason: null};
	}

	/**
	 * 返信を 1 件投稿する。橋渡しは返信の形の record だけを通す。
	 * @param {Object} record reply-text.js の buildReplyRecord() の結果
	 * @returns {Promise<{ok: boolean, uri: string|null, cid: string|null, reason: string|null}>}
	 *   応答から uri / cid が読めなければ失敗扱い (一覧へ差し込めず、消せもしないため)
	 */
	async createReply(record) {
		const result = await this.writeRecord(this.config.collections.post, record);
		if (!result.ok) {
			return {ok: false, uri: null, cid: null, reason: result.reason};
		}
		const json = result.json || {};
		if (typeof json.uri !== 'string' || typeof json.cid !== 'string') {
			return {ok: false, uri: null, cid: null, reason: 'no-record-uri'};
		}
		return {ok: true, uri: json.uri, cid: json.cid, reason: null};
	}

	/**
	 * 返信の連なりを applyWrites で 1 回に書く。
	 * parent の URI が DID を含むため、repo-not-self (覚えていた DID が古い) のときは
	 * DID を引き直して build() から組み直し、1 回だけやり直す。送り直しはしない
	 * @param {function(string): Promise<Object[]>} build DID から writes を組む
	 * @returns {Promise<{ok: boolean, results: Array<{uri: string, cid: string}>|null, writes: Object[]|null, reason: string|null}>}
	 *   応答が書いた内容と合わなければ reason は 'thread-unconfirmed'
	 */
	async createReplyThread(build) {
		let writes = null;
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const did = await this.getSessionDid();
			if (!did) {
				return {ok: false, results: null, writes: null, reason: 'no-session'};
			}
			try {
				writes = await build(did);
			} catch (error) {
				ExtDebug.log('返信の連なりを組めなかった', {理由: String((error && error.message) || error)});
				return {ok: false, results: null, writes: null, reason: 'build-failed'};
			}
			const result = await this.call(this.config.nsid.applyWrites, {
				body: {repo: did, writes},
				timeoutMs: EXT_CONFIG.mediaGrid.bridge.threadTimeoutMs
			});
			if (!result.ok && result.reason === BRIDGE_TIMEOUT) {
				// 送った後に待ちきれなかった = 書けているかもしれない。失敗として残すと送り直しで二重になる
				return {ok: false, results: null, writes, reason: 'thread-unconfirmed'};
			}
			if (result.ok) {
				const results = readThreadResults(result.json, writes, did, this.config.collections.post);
				if (results === null) {
					return {ok: false, results: null, writes, reason: 'thread-unconfirmed'};
				}
				return {ok: true, results, writes, reason: null};
			}
			if (result.reason !== this.config.reasons.repoNotSelf) {
				return {ok: false, results: null, writes, reason: result.reason};
			}
		}
		return {ok: false, results: null, writes, reason: this.config.reasons.repoNotSelf};
	}

	/**
	 * 自分の返信を消す。橋渡しが「消す相手が返信であること」を確かめてから消す。
	 * @param {string} uri 返信の AT URI
	 * @returns {Promise<{ok: boolean, reason: string|null}>}
	 */
	deleteReply(uri) {
		return this.deleteRecord(uri);
	}

	/**
	 * レコードを 1 件消す。
	 * **`rkey` は消す相手のレコードの AT URI から取る** (投稿の URI ではない)。
	 * @param {string} recordUri いいね・リポストのレコードの AT URI
	 * @returns {Promise<{ok: boolean, reason: string|null}>}
	 */
	async deleteRecord(recordUri) {
		const parsed = parseRecordUri(recordUri);
		if (!parsed) {
			return {ok: false, reason: 'invalid-record-uri'};
		}
		// 覚えていた DID が古かった (repo-not-self) ときだけ、引き直して 1 回やり直す
		let result = null;
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const did = await this.getSessionDid();
			if (!did) {
				return {ok: false, reason: 'no-session'};
			}
			result = await this.call(this.config.nsid.deleteRecord, {
				body: {repo: did, collection: parsed.collection, rkey: parsed.rkey}
			});
			if (result.ok || result.reason !== this.config.reasons.repoNotSelf) {
				break;
			}
		}
		return {ok: result.ok, reason: result.reason};
	}

	/**
	 * いいねを付ける。
	 * @param {string} uri 投稿の AT URI
	 * @param {string} cid 投稿の CID
	 * @returns {Promise<{ok: boolean, recordUri: string|null, reason: string|null}>}
	 */
	createLike(uri, cid) {
		return this.createRecord(this.config.collections.like, uri, cid);
	}

	/**
	 * いいねを外す。
	 * @param {string} recordUri いいねレコードの AT URI
	 * @returns {Promise<{ok: boolean, reason: string|null}>}
	 */
	deleteLike(recordUri) {
		return this.deleteRecord(recordUri);
	}

	/**
	 * リポストする。
	 * @param {string} uri 投稿の AT URI
	 * @param {string} cid 投稿の CID
	 * @returns {Promise<{ok: boolean, recordUri: string|null, reason: string|null}>}
	 */
	createRepost(uri, cid) {
		return this.createRecord(this.config.collections.repost, uri, cid);
	}

	/**
	 * リポストを取り消す。
	 * @param {string} recordUri リポストレコードの AT URI
	 * @returns {Promise<{ok: boolean, reason: string|null}>}
	 */
	deleteRepost(recordUri) {
		return this.deleteRecord(recordUri);
	}

	/**
	 * ブックマークに追加する。
	 * **レコードではなく appview の procedure。** 入力は {uri, cid} (lexicon で確認)
	 * @param {string} uri 投稿の AT URI
	 * @param {string} cid 投稿の CID
	 * @returns {Promise<{ok: boolean, reason: string|null}>}
	 */
	async createBookmark(uri, cid) {
		const result = await this.call(this.config.nsid.createBookmark, {
			body: {uri, cid}
		});
		return {ok: result.ok, reason: result.reason};
	}

	/**
	 * ブックマークから外す。入力は {uri} だけ (lexicon で確認)。
	 * @param {string} uri 投稿の AT URI
	 * @returns {Promise<{ok: boolean, reason: string|null}>}
	 */
	async deleteBookmark(uri) {
		const result = await this.call(this.config.nsid.deleteBookmark, {
			body: {uri}
		});
		return {ok: result.ok, reason: result.reason};
	}

	/**
	 * 本体の投稿作成モーダルを返信・引用モードで開く。
	 * **ライトボックスは閉じない** (2026-09-09 実測で、同時に開けることを確認)。
	 * @param {'reply'|'quote'} mode
	 * @param {Object} post getPosts が返す `post` オブジェクトそのもの (PostView)。
	 *   **整形しない。** quote は完全な PostView を要求するため
	 * @returns {Promise<{ok: boolean, reason: string|null}>}
	 */
	async openComposer(mode, post) {
		const actions = EXT_CONFIG.mediaGrid.bridge.actions;
		const result = await callBridge(actions.openComposer, {mode, post});
		if (!result || !result.ok) {
			ExtDebug.log('投稿作成モーダルを開けなかった', {
				mode,
				理由: (result && result.reason) || '応答なし'
			});
			return {ok: false, reason: (result && result.reason) || 'no-result'};
		}
		return {ok: true, reason: null};
	}
}

/**
 * ある種別について、状態が「意図した反応」になっているか。
 * 書き込みが失敗扱い (タイムアウトなど) になった後にサーバから引き直した状態と、
 * 押したときに意図した状態を突き合わせ、実は成功していたかを見分ける
 * @param {ActionState} state 引き直した (サーバの) 状態
 * @param {'like'|'repost'|'bookmark'} kind
 * @param {ActionState} wanted 押したときに意図した状態
 * @returns {boolean} 知らない種別なら false
 */
export function isActionApplied(state, kind, wanted) {
	if (kind === 'like') {
		return state.liked === wanted.liked;
	}
	if (kind === 'repost') {
		return state.reposted === wanted.reposted;
	}
	if (kind === 'bookmark') {
		return state.bookmarked === wanted.bookmarked;
	}
	return false;
}
