/**
 * 返信の入力欄に付ける動画 1 本の状態 (寸法の読み取り・アップロード・処理の待ち・失敗と再試行) と、
 * そのプレビューの描画。アップロードと寸法の読み取りは deps で受け取る。
 *
 * 非同期の続き (寸法の読み取り・進み具合・結果) は、始めたときの状態と回の番号が今も同じときだけ
 * 反映する。外した・別の動画に替えた・撤去した後に届いたものは黙って捨てる。
 *
 * 依存: config.js (寸法の読み取りの既定の待ち時間)、video-rules.js、embed-cards.js (buildGifPlayer)、motion.js、
 *       sheet-dom.js、reply-attachments.js (createIconButton)、icons.js (createIcon)、object-url.js、request-slot.js
 */
import {EXT_CONFIG} from '../common/config.js';
import {createIcon} from '../common/icons.js';
import {prefersReducedMotion} from '../common/motion.js';
import {
	checkVideoFile, checkVideoMeta, checkCaptionFile, videoStatusText, videoErrorText, toPercent
} from './video-rules.js';
import {buildGifPlayer} from './embed-cards.js';
import {createElement, createButton} from './sheet-dom.js';
import {createIconButton} from './reply-attachments.js';
import {createObjectUrl, revokeObjectUrl} from './object-url.js';
import {createRequestSlot} from './request-slot.js';

/** 字幕の印に使うアイコン */
const CAPTION_ICON = 'closedCaption';

/**
 * 入力欄の動画 1 本の状態。
 * @typedef {Object} VideoState
 * @property {File} file 選んだ動画
 * @property {string} url プレビューのオブジェクト URL (寸法を読み終えるまでは空)
 * @property {number} width 幅 (px)
 * @property {number} height 高さ (px)
 * @property {number} durationMs 長さ (ミリ秒)
 * @property {'reading'|'upload'|'processing'|'ready'|'error'} phase 段階
 * @property {number|null} progress 進み具合 (0〜1。不明は null)
 * @property {Object|null} blob 処理の結果の BlobRef (ready のとき)
 * @property {string|null} error 失敗の文言 (error のとき)
 * @property {string} alt ALT テキスト
 * @property {{blob: Blob, name: string, lang: string}|null} caption 字幕
 * @property {string|null} uploadId 走っているアップロードの id
 */

/**
 * ComposerVideo が使う外の処理 (入力欄の ComposerDeps のうち動画の分)。
 * @typedef {Object} VideoDeps
 * @property {(blob: Blob, onProgress: (event: {phase: string, progress: (number|null)}) => void) => {id: string, done: Promise<{ok: boolean, blob: (Object|null), reason: (string|null), message: (string|null)}>}} uploadVideo
 * @property {(id: string) => void} cancelVideoUpload
 * @property {(file: File) => Promise<{width: number, height: number, duration: number}|null>} readVideoMeta
 */

/**
 * プレビューのボタンが押されたときの処理。
 * @typedef {Object} VideoHandlers
 * @property {(button: HTMLButtonElement) => void} [onAlt] ALT のボタン
 * @property {() => void} [onRemoved] × で外した後 (フォーカスの移し先を決める)
 */

/** 段階のうち、アップロードが走っているもの */
const RUNNING_PHASES = ['upload', 'processing'];

/**
 * 進み具合を、状態の 1 行に出す値 (百分率の整数。不明は null) にする。
 * @param {number|null} progress
 * @returns {number|null}
 */
function shownPercent(progress) {
	return Number.isFinite(progress) ? toPercent(progress) : null;
}

/**
 * 進み具合の知らせを反映すべきか。段階が変わったか、状態の 1 行に出す百分率が変わったときだけ真。
 * @param {{phase: string, progress: (number|null)}} current いまの段階と進み具合
 * @param {{phase: string, progress: (number|null)}} next 届いた段階と進み具合
 * @returns {boolean}
 */
export function isVisibleProgressChange(current, next) {
	return current.phase !== next.phase || shownPercent(current.progress) !== shownPercent(next.progress);
}

/**
 * 動画の幅・高さ・長さ (秒) を読む。video にオブジェクト URL を入れ、loadedmetadata か error を待つ。
 * 読めない・時間切れは null。URL は必ず破棄し、video の読み込みも止める。
 * @param {File} file 動画
 * @param {Document} [doc] video を作る文書
 * @param {number} [timeoutMs] 諦めるまでの時間 (ミリ秒)。省略すると compose.video.metaTimeoutMs
 * @returns {Promise<{width: number, height: number, duration: number}|null>}
 */
export function readVideoMeta(file, doc = globalThis.document, timeoutMs = EXT_CONFIG.lightboxReplies.compose.video.metaTimeoutMs) {
	return new Promise((resolve) => {
		let url = '';
		let video = null;
		let timer = null;
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			if (timer !== null) clearTimeout(timer);
			try {
				if (video) {
					video.removeAttribute('src');
					// src を外しただけでは読み込みが続くため、空の状態で読み直させて止める
					if (typeof video.load === 'function') video.load();
				}
			} catch (error) {
				// 外せなくても URL の破棄は続ける
			}
			revokeObjectUrl(url);
			resolve(value);
		};
		try {
			video = doc.createElement('video');
			video.preload = 'metadata';
			video.muted = true;
			video.addEventListener('loadedmetadata', () => {
				finish({width: Number(video.videoWidth), height: Number(video.videoHeight), duration: Number(video.duration)});
			});
			video.addEventListener('error', () => finish(null));
			timer = setTimeout(() => finish(null), timeoutMs);
			url = createObjectUrl(file);
			if (!url) {
				finish(null);
				return;
			}
			video.src = url;
		} catch (error) {
			finish(null);
		}
	});
}

/**
 * 字幕のファイルを確かめ、text/vtt の Blob に付け直す
 * (Windows の Chrome は .vtt の型を application/octet-stream にするため)。
 * @param {File} file 選んだファイル
 * @param {{extension: string, mimeType: string, maxBytes: number, signature: string, headBytes: number}} rule
 *   compose.video.caption (compose.video を渡してもよい)
 * @returns {Promise<{ok: true, blob: Blob, name: string}|{ok: false, notice: 'notVtt'|'tooLarge'}>}
 */
export async function readCaptionFile(file, rule) {
	try {
		const caption = rule && rule.caption ? rule.caption : rule;
		const head = await file.slice(0, caption.headBytes).text();
		const checked = checkCaptionFile(file, head, {caption});
		if (!checked.ok) return checked;
		return {ok: true, blob: new Blob([file], {type: caption.mimeType}), name: String(file.name || '')};
	} catch (error) {
		return {ok: false, notice: 'notVtt'};
	}
}

/**
 * 入力欄の動画 1 本を持つ。
 */
export class ComposerVideo {
	/**
	 * @param {Object} config EXT_CONFIG.lightboxReplies
	 * @param {VideoDeps} deps 口は呼ぶたびに引く (差し替えに追随する)
	 * @param {() => void} [onChange] 状態が変わったとき (描き直しの合図)
	 */
	constructor(config, deps, onChange) {
		this.config = config;
		this.compose = config.compose;
		this.cards = config.cards;
		this.rule = config.compose.video;
		this.text = config.compose.text;
		this.deps = deps;
		this.onChange = typeof onChange === 'function' ? onChange : null;
		/** @type {VideoState|null} */
		this.state = null;
		/** アップロードの回。始める・外す・空に戻すたびに入れ替え、届いた進み具合と結果に照らす */
		this.upload = createRequestSlot();
		/** 描いているプレビュー (進み具合だけの変化では作り直さない) */
		this.view = null;
		/** 最後の render で受け取った処理。作り直さずに描いたプレビューのボタンもこれを呼ぶ @type {VideoHandlers} */
		this.handlers = {};
		this.destroyed = false;
	}

	/**
	 * 状態が変わったことを知らせる。撤去した後は知らせない。
	 * @returns {void}
	 */
	notify() {
		if (this.destroyed) return;
		try {
			if (this.onChange) this.onChange();
		} catch (error) {
			console.error('[XViewer] 動画の状態の変化を知らせられませんでした', error);
		}
	}

	/**
	 * 判定の結果 (unreadable / tooLarge / tooLong) を表示する文言にする。
	 * @param {string} notice
	 * @returns {string}
	 */
	noticeText(notice) {
		if (notice === 'tooLarge') return this.text.videoTooLarge;
		if (notice === 'tooLong') return this.text.videoTooLong;
		return this.text.videoUnreadable;
	}

	/**
	 * 動画を取り込む。形式・大きさを確かめ、寸法と長さを読み、通ればアップロードを始める。
	 * @param {File} file 選んだ動画
	 * @returns {Promise<{ok: true}|{ok: false, notice: string}>} notice は表示する文言。
	 *   読んでいる間に外された・撤去されたときは空 (知らせない)
	 */
	async setFile(file) {
		if (this.destroyed) return {ok: false, notice: ''};
		if (this.state) return {ok: false, notice: this.text.tooManyVideos};
		const checked = checkVideoFile(file, this.rule);
		if (!checked.ok) return {ok: false, notice: this.noticeText(checked.notice)};

		/** @type {VideoState} */
		const state = {
			file, url: '', width: 0, height: 0, durationMs: 0, phase: 'reading', progress: null,
			blob: null, error: null, alt: '', caption: null, uploadId: null
		};
		this.state = state;
		this.notify();

		let meta = null;
		try {
			meta = await this.deps.readVideoMeta(file);
		} catch (error) {
			meta = null;
		}
		if (this.destroyed || this.state !== state) return {ok: false, notice: ''};

		const measured = checkVideoMeta(meta, this.rule);
		if (!measured.ok) {
			this.state = null;
			this.notify();
			return {ok: false, notice: this.noticeText(measured.notice)};
		}
		state.width = measured.width;
		state.height = measured.height;
		state.durationMs = measured.durationMs;
		state.url = createObjectUrl(file);
		this.startUpload(state);
		return {ok: true};
	}

	/**
	 * アップロードを始める (送り直しも同じ)。進み具合と結果は、この回が今も続いているときだけ反映する。
	 * @param {VideoState} state
	 * @returns {void}
	 */
	startUpload(state) {
		const token = this.upload.begin();
		const isCurrent = () => !this.destroyed && this.state === state && this.upload.isCurrent(token);
		state.phase = 'upload';
		state.progress = 0;
		state.blob = null;
		state.error = null;
		state.uploadId = null;
		let handle = null;
		try {
			handle = this.deps.uploadVideo(state.file, (event) => {
				if (isCurrent()) this.applyProgress(state, event);
			});
		} catch (error) {
			handle = null;
		}
		if (!handle || typeof handle.id !== 'string' || !handle.done) {
			this.applyResult(state, {ok: false, blob: null, reason: null, message: null});
			return;
		}
		state.uploadId = handle.id;
		this.notify();
		Promise.resolve(handle.done).then(
			(result) => {
				if (isCurrent()) this.applyResult(state, result);
			},
			() => {
				if (isCurrent()) this.applyResult(state, {ok: false, blob: null, reason: null, message: null});
			}
		);
	}

	/**
	 * 進み具合を反映する。状態の 1 行に出す百分率と段階が前と同じなら知らせない
	 * (知らせると入力欄が描き直しと送信ボタンの判定を毎回やり直すため)。
	 * @param {VideoState} state
	 * @param {{phase: string, progress: (number|null)}} event
	 * @returns {void}
	 */
	applyProgress(state, event) {
		try {
			if (!event || RUNNING_PHASES.indexOf(event.phase) === -1) return;
			if (RUNNING_PHASES.indexOf(state.phase) === -1) return;
			const next = {phase: event.phase, progress: Number.isFinite(event.progress) ? event.progress : null};
			const visible = isVisibleProgressChange(state, next);
			state.phase = next.phase;
			state.progress = next.progress;
			if (visible) this.notify();
		} catch (error) {
			console.error('[XViewer] 動画の進み具合を反映できませんでした', error);
		}
	}

	/**
	 * アップロードの結果を反映する。
	 * @param {VideoState} state
	 * @param {{ok: boolean, blob: (Object|null), reason: (string|null), message: (string|null)}} result
	 * @returns {void}
	 */
	applyResult(state, result) {
		try {
			state.uploadId = null;
			state.progress = null;
			if (result && result.ok === true && result.blob) {
				state.phase = 'ready';
				state.blob = result.blob;
				state.error = null;
			} else {
				state.phase = 'error';
				state.blob = null;
				state.error = videoErrorText(result || {reason: null, message: null}, this.rule, this.text);
			}
		} catch (error) {
			state.phase = 'error';
			state.error = this.text.videoFailed;
		}
		this.notify();
	}

	/**
	 * 失敗した動画を同じファイルで最初から送り直す。error のときだけ。
	 * @returns {void}
	 */
	retry() {
		const state = this.state;
		if (this.destroyed || !state || state.phase !== 'error') return;
		this.startUpload(state);
	}

	/**
	 * 走っているアップロードを取り消す。
	 * @param {VideoState} state
	 * @returns {void}
	 */
	cancelRunning(state) {
		if (!state || !state.uploadId || RUNNING_PHASES.indexOf(state.phase) === -1) return;
		try {
			this.deps.cancelVideoUpload(state.uploadId);
		} catch (error) {
			console.error('[XViewer] 動画のアップロードを取り消せませんでした', error);
		}
	}

	/**
	 * 状態を捨てる。取り消すかは呼び出し側が決める。
	 * @returns {void}
	 */
	clear() {
		const state = this.state;
		this.state = null;
		this.upload.cancel();
		this.view = null;
		if (state) revokeObjectUrl(state.url);
	}

	/**
	 * 動画を外す。走っているアップロードを取り消し、URL を破棄する。
	 * @returns {void}
	 */
	remove() {
		if (!this.state) return;
		this.cancelRunning(this.state);
		this.clear();
		this.notify();
	}

	/**
	 * ALT テキストを付ける。
	 * @param {string} alt
	 * @returns {void}
	 */
	setAlt(alt) {
		if (!this.state) return;
		this.state.alt = typeof alt === 'string' ? alt : '';
		this.notify();
	}

	/**
	 * 字幕を付ける・外す。
	 * @param {{blob: Blob, name: string, lang: string}|null} caption
	 * @returns {void}
	 */
	setCaption(caption) {
		if (!this.state) return;
		this.state.caption = caption && caption.blob ? caption : null;
		this.notify();
	}

	/**
	 * 動画を付けているか (読み取り中・アップロード中を含む)。
	 * @returns {boolean}
	 */
	isActive() {
		return this.state !== null;
	}

	/**
	 * 処理が終わって送れるか。
	 * @returns {boolean}
	 */
	isReady() {
		return !!this.state && this.state.phase === 'ready' && !!this.state.blob;
	}

	/**
	 * 付けているが、まだ送れないか (読み取り中・アップロード中・処理中・失敗)。
	 * @returns {boolean}
	 */
	isPending() {
		return !!this.state && this.state.phase !== 'ready';
	}

	/**
	 * 送るときの動画の形にする。送れないときは null。
	 * @param {Object|null} captionRef 字幕を upload-blob で送った BlobRef (無ければ null)
	 * @returns {import('./reply-embed.js').UploadedVideo|null}
	 */
	toUploaded(captionRef) {
		if (!this.isReady()) return null;
		const state = this.state;
		const captions = captionRef && state.caption ? [{lang: state.caption.lang, file: captionRef}] : [];
		return {blob: state.blob, alt: state.alt, width: state.width, height: state.height, captions};
	}

	/**
	 * 描き分けが要る変化を表す鍵。これが同じあいだは状態の 1 行とボタンの押せる / 押せないだけを書き換える
	 * (送信中かどうかは鍵に入れない。送信の始まりと終わりで動画を作り直すと再生が最初に戻るため)。
	 * @returns {string}
	 */
	viewKey() {
		const state = this.state;
		return JSON.stringify([
			state.url, state.alt !== '', !!state.caption, state.phase === 'error', state.phase === 'reading'
		]);
	}

	/**
	 * プレビュー・状態の 1 行・再試行 (寸法を読んでいる間は ×) を描く。動画が無ければ入れ物を隠す。
	 * 外枠・状態の 1 行・動画の枠・操作の枠は同じ動画のあいだ使い回し、状態の 1 行は文字だけを書き換える
	 * (aria-live の要素を作り直すと、失敗などの変化が読み上げられないため)。
	 * 動画は鍵が変わったときだけ作り直す (作り直すと再生が最初に戻るため)。
	 * @param {HTMLElement} container 入れ物
	 * @param {VideoHandlers} handlers
	 * @param {boolean} busy 送信中か (ボタンを押せなくする)
	 * @returns {void}
	 */
	render(container, handlers, busy) {
		try {
			const state = this.state;
			if (!state) {
				container.textContent = '';
				container.hidden = true;
				this.view = null;
				return;
			}
			container.hidden = false;
			this.handlers = handlers || {};
			const statusText = videoStatusText({phase: state.phase, progress: state.progress, message: state.error}, this.text);
			const key = this.viewKey();
			const doc = container.ownerDocument;
			let view = this.view;
			if (!view || view.container !== container || view.state !== state || !container.contains(view.shell)) {
				const shell = createElement(doc, 'div', this.compose.classes.video);
				const media = createElement(doc, 'div');
				const status = createElement(doc, 'p', this.compose.classes.videoStatus);
				status.setAttribute('aria-live', 'polite');
				// 再試行のボタンが消えた後のフォーカスの受け皿にする
				status.setAttribute('tabindex', '-1');
				const actions = createElement(doc, 'div');
				shell.append(media, status, actions);
				container.replaceChildren(shell);
				view = {container, state, key: null, shell, media, status, actions};
				this.view = view;
			}
			if (view.key !== key) {
				view.media.replaceChildren(...this.buildMedia(doc, state, busy));
				const actions = this.buildActions(doc, state, busy);
				view.actions.replaceChildren(...actions);
				view.actions.hidden = actions.length === 0;
				view.key = key;
			}
			this.applyBusy(view, busy);
			if (view.status.textContent !== statusText) view.status.textContent = statusText;
		} catch (error) {
			console.error('[XViewer] 動画のプレビューを描けませんでした', error);
		}
	}

	/**
	 * プレビューのボタン (ALT・×・再試行) を、送信中は押せなくし、終われば戻す。再生のボタンは触らない。
	 * @param {{media: HTMLElement, actions: HTMLElement}} view
	 * @param {boolean} busy
	 * @returns {void}
	 */
	applyBusy(view, busy) {
		const tools = view.media.querySelector(`.${this.cards.classes.gifTools}`);
		const buttons = (tools ? Array.from(tools.querySelectorAll('button')) : [])
			.concat(Array.from(view.actions.querySelectorAll('button')));
		for (const button of buttons) button.disabled = !!busy;
	}

	/**
	 * 操作の枠のボタン。失敗したら「再試行」、寸法を読んでいる間 (プレビューがまだ無い) は外す ×。
	 * @param {Document} doc
	 * @param {VideoState} state
	 * @param {boolean} busy
	 * @returns {HTMLButtonElement[]}
	 */
	buildActions(doc, state, busy) {
		if (state.phase === 'error') return [this.buildRetry(doc, busy)];
		if (state.phase === 'reading') {
			const remove = createIconButton(doc, this.compose.classes.videoRemove, 'close', this.text.removeVideo);
			remove.disabled = !!busy;
			remove.addEventListener('click', () => this.removeByUser());
			return [remove];
		}
		return [];
	}

	/**
	 * 「再試行」のボタン。押した後は、ボタンが消えるため ALT のボタンか状態の 1 行へフォーカスを移す。
	 * @param {Document} doc
	 * @param {boolean} busy
	 * @returns {HTMLButtonElement}
	 */
	buildRetry(doc, busy) {
		const retry = createButton(doc, this.compose.classes.videoRetry, this.text.videoRetry);
		retry.disabled = !!busy;
		retry.addEventListener('click', () => {
			this.retry();
			this.focusAfterRetry();
		});
		return retry;
	}

	/**
	 * 再試行の後のフォーカスを、描き直したプレビューの ALT のボタン (押せなければ状態の 1 行) へ移す。
	 * @returns {void}
	 */
	focusAfterRetry() {
		try {
			const view = this.view;
			if (this.destroyed || !view || !view.container.contains(view.shell)) return;
			const alt = view.media.querySelector(`.${this.cards.classes.gifAlt}`);
			const target = alt && !alt.disabled ? alt : view.status;
			target.focus();
		} catch (error) {
			console.error('[XViewer] 再試行の後のフォーカスを移せませんでした', error);
		}
	}

	/**
	 * 利用者が × で外した。外した後のフォーカスは onRemoved に任せる。
	 * @returns {void}
	 */
	removeByUser() {
		this.remove();
		const onRemoved = this.handlers.onRemoved;
		if (typeof onRemoved !== 'function') return;
		try {
			onRemoved();
		} catch (error) {
			console.error('[XViewer] 外した後のフォーカスを移せませんでした', error);
		}
	}

	/**
	 * 動画のプレビューを組む (寸法を読み終えるまでは何も無い)。
	 * ボタンが呼ぶ処理は押した時点の this.handlers から引く。
	 * @param {Document} doc
	 * @param {VideoState} state
	 * @param {boolean} busy
	 * @returns {HTMLElement[]}
	 */
	buildMedia(doc, state, busy) {
		if (!state.url) return [];
		const t = this.text;
		const classes = this.cards.classes;
		const text = {
			...this.cards.text,
			gifAlt: t.videoAlt,
			gifAltDone: t.videoAltDone,
			removeGif: t.removeVideo,
			gifPlay: t.videoPlay,
			gifPause: t.videoPause
		};
		const player = buildGifPlayer(doc, {
			sources: [{src: state.url, type: state.file.type || ''}],
			width: state.width,
			height: state.height
		}, {
			classes,
			text,
			label: t.video,
			autoplay: !prefersReducedMotion(doc.defaultView),
			onAlt: typeof this.handlers.onAlt === 'function'
				? (button) => {
					if (typeof this.handlers.onAlt === 'function') this.handlers.onAlt(button);
				}
				: undefined,
			onRemove: () => this.removeByUser(),
			altDone: state.alt !== ''
		});
		// 手元のファイルは中身から形式を判定させる。type を書くと、Chrome は video/quicktime (.mov) を
		// 再生できない型と見なして source を飛ばし、中身が MP4 で再生できる動画でもプレビューが空になる
		for (const source of player.querySelectorAll('source')) source.removeAttribute('type');
		const tools = player.querySelector(`.${classes.gifTools}`);
		if (tools) {
			for (const button of tools.querySelectorAll('button')) button.disabled = !!busy;
			if (state.caption) {
				const badge = createElement(doc, 'span', this.compose.classes.videoBadge);
				badge.append(createIcon(doc, CAPTION_ICON), createElement(doc, 'span', '', t.videoCaptionBadge));
				const children = Array.from(tools.children);
				const alt = children.find((child) => child.classList.contains(classes.gifAlt));
				tools.replaceChildren(...(alt ? [alt] : []), badge, ...children.filter((child) => child !== alt));
			}
		}
		return [player];
	}

	/**
	 * 送った後に空へ戻す。送った動画の blob は record が参照しているため、取り消しは送らない。
	 * @returns {void}
	 */
	reset() {
		this.clear();
	}

	/**
	 * 撤去する。送れないまま走っていれば取り消す。以後の結果・進み具合・取り込みは何もしない。
	 * @returns {void}
	 */
	destroy() {
		if (this.isPending()) this.cancelRunning(this.state);
		this.clear();
		this.destroyed = true;
	}
}
