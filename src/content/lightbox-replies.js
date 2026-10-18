/**
 * ライトボックスのパネルの返信欄。
 * 姉妹プロジェクト XViewer for Pixiv のサイドバーのコメント欄と同じ形で、
 * 見出し・入力欄・返信の一覧 (新しい順、1 段の入れ子) を出す。
 *
 * **パネル (lightbox-panel.js) を import しない。** 本文の断片の描画・遷移・
 * 返信数の更新・呼び出し層は、パネルが host として渡す口だけを使う。
 * 書き込み (返信・削除) は呼び出し層 (PostActions) を通し、橋渡しの白名簿が
 * 「返信の作成」と「返信であると確かめた投稿の削除」だけを通す。
 *
 * 入力欄は部品 (reply-composer.js) が組む。ここは宛先・世代・送信中の印・言語の保存と、
 * 送れた返信の一覧への差し込みだけを持つ。
 *
 * 依存: config.js (EXT_CONFIG) / debug.js (ExtDebug) / reply-text.js / media-source.js /
 *       reply-composer.js / reply-embed.js / blob-transfer.js / image-prepare.js
 */
import {EXT_CONFIG} from '../common/config.js';
import {ExtDebug} from '../common/debug.js';
import {
	extractMediaFromEmbed, toLightboxImages, matchBlurLabels, formatBlurLabels
} from './media-source.js';
import {
	parseThreadReplies, flattenThreadBranch, sortNewestFirst, formatReplyDate, insertVisible, mediaAspectRatio
} from './reply-text.js';
import {ReplyComposer, defaultLanguages} from './reply-composer.js';
import {normalizeLanguages} from './reply-embed.js';
import {uploadBlob} from './blob-transfer.js';
import {prepareImage} from './image-prepare.js';

/**
 * パネルが返信欄に渡す口。
 * @typedef {Object} RepliesHost
 * @property {(text: string, facets: Array<Object>) => Array<Object>} toSegments
 *   本文を facets で区切る (パネルの applyFacets)
 * @property {(segment: Object) => Node} buildSegment 本文の断片 1 つを要素にする
 * @property {(target: {route: string, params: Object}) => Promise<void>} leaveTo
 *   ライトボックスを閉じて SPA 遷移する
 * @property {(delta: number) => void} adjustReplyCount 投稿の返信数を増減する
 * @property {(request: ReplyMediaRequest) => Promise<void>} openMedia
 *   ライトボックスを返信の画像で開き直す
 * @property {import('./post-actions.js').PostActions} actions 呼び出し層
 * @property {() => (import('./reply-sheets.js').SheetHost|null)} [getSheets]
 *   パネルに重ねる画面の持ち主 (パネルの要素ごとに 1 つ)
 */

/**
 * 返信の画像を開く依頼。
 * @typedef {Object} ReplyMediaRequest
 * @property {Object[]} images ライトボックスに渡す形 (toLightboxImages の結果)
 * @property {number} index 開く画像の位置
 * @property {string} postUri 返信の AT URI (パネルはこれで投稿を引く)
 * @property {string} authorDid
 * @property {string} handle 開けなかったときに投稿ページへ移るのに使う
 * @property {string} rkey
 */

/**
 * 返信の宛先。
 * @typedef {Object} ReplyTarget
 * @property {string} uri
 * @property {string} cid
 * @property {Object|null} replyRef 宛先の record.reply (root を引き継ぐのに使う)
 * @property {boolean} isPost 宛先が画像の投稿そのものか
 * @property {string|null} anchorUri 宛先が返信のとき、その返信が入っている 1 段目の返信
 * @property {string|null} handle 宛先の作者のハンドル
 */

/**
 * 1 行分の記録。
 * @typedef {Object} ReplyRow
 * @property {HTMLElement} li
 * @property {import('./reply-text.js').ReplyItem} item
 * @property {number} depth 0 = 1 段目、1 = 開いた返信の中
 * @property {string} anchorUri 1 段目の返信の URI (1 段目なら自分)
 * @property {HTMLElement|null} body 返信の入力欄を差し込む先
 * @property {HTMLButtonElement|null} showButton 「返信を表示」
 * @property {HTMLElement|null} area 開いた返信の入れ物
 */

export class LightboxReplies {
	/**
	 * @param {Object} config EXT_CONFIG.lightboxReplies
	 * @param {RepliesHost} host
	 */
	constructor(config, host) {
		this.config = config;
		this.host = host;
		/**
		 * 返信の画像を取り出す設定。ライトボックスは動画を表示できないため、
		 * グリッドの設定に関わらず動画を落とす
		 */
		this.mediaConfig = {...EXT_CONFIG.mediaGrid, excludeVideos: true};
		/** NSFW のぼかしを解除するか (グリッドと同じポップアップのトグル) */
		this.unblurEnabled = EXT_CONFIG.mediaGrid.unblur.defaultEnabled;
		/**
		 * 取得の世代。投稿が変わる・区画を外すたびに進め、古い応答を捨てる
		 * (MediaFetcher.generation と同じ考え方)
		 */
		this.generation = 0;
		/** @type {string|null} 描画中の投稿の AT URI */
		this.postUri = null;
		/** @type {Object|null} 描画中の投稿 (PanelPost) */
		this.post = null;
		/** パネルが書き込みを許したか (postActions が有効で viewer がある) */
		this.requestedCanWrite = false;
		/** 一覧を公開 API で読んだか (認証が無いので書き込みを出さない) */
		this.fromPublic = false;
		/** 投稿の作者が返信を制限しているか */
		this.replyDisabled = false;
		/** @type {'idle'|'loading'|'loaded'|'error'} */
		this.loadState = 'idle';
		/** @type {Array<Object>|null} 1 段目の返信 (新しい順) */
		this.items = null;
		/** 1 段目のうち描いた件数 */
		this.shown = 0;
		/**
		 * 開いた返信の状態。キーは 1 段目の返信の URI
		 * @type {Map<string, {open: boolean, items: Array<Object>|null, shown: number}>}
		 */
		this.branches = new Map();
		/** @type {string|null} ログイン中の DID */
		this.sessionDid = null;
		/** @type {{did: string, handle: string, displayName: string, avatarUrl: string|null}|null} */
		this.selfProfile = null;
		/** @type {Map<string, Object>} DID ごとの自分のプロフィール (アカウント切り替えに備える) */
		this.profileCache = new Map();
		/** @type {Promise<void>|null} セッションの読み込み。一覧の描画はこれを待つ */
		this.sessionPromise = null;
		/** 送信中か。**連打・Ctrl+Enter との二重送信で返信が 2 件できるのを防ぐ** */
		this.posting = false;
		/** @type {HTMLButtonElement|null} 「本当に削除？」になっている削除ボタン */
		this.confirmingButton = null;
		/** @type {Map<string, ReplyRow>} */
		this.rows = new Map();
		/** @type {Set<ReplyComposer>} 描いている入力欄 */
		this.composers = new Set();
		/** @type {{composer: ReplyComposer, button: HTMLButtonElement}|null} 返信への返信の入力欄 */
		this.rowForm = null;
		/** @type {ReplyComposer|null} 投稿への入力欄 */
		this.mainComposer = null;
		/** @type {Promise<string[]>|null} 覚えている投稿言語 (読むのは 1 回だけ) */
		this.languagesPromise = null;
		/** @type {IntersectionObserver|null} 「上部へ」の出し入れ */
		this.observer = null;
		this.sectionEl = null;
		this.formSlot = null;
		this.statusEl = null;
		this.listEl = null;
		this.moreButton = null;
		this.toTopButton = null;
		this.headingEl = null;
		this.sentinelEl = null;
	}

	/**
	 * 区画を作って container の末尾に足す。
	 * 同じ投稿で取得済みなら取り直さない (設定の切り替えでパネルが描き直されたとき)
	 * @param {HTMLElement} container パネルの本文の入れ物
	 * @param {Object} post PanelPost
	 * @param {{canWrite: boolean}} options
	 * @returns {void}
	 */
	mount(container, post, options) {
		try {
			if (!container || !post || typeof post.postUri !== 'string') {
				return;
			}
			if (post.postUri !== this.postUri) {
				this.reset(post.postUri);
			}
			this.post = post;
			this.requestedCanWrite = !!(options && options.canWrite);
			this.removeDom();
			this.buildSection(container);
			this.sessionPromise = this.prepareSession(this.generation);
			if (this.loadState === 'idle') {
				this.load();
				return;
			}
			this.sessionPromise.then(() => {
				if (this.sectionEl) {
					this.renderForm();
					this.renderBody();
				}
			});
		} catch (error) {
			console.error('[XViewer] 返信欄の描画に失敗しました', error);
		}
	}

	/**
	 * NSFW のぼかし解除を反映する。描いた画像は作り直さず、区画のクラスだけで打ち消す。
	 * @param {boolean} enabled
	 * @returns {void}
	 */
	setUnblur(enabled) {
		this.unblurEnabled = enabled === true;
		if (this.sectionEl) {
			this.sectionEl.classList.toggle(this.config.classes.unblur, this.unblurEnabled);
		}
	}

	/**
	 * 飛行中の応答を捨て、区画を外す。次に開いたときは取り直す。
	 * @returns {void}
	 */
	destroy() {
		this.reset(null);
		this.removeDom();
	}

	/**
	 * 投稿が変わったときの初期化。世代を進めて飛行中の応答を捨てる。
	 * @param {string|null} postUri
	 * @returns {void}
	 */
	reset(postUri) {
		this.generation += 1;
		this.postUri = postUri;
		this.post = null;
		this.items = null;
		this.shown = 0;
		this.loadState = 'idle';
		this.fromPublic = false;
		this.replyDisabled = false;
		this.branches = new Map();
		this.posting = false;
	}

	/** 区画の DOM と、それに結び付いた状態を外す。 */
	removeDom() {
		try {
			for (const composer of this.composers) {
				composer.destroy();
			}
			const sheets = this.getSheets();
			if (sheets && sheets.isOpen()) {
				// 重ねる画面は入力欄から開くもの。区画を外すなら一緒に閉じる
				sheets.close(false);
			}
		} catch (error) {
			console.error('[XViewer] 返信欄の入力欄の撤去に失敗しました', error);
		}
		try {
			if (this.observer) {
				this.observer.disconnect();
			}
			if (this.sectionEl) {
				this.sectionEl.remove();
			}
		} catch (error) {
			console.error('[XViewer] 返信欄の撤去に失敗しました', error);
		} finally {
			this.observer = null;
			this.sectionEl = null;
			this.formSlot = null;
			this.statusEl = null;
			this.listEl = null;
			this.moreButton = null;
			this.toTopButton = null;
			this.headingEl = null;
			this.sentinelEl = null;
			this.rows = new Map();
			this.composers = new Set();
			this.rowForm = null;
			this.mainComposer = null;
			this.confirmingButton = null;
		}
	}

	/**
	 * 書き込み (入力欄・削除) を出せるか。
	 * @returns {boolean}
	 */
	isWritable() {
		return this.requestedCanWrite && !this.fromPublic && !this.replyDisabled
			&& typeof this.sessionDid === 'string' && this.sessionDid !== '';
	}

	/**
	 * パネルのキーの扱い (panel-focus-guard.js) が読む状態。
	 * @returns {{hasDraft: boolean, confirming: boolean}}
	 */
	readKeyState() {
		// フォーカスがどこにあっても、書きかけ (本文か添付) が 1 つでもあれば Escape で閉じさせない
		let hasDraft = false;
		for (const composer of this.composers) {
			if (composer.hasDraft()) {
				hasDraft = true;
			}
		}
		return {hasDraft, confirming: this.confirmingButton !== null};
	}

	/**
	 * 操作行の「返信」から呼ぶ。投稿への入力欄があれば見える位置へ送ってフォーカスする。
	 * @returns {boolean} 入力欄が無ければ false (呼び出し側が本体の作成画面を開く)
	 */
	focusComposer() {
		try {
			if (!this.mainComposer || !this.sectionEl || !this.sectionEl.isConnected) {
				return false;
			}
			this.sectionEl.scrollIntoView({block: 'start', behavior: this.scrollBehavior()});
			this.mainComposer.focus();
			return true;
		} catch (error) {
			return false;
		}
	}

	/**
	 * 動きを減らす設定なら即座に、そうでなければ滑らかに送る。
	 * @returns {'auto'|'smooth'}
	 */
	scrollBehavior() {
		try {
			return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
		} catch (error) {
			return 'auto';
		}
	}

	/**
	 * ログイン中の DID と、書き込むときに出す自分のプロフィールを読む。
	 * @param {number} generation
	 * @returns {Promise<void>}
	 */
	async prepareSession(generation) {
		try {
			const did = await this.host.actions.getSessionDid();
			if (generation !== this.generation) {
				return;
			}
			this.sessionDid = did;
			if (!did || !this.requestedCanWrite) {
				this.selfProfile = null;
				return;
			}
			const profile = await this.fetchProfile(did);
			if (generation === this.generation) {
				this.selfProfile = profile;
			}
		} catch (error) {
			console.error('[XViewer] 返信欄のセッションの読み込みに失敗しました', error);
		}
	}

	/**
	 * 自分のプロフィールを公開 API で引く。DID ごとに 1 回だけ。
	 * 引けなくても書き込みは止めない (アバターが出ないだけ)。
	 * @param {string} did
	 * @returns {Promise<{did: string, handle: string, displayName: string, avatarUrl: string|null}>}
	 */
	async fetchProfile(did) {
		const cached = this.profileCache.get(did);
		if (cached) {
			return cached;
		}
		const json = await this.fetchPublicJson(this.config.api.profilePath, {actor: did});
		const handle = json && typeof json.handle === 'string' ? json.handle : did;
		const profile = {
			did,
			handle,
			displayName: json && typeof json.displayName === 'string' && json.displayName
				? json.displayName
				: handle,
			avatarUrl: json && typeof json.avatar === 'string' ? json.avatar : null
		};
		if (json) {
			this.profileCache.set(did, profile);
		}
		return profile;
	}

	/**
	 * 公開 API を 1 回呼ぶ。タイムアウト付き。
	 * @param {string} apiPath /xrpc/...
	 * @param {Object} params
	 * @returns {Promise<Object|null>} 失敗なら null
	 */
	async fetchPublicJson(apiPath, params) {
		const api = this.config.api;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), api.timeoutMs);
		try {
			const url = new URL(apiPath, api.origin);
			Object.keys(params).forEach((key) => url.searchParams.set(key, String(params[key])));
			const response = await fetch(url.toString(), {signal: controller.signal});
			if (!response.ok) {
				return null;
			}
			return await response.json();
		} catch (error) {
			return null;
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * スレッドを引く。認証付きを先に試し、だめなら公開 API に落ちる。
	 * @param {string} uri 起点
	 * @param {number} depth
	 * @returns {Promise<{json: Object|null, fromPublic: boolean}>}
	 */
	async fetchThread(uri, depth) {
		const authed = await this.host.actions.fetchThread(uri, depth);
		if (authed) {
			return {json: authed, fromPublic: false};
		}
		const json = await this.fetchPublicJson(this.config.api.threadPath, {
			uri, depth, parentHeight: 0
		});
		return {json, fromPublic: json !== null};
	}

	/**
	 * 1 段目の返信を読む。返信数が 0 なら取得しない。
	 * @returns {Promise<void>}
	 */
	async load() {
		const generation = this.generation;
		const post = this.post;
		try {
			this.loadState = 'loading';
			this.renderBody();
			await this.sessionPromise;
			if (generation !== this.generation) {
				return;
			}
			this.replyDisabled = !!(post.viewer && post.viewer.replyDisabled === true);
			if (!post.counts || post.counts.reply === 0) {
				this.items = [];
			} else {
				ExtDebug.log('返信の取得を開始', {postUri: post.postUri});
				const result = await this.fetchThread(post.postUri, this.config.depth.root);
				if (generation !== this.generation) {
					return;
				}
				if (!result.json) {
					this.loadState = 'error';
					this.renderForm();
					this.renderBody();
					return;
				}
				this.fromPublic = result.fromPublic;
				const thread = result.json.thread;
				const viewer = thread && thread.post && thread.post.viewer;
				if (viewer && viewer.replyDisabled === true) {
					this.replyDisabled = true;
				}
				this.items = sortNewestFirst(parseThreadReplies(result.json));
				ExtDebug.log('返信の取得が終了', {件数: this.items.length, 公開API: this.fromPublic});
			}
			this.loadState = 'loaded';
			this.shown = Math.min(this.config.pageSize, this.items.length);
			this.renderForm();
			this.renderBody();
		} catch (error) {
			console.error('[XViewer] 返信の取得に失敗しました', error);
			if (generation === this.generation) {
				this.loadState = 'error';
				this.renderBody();
			}
		}
	}

	/**
	 * 区画の外枠 (見出し・入力欄の置き場・一覧) を作る。
	 * @param {HTMLElement} container
	 * @returns {void}
	 */
	buildSection(container) {
		const c = this.config.classes;
		const text = this.config.text;
		const section = document.createElement('section');
		section.className = c.section;
		section.classList.toggle(c.unblur, this.unblurEnabled);
		const sentinel = document.createElement('div');
		sentinel.className = c.sentinel;
		const header = document.createElement('div');
		header.className = c.header;
		const heading = document.createElement('h3');
		heading.className = c.heading;
		heading.tabIndex = -1;
		const headingText = document.createElement('span');
		headingText.className = c.headingText;
		headingText.textContent = text.heading;
		const toTop = document.createElement('button');
		toTop.type = 'button';
		toTop.className = c.toTop;
		toTop.textContent = text.toTop;
		toTop.hidden = true;
		toTop.addEventListener('click', () => {
			sentinel.scrollIntoView({block: 'start', behavior: this.scrollBehavior()});
			heading.focus({preventScroll: true});
		});
		heading.appendChild(headingText);
		heading.appendChild(toTop);
		const formSlot = document.createElement('div');
		header.appendChild(heading);
		header.appendChild(formSlot);
		const status = document.createElement('div');
		status.className = c.status;
		const list = document.createElement('ul');
		list.className = c.list;
		const more = document.createElement('button');
		more.type = 'button';
		more.className = c.more;
		more.textContent = text.more;
		more.hidden = true;
		more.addEventListener('click', () => this.showMore());
		section.appendChild(sentinel);
		section.appendChild(header);
		section.appendChild(status);
		section.appendChild(list);
		section.appendChild(more);
		container.appendChild(section);

		this.sectionEl = section;
		this.sentinelEl = sentinel;
		this.headingEl = heading;
		this.toTopButton = toTop;
		this.formSlot = formSlot;
		this.statusEl = status;
		this.listEl = list;
		this.moreButton = more;
		this.observeHeader();
	}

	/**
	 * 見出しが上端に貼り付いたときだけ「上部へ」を出す。
	 * 区画の先頭の番兵が画面の上へ抜けたら貼り付いたとみなす
	 * @returns {void}
	 */
	observeHeader() {
		try {
			if (typeof IntersectionObserver !== 'function') {
				return;
			}
			this.observer = new IntersectionObserver((entries) => {
				for (const entry of entries) {
					if (this.toTopButton) {
						this.toTopButton.hidden = entry.isIntersecting
							|| entry.boundingClientRect.top > 0;
					}
				}
			});
			this.observer.observe(this.sentinelEl);
		} catch (error) {
			this.observer = null;
		}
	}

	/**
	 * 見出しの下の入力欄 (または返信不可の 1 行) を描く。
	 * @returns {void}
	 */
	renderForm() {
		if (!this.formSlot || !this.post) {
			return;
		}
		if (this.mainComposer) {
			this.composers.delete(this.mainComposer);
			this.mainComposer.destroy();
			this.mainComposer = null;
		}
		this.formSlot.textContent = '';
		if (this.replyDisabled) {
			const note = document.createElement('p');
			note.className = this.config.classes.status;
			note.textContent = this.config.text.disabled;
			this.formSlot.appendChild(note);
			return;
		}
		if (!this.isWritable()) {
			return;
		}
		const raw = this.post.raw || {};
		const record = raw.record || {};
		this.mainComposer = this.createComposer({
			uri: this.post.postUri,
			cid: this.post.cid,
			replyRef: record.reply || null,
			isPost: true,
			anchorUri: null,
			handle: this.post.handle
		}, this.config.text.placeholder, record.langs);
		this.formSlot.appendChild(this.mainComposer.el);
		this.mainComposer.sync();
	}

	/**
	 * 重ねる画面の持ち主をパネルから受け取る。無ければ null (ALT などの画面を開かない)。
	 * @returns {import('./reply-sheets.js').SheetHost|null}
	 */
	getSheets() {
		try {
			return typeof this.host.getSheets === 'function' ? this.host.getSheets() || null : null;
		} catch (error) {
			return null;
		}
	}

	/**
	 * 入力欄の部品を 1 つ作る。宛先・世代・送信中の印・言語の保存はここから口として渡す。
	 * @param {ReplyTarget} target 返信の宛先
	 * @param {string} placeholder
	 * @param {*} parentLangs 宛先の record.langs (言語の提案に使う)
	 * @returns {ReplyComposer}
	 */
	createComposer(target, placeholder, parentLangs) {
		const composer = new ReplyComposer(this.config, {
			actions: this.host.actions,
			sheets: this.getSheets(),
			uploadBlob,
			prepareImage,
			getSelfProfile: () => this.selfProfile,
			getSessionDid: () => this.sessionDid,
			isCurrent: (generation) => generation === this.generation,
			getGeneration: () => this.generation,
			isPosting: () => this.posting,
			setPosting: (posting) => {
				this.posting = posting === true;
			},
			onPosted: (result, record, posted, embedView) => {
				this.insertOwnReply(posted, this.buildOwnItem(result, record, posted, embedView), composer);
			},
			resolveHandle: (handle) => this.resolveHandle(handle),
			parentLangs: Array.isArray(parentLangs) ? parentLangs : null,
			loadLanguages: () => this.loadLanguages(),
			saveLanguages: (codes) => this.saveLanguages(codes)
		}, target, placeholder);
		this.composers.add(composer);
		return composer;
	}

	/**
	 * ハンドルを DID に引く (本文中のメンションの facets に使う)。
	 * @param {string} handle
	 * @returns {Promise<string|null>} 引けなければ null
	 */
	async resolveHandle(handle) {
		const json = await this.fetchPublicJson(this.config.api.resolveHandlePath, {handle});
		return json && typeof json.did === 'string' ? json.did : null;
	}

	/**
	 * 覚えている投稿言語を読む。無ければブラウザの言語。読むのは 1 回だけで、以後は覚えた値を返す。
	 * @returns {Promise<string[]>}
	 */
	loadLanguages() {
		if (!this.languagesPromise) {
			this.languagesPromise = this.readStoredLanguages();
		}
		return this.languagesPromise;
	}

	/**
	 * chrome.storage.local から投稿言語を読む。読めない・空ならブラウザの言語。
	 * @returns {Promise<string[]>}
	 */
	async readStoredLanguages() {
		const compose = this.config.compose;
		try {
			const key = compose.languageStorageKey;
			const stored = await chrome.storage.local.get(key);
			const codes = normalizeLanguages(stored && stored[key], compose.maxLanguages, compose.languageCodes);
			if (codes.length > 0) {
				return codes;
			}
		} catch (error) {
			console.error('[XViewer] 投稿言語の読み込みに失敗しました', error);
		}
		return defaultLanguages(navigator.language, compose);
	}

	/**
	 * 選んだ投稿言語を覚え、次の入力欄の既定にする。
	 * @param {string[]} codes
	 * @returns {void}
	 */
	saveLanguages(codes) {
		const compose = this.config.compose;
		const normalized = normalizeLanguages(codes, compose.maxLanguages, compose.languageCodes);
		if (normalized.length === 0) {
			return;
		}
		this.languagesPromise = Promise.resolve(normalized);
		try {
			Promise.resolve(chrome.storage.local.set({[compose.languageStorageKey]: normalized})).catch((error) => {
				console.error('[XViewer] 投稿言語の保存に失敗しました', error);
			});
		} catch (error) {
			console.error('[XViewer] 投稿言語の保存に失敗しました', error);
		}
	}

	/**
	 * 投稿した返信を、取り直さずに一覧の 1 件として組み立てる。
	 * @param {{uri: string, cid: string}} result createReply の応答
	 * @param {Object} record 送った record
	 * @param {ReplyTarget} target
	 * @param {Object|null} embedView 添付した画像の embed view (取り直さずに描く)。無ければ null
	 * @returns {Object} ReplyItem
	 */
	buildOwnItem(result, record, target, embedView) {
		const profile = this.selfProfile || {
			did: this.sessionDid, handle: this.sessionDid, displayName: this.sessionDid, avatarUrl: null
		};
		const rkey = result.uri.slice(result.uri.lastIndexOf('/') + 1);
		return {
			uri: result.uri,
			cid: result.cid,
			rkey,
			authorDid: this.sessionDid,
			handle: profile.handle,
			displayName: profile.displayName,
			avatarUrl: profile.avatarUrl,
			text: record.text,
			facets: Array.isArray(record.facets) ? record.facets : [],
			createdAt: record.createdAt,
			replyCount: 0,
			hasEmbed: !!embedView,
			embed: embedView || null,
			labels: record.labels && Array.isArray(record.labels.values)
				? record.labels.values.map((label) => label.val)
				: [],
			langs: Array.isArray(record.langs) ? record.langs : null,
			replyRef: record.reply,
			parentUri: record.reply.parent.uri,
			parentHandle: !target.isPost && target.uri !== target.anchorUri ? target.handle : null
		};
	}

	/**
	 * 投稿した返信を差し込む。投稿への返信は一覧の先頭、返信への返信は開いた返信の末尾。
	 * @param {ReplyTarget} target
	 * @param {Object} item ReplyItem
	 * @param {ReplyComposer} [composer] 送った入力欄。返信への返信の入力欄なら閉じる
	 *   (送信中に閉じられて別の入力欄が開いていれば、そちらは閉じない)
	 * @returns {void}
	 */
	insertOwnReply(target, item, composer) {
		if (target.isPost) {
			if (!Array.isArray(this.items)) {
				this.items = [];
			}
			this.items.unshift(item);
			this.shown += 1;
			this.loadState = 'loaded';
			this.host.adjustReplyCount(1);
			if (this.listEl) {
				this.renderStatus(null);
				this.listEl.prepend(this.buildRow(item, 0, item.uri));
			}
			return;
		}
		if (!composer || (this.rowForm && this.rowForm.composer === composer)) {
			this.closeRowForm(false);
		}
		const anchorRow = this.rows.get(target.anchorUri);
		if (target.uri === target.anchorUri && anchorRow) {
			anchorRow.item.replyCount += 1;
		}
		const branch = this.branches.get(target.anchorUri);
		if (branch && branch.open && Array.isArray(branch.items)) {
			const inserted = insertVisible(branch.items, branch.shown, item);
			branch.items = inserted.items;
			branch.shown = inserted.shown;
			this.renderBranch(target.anchorUri);
			return;
		}
		// 開いていなければ、投稿した 1 件だけを持って開く (取り直すと反映が間に合わないことがある)
		this.branches.set(target.anchorUri, {open: true, items: [item], shown: 1});
		this.renderBranch(target.anchorUri);
	}

	/**
	 * 一覧の部分 (状態の 1 行・行・「もっと見る」) を今の状態から描き直す。
	 * @returns {void}
	 */
	renderBody() {
		if (!this.listEl) {
			return;
		}
		const text = this.config.text;
		this.listEl.textContent = '';
		this.moreButton.hidden = true;
		if (this.loadState === 'idle' || this.loadState === 'loading') {
			this.renderStatus(text.loading);
			return;
		}
		if (this.loadState === 'error') {
			this.renderStatus(text.error, () => this.load());
			return;
		}
		if (!this.items || this.items.length === 0) {
			this.renderStatus(text.empty);
			return;
		}
		this.renderStatus(null);
		for (const item of this.items.slice(0, this.shown)) {
			this.listEl.appendChild(this.buildRow(item, 0, item.uri));
		}
		this.moreButton.hidden = this.shown >= this.items.length;
	}

	/**
	 * 一覧の上の 1 行を出す。onRetry があれば押せるボタンにする。
	 * @param {string|null} message null なら消す
	 * @param {(() => void)} [onRetry]
	 * @returns {void}
	 */
	renderStatus(message, onRetry) {
		if (!this.statusEl) {
			return;
		}
		this.statusEl.textContent = '';
		if (message === null) {
			return;
		}
		if (onRetry) {
			// ボタン自身に role="alert" を付けるとボタンとして読まれないため、包む側に付ける
			const wrapper = document.createElement('p');
			wrapper.setAttribute('role', 'alert');
			const retry = document.createElement('button');
			retry.type = 'button';
			retry.className = this.config.classes.retry;
			retry.textContent = message;
			retry.addEventListener('click', onRetry);
			wrapper.appendChild(retry);
			this.statusEl.appendChild(wrapper);
			return;
		}
		const line = document.createElement('p');
		line.textContent = message;
		this.statusEl.appendChild(line);
	}

	/** 1 段目を次の pageSize 件だけ足す。 */
	showMore() {
		if (!this.items || !this.listEl) {
			return;
		}
		const next = this.items.slice(this.shown, this.shown + this.config.pageSize);
		for (const item of next) {
			this.listEl.appendChild(this.buildRow(item, 0, item.uri));
		}
		this.shown += next.length;
		this.moreButton.hidden = this.shown >= this.items.length;
	}

	/**
	 * 返信 1 件の行を作る。
	 * @param {Object} item ReplyItem
	 * @param {number} depth 0 = 1 段目、1 = 開いた返信の中
	 * @param {string} anchorUri 1 段目の返信の URI
	 * @returns {HTMLElement}
	 */
	buildRow(item, depth, anchorUri) {
		const c = this.config.classes;
		const text = this.config.text;
		const routes = EXT_CONFIG.mediaGrid.bridge.routes;
		const li = document.createElement('li');
		li.className = depth === 0 ? c.item : `${c.item} ${c.child}`;
		const toProfile = () => this.host.leaveTo({route: routes.profile, params: {name: item.handle}});

		const avatar = document.createElement('img');
		avatar.className = c.avatar;
		avatar.alt = '';
		// 名前のボタンと同じ行き先のため、読み上げとタブ移動では名前だけを数える
		avatar.setAttribute('aria-hidden', 'true');
		if (item.avatarUrl) {
			avatar.src = item.avatarUrl;
		}
		avatar.addEventListener('click', toProfile);
		li.appendChild(avatar);

		const body = document.createElement('div');
		body.className = c.body;
		const nameRow = document.createElement('div');
		nameRow.className = c.nameRow;
		const name = document.createElement('button');
		name.type = 'button';
		name.className = c.name;
		name.textContent = item.displayName;
		name.title = `@${item.handle}`;
		name.addEventListener('click', toProfile);
		nameRow.appendChild(name);
		const label = this.labelFor(item);
		if (label) {
			const span = document.createElement('span');
			span.className = label.self ? `${c.label} ${c.labelSelf}` : c.label;
			span.textContent = label.text;
			nameRow.appendChild(span);
		}
		body.appendChild(nameRow);
		if (item.parentHandle) {
			const replyTo = document.createElement('p');
			replyTo.className = c.replyTo;
			replyTo.textContent = `${text.replyTo} @${item.parentHandle}`;
			body.appendChild(replyTo);
		}
		if (item.text) {
			const paragraph = document.createElement('p');
			paragraph.className = c.text;
			for (const segment of this.host.toSegments(item.text, item.facets)) {
				paragraph.appendChild(this.host.buildSegment(segment));
			}
			body.appendChild(paragraph);
		}
		const media = this.buildMedia(item);
		if (media) {
			body.appendChild(media);
		} else if (item.hasEmbed) {
			// 画像以外の添付 (動画・リンクカード・引用) は文字で知らせるだけにする
			const embed = document.createElement('p');
			embed.className = c.embed;
			embed.textContent = text.hasEmbed;
			body.appendChild(embed);
		}

		/** @type {ReplyRow} */
		const row = {li, item, depth, anchorUri, body, showButton: null, area: null};
		body.appendChild(this.buildMeta(row));
		li.appendChild(body);
		if (depth === 0) {
			const area = document.createElement('div');
			area.className = c.area;
			area.hidden = true;
			body.appendChild(area);
			row.area = area;
		}
		this.rows.set(item.uri, row);
		if (depth === 0) {
			const branch = this.branches.get(item.uri);
			if (branch && branch.open) {
				// 描き直し (設定の切り替え・「もっと見る」) の後も開いた状態を保つ
				queueMicrotask(() => this.renderBranch(item.uri));
			}
		}
		return li;
	}

	/**
	 * 返信に付いた画像のサムネイルを並べる。押すとライトボックスをその画像で開き直す。
	 * NSFW ラベル付きはグリッドと同じく、1 回目の押下でぼかしを外すだけにする。
	 * @param {Object} item ReplyItem
	 * @returns {HTMLElement|null} 画像が無ければ null
	 */
	buildMedia(item) {
		const media = extractMediaFromEmbed(item.embed, this.mediaConfig);
		if (media.length === 0) {
			return null;
		}
		const c = this.config.classes;
		const text = this.config.text;
		const images = toLightboxImages(media);
		const blurText = formatBlurLabels(matchBlurLabels(item.labels, this.mediaConfig), this.mediaConfig);
		const shown = media.slice(0, this.config.media.maxThumbs);
		const rest = media.length - shown.length;
		const wrap = document.createElement('div');
		wrap.className = c.media;
		wrap.dataset.count = String(shown.length);
		if (shown.length === 1) {
			wrap.style.aspectRatio = String(mediaAspectRatio(shown[0].dimensions, this.config.media.singleAspect));
		}
		const openLabel = (alt) => (alt ? `${text.openMedia}: ${alt}` : text.openMedia);
		shown.forEach((entry, index) => {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = c.mediaItem;
			button.setAttribute('aria-label', openLabel(entry.alt));
			const img = document.createElement('img');
			img.src = entry.thumbUrl;
			img.alt = '';
			img.loading = 'lazy';
			img.decoding = 'async';
			button.appendChild(img);
			if (blurText) {
				button.classList.add(c.mediaBlurred);
				const label = document.createElement('span');
				label.className = c.mediaLabel;
				label.textContent = blurText;
				button.appendChild(label);
				if (!this.unblurEnabled) {
					button.setAttribute('aria-label', `${text.showBlurred}: ${blurText}`);
				}
			}
			if (rest > 0 && index === shown.length - 1) {
				const more = document.createElement('span');
				more.className = c.mediaMore;
				more.textContent = `+${rest}`;
				button.appendChild(more);
			}
			button.addEventListener('click', () => {
				if (!this.unblurEnabled && button.classList.contains(c.mediaBlurred)) {
					button.classList.remove(c.mediaBlurred);
					button.setAttribute('aria-label', openLabel(entry.alt));
					return;
				}
				this.host.openMedia({
					images,
					index,
					postUri: item.uri,
					authorDid: item.authorDid,
					handle: item.handle,
					rkey: item.rkey
				});
			});
			wrap.appendChild(button);
		});
		return wrap;
	}

	/**
	 * 「作者」「あなた」のどちらを付けるか。
	 * @param {Object} item ReplyItem
	 * @returns {{text: string, self: boolean}|null}
	 */
	labelFor(item) {
		if (this.sessionDid && item.authorDid === this.sessionDid) {
			return {text: this.config.text.labelSelf, self: true};
		}
		const raw = this.post && this.post.raw;
		if (raw && raw.author && item.authorDid === raw.author.did) {
			return {text: this.config.text.labelAuthor, self: false};
		}
		return null;
	}

	/**
	 * 行の下段 (返信 · 削除 · 返信を表示 · 日時) を作る。
	 * @param {ReplyRow} row
	 * @returns {HTMLElement}
	 */
	buildMeta(row) {
		const c = this.config.classes;
		const text = this.config.text;
		const routes = EXT_CONFIG.mediaGrid.bridge.routes;
		const item = row.item;
		const meta = document.createElement('div');
		meta.className = c.meta;
		const button = (className, label) => {
			const el = document.createElement('button');
			el.type = 'button';
			el.className = `${c.metaButton} ${className}`;
			el.textContent = label;
			meta.appendChild(el);
			return el;
		};
		if (this.isWritable()) {
			const reply = button(c.toggle, text.reply);
			reply.setAttribute('aria-expanded', 'false');
			reply.addEventListener('click', () => this.toggleRowForm(row, reply));
			if (item.authorDid === this.sessionDid) {
				const remove = button(c.deleteButton, text.delete);
				remove.addEventListener('click', () => this.onDeleteClick(row, remove));
				remove.addEventListener('blur', () => this.cancelConfirm(remove));
				remove.addEventListener('keydown', (event) => {
					if (event.key === 'Escape' && this.confirmingButton === remove) {
						// 聞き返しを畳むだけにする (ライトボックスまで閉じない)
						event.stopPropagation();
						this.cancelConfirm(remove);
					}
				});
			}
		}
		if (row.depth === 0) {
			const show = button(c.showReplies, text.showReplies);
			show.setAttribute('aria-expanded', 'false');
			show.hidden = item.replyCount === 0 && !this.branches.has(item.uri);
			show.addEventListener('click', () => this.toggleBranch(item.uri));
			row.showButton = show;
		}
		const date = button(c.date, formatReplyDate(item.createdAt));
		date.addEventListener('click', () => this.host.leaveTo({
			route: routes.post, params: {name: item.handle, rkey: item.rkey}
		}));
		return meta;
	}

	/**
	 * 行の直下の入力欄を出し入れする。同時に開くのは 1 つだけ。
	 * @param {ReplyRow} row
	 * @param {HTMLButtonElement} button 「返信」
	 * @returns {void}
	 */
	toggleRowForm(row, button) {
		const opened = this.rowForm && this.rowForm.button === button;
		this.closeRowForm(opened);
		if (opened) {
			return;
		}
		const composer = this.createComposer({
			uri: row.item.uri,
			cid: row.item.cid,
			replyRef: row.item.replyRef,
			isPost: false,
			anchorUri: row.anchorUri,
			handle: row.item.handle
		}, this.config.text.replyPlaceholder, row.item.langs);
		const meta = row.body.querySelector(`.${this.config.classes.meta}`);
		if (meta && meta.nextSibling) {
			row.body.insertBefore(composer.el, meta.nextSibling);
		} else {
			row.body.appendChild(composer.el);
		}
		composer.sync();
		button.setAttribute('aria-expanded', 'true');
		this.rowForm = {composer, button};
		composer.focus();
	}

	/**
	 * 返信への返信の入力欄を閉じる。
	 * @param {boolean} restoreFocus 閉じた後に「返信」ボタンへフォーカスを戻すか
	 * @returns {void}
	 */
	closeRowForm(restoreFocus) {
		if (!this.rowForm) {
			return;
		}
		const {composer, button} = this.rowForm;
		this.rowForm = null;
		this.composers.delete(composer);
		composer.destroy();
		button.setAttribute('aria-expanded', 'false');
		if (restoreFocus && button.isConnected) {
			button.focus({preventScroll: true});
		}
	}

	/**
	 * 1 段目の返信の中を開く / 閉じる。閉じたら中身を捨て、次に開くときは取り直す。
	 * @param {string} anchorUri
	 * @returns {void}
	 */
	toggleBranch(anchorUri) {
		const branch = this.branches.get(anchorUri);
		if (branch && branch.open) {
			this.branches.delete(anchorUri);
			this.renderBranch(anchorUri);
			return;
		}
		this.branches.set(anchorUri, {open: true, items: null, shown: 0});
		this.renderBranch(anchorUri);
		this.loadBranch(anchorUri);
	}

	/**
	 * 開いた返信の下を読む。
	 * @param {string} anchorUri
	 * @returns {Promise<void>}
	 */
	async loadBranch(anchorUri) {
		const generation = this.generation;
		try {
			const result = await this.fetchThread(anchorUri, this.config.depth.branch);
			const branch = this.branches.get(anchorUri);
			if (generation !== this.generation || !branch || !branch.open) {
				return;
			}
			if (!result.json) {
				branch.error = true;
				this.renderBranch(anchorUri);
				return;
			}
			branch.items = flattenThreadBranch(result.json, anchorUri);
			branch.shown = Math.min(this.config.pageSize, branch.items.length);
			this.renderBranch(anchorUri);
		} catch (error) {
			console.error('[XViewer] 返信の中の取得に失敗しました', error);
		}
	}

	/**
	 * 開いた返信の中を今の状態から描き直す。
	 * @param {string} anchorUri
	 * @returns {void}
	 */
	renderBranch(anchorUri) {
		const row = this.rows.get(anchorUri);
		if (!row || !row.area) {
			return;
		}
		const c = this.config.classes;
		const text = this.config.text;
		const branch = this.branches.get(anchorUri);
		const open = !!(branch && branch.open);
		// 中の行に返信への返信の入力欄があれば、描き直しで消える前に閉じる
		if (this.rowForm && row.area.contains(this.rowForm.composer.el)) {
			this.closeRowForm(false);
		}
		// 中の行の記録を外してから描き直す
		for (const [uri, child] of this.rows) {
			if (child.depth === 1 && child.anchorUri === anchorUri) {
				this.rows.delete(uri);
			}
		}
		row.area.textContent = '';
		row.area.hidden = !open;
		if (row.showButton) {
			row.showButton.hidden = !open && row.item.replyCount === 0;
			row.showButton.setAttribute('aria-expanded', open ? 'true' : 'false');
			row.showButton.textContent = open ? text.hideReplies : text.showReplies;
		}
		if (!open) {
			return;
		}
		if (branch.error) {
			const error = document.createElement('p');
			error.className = c.error;
			error.setAttribute('role', 'alert');
			error.textContent = text.error;
			row.area.appendChild(error);
			return;
		}
		if (!Array.isArray(branch.items)) {
			const loading = document.createElement('p');
			loading.className = c.status;
			loading.textContent = text.loading;
			row.area.appendChild(loading);
			return;
		}
		const list = document.createElement('ul');
		list.className = c.childList;
		for (const item of branch.items.slice(0, branch.shown)) {
			list.appendChild(this.buildRow(item, 1, anchorUri));
		}
		row.area.appendChild(list);
		if (branch.shown < branch.items.length) {
			const more = document.createElement('button');
			more.type = 'button';
			more.className = c.more;
			more.textContent = text.moreReplies;
			more.addEventListener('click', () => {
				branch.shown = Math.min(branch.shown + this.config.pageSize, branch.items.length);
				this.renderBranch(anchorUri);
			});
			row.area.appendChild(more);
		}
	}

	/**
	 * 削除ボタンの押下。1 回目で聞き返し、2 回目で消す。
	 * @param {ReplyRow} row
	 * @param {HTMLButtonElement} button
	 * @returns {Promise<void>}
	 */
	async onDeleteClick(row, button) {
		if (this.confirmingButton !== button) {
			this.cancelConfirm(this.confirmingButton);
			this.confirmingButton = button;
			button.classList.add(this.config.classes.confirming);
			button.textContent = this.config.text.confirmDelete;
			return;
		}
		this.cancelConfirm(button);
		const generation = this.generation;
		button.disabled = true;
		this.clearError(row.body);
		try {
			const result = await this.host.actions.deleteReply(row.item.uri);
			if (generation !== this.generation) {
				return;
			}
			if (!result.ok) {
				ExtDebug.log('返信の削除が失敗', {理由: result.reason});
				button.disabled = false;
				this.showError(row.body, this.config.text.deleteFailed);
				return;
			}
			this.removeRow(row);
		} catch (error) {
			console.error('[XViewer] 返信の削除に失敗しました', error);
			if (generation === this.generation) {
				button.disabled = false;
				this.showError(row.body, this.config.text.deleteFailed);
			}
		}
	}

	/**
	 * 削除の聞き返しを畳む。
	 * @param {HTMLButtonElement|null} button
	 * @returns {void}
	 */
	cancelConfirm(button) {
		if (!button || this.confirmingButton !== button) {
			return;
		}
		this.confirmingButton = null;
		button.classList.remove(this.config.classes.confirming);
		button.textContent = this.config.text.delete;
	}

	/**
	 * 消した返信の行を外し、件数を合わせる。フォーカスは次の行の削除ボタンか見出しへ。
	 * @param {ReplyRow} row
	 * @returns {void}
	 */
	removeRow(row) {
		const c = this.config.classes;
		let next = row.li.nextElementSibling;
		while (next && !next.querySelector(`.${c.deleteButton}`)) {
			next = next.nextElementSibling;
		}
		if (this.rowForm && row.li.contains(this.rowForm.composer.el)) {
			this.closeRowForm(false);
		}
		row.li.remove();
		this.rows.delete(row.item.uri);
		if (row.depth === 0) {
			const index = this.items ? this.items.indexOf(row.item) : -1;
			if (index !== -1) {
				this.items.splice(index, 1);
				this.shown = Math.max(0, this.shown - 1);
			}
			this.branches.delete(row.item.uri);
			this.host.adjustReplyCount(-1);
			if (this.items && this.items.length === 0) {
				this.renderBody();
			}
		} else {
			const branch = this.branches.get(row.anchorUri);
			if (branch && Array.isArray(branch.items)) {
				const index = branch.items.indexOf(row.item);
				if (index !== -1) {
					branch.items.splice(index, 1);
					branch.shown = Math.max(0, branch.shown - 1);
				}
			}
			const anchor = this.rows.get(row.anchorUri);
			if (anchor && row.item.parentUri === row.anchorUri) {
				anchor.item.replyCount = Math.max(0, anchor.item.replyCount - 1);
			}
		}
		const target = next ? next.querySelector(`.${c.deleteButton}`) : null;
		if (target) {
			target.focus({preventScroll: true});
		} else if (this.headingEl) {
			this.headingEl.focus({preventScroll: true});
		}
	}

	/**
	 * 入れ物の末尾に 1 行のエラーを出す (前のものは消す)。
	 * @param {HTMLElement} container
	 * @param {string} message
	 * @returns {void}
	 */
	showError(container, message) {
		if (!container || !container.isConnected) {
			return;
		}
		this.clearError(container);
		const error = document.createElement('p');
		error.className = this.config.classes.error;
		error.setAttribute('role', 'alert');
		error.textContent = message;
		container.appendChild(error);
	}

	/**
	 * 入れ物の直下のエラーを消す。
	 * @param {HTMLElement} container
	 * @returns {void}
	 */
	clearError(container) {
		if (!container) {
			return;
		}
		for (const child of Array.from(container.children)) {
			if (child.classList.contains(this.config.classes.error)) {
				child.remove();
			}
		}
	}
}
