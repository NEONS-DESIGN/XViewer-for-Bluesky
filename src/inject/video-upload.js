/**
 * MAIN ワールドで動く動画のアップロードの流れ。
 * video.bsky.app の分割アップロード (getUploadLimits → startUpload → uploadPart → finishUpload →
 * getJobStatus) を Bluesky 本体と同じ順で流し、変換し終えた動画の BlobRef だけを返す。
 * 通信・待ち・時刻・乱数はすべて deps から受け取り、ここ自身はブラウザ API に触れない。
 * (Node のテストで順序と分岐を確かめるため。実際の通信は page-bridge.js が与える)
 *
 * トークンは deps へ渡すだけで、結果・進み具合には入れない。
 */
import {BRIDGE_PROTOCOL} from '../common/bridge-protocol.js';

/** 動画サービスの宛先・NSID・回数・待ち時間。値は 2026-10-19 に本体の動きと照らした */
export const VIDEO_UPLOAD = Object.freeze({
	origin: 'https://video.bsky.app',
	/** 上限の確認のトークンの aud */
	serviceDid: 'did:web:video.bsky.app',
	nsid: Object.freeze({
		getServiceAuth: 'com.atproto.server.getServiceAuth',
		getSession: 'com.atproto.server.getSession',
		uploadBlob: 'com.atproto.repo.uploadBlob',
		getUploadLimits: 'app.bsky.video.getUploadLimits',
		startUpload: 'app.bsky.video.startUpload',
		uploadPart: 'app.bsky.video.uploadPart',
		finishUpload: 'app.bsky.video.finishUpload',
		getUploadStatus: 'app.bsky.video.getUploadStatus',
		getJobStatus: 'app.bsky.video.getJobStatus',
		abortUpload: 'app.bsky.video.abortUpload'
	}),
	/** DID 文書の中で PDS を指す service の id */
	pdsServiceId: '#atproto_pds',
	/** 同時に送る部品の数 */
	partConcurrency: 4,
	/** 部品ごとの送信の回数の上限 */
	partAttempts: 5,
	/** 部品 1 本の送信を打ち切るまでの時間 */
	partTimeoutMs: 120000,
	/** 動画サービスが PDS へ uploadBlob するトークンの寿命 (秒) */
	tokenTtlSec: 1800,
	/** 送り直しの間隔の基準。n 回目の失敗の後は retryBaseMs * 2^(n-1) 空ける */
	retryBaseMs: 500,
	/** finishUpload を試す回数の上限 */
	finishAttempts: 3,
	/** getJobStatus を引く間隔 (finishing の待ちにも使う) */
	pollIntervalMs: 1500,
	/** getJobStatus の失敗が続いてよい回数 */
	maxPollFailures: 10,
	/** 処理の完了を待つ時間の上限 */
	processingTimeoutMs: 1200000,
	/**
	 * 進み具合が増えなくても、直近の値を送り直す間隔。
	 * 分離ワールドは進み具合が 150 秒届かないと打ち切るため、それより十分短くする
	 */
	progressHeartbeatMs: 30000,
	/** 動画サービスと PDS への XRPC (部品の送信を除く) 1 回を打ち切るまでの時間 */
	requestTimeoutMs: 30000,
	/** startUpload に渡す名前の乱数の長さ */
	nameLength: 12,
	/** startUpload に渡す名前の拡張子 */
	extensions: Object.freeze({
		'video/mp4': 'mp4',
		'video/webm': 'webm',
		'video/quicktime': 'mov',
		'video/mpeg': 'mpeg'
	})
});

/** 応答の状態コードのうち、分岐に使うもの */
const HTTP_STATUS = Object.freeze({
	okMin: 200,
	okMax: 299,
	unauthorized: 401,
	requestTimeout: 408,
	tooManyRequests: 429,
	serverErrorMin: 500
});

/** getJobStatus の jobStatus.state のうち、待ちを終えるもの */
const JOB_STATE = Object.freeze({completed: 'JOB_STATE_COMPLETED', failed: 'JOB_STATE_FAILED'});

/** getUploadStatus の state のうち、回復と失敗の判定に使うもの */
const UPLOAD_STATE = Object.freeze({created: 'created', finishing: 'finishing', completed: 'completed', failed: 'failed'});

/** jobStatus.progress の最大値 (0〜100 で届く) */
const JOB_PROGRESS_MAX = 100;

/** BlobRef の $type */
const BLOB_TYPE = 'blob';

/** onProgress の phase */
const PHASE = Object.freeze({upload: 'upload', processing: 'processing'});

/**
 * @typedef {Object} PartPlan
 * @property {number} partNumber 1 始まりの部品の番号
 * @property {number} offset 動画の中の開始位置 (バイト)
 * @property {number} size 部品の大きさ (バイト)
 */

/**
 * @typedef {Object} VideoBlobRef
 * @property {'blob'} $type
 * @property {{$link: string}} ref
 * @property {'video/mp4'} mimeType
 * @property {number} size
 */

/**
 * @typedef {{state: 'processing', progress: number | null}
 *   | {state: 'completed', blob: VideoBlobRef}
 *   | {state: 'failed', code: string | null, error: string | null}} JobStatusResult
 */

/**
 * @typedef {{ok: true, blob: VideoBlobRef} | {ok: false, reason: string, message?: string}} VideoUploadResult
 */

/**
 * @typedef {Object} VideoUploadDeps
 * @property {(aud: string, lxm: string, exp?: number) => Promise<string>} getServiceAuth 失敗は throw
 * @property {() => Promise<any>} getSession com.atproto.server.getSession の応答
 * @property {(method: 'GET' | 'POST', nsid: string, opts: {token?: string, params?: Object, body?: Object})
 *   => Promise<{status: number, json: any}>} requestJson 動画サービスへの XRPC。通信の失敗は throw
 * @property {(args: {jobId: string, partNumber: number, chunk: Blob, token: string,
 *   onBytes: (sent: number) => void, signal: AbortSignal}) => Promise<{status: number, json: any}>} sendPart
 *   部品 1 本の送信。args.signal はほかの部品が諦めたときに鳴る (取り消しの signal と合わせて見る)
 * @property {(ms: number, signal: AbortSignal) => Promise<void>} sleep
 * @property {() => number} now ミリ秒の時刻
 * @property {() => string} random 名前に使う乱数の文字列
 * @property {(progress: {phase: 'upload' | 'processing', progress: number | null}) => void} onProgress
 */

/**
 * @typedef {Object} UploadContext 1 回のアップロードの間だけ持つ状態
 * @property {Blob} blob
 * @property {VideoUploadDeps} deps
 * @property {AbortSignal | undefined} signal
 * @property {string | null} aud PDS の DID
 * @property {string | null} token uploadBlob のトークン
 * @property {Promise<void> | null} refreshing 取り直しの最中ならその Promise
 * @property {string | null} jobId
 * @property {boolean} jobOpen 部品の送信から完了までの間 (諦めたら abortUpload を送る)
 * @property {boolean} abortSent abortUpload を送ったか
 * @property {Map<number, number>} sentBytes 部品ごとの送れたバイト数
 * @property {number} uploadProgress 最後に知らせた upload の進み具合
 * @property {{phase: 'upload' | 'processing', progress: number | null}} lastProgress 最後に知らせた進み具合
 * @property {number} lastProgressAt 最後に進み具合を知らせた時刻 (ミリ秒)
 */

/** 流れを止めて結果を返すための例外 */
class UploadStop extends Error {
	/**
	 * @param {string} reason BRIDGE_PROTOCOL.reasons の値
	 * @param {any} [serverMessage] サーバが返した文言 (文字列のときだけ結果に入る)
	 */
	constructor(reason, serverMessage) {
		super(reason);
		this.reason = reason;
		this.serverMessage = serverMessage;
	}
}

/**
 * 動画を partSize ごとの部品に分ける。最後の部品が端数を持つ。
 * @param {number} totalSize 動画の大きさ (バイト)
 * @param {number} partSize 部品の大きさ (バイト)
 * @returns {PartPlan[]} 0 バイト以下なら空
 */
export function planParts(totalSize, partSize) {
	if (!Number.isFinite(partSize) || partSize <= 0) {
		throw new RangeError('partSize は正の数でなければならない');
	}
	if (!Number.isFinite(totalSize)) {
		throw new RangeError('totalSize は有限の数でなければならない');
	}
	const parts = [];
	let offset = 0;
	let partNumber = 1;
	while (offset < totalSize) {
		const size = Math.min(partSize, totalSize - offset);
		parts.push({partNumber, offset, size});
		offset += size;
		partNumber++;
	}
	return parts;
}

/**
 * getSession の応答の DID 文書から PDS の DID (did:web:<ホスト名>) を作る。
 * 本体の借りたクライアントは PDS の URL を持っていないため、ここから引く。
 * @param {any} json getSession の応答
 * @returns {string | null} #atproto_pds が https の URL でなければ null
 */
export function pdsAudFromSession(json) {
	try {
		const services = json?.didDoc?.service;
		if (!Array.isArray(services)) return null;
		const fullId = typeof json.did === 'string' ? json.did + VIDEO_UPLOAD.pdsServiceId : null;
		const entry = services.find((service) => isPlainObject(service)
			&& (service.id === VIDEO_UPLOAD.pdsServiceId || (fullId !== null && service.id === fullId)));
		if (!entry || typeof entry.serviceEndpoint !== 'string') return null;
		const url = new URL(entry.serviceEndpoint);
		// did:web はポートを %3A で表すため、ポート付きは扱わない
		if (url.protocol !== 'https:' || url.port !== '' || url.hostname === '') return null;
		return `did:web:${url.hostname}`;
	} catch {
		return null;
	}
}

/**
 * getServiceAuth の exp (秒の整数) を作る。lexicon が整数を求めるため切り捨てる。
 * @param {number} nowMs ミリ秒の時刻
 * @param {number} ttlSec 寿命 (秒)
 * @returns {number}
 */
export function serviceAuthExp(nowMs, ttlSec) {
	return Math.floor(nowMs / 1000) + Math.floor(ttlSec);
}

/**
 * jobStatus (getJobStatus の応答の jobStatus、finishUpload の応答の jobStatus) を読む。
 * 完了と失敗以外の state はすべて処理中として扱う。
 * @param {any} status
 * @returns {JobStatusResult | null} state が読めなければ null
 */
export function readJobStatus(status) {
	if (!isPlainObject(status) || typeof status.state !== 'string') return null;
	if (status.state === JOB_STATE.completed) {
		const blob = toVideoBlobRef(status.blob);
		return blob ? {state: 'completed', blob} : {state: 'failed', code: null, error: null};
	}
	if (status.state === JOB_STATE.failed) {
		return {state: 'failed', code: nonEmptyString(status.failureCode), error: nonEmptyString(status.error)};
	}
	return {state: 'processing', progress: toUnitProgress(status.progress)};
}

/**
 * 変換し終えた動画の BlobRef を、record に入れる形だけに絞る。
 * @param {any} value
 * @returns {VideoBlobRef | null} video/mp4 でない・形が崩れていれば null
 */
export function toVideoBlobRef(value) {
	if (!isPlainObject(value)) return null;
	if (value.$type !== undefined && value.$type !== BLOB_TYPE) return null;
	const link = isPlainObject(value.ref) ? value.ref.$link : null;
	if (typeof link !== 'string' || link === '') return null;
	if (value.mimeType !== BRIDGE_PROTOCOL.video.blobMimeType) return null;
	if (!Number.isSafeInteger(value.size) || value.size <= 0) return null;
	return {$type: BLOB_TYPE, ref: {$link: link}, mimeType: value.mimeType, size: value.size};
}

/**
 * startUpload に渡す名前 (<乱数>.<拡張子>) を作る。
 * @param {string} random
 * @param {string} mimeType
 * @returns {string}
 */
export function uploadName(random, mimeType) {
	if (typeof random !== 'string' || random === '') {
		throw new TypeError('名前の乱数が空');
	}
	if (!Object.hasOwn(VIDEO_UPLOAD.extensions, mimeType)) {
		throw new TypeError(`扱えない動画の形式: ${mimeType}`);
	}
	return `${random}.${VIDEO_UPLOAD.extensions[mimeType]}`;
}

/**
 * 動画を video.bsky.app へ送り、変換し終えるまで待つ。
 * 中断されたら、その場で canceled を返す (ジョブがあれば abortUpload を投げっぱなしで送る)。
 * 流れが続いているあいだは、進み具合が増えなくても progressHeartbeatMs ごとに直近の値を送り直す。
 * @param {Blob} blob 動画
 * @param {VideoUploadDeps} deps
 * @param {AbortSignal} signal
 * @returns {Promise<VideoUploadResult>}
 */
export function runVideoUpload(blob, deps, signal) {
	/** @type {UploadContext} */
	const ctx = {
		blob,
		deps,
		signal,
		aud: null,
		token: null,
		refreshing: null,
		jobId: null,
		jobOpen: false,
		abortSent: false,
		sentBytes: new Map(),
		uploadProgress: -1,
		lastProgress: {phase: PHASE.upload, progress: 0},
		lastProgressAt: 0
	};
	const stopHeartbeat = signal?.aborted ? () => {} : startHeartbeat(ctx);
	const flow = runFlow(ctx).catch((error) => settleFailure(ctx, error));
	flow.finally(stopHeartbeat);
	if (!signal) return flow;
	let onAbort = null;
	const canceled = new Promise((resolve) => {
		onAbort = () => {
			stopHeartbeat();
			sendAbortUpload(ctx);
			resolve(canceledResult());
		};
		if (signal.aborted) {
			onAbort();
		} else {
			signal.addEventListener('abort', onAbort, {once: true});
		}
	});
	flow.finally(() => signal.removeEventListener('abort', onAbort));
	return Promise.race([flow, canceled]);
}

/**
 * 進み具合の送り直しを始める。直近 progressHeartbeatMs のあいだに何も知らせていなければ、
 * 最後に知らせた値 (まだ無ければ upload の 0) をもう一度送る。
 * (上限の確認・部品の送信の停滞・完了の待ちのあいだも、分離ワールドの打ち切りに掛からないように)
 * @param {UploadContext} ctx
 * @returns {() => void} 止める関数。何度呼んでもよい
 */
function startHeartbeat(ctx) {
	const stop = new AbortController();
	const interval = VIDEO_UPLOAD.progressHeartbeatMs;
	try {
		ctx.lastProgressAt = ctx.deps.now();
	} catch {
		ctx.lastProgressAt = 0;
	}
	const loop = async () => {
		while (!stop.signal.aborted) {
			await ctx.deps.sleep(interval, stop.signal);
			if (stop.signal.aborted || ctx.signal?.aborted) return;
			if (ctx.deps.now() - ctx.lastProgressAt >= interval) emitProgress(ctx, ctx.lastProgress);
		}
	};
	loop().catch(() => {});
	return () => stop.abort();
}

/**
 * 上限の確認から処理の完了までを順に流す。
 * @param {UploadContext} ctx
 * @returns {Promise<VideoUploadResult>}
 */
async function runFlow(ctx) {
	throwIfAborted(ctx);
	await checkUploadLimits(ctx);
	const aud = pdsAudFromSession(await ctx.deps.getSession());
	throwIfAborted(ctx);
	if (aud === null) throw new UploadStop(BRIDGE_PROTOCOL.reasons.uploadFailed);
	ctx.aud = aud;
	await refreshToken(ctx);
	throwIfAborted(ctx);
	const parts = await startJob(ctx);
	emitUploadProgress(ctx, 0);
	await sendParts(ctx, parts);
	const finished = await finishJob(ctx, parts);
	ctx.jobOpen = false;
	return waitForProcessing(ctx, finished);
}

/**
 * getUploadLimits で今日まだ送れるかを確かめる。
 * @param {UploadContext} ctx
 * @returns {Promise<void>} 送れなければ UploadStop を投げる
 */
async function checkUploadLimits(ctx) {
	const {nsid} = VIDEO_UPLOAD;
	const token = await ctx.deps.getServiceAuth(VIDEO_UPLOAD.serviceDid, nsid.getUploadLimits);
	throwIfAborted(ctx);
	const res = await ctx.deps.requestJson('GET', nsid.getUploadLimits, {token});
	throwIfAborted(ctx);
	const json = res?.json;
	// 本文が JSON でない (落ちている) ときは、送れないのではなく通信の失敗として扱う
	if (!isPlainObject(json)) throw new UploadStop(BRIDGE_PROTOCOL.reasons.uploadFailed);
	if (json.canUpload === true) return;
	// 送れないと明示されたときだけ forbidden にする (5xx などで canUpload が無いときは通信の失敗)
	if (json.canUpload === false) throw new UploadStop(BRIDGE_PROTOCOL.reasons.uploadForbidden, json.message);
	throw new UploadStop(BRIDGE_PROTOCOL.reasons.uploadFailed);
}

/**
 * startUpload でジョブを作り、部品の分け方を確かめる。
 * @param {UploadContext} ctx
 * @returns {Promise<PartPlan[]>}
 */
async function startJob(ctx) {
	const {blob, deps} = ctx;
	const failed = BRIDGE_PROTOCOL.reasons.uploadFailed;
	const mimeType = blob.type;
	const name = uploadName(deps.random(), mimeType);
	const res = await deps.requestJson('POST', VIDEO_UPLOAD.nsid.startUpload, {
		token: ctx.token,
		body: {sizeBytes: blob.size, mimeType, name}
	});
	const json = res?.json;
	if (!isOk(res?.status)) throw new UploadStop(failed, isPlainObject(json) ? json.message : undefined);
	if (!isPlainObject(json) || typeof json.jobId !== 'string' || json.jobId === '') throw new UploadStop(failed);
	// ここから先で諦めたら、サーバの予約を abortUpload で返す
	ctx.jobId = json.jobId;
	ctx.jobOpen = true;
	throwIfAborted(ctx);
	if (!Number.isSafeInteger(json.partSizeBytes) || json.partSizeBytes <= 0) throw new UploadStop(failed);
	const parts = planParts(blob.size, json.partSizeBytes);
	if (parts.length !== json.partCount) throw new UploadStop(failed);
	return parts;
}

/**
 * 部品を同時 partConcurrency 本で送る。各 worker が次の番号を取って送り、1 本でも諦めたら全体を止める。
 * 止めるときは子の AbortController を鳴らし、ほかの送信中の部品も打ち切らせる。
 * @param {UploadContext} ctx
 * @param {PartPlan[]} parts
 * @returns {Promise<void>}
 */
async function sendParts(ctx, parts) {
	const stop = new AbortController();
	let next = 0;
	let firstError = null;
	const worker = async () => {
		while (!stop.signal.aborted) {
			const part = parts[next++];
			if (!part) return;
			try {
				await sendPartWithRetry(ctx, part, stop.signal);
			} catch (error) {
				if (firstError === null) firstError = error;
				stop.abort();
				return;
			}
		}
	};
	const count = Math.min(VIDEO_UPLOAD.partConcurrency, parts.length);
	await Promise.all(Array.from({length: count}, worker));
	throwIfAborted(ctx);
	if (firstError !== null) throw firstError;
}

/**
 * 部品 1 本を partAttempts 回まで送る。401 はトークンを取り直してすぐ送り直し、
 * 通信の失敗・408・429・5xx は間を空けて送り直し、それ以外の失敗はすぐ諦める。
 * @param {UploadContext} ctx
 * @param {PartPlan} part
 * @param {AbortSignal} stopSignal ほかの部品が諦めたときに鳴る
 * @returns {Promise<void>}
 */
async function sendPartWithRetry(ctx, part, stopSignal) {
	const failed = BRIDGE_PROTOCOL.reasons.uploadFailed;
	for (let attempt = 1; attempt <= VIDEO_UPLOAD.partAttempts; attempt++) {
		throwIfAborted(ctx);
		if (stopSignal.aborted) throw new UploadStop(failed);
		// 送り直しでは送れたバイト数が 0 から数え直しになる
		reportPartBytes(ctx, part, 0);
		let res = null;
		try {
			res = await ctx.deps.sendPart({
				jobId: ctx.jobId,
				partNumber: part.partNumber,
				// 部品はその場で切り出し、動画全体を配列に読み込まない
				chunk: ctx.blob.slice(part.offset, part.offset + part.size),
				token: ctx.token,
				onBytes: (sent) => reportPartBytes(ctx, part, sent),
				signal: stopSignal
			});
		} catch {
			res = null;
		}
		throwIfAborted(ctx);
		if (stopSignal.aborted) throw new UploadStop(failed);
		const status = res?.status;
		if (isOk(status)) {
			reportPartBytes(ctx, part, part.size);
			return;
		}
		if (status === HTTP_STATUS.unauthorized) {
			await refreshToken(ctx);
			continue;
		}
		if (res !== null && !isRetryableStatus(status)) throw new UploadStop(failed);
		if (attempt < VIDEO_UPLOAD.partAttempts) await waitFor(ctx, backoffMs(attempt));
	}
	throw new UploadStop(failed);
}

/**
 * トークンを取り直して finishUpload を送る。失敗したら getUploadStatus を見て、
 * created は欠けた部品を送り直し、finishing は待ち、completed はその jobStatus を使う。
 * @param {UploadContext} ctx
 * @param {PartPlan[]} parts
 * @returns {Promise<{jobId: string | null, jobStatus: any}>} 処理の状態を引くジョブと、その時点の jobStatus
 */
async function finishJob(ctx, parts) {
	const {nsid} = VIDEO_UPLOAD;
	const failed = BRIDGE_PROTOCOL.reasons.uploadFailed;
	// 動画サービスは finishUpload で受け取ったトークンで PDS へ送るため、部品を送り終えてから取り直す
	await refreshToken(ctx);
	for (let attempt = 1; attempt <= VIDEO_UPLOAD.finishAttempts; attempt++) {
		throwIfAborted(ctx);
		const finished = readFinished(
			await tryRequest(ctx, 'POST', nsid.finishUpload, {token: ctx.token, body: {jobId: ctx.jobId}})
		);
		throwIfAborted(ctx);
		if (finished) return finished;
		const res = await tryRequest(ctx, 'GET', nsid.getUploadStatus, {token: ctx.token, params: {jobId: ctx.jobId}});
		throwIfAborted(ctx);
		const json = isOk(res?.status) && isPlainObject(res.json) ? res.json : null;
		const state = json?.state;
		if (state === UPLOAD_STATE.completed) {
			const done = readFinished(res);
			if (done) return done;
			throw new UploadStop(failed);
		}
		if (state === UPLOAD_STATE.failed) throw new UploadStop(failed, json.failureReason);
		if (attempt >= VIDEO_UPLOAD.finishAttempts) break;
		if (json === null) {
			await waitFor(ctx, backoffMs(attempt));
			continue;
		}
		if (state === UPLOAD_STATE.created) {
			const missing = missingParts(parts, json.receivedParts);
			if (missing.length > 0) {
				for (const part of missing) ctx.sentBytes.delete(part.partNumber);
				await sendParts(ctx, missing);
			} else {
				await waitFor(ctx, backoffMs(attempt));
			}
			continue;
		}
		if (state === UPLOAD_STATE.finishing) {
			await waitFor(ctx, VIDEO_UPLOAD.pollIntervalMs);
			continue;
		}
		throw new UploadStop(failed);
	}
	throw new UploadStop(failed);
}

/**
 * getJobStatus を pollIntervalMs おきに引き、処理の完了を待つ。トークンは付けない。
 * @param {UploadContext} ctx
 * @param {{jobId: string | null, jobStatus: any}} finished
 * @returns {Promise<VideoUploadResult>}
 */
async function waitForProcessing(ctx, finished) {
	const {deps} = ctx;
	const first = readJobStatus(finished.jobStatus);
	// 同じ中身を送り直すと finishUpload が最初から完了を返す
	if (first && first.state !== 'processing') return concludeJob(first);
	// 処理の状態は分割アップロードの jobId では引けないため、引くジョブが分からなければ諦める
	if (finished.jobId === null) throw new UploadStop(BRIDGE_PROTOCOL.reasons.uploadFailed);
	emitProgress(ctx, {phase: PHASE.processing, progress: first?.progress ?? null});
	const startedAt = deps.now();
	let failures = 0;
	for (let poll = 0; ; poll++) {
		if (poll > 0) await waitFor(ctx, VIDEO_UPLOAD.pollIntervalMs);
		if (deps.now() - startedAt >= VIDEO_UPLOAD.processingTimeoutMs) {
			throw new UploadStop(BRIDGE_PROTOCOL.reasons.videoFailed);
		}
		const res = await tryRequest(ctx, 'GET', VIDEO_UPLOAD.nsid.getJobStatus, {params: {jobId: finished.jobId}});
		throwIfAborted(ctx);
		const status = isOk(res?.status) && isPlainObject(res.json) ? readJobStatus(res.json.jobStatus) : null;
		if (status === null) {
			failures++;
			if (failures >= VIDEO_UPLOAD.maxPollFailures) throw new UploadStop(BRIDGE_PROTOCOL.reasons.uploadFailed);
			continue;
		}
		if (status.state === 'processing') {
			failures = 0;
			emitProgress(ctx, {phase: PHASE.processing, progress: status.progress});
			continue;
		}
		return concludeJob(status);
	}
}

/**
 * 完了か失敗の jobStatus を結果にする。
 * @param {JobStatusResult} status
 * @returns {VideoUploadResult}
 */
function concludeJob(status) {
	if (status.state === 'completed') return {ok: true, blob: status.blob};
	throw new UploadStop(BRIDGE_PROTOCOL.reasons.videoFailed, status.code ?? status.error);
}

/**
 * finishUpload (または completed の getUploadStatus) の応答から、処理の状態を引くジョブを読む。
 * ジョブは completedJobId、無ければ jobStatus.jobId を使う。分割アップロードの jobId は使わない。
 * @param {{status: number, json: any} | null} res
 * @returns {{jobId: string | null, jobStatus: any} | null} jobId はどちらも無ければ null
 */
function readFinished(res) {
	if (!isOk(res?.status) || !isPlainObject(res.json) || !isPlainObject(res.json.jobStatus)) return null;
	const {completedJobId, jobStatus} = res.json;
	return {jobId: nonEmptyString(completedJobId) ?? nonEmptyString(jobStatus.jobId), jobStatus};
}

/**
 * 失敗・中断を結果にする。部品の送信から完了までの間なら abortUpload を送る。
 * @param {UploadContext} ctx
 * @param {any} error
 * @returns {VideoUploadResult}
 */
function settleFailure(ctx, error) {
	if (ctx.signal?.aborted) {
		sendAbortUpload(ctx);
		return canceledResult();
	}
	if (ctx.jobOpen) sendAbortUpload(ctx);
	if (error instanceof UploadStop) return failure(error.reason, error.serverMessage);
	return failure(BRIDGE_PROTOCOL.reasons.uploadFailed);
}

/**
 * ジョブがあれば abortUpload を投げっぱなしで 1 回だけ送る。結果は待たない。
 * @param {UploadContext} ctx
 */
function sendAbortUpload(ctx) {
	if (ctx.jobId === null || ctx.abortSent) return;
	ctx.abortSent = true;
	try {
		Promise.resolve(ctx.deps.requestJson('POST', VIDEO_UPLOAD.nsid.abortUpload, {
			token: ctx.token,
			body: {jobId: ctx.jobId}
		})).catch(() => {});
	} catch {
		// 送れなくてもサーバ側の予約は期限で消える
	}
}

/**
 * uploadBlob のトークンを取り直す。同時に何本から呼ばれても 1 回にまとめる。
 * @param {UploadContext} ctx
 * @returns {Promise<void>}
 */
function refreshToken(ctx) {
	if (ctx.refreshing === null) {
		const pending = (async () => {
			const exp = serviceAuthExp(ctx.deps.now(), VIDEO_UPLOAD.tokenTtlSec);
			const token = await ctx.deps.getServiceAuth(ctx.aud, VIDEO_UPLOAD.nsid.uploadBlob, exp);
			if (typeof token !== 'string' || token === '') throw new UploadStop(BRIDGE_PROTOCOL.reasons.uploadFailed);
			ctx.token = token;
		})();
		ctx.refreshing = pending;
		pending.then(
			() => { ctx.refreshing = null; },
			() => { ctx.refreshing = null; }
		);
	}
	return ctx.refreshing;
}

/**
 * requestJson を呼び、通信の失敗は null にする。
 * @param {UploadContext} ctx
 * @param {'GET' | 'POST'} method
 * @param {string} nsid
 * @param {{token?: string, params?: Object, body?: Object}} opts
 * @returns {Promise<{status: number, json: any} | null>}
 */
async function tryRequest(ctx, method, nsid, opts) {
	try {
		return await ctx.deps.requestJson(method, nsid, opts);
	} catch {
		return null;
	}
}

/**
 * 部品の送れたバイト数を記録し、全体の進み具合を知らせる。
 * @param {UploadContext} ctx
 * @param {PartPlan} part
 * @param {number} sent
 */
function reportPartBytes(ctx, part, sent) {
	const bytes = Number.isFinite(sent) ? Math.min(Math.max(sent, 0), part.size) : 0;
	ctx.sentBytes.set(part.partNumber, bytes);
	const total = ctx.blob.size;
	if (!(total > 0)) return;
	let sum = 0;
	for (const value of ctx.sentBytes.values()) sum += value;
	emitUploadProgress(ctx, Math.min(sum / total, 1));
}

/**
 * upload の進み具合を、前に知らせた値より増えたときだけ知らせる。(送り直しで戻って見えないように)
 * @param {UploadContext} ctx
 * @param {number} progress 0〜1
 */
function emitUploadProgress(ctx, progress) {
	if (progress <= ctx.uploadProgress) return;
	ctx.uploadProgress = progress;
	emitProgress(ctx, {phase: PHASE.upload, progress});
}

/**
 * onProgress を呼び、送り直しのために値と時刻を控える。呼び出し側の例外で流れを止めない。
 * @param {UploadContext} ctx
 * @param {{phase: 'upload' | 'processing', progress: number | null}} progress
 */
function emitProgress(ctx, progress) {
	const value = {phase: progress.phase, progress: progress.progress};
	ctx.lastProgress = value;
	try {
		ctx.lastProgressAt = ctx.deps.now();
	} catch {
		// 時刻が取れなくても知らせは続ける
	}
	try {
		ctx.deps.onProgress?.({...value});
	} catch {
		// 進み具合の表示の失敗はアップロードに関係しない
	}
}

/**
 * 待つ。待っている間に中断されたら UploadStop を投げる。
 * @param {UploadContext} ctx
 * @param {number} ms
 * @returns {Promise<void>}
 */
async function waitFor(ctx, ms) {
	await ctx.deps.sleep(ms, ctx.signal);
	throwIfAborted(ctx);
}

/**
 * 中断されていれば UploadStop を投げる。
 * @param {UploadContext} ctx
 */
function throwIfAborted(ctx) {
	if (ctx.signal?.aborted) throw new UploadStop(BRIDGE_PROTOCOL.reasons.canceled);
}

/**
 * n 回目の失敗の後に空ける時間。
 * @param {number} attempt 1 始まり
 * @returns {number}
 */
function backoffMs(attempt) {
	return VIDEO_UPLOAD.retryBaseMs * 2 ** (attempt - 1);
}

/**
 * 受け取り済みの番号に無い部品を返す。
 * @param {PartPlan[]} parts
 * @param {any} receivedParts getUploadStatus の receivedParts
 * @returns {PartPlan[]}
 */
function missingParts(parts, receivedParts) {
	const received = new Set(Array.isArray(receivedParts) ? receivedParts : []);
	return parts.filter((part) => !received.has(part.partNumber));
}

/**
 * 送り直してよい失敗か。(408・429・5xx)
 * @param {any} status
 * @returns {boolean}
 */
function isRetryableStatus(status) {
	return status === HTTP_STATUS.requestTimeout
		|| status === HTTP_STATUS.tooManyRequests
		|| (Number.isInteger(status) && status >= HTTP_STATUS.serverErrorMin);
}

/**
 * 2xx か。
 * @param {any} status
 * @returns {boolean}
 */
function isOk(status) {
	return Number.isInteger(status) && status >= HTTP_STATUS.okMin && status <= HTTP_STATUS.okMax;
}

/**
 * 0〜100 の progress を 0〜1 に直す。
 * @param {any} value
 * @returns {number | null} 数でなければ null
 */
function toUnitProgress(value) {
	if (typeof value !== 'number' || !Number.isFinite(value)) return null;
	return Math.min(Math.max(value / JOB_PROGRESS_MAX, 0), 1);
}

/**
 * 空でない文字列ならそのまま、そうでなければ null。
 * @param {any} value
 * @returns {string | null}
 */
function nonEmptyString(value) {
	return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * 配列でないオブジェクトか。
 * @param {any} value
 * @returns {boolean}
 */
function isPlainObject(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 失敗の結果を作る。message はサーバが文字列を返したときだけ入れる。
 * @param {string} reason
 * @param {any} [message]
 * @returns {{ok: false, reason: string, message?: string}}
 */
function failure(reason, message) {
	const result = {ok: false, reason};
	if (typeof message === 'string' && message !== '') result.message = message;
	return result;
}

/**
 * 中断の結果を作る。
 * @returns {{ok: false, reason: string}}
 */
function canceledResult() {
	return {ok: false, reason: BRIDGE_PROTOCOL.reasons.canceled};
}
