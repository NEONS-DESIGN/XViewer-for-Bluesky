/**
 * 返信の入力欄 1 つ分の入れ物。投稿 (reply-post.js の ComposerPost) を並べ、共通の行 (言語の提案・「＋」・言語・
 * 残りの文字数・送信) と送信を持つ。共通の行はアクティブな投稿のツールバーに並べる。
 * 「＋」で続きの投稿を足し、空でない投稿が 2 件以上なら 1 回の applyWrites で返信の連なりとして送る。
 * 投稿への入力欄も、返信への返信の入力欄もこれを使う。
 *
 * **返信欄 (lightbox-replies.js) を import しない。** 送った結果・世代・送信中の印・
 * 言語の保存・通信は、返信欄が deps として渡す口だけを使う。書き込みは呼び出し層 (PostActions)
 * と橋渡しを通る。
 *
 * 依存: debug.js / icons.js / bridge-protocol.js / reply-text.js / reply-embed.js / reply-sheets.js /
 *       reply-attachments.js / reply-submit.js / sheet-dom.js / reply-post.js / reply-thread.js / record-cid.js
 */
import {ExtDebug} from '../common/debug.js';
import {createIcon} from '../common/icons.js';
import {BRIDGE_PROTOCOL} from '../common/bridge-protocol.js';
import {resolveReplyRef} from './reply-text.js';
import {normalizeLanguages, suggestReplyLanguage} from './reply-embed.js';
import {openLanguageSheet, languageName} from './reply-sheets.js';
import {createIconButton} from './reply-attachments.js';
import {createElement, createButton, formatText, browserLocale} from './sheet-dom.js';
import {runSubmit, runThreadSubmit} from './reply-submit.js';
import {ComposerPost, defaultLanguages} from './reply-post.js';
import {
	isEmptyPost, splitEmptyPosts, canAddPost, canSubmitThread, chainThreadRecords, chainTargets
} from './reply-thread.js';
import {computeRecordCid, nextTid} from './record-cid.js';

export {pickPastedMedia, hasMediaItems, uploadAll, runSubmit, runThreadSubmit} from './reply-submit.js';
export {defaultLanguages} from './reply-post.js';

/** TID の clock id が取れる値の数 (10 ビット) */
const TID_CLOCK_ID_COUNT = 1024;

/** Date.now() のミリ秒を TID のマイクロ秒にする倍率 */
const MICROS_PER_MS = 1000;

/** 送信ボタンの読み上げを「{件数} 件の返信を送信」にする件数の下限 */
const THREAD_LABEL_MIN_POSTS = 2;

/** 動きを減らす設定の問い合わせ */
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * 動きを減らす設定か。読めなければ偽。
 * @returns {boolean}
 */
function prefersReducedMotion() {
	try {
		const view = document.defaultView;
		return !!view && typeof view.matchMedia === 'function' && view.matchMedia(REDUCED_MOTION_QUERY).matches === true;
	} catch (error) {
		return false;
	}
}

/**
 * 入力欄が使う口。返信欄 (lightbox-replies.js) が入力欄ごとに作って渡す。
 * @typedef {Object} ComposerDeps
 * @property {import('./post-actions.js').PostActions} actions 呼び出し層 (createReply / createReplyThread)
 * @property {import('./reply-sheets.js').SheetHost|null} sheets 重ねる画面の持ち主
 * @property {(blob: Blob) => Promise<{ok: boolean, blob: Object|null, reason: string|null}>} uploadBlob
 * @property {typeof import('./image-prepare.js').prepareImage} prepareImage
 * @property {() => Object|null} getSelfProfile 自分のプロフィール (アバターと連なりの宛先のハンドルに使う)
 * @property {() => string|null} getSessionDid ログイン中の DID
 * @property {(generation: number) => boolean} isCurrent 応答を使ってよい世代か
 * @property {() => number} getGeneration 今の世代
 * @property {() => boolean} isPosting どれかの入力欄が送信中か
 * @property {(posting: boolean) => void} setPosting
 * @property {(result: {uri: string, cid: string}, record: Object,
 *   target: import('./lightbox-replies.js').ReplyTarget, embedView: Object|null) => void} onPosted
 *   送れた返信を一覧へ入れる (連なりなら送った順に 1 件ずつ呼ぶ)
 * @property {() => void} reload 返信欄が一覧を取り直す (連なりが届いたか確かめられなかったとき)
 * @property {(handle: string) => Promise<string|null>} resolveHandle メンションを DID に引く
 * @property {string[]|null} parentLangs 返信先の record.langs (言語の提案に使う)
 * @property {() => Promise<string[]>} loadLanguages 覚えている投稿言語
 * @property {(codes: string[]) => void} saveLanguages 選んだ投稿言語を覚える
 * @property {(url: string, timeoutMs: number) => Promise<{status: number, json: any}|null>} fetchJson
 *   JSON を引く (リンクカード・GIF の検索)。失敗は null
 * @property {(url: string, timeoutMs: number) => Promise<Blob|null>} fetchBlob サムネイルを引く。失敗は null
 * @property {(uri: string) => Promise<Object|null>} fetchPost 引用する投稿を引く (getPosts の応答)
 * @property {(uri: string) => string|null} safeHref リンクにしてよい URL か
 * @property {(iso: string) => string} formatDate 引用元の日時の表示
 * @property {string|null} gifLocale GIF の検索に渡す地域 (小文字の 2 文字。無ければ null)
 * @property {(labels: string[]) => string|null} [blurText] 引用元の画像をぼかす理由 (無ければぼかさない)
 * @property {typeof import('./blob-transfer.js').uploadVideo} uploadVideo 動画をアップロードし、処理を待つ
 * @property {typeof import('./blob-transfer.js').cancelVideoUpload} cancelVideoUpload 走っている動画のアップロードを取り消す
 * @property {typeof import('./reply-video.js').readVideoMeta} readVideoMeta 動画の幅・高さ・長さを読む
 */

/**
 * 連なりの送信の進み具合を、全投稿を通した 1 つの番号にまとめる。
 * 画像・字幕は送る前に数が分かるため最初から全体に入れ、GIF・カードのサムネイルは record を組むとき
 * (すべての画像を送り終えた後) に分かるため、分かった時点で全体に足す。
 * @param {(current: number, total: number) => void} show いま送っている番号 (1 始まり) と全体の数を出す
 * @returns {{blob: (current: number, total: number) => void,
 *   thumbnail: (index: number, done: number, total: number) => void}}
 *   blob は runThreadSubmit の進み具合 (全投稿を通した画像の番号)、thumbnail は投稿 index のサムネイルの進み具合
 *   (done は送り終えた数、total はその投稿のサムネイルの数)
 */
export function createThreadProgress(show) {
	let blobTotal = 0;
	let thumbTotal = 0;
	/** @type {Map<number, number>} 投稿ごとの、その投稿より前のサムネイルの数 */
	const thumbBase = new Map();
	return {
		blob(current, total) {
			blobTotal = total;
			show(current, blobTotal + thumbTotal);
		},
		thumbnail(index, done, total) {
			if (!thumbBase.has(index)) {
				thumbBase.set(index, thumbTotal);
				thumbTotal += total;
			}
			// done は送り終えた数。送っている最中のものを 1 始まりで数える (画像と同じ見せ方)
			const current = blobTotal + thumbBase.get(index) + Math.min(Math.max(done, 0) + 1, total);
			show(current, blobTotal + thumbTotal);
		}
	};
}

/**
 * 送り始めたときのフォーカスの位置。
 * @typedef {Object} SubmitFocus
 * @property {import('./reply-post.js').ComposerPost|null} post 本文の欄にフォーカスがあった投稿
 * @property {boolean} inside フォーカスがこの入力欄の中 (送信ボタンなど) にあったか
 * @property {number} resets 送り始めたときの resetCount
 */

/**
 * 入力欄 1 つ分 (投稿の入れ物)。
 */
export class ReplyComposer {
	/**
	 * @param {Object} config EXT_CONFIG.lightboxReplies
	 * @param {ComposerDeps} deps 返信欄から渡す口
	 * @param {import('./lightbox-replies.js').ReplyTarget} target 返信の宛先
	 * @param {string} placeholder 本文の欄の placeholder
	 */
	constructor(config, deps, target, placeholder) {
		this.config = config;
		this.compose = config.compose;
		this.deps = deps;
		this.target = target;
		this.locale = browserLocale(this.compose.emoji.query.localeJa);
		/** @type {ComposerPost[]} 並べている投稿 */
		this.posts = [];
		/** アクティブな投稿の位置 (共通の行を並べる投稿) */
		this.activeIndex = 0;
		/** @type {string[]} 選んでいる投稿言語 */
		this.languages = defaultLanguages(navigator.language, this.compose);
		/** 利用者が言語を選び直したか (覚えた言語の読み込みで上書きしない) */
		this.languagesTouched = false;
		/** 言語の提案を「×」で閉じたか */
		this.suggestDismissed = false;
		/** @type {string|null} 出している言語の提案 */
		this.suggestCode = null;
		/** @type {HTMLElement|null} 入れ物の末尾の 1 行 (返信の作成の失敗の知らせ・空の投稿の問い合わせ) */
		this.noticeEl = null;
		/** @type {HTMLElement|null} 出している空の投稿の問い合わせ (noticeEl と同じ要素) */
		this.skipPromptEl = null;
		/** この入力欄が送信中か */
		this.busy = false;
		this.destroyed = false;
		/** rkey (TID) の clock id。入力欄ごとに 1 つ決める */
		this.clockId = Math.floor(Math.random() * TID_CLOCK_ID_COUNT);
		/** @type {string|null} 最後に作った TID (次の TID をこれより大きくする) */
		this.lastTid = null;
		/** 送れた後に入力欄を空に戻した回数 (送信の後のフォーカスの戻し方を決めるのに使う) */
		this.resetCount = 0;
		this.build(placeholder);
		this.applyStoredLanguages();
	}

	/**
	 * アクティブな投稿。
	 * @returns {ComposerPost|null}
	 */
	get active() {
		return this.posts[this.activeIndex] || null;
	}

	/**
	 * 入れ物と共通の行を組み、投稿を 1 件入れる。
	 * @param {string} placeholder
	 * @returns {void}
	 */
	build(placeholder) {
		const c = this.config.classes;
		const cc = this.compose.classes;
		const t = this.compose.text;
		const doc = document;
		const el = createElement(doc, 'div', cc.thread);
		const suggest = createElement(doc, 'div', cc.suggest);
		suggest.hidden = true;
		const suggestText = createElement(doc, 'span', cc.suggestText);
		const suggestAccept = createButton(doc, cc.suggestAccept, t.suggestAccept);
		const suggestDismiss = createIconButton(doc, cc.suggestDismiss, 'close', t.suggestDismiss);
		suggest.append(suggestText, suggestAccept, suggestDismiss);
		// 「＋」は足せるときだけツールバーの言語の左に置く (placeAddButton)
		const addButton = createIconButton(doc, `${cc.tool} ${cc.addPost}`, 'add', t.addPost);
		addButton.hidden = true;
		const languageButton = createButton(doc, cc.languageButton, '');
		languageButton.title = t.language;
		const languageText = createElement(doc, 'span', cc.languageText);
		languageButton.append(createIcon(doc, 'translate'), languageText);
		const remaining = createElement(doc, 'span', c.remaining);
		const submit = createButton(doc, c.submit, this.config.text.submit);
		Object.assign(this, {
			el, suggestEl: suggest, suggestText, addButton, languageButton, languageText, remaining, submitButton: submit
		});

		const post = this.createPost(placeholder);
		this.posts = [post];
		this.activeIndex = 0;
		el.append(post.el);
		this.mountShared(post);
		this.bindEvents(suggestAccept, suggestDismiss);
		this.renderLanguages();
		this.sync();
	}

	/**
	 * 投稿を 1 件作る。投稿からの知らせはこの入れ物が受ける。
	 * @param {string} placeholder
	 * @returns {ComposerPost}
	 */
	createPost(placeholder) {
		const post = new ComposerPost(this.config, this.deps, {
			onChange: () => this.sync(),
			onActivate: (one) => this.onActivate(one),
			onSubmit: () => this.submit(),
			onRemove: (one) => this.removePost(one),
			getLanguages: () => this.languages,
			isBusy: () => this.busy
		}, placeholder);
		// 本文を直したら空の投稿の問い合わせを引っ込める
		post.textarea.addEventListener('input', () => this.hideSkipPrompt());
		return post;
	}

	/**
	 * 共通の行 (言語・残り・送信と言語の提案) を投稿のツールバーへ並べる。「＋」は placeAddButton が置く。
	 * @param {ComposerPost} post
	 * @returns {void}
	 */
	mountShared(post) {
		post.mountShared([this.languageButton, this.remaining, this.submitButton], this.suggestEl);
	}

	/**
	 * 「＋」を出す / 外す。出すときはアクティブな投稿のツールバーの言語の左に置く。
	 * 隠すときは要素ごと外す (投稿が 1 件で空のあいだのツールバーを今までと同じ並びに保つ)。
	 * 置き場所が変わるときだけ動かす (押している最中のボタンを付け外ししないため)。
	 * @param {boolean} show
	 * @returns {void}
	 */
	placeAddButton(show) {
		const button = this.addButton;
		button.hidden = !show;
		try {
			if (!show) {
				if (button.parentNode) button.remove();
				return;
			}
			const post = this.active;
			if (!post) return;
			const toolbar = post.toolbarEl;
			if (button.parentNode !== toolbar && toolbar.contains(this.languageButton)) {
				toolbar.insertBefore(button, this.languageButton);
			}
		} catch (error) {
			console.error('[XViewer] 投稿を足すボタンを置けませんでした', error);
		}
	}

	/**
	 * 投稿の中にフォーカスが入った。その投稿をアクティブにする。
	 * @param {ComposerPost} post
	 * @returns {void}
	 */
	onActivate(post) {
		if (this.destroyed) return;
		const index = this.posts.indexOf(post);
		if (index === -1 || index === this.activeIndex) return;
		this.setActive(index);
	}

	/**
	 * index の投稿をアクティブにし、共通の行をその投稿のツールバーへ移す。
	 * 共通の行を付け直すのはアクティブな投稿が変わったときだけ (付け直すと押している最中のボタンが外れる)。
	 * @param {number} index
	 * @returns {void}
	 */
	setActive(index) {
		if (this.destroyed || index < 0 || index >= this.posts.length) return;
		const previous = this.active;
		const next = this.posts[index];
		this.activeIndex = index;
		if (previous !== next) {
			if (previous) previous.mountShared([]);
			this.addButton.remove();
			this.mountShared(next);
		}
		this.sync();
		if (previous !== next) this.reveal(next.el);
	}

	/**
	 * 「＋」: アクティブな投稿のすぐ後ろに空の投稿を入れ、その本文の欄へフォーカスを移す。
	 * 足せる条件 (canAddPost) を満たさないとき・送信中は何もしない。
	 * @returns {void}
	 */
	addPost() {
		if (this.destroyed || this.busy) return;
		const summaries = this.posts.map((one) => one.summary());
		if (!canAddPost(summaries, this.activeIndex, this.compose.thread.maxPosts)) return;
		this.hideSkipPrompt();
		const post = this.createPost(this.compose.text.addPlaceholder);
		const index = this.activeIndex + 1;
		try {
			const before = index < this.posts.length
				? this.posts[index].el
				: (this.noticeEl && this.noticeEl.parentNode === this.el ? this.noticeEl : null);
			this.el.insertBefore(post.el, before);
		} catch (error) {
			console.error('[XViewer] 投稿を足せませんでした', error);
			post.destroy();
			return;
		}
		this.posts.splice(index, 0, post);
		this.setActive(index);
		post.focus();
	}

	/**
	 * 投稿を 1 件消す (「×」)。投稿が 1 件のとき・送信中は何もしない。
	 * 消した投稿は destroy (動画のアップロードを取り消し、預かった画像の URL を捨て、その投稿の重ねる画面を閉じる)。
	 * アクティブな投稿を消したら、前 (無ければ次) の投稿をアクティブにして本文の欄へフォーカスを移す。
	 * @param {ComposerPost} post
	 * @returns {void}
	 */
	removePost(post) {
		if (this.destroyed || this.busy || this.posts.length < 2) return;
		const index = this.posts.indexOf(post);
		if (index === -1) return;
		const wasActive = index === this.activeIndex;
		this.hideSkipPrompt();
		post.mountShared([]);
		if (wasActive) this.addButton.remove();
		this.posts.splice(index, 1);
		post.destroy();
		if (wasActive) {
			this.activeIndex = index > 0 ? index - 1 : 0;
			this.mountShared(this.active);
		} else if (index < this.activeIndex) {
			this.activeIndex -= 1;
		}
		this.sync();
		if (wasActive && this.active) {
			this.reveal(this.active.el);
			this.active.focus();
		}
	}

	/**
	 * 共通の行の要素にリスナーを付ける。
	 * @param {HTMLButtonElement} suggestAccept 提案の「はい」
	 * @param {HTMLButtonElement} suggestDismiss 提案の「×」
	 * @returns {void}
	 */
	bindEvents(suggestAccept, suggestDismiss) {
		this.submitButton.addEventListener('click', () => this.submit());
		this.addButton.addEventListener('click', () => this.addPost());
		this.languageButton.addEventListener('click', () => this.openLanguages());
		suggestAccept.addEventListener('click', () => this.acceptSuggestion());
		suggestDismiss.addEventListener('click', () => {
			this.suggestDismissed = true;
			this.renderSuggest();
			this.focus();
		});
	}

	/**
	 * アクティブな投稿の本文の欄へフォーカスを移す。
	 * @returns {void}
	 */
	focus() {
		const post = this.active;
		if (post) post.focus();
	}

	/**
	 * 書きかけがあるか (どれかの投稿に本文・添付・GIF・動画が 1 つでもある)。
	 * Escape でライトボックスを閉じさせない判定に使う。
	 * @returns {boolean}
	 */
	hasDraft() {
		if (this.destroyed || !this.el.isConnected) return false;
		return this.posts.some((post) => post.hasDraft());
	}

	/**
	 * 残りの文字数・送信ボタン・「＋」「×」・投稿の濃淡と、各投稿の GIF ボタンと欄の高さを今の状態に合わせる。
	 * @returns {void}
	 */
	sync() {
		const post = this.active;
		if (!post || !this.remaining) return;
		const c = this.config.classes;
		const summaries = [];
		const checks = [];
		for (const one of this.posts) {
			one.sync();
			const summary = one.summary();
			summaries.push(summary);
			checks.push({empty: isEmptyPost(summary), ok: one.check().ok});
		}
		this.renderPosts();
		this.placeAddButton(canAddPost(summaries, this.activeIndex, this.compose.thread.maxPosts));
		const check = post.check();
		this.remaining.textContent = `${this.config.text.remaining} ${check.remaining}`;
		this.remaining.classList.toggle(c.warn, check.remaining <= this.config.warnRemaining);
		this.submitButton.disabled = !canSubmitThread(checks) || this.busy || this.deps.isPosting();
		const filled = checks.filter((one) => !one.empty).length;
		// 送信中は外す (見える「送信中 2/5」を読ませる)
		if (filled >= THREAD_LABEL_MIN_POSTS && !this.busy) {
			this.submitButton.setAttribute('aria-label', formatText(this.compose.text.submitThread, {count: filled}));
		} else {
			this.submitButton.removeAttribute('aria-label');
		}
	}

	/**
	 * 投稿の濃淡と「×」を合わせる。投稿が 2 件以上のときだけ、アクティブでない投稿を薄くし、
	 * アクティブな投稿に「×」を出す。
	 * @returns {void}
	 */
	renderPosts() {
		const multiple = this.posts.length >= 2;
		this.el.classList.toggle(this.compose.classes.threadMulti, multiple);
		this.posts.forEach((one, index) => {
			const active = index === this.activeIndex;
			one.setActive(active || !multiple);
			one.setRemovable(multiple && active);
		});
	}

	/**
	 * 覚えた言語を読み、まだ選び直していなければそれにする。
	 * @returns {Promise<void>}
	 */
	async applyStoredLanguages() {
		try {
			const codes = await this.deps.loadLanguages();
			if (this.destroyed || this.languagesTouched) return;
			// 空でもそのまま使う (提案で切り替えた言語を、送った後まで持ち越さない)
			this.languages = normalizeLanguages(codes, this.compose.maxLanguages, this.compose.languageCodes);
			this.renderLanguages();
		} catch (error) {
			console.error('[XViewer] 投稿言語を読み込めませんでした', error);
		}
	}

	/**
	 * 言語のボタンの文言と、言語の提案を今の選択に合わせる。
	 * @returns {void}
	 */
	renderLanguages() {
		const t = this.compose.text;
		const names = this.languages.map((code) => languageName(code, this.locale)).join(t.listSeparator);
		this.languageText.textContent = names || t.language;
		this.languageButton.setAttribute('aria-label', names ? formatText(t.languageCurrent, {names}) : t.language);
		this.renderSuggest();
	}

	/**
	 * 返信先の言語が選択に無いときだけ提案を出す。
	 * @returns {void}
	 */
	renderSuggest() {
		const code = this.suggestDismissed
			? null
			: suggestReplyLanguage(this.deps.parentLangs, this.languages, this.compose.languageCodes);
		this.suggestCode = code;
		this.suggestEl.hidden = code === null;
		this.suggestText.textContent = code === null
			? ''
			: formatText(this.compose.text.suggest, {言語: languageName(code, this.locale)});
	}

	/**
	 * 提案の「はい」。その言語だけに切り替える (覚えはしない。送った後は覚えた言語に戻す)。
	 * @returns {void}
	 */
	acceptSuggestion() {
		if (!this.suggestCode) return;
		this.languages = [this.suggestCode];
		this.languagesTouched = true;
		this.renderLanguages();
		this.focus();
	}

	/**
	 * 投稿言語の画面を開く。選んだものは覚えて次回の既定にする。
	 * @returns {void}
	 */
	openLanguages() {
		if (!this.deps.sheets || this.busy) return;
		openLanguageSheet(this.deps.sheets, {selected: this.languages.slice()}, this.languageButton, (codes) => {
			this.languages = normalizeLanguages(codes, this.compose.maxLanguages, this.compose.languageCodes);
			this.languagesTouched = true;
			this.deps.saveLanguages(this.languages.slice());
			this.renderLanguages();
		}, {
			owner: this.el,
			restoreFocus: () => {
				if (this.el.contains(this.languageButton)) this.languageButton.focus({preventScroll: true});
			}
		});
	}

	/**
	 * 返信を送る。空でない投稿が 1 件なら今までどおり createRecord で、2 件以上なら連なりとして
	 * applyWrites で 1 回に送る。空でない投稿のあいだに空の投稿があれば、1 回目は送らずに問い合わせを出す。
	 * @param {{skipEmpty?: boolean}} [options] skipEmpty: 問い合わせに「飛ばして送信」と答えた
	 * @returns {Promise<void>}
	 */
	async submit(options = {}) {
		if (this.destroyed || this.busy || this.deps.isPosting()) return;
		const summaries = this.posts.map((post) => post.summary());
		const checks = this.posts.map((post, index) => ({empty: isEmptyPost(summaries[index]), ok: post.check().ok}));
		if (!canSubmitThread(checks)) return;
		const {indexes, skippedMiddle} = splitEmptyPosts(summaries);
		if (indexes.length === 1) {
			await this.submitSingle(this.posts[indexes[0]]);
			return;
		}
		if (skippedMiddle && !(options && options.skipEmpty === true)) {
			this.showSkipPrompt();
			return;
		}
		await this.submitThread(indexes.map((index) => this.posts[index]));
	}

	/**
	 * 返信を 1 件送る。失敗したら本文・添付・ALT・GIF・動画・字幕・カード・引用・ラベル・言語を残して 1 行で知らせる
	 * (blob の送信の失敗は投稿に、返信の作成の失敗は入れ物に)。
	 * @param {ComposerPost} post 送る投稿 (空でない唯一の投稿)
	 * @returns {Promise<void>}
	 */
	async submitSingle(post) {
		const generation = this.deps.getGeneration();
		const focused = this.focusState();
		const languages = this.languages.slice();
		const images = post.uploadImages();
		/** @type {{record: Object, embedView: (did: string) => Object|null}|null} 組んだ record と投稿直後の描画 */
		let built = null;
		this.deps.setPosting(true);
		this.setBusy(true);
		this.showNotice([]);
		post.showNotice([]);
		try {
			await runSubmit({
				images,
				upload: this.deps.uploadBlob,
				onProgress: (current, total) => this.showProgress(current, total),
				// 入力欄が外されただけ (描き直し・返信への返信の入力欄を閉じた) なら送信は続ける。
				// 止めると、作れた返信が一覧に入らない・書きかけが黙って消える
				isCurrent: () => this.deps.isCurrent(generation),
				buildRecord: async (blobs) => {
					built = await post.buildRecord(blobs, languages, resolveReplyRef(this.target),
						(done, total) => this.showProgress(done, total));
					return built.record;
				},
				createReply: (record) => this.deps.actions.createReply(record),
				onPosted: (result, record) => {
					const embedView = built ? this.buildEmbedView(built.embedView) : null;
					if (!this.destroyed) this.resetAfterPost();
					this.deps.onPosted(result, record, this.target, embedView);
				},
				onFailed: (kind, reason) => {
					ExtDebug.log('返信の投稿が失敗', {段階: kind, 理由: reason});
					if (this.destroyed) return;
					if (kind === 'upload') post.showUploadFailed();
					else this.showNotice([this.config.text.postFailed]);
				}
			});
		} catch (error) {
			console.error('[XViewer] 返信の投稿に失敗しました', error);
			if (!this.destroyed && this.deps.isCurrent(generation)) this.showNotice([this.config.text.postFailed]);
		} finally {
			this.finishSubmit(generation, focused);
		}
	}

	/**
	 * 2 件以上の返信を連なりとして送る。投稿ごとに blob を送って record を組み、rkey (TID) と CID で連ねて
	 * 1 回の applyWrites で書く。どれかの blob の送信が失敗したらその投稿に 1 行を出し、何も作らない。
	 * @param {ComposerPost[]} posts 送る投稿 (空の投稿を除いた並び)
	 * @returns {Promise<void>}
	 */
	async submitThread(posts) {
		const generation = this.deps.getGeneration();
		const focused = this.focusState();
		const languages = this.languages.slice();
		// 1 件目の reply だけが使われ、2 件目以降は chainThreadRecords が直前の投稿へ向け直す
		const reply = resolveReplyRef(this.target);
		/** @type {Array<((did: string) => Object|null)|null>} 投稿ごとの、投稿直後の描画を作る関数 */
		const embedViews = posts.map(() => null);
		/** @type {Array<{uri: string, cid: string}>|null} 最後に組んだ連なりの、手元で計算した uri と CID */
		let localRefs = null;
		const progress = createThreadProgress((current, total) => this.showProgress(current, total));
		const steps = posts.map((post, index) => ({
			images: post.uploadImages(),
			buildRecord: async (blobs) => {
				const built = await post.buildRecord(blobs, languages, reply,
					(done, total) => progress.thumbnail(index, done, total));
				embedViews[index] = built.embedView;
				return built.record;
			},
			onUploadFailed: (reason) => {
				ExtDebug.log('返信の連なりの blob の送信が失敗', {投稿: index + 1, 理由: reason});
				if (!this.destroyed && !post.destroyed) post.showUploadFailed();
			}
		}));
		this.deps.setPosting(true);
		this.setBusy(true);
		this.showNotice([]);
		for (const post of posts) post.showNotice([]);
		try {
			await runThreadSubmit({
				posts: steps,
				upload: this.deps.uploadBlob,
				onProgress: (current, total) => progress.blob(current, total),
				isCurrent: () => this.deps.isCurrent(generation),
				// DID が古くて組み直すときも、そのたびに新しい rkey で組む
				send: (records) => this.deps.actions.createReplyThread(async (did) => {
					const chained = await chainThreadRecords(records, {
						repo: did,
						collection: BRIDGE_PROTOCOL.collections.post,
						createType: BRIDGE_PROTOCOL.thread.createType,
						nowMs: Date.now(),
						rkeys: this.nextRkeys(records.length),
						computeCid: computeRecordCid
					});
					localRefs = chained.refs;
					return chained.writes;
				}),
				onPosted: (results, values) => this.onThreadPosted(results, values, localRefs, embedViews),
				onFailed: (kind, reason) => this.onThreadFailed(kind, reason)
			});
		} catch (error) {
			console.error('[XViewer] 返信の連なりの投稿に失敗しました', error);
			if (!this.destroyed && this.deps.isCurrent(generation)) this.showNotice([this.config.text.postFailed]);
		} finally {
			this.finishSubmit(generation, focused);
		}
	}

	/**
	 * 連なりが書けた。入力欄を空の 1 件に戻し、送った順に一覧へ入れる (宛先は直前の投稿へ連ねる)。
	 * 手元で計算した CID が応答と違えば記録だけする (一覧には応答の cid を使う)。
	 * @param {Array<{uri: string, cid: string}>} results 応答の uri と cid (送った順)
	 * @param {Object[]} values 送った record (連ねた後のもの)
	 * @param {Array<{uri: string, cid: string}>|null} localRefs 手元で計算した uri と CID
	 * @param {Array<((did: string) => Object|null)|null>} embedViews 投稿ごとの、投稿直後の描画を作る関数
	 * @returns {void}
	 */
	onThreadPosted(results, values, localRefs, embedViews) {
		this.logCidMismatch(localRefs, results);
		const views = embedViews.map((view) => this.buildEmbedView(view));
		const profile = this.deps.getSelfProfile();
		const selfHandle = profile && typeof profile.handle === 'string' ? profile.handle : null;
		const targets = chainTargets(this.target, results, values, selfHandle);
		if (!this.destroyed) this.resetAfterPost();
		results.forEach((result, index) => {
			try {
				this.deps.onPosted(result, values[index], targets[index], views[index]);
			} catch (error) {
				console.error('[XViewer] 送った返信を一覧へ入れられませんでした', error);
			}
		});
	}

	/**
	 * 連なりを送れなかった。届いたか確かめられないときは入力欄を空の 1 件に戻して一覧を取り直し、
	 * それ以外 (何も作られていない) は全投稿を残して「返信できませんでした」を出す。
	 * @param {'post'|'unconfirmed'} kind
	 * @param {string} reason
	 * @returns {void}
	 */
	onThreadFailed(kind, reason) {
		ExtDebug.log('返信の連なりの投稿が失敗', {段階: kind, 理由: reason});
		if (kind === 'unconfirmed') {
			if (!this.destroyed) {
				this.resetAfterPost();
				this.showNotice([this.compose.text.threadUnconfirmed]);
			}
			try {
				if (typeof this.deps.reload === 'function') this.deps.reload();
			} catch (error) {
				console.error('[XViewer] 返信の一覧を取り直せませんでした', error);
			}
			return;
		}
		if (!this.destroyed) this.showNotice([this.config.text.postFailed]);
	}

	/**
	 * 手元で計算した CID と応答の cid が違う投稿をデバッグに記録する。
	 * @param {Array<{uri: string, cid: string}>|null} localRefs
	 * @param {Array<{uri: string, cid: string}>} results
	 * @returns {void}
	 */
	logCidMismatch(localRefs, results) {
		if (!Array.isArray(localRefs) || !Array.isArray(results)) return;
		results.forEach((result, index) => {
			const local = localRefs[index];
			if (local && result && local.cid !== result.cid) {
				ExtDebug.log('手元で計算した CID が応答と違う', {投稿: index + 1, 手元: local.cid, 応答: result.cid});
			}
		});
	}

	/**
	 * 投稿直後の描画を作る。作れなければ null (一覧には本文だけで入れる)。
	 * @param {((did: string) => Object|null)|null} view buildRecord が返した関数
	 * @returns {Object|null}
	 */
	buildEmbedView(view) {
		if (typeof view !== 'function') return null;
		try {
			return view(this.deps.getSessionDid());
		} catch (error) {
			console.error('[XViewer] 送った返信の添付を描けませんでした', error);
			return null;
		}
	}

	/**
	 * 連なりの件数ぶんの rkey (TID) を作る。前に作ったものより必ず大きくする。
	 * @param {number} count
	 * @returns {string[]}
	 */
	nextRkeys(count) {
		const nowMicros = Date.now() * MICROS_PER_MS;
		const rkeys = [];
		for (let i = 0; i < count; i++) {
			this.lastTid = nextTid(this.lastTid, nowMicros, this.clockId);
			rkeys.push(this.lastTid);
		}
		return rkeys;
	}

	/**
	 * 送り始めたときのフォーカスの位置を控える。
	 * @returns {SubmitFocus}
	 */
	focusState() {
		const active = document.activeElement;
		let inside = false;
		try {
			inside = !!active && this.el.contains(active);
		} catch (error) {
			inside = false;
		}
		return {
			post: this.posts.find((post) => post.textarea === active) || null,
			inside,
			resets: this.resetCount
		};
	}

	/**
	 * 送信の後のフォーカス。本文の欄から送ったならその欄 (畳まれて消えていれば残った投稿) へ戻す。
	 * 送信ボタンなど入力欄の中から送れたときと、送信中にフォーカスを失ったときは、残った投稿の本文の欄へ移す
	 * (送れた後は共通の行を付け直すため、押したボタンからフォーカスが外れる)。
	 * @param {SubmitFocus} focused
	 * @returns {void}
	 */
	restoreFocus(focused) {
		if (this.destroyed || !focused) return;
		if (focused.post) {
			const target = focused.post.destroyed ? this.active : focused.post;
			if (target && !target.destroyed && target.textarea.isConnected) target.focus();
			return;
		}
		if (!focused.inside) return;
		const active = this.active;
		if (!active || !this.el.isConnected) return;
		let lost = true;
		try {
			lost = !this.el.contains(document.activeElement);
		} catch (error) {
			lost = true;
		}
		if (this.resetCount !== focused.resets || lost) active.focus();
	}

	/**
	 * 送信の後始末。送信中の印を下ろし、控えを捨て、外されていればメディアを片付け、フォーカスを戻す。
	 * @param {number} generation 送り始めた世代
	 * @param {SubmitFocus} focused 送り始めたときのフォーカスの位置
	 * @returns {void}
	 */
	finishSubmit(generation, focused) {
		if (this.deps.isCurrent(generation)) this.deps.setPosting(false);
		this.setBusy(false);
		// record を組む前に終わった (失敗・世代の変化) ときに控えが残らないようにする
		for (const one of this.posts) one.clearSending();
		// 送信中に外されていたら、送り終えたここで投稿の GIF・カード・引用・動画を片付ける
		if (this.destroyed) {
			for (const one of this.posts) one.disposeMedia();
		}
		this.sync();
		this.restoreFocus(focused);
	}

	/**
	 * 送れた後に、投稿を空の 1 件に戻し、言語を覚えたものに戻す。
	 * 言語の提案を閉じたことはその入力欄のあいだ保つ。
	 * @returns {void}
	 */
	resetAfterPost() {
		this.resetCount += 1;
		this.collapsePosts();
		for (const post of this.posts) post.resetAfterPost();
		this.languagesTouched = false;
		this.renderLanguages();
		this.applyStoredLanguages();
	}

	/**
	 * 投稿を先頭の 1 件だけにする (残りは片付ける)。送れた後に呼ぶ。
	 * 送信中に片付けた投稿のメディアは destroy が残すため、ここで片付ける (送った record はもう組み終えている)。
	 * @returns {void}
	 */
	collapsePosts() {
		if (this.posts.length < 2) return;
		const keep = this.posts[0];
		const removed = this.posts.slice(1);
		const active = this.active;
		if (active && active !== keep) active.mountShared([]);
		this.addButton.remove();
		this.posts = [keep];
		const activeChanged = this.activeIndex !== 0;
		this.activeIndex = 0;
		for (const post of removed) {
			const wasBusy = post.busy;
			post.mountShared([]);
			post.destroy();
			if (wasBusy) post.disposeMedia();
		}
		if (activeChanged) this.mountShared(keep);
		this.sync();
	}

	/**
	 * 送信中の見た目にする / 戻す。投稿の操作と共通の行 (提案・「＋」・言語・送信) を止める。
	 * @param {boolean} busy
	 * @returns {void}
	 */
	setBusy(busy) {
		this.busy = busy;
		for (const post of this.posts) post.setBusy(busy);
		try {
			const controls = [this.addButton, this.languageButton, this.submitButton]
				.concat(Array.from(this.suggestEl.querySelectorAll(this.compose.busyControls)));
			for (const control of controls) control.disabled = busy;
			if (busy) {
				this.submitButton.setAttribute('aria-busy', 'true');
				// 「{件数} 件の返信を送信」を外し、見える「送信中 2/5」を読ませる (終われば sync が付け直す)
				this.submitButton.removeAttribute('aria-label');
			} else {
				this.submitButton.removeAttribute('aria-busy');
				this.submitButton.textContent = this.config.text.submit;
			}
		} catch (error) {
			console.error('[XViewer] 入力欄の送信中の表示に失敗しました', error);
		}
	}

	/**
	 * 送信ボタンにアップロードの進み具合 (いま送っている枚目) を出す。
	 * @param {number} current いま送っている枚目 (1 始まり)
	 * @param {number} total 全体の枚数
	 * @returns {void}
	 */
	showProgress(current, total) {
		const done = Math.min(Math.max(current, 1), total);
		if (this.busy) this.submitButton.textContent = formatText(this.compose.text.sending, {done, total});
	}

	/**
	 * 入れ物の末尾の 1 行を出す (前のものと空の投稿の問い合わせは消す)。空なら消すだけ。
	 * @param {string[]} messages 知らせる文
	 * @returns {void}
	 */
	showNotice(messages) {
		try {
			if (this.noticeEl) this.noticeEl.remove();
			this.noticeEl = null;
			this.skipPromptEl = null;
			if (!Array.isArray(messages) || messages.length === 0 || this.destroyed) return;
			const notice = createElement(this.el.ownerDocument, 'p', this.config.classes.error,
				messages.join(this.compose.text.noticeSeparator));
			notice.setAttribute('role', 'alert');
			this.el.append(notice);
			this.noticeEl = notice;
			this.reveal(notice);
		} catch (error) {
			console.error('[XViewer] 入力欄の知らせを出せませんでした', error);
		}
	}

	/**
	 * 空でない投稿のあいだに空の投稿があるときの問い合わせを、入れ物の末尾の 1 行の位置に出す。
	 * 「飛ばして送信」へフォーカスを移す。
	 * @returns {void}
	 */
	showSkipPrompt() {
		const cc = this.compose.classes;
		const t = this.compose.text;
		this.showNotice([]);
		if (this.destroyed) return;
		try {
			const doc = this.el.ownerDocument;
			const prompt = createElement(doc, 'div', cc.skipEmpty);
			prompt.setAttribute('role', 'alert');
			const text = createElement(doc, 'span', cc.skipEmptyText, t.skipEmpty);
			const keep = createButton(doc, cc.skipEmptyKeep, t.skipEmptyKeep);
			const send = createButton(doc, cc.skipEmptySend, t.skipEmptySend);
			keep.addEventListener('click', () => {
				this.hideSkipPrompt();
				this.focus();
			});
			send.addEventListener('click', () => {
				this.hideSkipPrompt();
				// 押したボタンが消えるため、送り終えた後の戻り先として本文の欄へフォーカスを移しておく
				this.focus();
				this.submit({skipEmpty: true});
			});
			prompt.addEventListener('keydown', (event) => {
				if (event.key !== 'Escape') return;
				// 問い合わせを引っ込めるだけにする (ライトボックスまで閉じない)
				event.stopPropagation();
				this.hideSkipPrompt();
				this.focus();
			});
			prompt.append(text, keep, send);
			this.el.append(prompt);
			this.noticeEl = prompt;
			this.skipPromptEl = prompt;
			this.reveal(prompt);
			send.focus({preventScroll: true});
		} catch (error) {
			console.error('[XViewer] 空の投稿の問い合わせを出せませんでした', error);
		}
	}

	/**
	 * 投稿が 2 件以上で入れ物が中でスクロールするとき、element を入れ物の中で見える所まで送る
	 * (アクティブにした・足した投稿、問い合わせ、知らせの 1 行)。1 件のときは今までどおり何もしない。
	 * 動きを減らす設定なら一気に送る。
	 * @param {HTMLElement|null} element
	 * @returns {void}
	 */
	reveal(element) {
		if (!element || this.destroyed || this.posts.length < 2 || typeof element.scrollIntoView !== 'function') return;
		try {
			element.scrollIntoView({block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth'});
		} catch (error) {
			console.error('[XViewer] 入力欄の中を送れませんでした', error);
		}
	}

	/**
	 * 空の投稿の問い合わせを出していれば引っ込める。
	 * @returns {void}
	 */
	hideSkipPrompt() {
		if (this.skipPromptEl) this.showNotice([]);
	}

	/**
	 * 後始末。開いている重ねる画面がこの入力欄のものなら閉じ、投稿をすべて片付けて外す。
	 * 動画のアップロードが走っていれば取り消す。
	 * @returns {void}
	 */
	destroy() {
		if (this.destroyed) return;
		this.destroyed = true;
		try {
			const sheets = this.deps.sheets;
			if (sheets && sheets.isOpenedFrom(this.el)) sheets.close(false);
		} catch (error) {
			console.error('[XViewer] 入力欄の重ねる画面を閉じられませんでした', error);
		}
		for (const post of this.posts) post.destroy();
		try {
			this.el.remove();
		} catch (error) {
			console.error('[XViewer] 入力欄の撤去に失敗しました', error);
		}
	}
}
