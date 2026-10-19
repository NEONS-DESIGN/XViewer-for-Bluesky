/**
 * video-upload.js の動画のアップロードの流れ。通信・待ち・時刻はすべて偽の deps で与え、
 * 呼ばれた順・送り直し・回復・中断・進み具合を確かめる。実際の video.bsky.app との通信は実機で確認する。
 */

import test from 'node:test';
import assert from 'node:assert';

import {
	VIDEO_UPLOAD,
	planParts,
	pdsAudFromSession,
	serviceAuthExp,
	readJobStatus,
	toVideoBlobRef,
	uploadName,
	runVideoUpload,
	forgetPdsAud
} from '../src/inject/video-upload.js';

const PDS_HOST = 'chaga.us-west.host.bsky.network';
const SESSION = {
	did: 'did:plc:testuser',
	handle: 'example.test',
	didDoc: {
		id: 'did:plc:testuser',
		service: [
			{id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: `https://${PDS_HOST}`}
		]
	}
};
const VIDEO_BLOB = {$type: 'blob', ref: {$link: 'bafkreitestvideo'}, mimeType: 'video/mp4', size: 131831};
const PART_SIZE = 4;
const START_CLOCK = 1792343503999;

/**
 * 指定の大きさの動画の Blob を作る。
 * @param {number} size
 * @returns {Blob}
 */
function makeVideo(size) {
	return new Blob([new Uint8Array(size)], {type: 'video/mp4'});
}

/**
 * 偽の deps を作る。XRPC は NSID の末尾の名前で handlers を引き、呼ばれた順を calls に記録する。
 * sleep は即座に解決し、時計を ms だけ進める。ただし進み具合の送り直しの待ち (progressHeartbeatMs) は
 * 記録せず、signal が鳴るまで解決しない (送り直しは専用のテストで確かめる)。
 * @param {Object} [overrides] NSID の末尾の名前 (と uploadPart) ごとの差し替え、token、session、deps
 * @returns {{deps: Object, calls: Array<Object>, progress: Array<Object>, advance: (ms: number) => void}}
 */
function makeDeps(overrides = {}) {
	const calls = [];
	const progress = [];
	let clock = START_CLOCK;
	const handlers = {
		getUploadLimits: () => ({status: 200, json: {canUpload: true, message: 'User can upload'}}),
		startUpload: (opts) => ({
			status: 200,
			json: {
				jobId: 'job-1',
				partSizeBytes: PART_SIZE,
				partCount: Math.ceil(opts.body.sizeBytes / PART_SIZE),
				expiresAt: '2026-10-19T12:00:00Z'
			}
		}),
		uploadPart: (args) => ({status: 200, json: {partNumber: args.partNumber, sizeBytes: args.chunk.size}}),
		finishUpload: () => ({
			status: 200,
			json: {completedJobId: 'done-1', jobStatus: {jobId: 'done-1', state: 'JOB_STATE_ENCODING', progress: 0}}
		}),
		getUploadStatus: () => ({status: 200, json: {state: 'finishing', receivedParts: []}}),
		getJobStatus: () => ({
			status: 200,
			json: {jobStatus: {jobId: 'done-1', state: 'JOB_STATE_COMPLETED', blob: {...VIDEO_BLOB, extra: 1}}}
		}),
		abortUpload: () => ({status: 200, json: {state: 'aborted'}}),
		...overrides.handlers
	};
	const token = overrides.token ?? 'tok';
	const deps = {
		getServiceAuth: async (aud, lxm, exp) => {
			calls.push({fn: 'getServiceAuth', aud, lxm, exp});
			return token;
		},
		getSession: async () => {
			calls.push({fn: 'getSession'});
			return overrides.session ?? SESSION;
		},
		requestJson: async (method, nsid, opts) => {
			const name = nsid.split('.').pop();
			calls.push({fn: name, method, nsid, opts});
			return handlers[name](opts);
		},
		sendPart: async (args) => {
			calls.push({fn: 'uploadPart', partNumber: args.partNumber, size: args.chunk.size, token: args.token, jobId: args.jobId});
			args.onBytes(Math.floor(args.chunk.size / 2));
			return handlers.uploadPart(args);
		},
		sleep: async (ms, signal) => {
			if (ms === VIDEO_UPLOAD.progressHeartbeatMs) {
				await untilAborted(signal);
				return;
			}
			calls.push({fn: 'sleep', ms});
			clock += ms;
		},
		now: () => clock,
		random: () => 'abcdefghijkl',
		onProgress: (value) => progress.push(value),
		...overrides.deps
	};
	return {deps, calls, progress, advance: (ms) => { clock += ms; }};
}

/**
 * signal が鳴るまで待つ。
 * @param {AbortSignal} signal
 * @returns {Promise<void>}
 */
function untilAborted(signal) {
	return new Promise((resolve) => {
		if (!signal || signal.aborted) {
			resolve();
			return;
		}
		signal.addEventListener('abort', () => resolve(), {once: true});
	});
}

/**
 * 外から解決できる Promise を作る。
 * @returns {{promise: Promise<any>, resolve: (value?: any) => void}}
 */
function deferred() {
	let resolve = null;
	const promise = new Promise((r) => { resolve = r; });
	return {promise, resolve};
}

/** 溜まった microtask と setImmediate を流す */
function flush() {
	return new Promise((resolve) => setImmediate(resolve));
}

/** sleep を除いた呼び出しの名前の並び */
function names(calls) {
	return calls.filter((c) => c.fn !== 'sleep').map((c) => c.fn);
}

test('VIDEO_UPLOAD: 凍結した定数', () => {
	assert.ok(Object.isFrozen(VIDEO_UPLOAD));
	assert.strictEqual(VIDEO_UPLOAD.origin, 'https://video.bsky.app');
	assert.strictEqual(VIDEO_UPLOAD.serviceDid, 'did:web:video.bsky.app');
	assert.strictEqual(VIDEO_UPLOAD.nsid.uploadBlob, 'com.atproto.repo.uploadBlob');
	assert.strictEqual(VIDEO_UPLOAD.partConcurrency, 4);
	assert.strictEqual(VIDEO_UPLOAD.extensions['video/quicktime'], 'mov');
});

test('planParts: 割り切れる・端数・1 本・0 バイト', () => {
	assert.deepStrictEqual(planParts(10, 5), [
		{partNumber: 1, offset: 0, size: 5},
		{partNumber: 2, offset: 5, size: 5}
	]);
	const odd = planParts(11, 5);
	assert.strictEqual(odd.length, 3);
	assert.deepStrictEqual(odd[2], {partNumber: 3, offset: 10, size: 1});
	assert.deepStrictEqual(planParts(3, 5), [{partNumber: 1, offset: 0, size: 3}]);
	assert.deepStrictEqual(planParts(0, 5), []);
	assert.throws(() => planParts(3, 0));
	assert.throws(() => planParts(3, -1));
	assert.throws(() => planParts(3, NaN));
});

test('pdsAudFromSession: #atproto_pds の https だけを did:web にする', () => {
	assert.strictEqual(pdsAudFromSession(SESSION), `did:web:${PDS_HOST}`);
	const withService = (service) => ({...SESSION, didDoc: {...SESSION.didDoc, service: [service]}});
	assert.strictEqual(
		pdsAudFromSession(withService({id: '#atproto_pds', serviceEndpoint: `http://${PDS_HOST}`})),
		null
	);
	assert.strictEqual(
		pdsAudFromSession(withService({id: '#atproto_labeler', serviceEndpoint: `https://${PDS_HOST}`})),
		null
	);
	assert.strictEqual(pdsAudFromSession({did: 'did:plc:testuser'}), null);
	assert.strictEqual(pdsAudFromSession(null), null);
	assert.strictEqual(
		pdsAudFromSession(withService({id: '#atproto_pds', serviceEndpoint: 'not a url'})),
		null
	);
});

test('serviceAuthExp: 秒の整数に切り捨てる', () => {
	assert.strictEqual(serviceAuthExp(1792343503999, 1800), 1792345303);
	assert.ok(Number.isInteger(serviceAuthExp(1792343503123, 1800)));
});

test('readJobStatus: 処理中・完了・失敗・崩れた応答', () => {
	assert.deepStrictEqual(readJobStatus({state: 'JOB_STATE_ENCODING', progress: 70}), {state: 'processing', progress: 0.7});
	assert.deepStrictEqual(readJobStatus({state: 'JOB_STATE_CREATED'}), {state: 'processing', progress: null});
	assert.deepStrictEqual(readJobStatus({state: 'JOB_STATE_COMPLETED', blob: VIDEO_BLOB}), {state: 'completed', blob: VIDEO_BLOB});
	assert.deepStrictEqual(readJobStatus({state: 'JOB_STATE_COMPLETED'}), {state: 'failed', code: null, error: null});
	assert.deepStrictEqual(
		readJobStatus({state: 'JOB_STATE_FAILED', failureCode: 'encoding_failure'}),
		{state: 'failed', code: 'encoding_failure', error: null}
	);
	assert.deepStrictEqual(
		readJobStatus({state: 'JOB_STATE_FAILED', error: 'bad video'}),
		{state: 'failed', code: null, error: 'bad video'}
	);
	assert.strictEqual(readJobStatus({}), null);
	assert.strictEqual(readJobStatus(null), null);
	assert.strictEqual(readJobStatus('JOB_STATE_COMPLETED'), null);
});

test('toVideoBlobRef: 余分なキーを落とし、video/mp4 でなければ null', () => {
	assert.deepStrictEqual(toVideoBlobRef({...VIDEO_BLOB, extra: 1, ref: {$link: 'bafkreitestvideo', x: 2}}), VIDEO_BLOB);
	assert.strictEqual(toVideoBlobRef({...VIDEO_BLOB, mimeType: 'video/webm'}), null);
	assert.strictEqual(toVideoBlobRef({...VIDEO_BLOB, ref: {}}), null);
	assert.strictEqual(toVideoBlobRef({...VIDEO_BLOB, size: 0}), null);
	assert.strictEqual(toVideoBlobRef({...VIDEO_BLOB, $type: 'other'}), null);
	assert.strictEqual(toVideoBlobRef(null), null);
});

test('uploadName: 乱数と拡張子をつなぐ', () => {
	assert.strictEqual(uploadName('abcdefghijkl', 'video/mp4'), 'abcdefghijkl.mp4');
	assert.strictEqual(uploadName('abcdefghijkl', 'video/quicktime'), 'abcdefghijkl.mov');
	assert.throws(() => uploadName('abcdefghijkl', 'image/png'));
});

test('runVideoUpload: 本体と同じ順に呼び、BlobRef だけを返す', async () => {
	const {deps, calls} = makeDeps();
	const result = await runVideoUpload(makeVideo(10), deps, new AbortController().signal);
	assert.deepStrictEqual(result, {ok: true, blob: VIDEO_BLOB});
	assert.deepStrictEqual(names(calls), [
		'getServiceAuth', 'getUploadLimits', 'getSession', 'getServiceAuth', 'startUpload',
		'uploadPart', 'uploadPart', 'uploadPart', 'getServiceAuth', 'finishUpload', 'getJobStatus'
	]);
	const auths = calls.filter((c) => c.fn === 'getServiceAuth');
	assert.strictEqual(auths[0].aud, 'did:web:video.bsky.app');
	assert.strictEqual(auths[0].lxm, 'app.bsky.video.getUploadLimits');
	assert.strictEqual(auths[1].aud, `did:web:${PDS_HOST}`);
	assert.strictEqual(auths[1].lxm, 'com.atproto.repo.uploadBlob');
	assert.ok(Number.isInteger(auths[1].exp));
	assert.strictEqual(auths[1].exp, serviceAuthExp(START_CLOCK, VIDEO_UPLOAD.tokenTtlSec));
	assert.strictEqual(auths[2].lxm, 'com.atproto.repo.uploadBlob');
	const limits = calls.find((c) => c.fn === 'getUploadLimits');
	assert.strictEqual(limits.method, 'GET');
	assert.strictEqual(limits.opts.token, 'tok');
	const start = calls.find((c) => c.fn === 'startUpload');
	assert.strictEqual(start.method, 'POST');
	assert.deepStrictEqual(start.opts.body, {sizeBytes: 10, mimeType: 'video/mp4', name: 'abcdefghijkl.mp4'});
	const parts = calls.filter((c) => c.fn === 'uploadPart');
	assert.deepStrictEqual(parts.map((c) => [c.partNumber, c.size, c.jobId]), [[1, 4, 'job-1'], [2, 4, 'job-1'], [3, 2, 'job-1']]);
	const finish = calls.find((c) => c.fn === 'finishUpload');
	assert.deepStrictEqual(finish.opts.body, {jobId: 'job-1'});
	const poll = calls.find((c) => c.fn === 'getJobStatus');
	assert.strictEqual(poll.method, 'GET');
	assert.strictEqual(poll.opts.token, undefined);
	assert.deepStrictEqual(poll.opts.params, {jobId: 'done-1'});
	assert.ok(!calls.some((c) => c.fn === 'abortUpload'));
});

test('runVideoUpload: 結果と進み具合にトークンが入らない', async () => {
	const ok = makeDeps({token: 'secret-token'});
	const result = await runVideoUpload(makeVideo(10), ok.deps, new AbortController().signal);
	assert.ok(!JSON.stringify(result).includes('secret-token'));
	assert.deepStrictEqual(Object.keys(result).sort(), ['blob', 'ok']);
	for (const value of ok.progress) {
		assert.ok(!JSON.stringify(value).includes('secret-token'));
	}
	assert.ok(ok.progress.length > 0);

	const ng = makeDeps({
		token: 'secret-token',
		handlers: {startUpload: () => ({status: 400, json: {error: 'InvalidRequest', message: 'too large'}})}
	});
	const failed = await runVideoUpload(makeVideo(10), ng.deps, new AbortController().signal);
	assert.ok(!JSON.stringify(failed).includes('secret-token'));
	for (const key of Object.keys(failed)) {
		assert.ok(['ok', 'reason', 'message'].includes(key), key);
	}
	assert.deepStrictEqual(failed, {ok: false, reason: 'upload-failed', message: 'too large'});
});

test('runVideoUpload: canUpload が偽なら message を添えて upload-forbidden で終え、startUpload を呼ばない', async () => {
	const {deps, calls} = makeDeps({
		handlers: {getUploadLimits: () => ({status: 200, json: {canUpload: false, message: 'daily limit'}})}
	});
	const result = await runVideoUpload(makeVideo(10), deps, new AbortController().signal);
	assert.deepStrictEqual(result, {ok: false, reason: 'upload-forbidden', message: 'daily limit'});
	assert.ok(!calls.some((c) => c.fn === 'startUpload'));
	assert.ok(!calls.some((c) => c.fn === 'abortUpload'));

	const noMessage = makeDeps({
		handlers: {getUploadLimits: () => ({status: 401, json: {canUpload: false, error: 'missing_token'}})}
	});
	assert.deepStrictEqual(
		await runVideoUpload(makeVideo(10), noMessage.deps, new AbortController().signal),
		{ok: false, reason: 'upload-forbidden'}
	);
});

test('runVideoUpload: 上限の確認で canUpload が無い応答 (5xx など) は upload-failed にする', async () => {
	for (const response of [
		{status: 500, json: {error: 'InternalServerError', message: 'boom'}},
		{status: 200, json: {}},
		{status: 502, json: {canUpload: 'no'}}
	]) {
		const {deps, calls} = makeDeps({handlers: {getUploadLimits: () => response}});
		const result = await runVideoUpload(makeVideo(10), deps, new AbortController().signal);
		assert.deepStrictEqual(result, {ok: false, reason: 'upload-failed'}, JSON.stringify(response));
		assert.ok(!calls.some((c) => c.fn === 'startUpload'));
	}
});

test('runVideoUpload: partCount が合わなければ upload-failed で abortUpload を送る', async () => {
	const {deps, calls} = makeDeps({
		handlers: {
			startUpload: () => ({status: 200, json: {jobId: 'job-1', partSizeBytes: PART_SIZE, partCount: 7}})
		}
	});
	const result = await runVideoUpload(makeVideo(10), deps, new AbortController().signal);
	assert.deepStrictEqual(result, {ok: false, reason: 'upload-failed'});
	assert.ok(!calls.some((c) => c.fn === 'uploadPart'));
	const abort = calls.find((c) => c.fn === 'abortUpload');
	assert.ok(abort);
	assert.strictEqual(abort.method, 'POST');
	assert.deepStrictEqual(abort.opts.body, {jobId: 'job-1'});
	assert.strictEqual(abort.opts.token, 'tok');
});

test('runVideoUpload: PDS が分からなければ upload-failed で startUpload を呼ばない', async () => {
	const {deps, calls} = makeDeps({session: {did: 'did:plc:testuser'}});
	const result = await runVideoUpload(makeVideo(10), deps, new AbortController().signal);
	assert.deepStrictEqual(result, {ok: false, reason: 'upload-failed'});
	assert.ok(!calls.some((c) => c.fn === 'startUpload'));
});

test('runVideoUpload: 部品の失敗は 5 回まで送り直し、401 ではトークンを取り直す', async () => {
	let firstPartTries = 0;
	const recovering = makeDeps({
		handlers: {
			uploadPart: (args) => {
				if (args.partNumber !== 1) return {status: 200, json: {}};
				firstPartTries++;
				if (firstPartTries <= 2) throw new TypeError('network');
				if (firstPartTries === 3) return {status: 401, json: {error: 'AuthRequired'}};
				return {status: 200, json: {}};
			}
		}
	});
	const ok = await runVideoUpload(makeVideo(10), recovering.deps, new AbortController().signal);
	assert.deepStrictEqual(ok, {ok: true, blob: VIDEO_BLOB});
	assert.strictEqual(firstPartTries, 4);
	// 上限の確認・最初・401 の取り直し・完了の前の 4 回
	assert.strictEqual(recovering.calls.filter((c) => c.fn === 'getServiceAuth').length, 4);
	const sleeps = recovering.calls.filter((c) => c.fn === 'sleep').map((c) => c.ms);
	assert.deepStrictEqual(sleeps, [500, 1000]);

	const failing = makeDeps({
		handlers: {
			uploadPart: (args) => (args.partNumber === 2 ? {status: 503, json: {}} : {status: 200, json: {}})
		}
	});
	const ng = await runVideoUpload(makeVideo(10), failing.deps, new AbortController().signal);
	assert.deepStrictEqual(ng, {ok: false, reason: 'upload-failed'});
	assert.strictEqual(failing.calls.filter((c) => c.fn === 'uploadPart' && c.partNumber === 2).length, 5);
	assert.deepStrictEqual(failing.calls.filter((c) => c.fn === 'sleep').map((c) => c.ms), [500, 1000, 2000, 4000]);
	assert.ok(failing.calls.some((c) => c.fn === 'abortUpload'));
	assert.ok(!failing.calls.some((c) => c.fn === 'finishUpload'));

	const rejected = makeDeps({
		handlers: {uploadPart: () => ({status: 400, json: {}})}
	});
	const bad = await runVideoUpload(makeVideo(10), rejected.deps, new AbortController().signal);
	assert.deepStrictEqual(bad, {ok: false, reason: 'upload-failed'});
	assert.ok(!rejected.calls.some((c) => c.fn === 'sleep'));
});

test('runVideoUpload: 部品は同時 4 本まで送る', async () => {
	let inFlight = 0;
	let maxInFlight = 0;
	const {deps, calls} = makeDeps({
		deps: {
			sendPart: async (args) => {
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise((resolve) => setImmediate(resolve));
				inFlight--;
				args.onBytes(args.chunk.size);
				return {status: 200, json: {}};
			}
		}
	});
	const result = await runVideoUpload(makeVideo(PART_SIZE * 9), deps, new AbortController().signal);
	assert.strictEqual(result.ok, true);
	assert.strictEqual(maxInFlight, VIDEO_UPLOAD.partConcurrency);
	assert.ok(calls.some((c) => c.fn === 'finishUpload'));
});

test('runVideoUpload: finishUpload の失敗から getUploadStatus で回復する', async () => {
	let finishes = 0;
	const created = makeDeps({
		handlers: {
			finishUpload: () => {
				finishes++;
				if (finishes === 1) return {status: 500, json: {}};
				return {status: 200, json: {completedJobId: 'done-1', jobStatus: {state: 'JOB_STATE_ENCODING'}}};
			},
			getUploadStatus: () => ({status: 200, json: {state: 'created', receivedParts: [1, 3]}})
		}
	});
	const ok = await runVideoUpload(makeVideo(10), created.deps, new AbortController().signal);
	assert.deepStrictEqual(ok, {ok: true, blob: VIDEO_BLOB});
	const firstFinish = created.calls.findIndex((c) => c.fn === 'finishUpload');
	const resent = created.calls.slice(firstFinish).filter((c) => c.fn === 'uploadPart').map((c) => c.partNumber);
	assert.deepStrictEqual(resent, [2]);
	const status = created.calls.find((c) => c.fn === 'getUploadStatus');
	assert.strictEqual(status.method, 'GET');
	assert.deepStrictEqual(status.opts.params, {jobId: 'job-1'});
	assert.strictEqual(finishes, 2);

	const completed = makeDeps({
		handlers: {
			finishUpload: () => ({status: 502, json: {}}),
			getUploadStatus: () => ({
				status: 200,
				json: {
					state: 'completed',
					completedJobId: 'done-2',
					jobStatus: {state: 'JOB_STATE_COMPLETED', blob: VIDEO_BLOB}
				}
			})
		}
	});
	assert.deepStrictEqual(
		await runVideoUpload(makeVideo(10), completed.deps, new AbortController().signal),
		{ok: true, blob: VIDEO_BLOB}
	);
	assert.strictEqual(completed.calls.filter((c) => c.fn === 'finishUpload').length, 1);
	assert.ok(!completed.calls.some((c) => c.fn === 'getJobStatus'));
	assert.ok(!completed.calls.some((c) => c.fn === 'abortUpload'));

	const failed = makeDeps({
		handlers: {
			finishUpload: () => ({status: 500, json: {}}),
			getUploadStatus: () => ({status: 200, json: {state: 'failed', failureReason: 'broken'}})
		}
	});
	assert.deepStrictEqual(
		await runVideoUpload(makeVideo(10), failed.deps, new AbortController().signal),
		{ok: false, reason: 'upload-failed', message: 'broken'}
	);
	assert.strictEqual(failed.calls.filter((c) => c.fn === 'finishUpload').length, 1);

	const failedNoReason = makeDeps({
		handlers: {
			finishUpload: () => ({status: 500, json: {}}),
			getUploadStatus: () => ({status: 200, json: {state: 'failed', failureReason: 42}})
		}
	});
	assert.deepStrictEqual(
		await runVideoUpload(makeVideo(10), failedNoReason.deps, new AbortController().signal),
		{ok: false, reason: 'upload-failed'}
	);

	const finishing = makeDeps({
		handlers: {
			finishUpload: () => ({status: 500, json: {}}),
			getUploadStatus: () => ({status: 200, json: {state: 'finishing', receivedParts: [1, 2, 3]}})
		}
	});
	assert.deepStrictEqual(
		await runVideoUpload(makeVideo(10), finishing.deps, new AbortController().signal),
		{ok: false, reason: 'upload-failed'}
	);
	assert.strictEqual(finishing.calls.filter((c) => c.fn === 'finishUpload').length, VIDEO_UPLOAD.finishAttempts);
	assert.ok(finishing.calls.some((c) => c.fn === 'sleep' && c.ms === VIDEO_UPLOAD.pollIntervalMs));
	assert.ok(finishing.calls.some((c) => c.fn === 'abortUpload'));
});

test('runVideoUpload: 処理の失敗は video-failed と failureCode を返す', async () => {
	const {deps, calls} = makeDeps({
		handlers: {
			getJobStatus: () => ({
				status: 200,
				json: {jobStatus: {state: 'JOB_STATE_FAILED', failureCode: 'encoding_failure', error: 'Encoding failed'}}
			})
		}
	});
	const result = await runVideoUpload(makeVideo(10), deps, new AbortController().signal);
	assert.deepStrictEqual(result, {ok: false, reason: 'video-failed', message: 'encoding_failure'});
	assert.ok(!calls.some((c) => c.fn === 'abortUpload'));

	const errorOnly = makeDeps({
		handlers: {
			finishUpload: () => ({status: 200, json: {completedJobId: 'done-1', jobStatus: {state: 'JOB_STATE_FAILED', error: 'Encoding failed'}}})
		}
	});
	assert.deepStrictEqual(
		await runVideoUpload(makeVideo(10), errorOnly.deps, new AbortController().signal),
		{ok: false, reason: 'video-failed', message: 'Encoding failed'}
	);
	assert.ok(!errorOnly.calls.some((c) => c.fn === 'getJobStatus'));
});

test('runVideoUpload: getJobStatus の通信の失敗が 10 回続くと失敗、途中で成功すれば数え直す', async () => {
	const failing = makeDeps({
		handlers: {
			getJobStatus: () => {
				throw new TypeError('network');
			}
		}
	});
	const ng = await runVideoUpload(makeVideo(10), failing.deps, new AbortController().signal);
	assert.deepStrictEqual(ng, {ok: false, reason: 'upload-failed'});
	assert.strictEqual(failing.calls.filter((c) => c.fn === 'getJobStatus').length, VIDEO_UPLOAD.maxPollFailures);

	let polls = 0;
	const flaky = makeDeps({
		handlers: {
			getJobStatus: () => {
				polls++;
				if (polls <= 9) return {status: 500, json: {}};
				if (polls === 10) return {status: 200, json: {jobStatus: {state: 'JOB_STATE_ENCODING', progress: 50}}};
				if (polls <= 19) return {status: 200, json: {}};
				return {status: 200, json: {jobStatus: {state: 'JOB_STATE_COMPLETED', blob: VIDEO_BLOB}}};
			}
		}
	});
	const ok = await runVideoUpload(makeVideo(10), flaky.deps, new AbortController().signal);
	assert.deepStrictEqual(ok, {ok: true, blob: VIDEO_BLOB});
	assert.strictEqual(polls, 20);
	assert.ok(flaky.calls.filter((c) => c.fn === 'sleep').every((c) => c.ms === VIDEO_UPLOAD.pollIntervalMs));
});

test('runVideoUpload: 処理が長すぎると video-failed で終える', async () => {
	const {deps, calls} = makeDeps({
		handlers: {
			getJobStatus: () => ({status: 200, json: {jobStatus: {state: 'JOB_STATE_ENCODING', progress: 10}}})
		}
	});
	const result = await runVideoUpload(makeVideo(10), deps, new AbortController().signal);
	assert.deepStrictEqual(result, {ok: false, reason: 'video-failed'});
	const polls = calls.filter((c) => c.fn === 'getJobStatus').length;
	assert.strictEqual(polls, VIDEO_UPLOAD.processingTimeoutMs / VIDEO_UPLOAD.pollIntervalMs);
});

test('runVideoUpload: 中断するとジョブの abortUpload を送り canceled を返す', async () => {
	const controller = new AbortController();
	const {deps, calls} = makeDeps({
		handlers: {
			uploadPart: (args) => {
				if (args.partNumber === 2) controller.abort();
				return {status: 200, json: {}};
			},
			abortUpload: async () => {
				throw new TypeError('network');
			}
		}
	});
	const result = await runVideoUpload(makeVideo(10), deps, controller.signal);
	assert.deepStrictEqual(result, {ok: false, reason: 'canceled'});
	const aborts = calls.filter((c) => c.fn === 'abortUpload');
	assert.strictEqual(aborts.length, 1);
	assert.deepStrictEqual(aborts[0].opts.body, {jobId: 'job-1'});
	assert.strictEqual(aborts[0].opts.token, 'tok');
	// 後続の処理が止まるのを待ってから、完了へ進んでいないことを確かめる
	await new Promise((resolve) => setImmediate(resolve));
	assert.ok(!calls.some((c) => c.fn === 'finishUpload'));
	assert.strictEqual(calls.filter((c) => c.fn === 'abortUpload').length, 1);

	const before = new AbortController();
	before.abort();
	const early = makeDeps();
	assert.deepStrictEqual(await runVideoUpload(makeVideo(10), early.deps, before.signal), {ok: false, reason: 'canceled'});
	assert.deepStrictEqual(early.calls, []);
});

test('runVideoUpload: 進み具合は upload が 0〜1 で増え、処理中は processing の progress を流す', async () => {
	let polls = 0;
	const {deps, progress} = makeDeps({
		handlers: {
			getJobStatus: () => {
				polls++;
				if (polls === 1) return {status: 200, json: {jobStatus: {state: 'JOB_STATE_ENCODING', progress: 25}}};
				if (polls === 2) return {status: 200, json: {jobStatus: {state: 'JOB_STATE_UPLOADING', progress: 75}}};
				return {status: 200, json: {jobStatus: {state: 'JOB_STATE_COMPLETED', blob: VIDEO_BLOB}}};
			}
		}
	});
	const result = await runVideoUpload(makeVideo(10), deps, new AbortController().signal);
	assert.strictEqual(result.ok, true);
	const upload = progress.filter((p) => p.phase === 'upload').map((p) => p.progress);
	assert.strictEqual(upload[0], 0);
	assert.strictEqual(upload[upload.length - 1], 1);
	for (let i = 1; i < upload.length; i++) {
		assert.ok(upload[i] > upload[i - 1], `upload の進み具合が増えていない: ${upload}`);
		assert.ok(upload[i] >= 0 && upload[i] <= 1);
	}
	const firstProcessing = progress.findIndex((p) => p.phase === 'processing');
	assert.ok(firstProcessing > 0);
	assert.ok(progress.slice(firstProcessing).every((p) => p.phase === 'processing'));
	const processing = progress.filter((p) => p.phase === 'processing').map((p) => p.progress);
	assert.ok(processing.includes(0.25));
	assert.ok(processing.includes(0.75));
	assert.ok(processing.indexOf(0.25) < processing.indexOf(0.75));
	for (const value of progress) {
		assert.deepStrictEqual(Object.keys(value).sort(), ['phase', 'progress']);
	}
});

/**
 * 進み具合の送り直しの待ちを外から進められる sleep に差し替える。
 * @param {ReturnType<typeof makeDeps>} made
 * tick は時計を間隔ぶん進めてから、release は時計を進めずに待ちを解く。
 * @returns {{tick: () => Promise<void>, release: () => Promise<void>, signals: AbortSignal[], count: () => number}}
 */
function controlHeartbeat(made) {
	const flowSleep = made.deps.sleep;
	const pending = [];
	const signals = [];
	made.deps.sleep = (ms, signal) => {
		if (ms !== VIDEO_UPLOAD.progressHeartbeatMs) return flowSleep(ms, signal);
		signals.push(signal);
		const wait = deferred();
		pending.push(wait);
		signal.addEventListener('abort', () => wait.resolve(), {once: true});
		return wait.promise;
	};
	const release = async () => {
		await flush();
		pending[pending.length - 1].resolve();
		await flush();
	};
	return {
		tick: async () => {
			made.advance(VIDEO_UPLOAD.progressHeartbeatMs);
			await release();
		},
		release,
		signals,
		count: () => pending.length
	};
}

test('runVideoUpload: 上限の確認などで止まっていても、間隔ごとに直近の進み具合を送り直し、終わったら止める', async () => {
	const session = deferred();
	const made = makeDeps({deps: {getSession: () => session.promise}});
	const heartbeat = controlHeartbeat(made);
	const pending = runVideoUpload(makeVideo(10), made.deps, new AbortController().signal);
	await heartbeat.tick();
	await heartbeat.tick();
	await heartbeat.tick();
	assert.deepStrictEqual(made.progress, [
		{phase: 'upload', progress: 0},
		{phase: 'upload', progress: 0},
		{phase: 'upload', progress: 0}
	]);
	session.resolve(SESSION);
	assert.deepStrictEqual(await pending, {ok: true, blob: VIDEO_BLOB});
	await flush();
	assert.ok(heartbeat.signals.every((signal) => signal.aborted));
	const count = heartbeat.count();
	await flush();
	assert.strictEqual(heartbeat.count(), count);
});

test('runVideoUpload: 部品の送信が止まっているあいだも、増えていない upload の値を送り直す', async () => {
	const stalled = deferred();
	const made = makeDeps({
		deps: {
			sendPart: async (args) => {
				if (args.partNumber === 1) {
					await stalled.promise;
				}
				args.onBytes(args.chunk.size);
				return {status: 200, json: {}};
			}
		}
	});
	const heartbeat = controlHeartbeat(made);
	const pending = runVideoUpload(makeVideo(10), made.deps, new AbortController().signal);
	await flush();
	const before = made.progress.length;
	const last = made.progress[before - 1];
	assert.strictEqual(last.phase, 'upload');
	assert.ok(last.progress > 0 && last.progress < 1);
	await heartbeat.tick();
	await heartbeat.tick();
	assert.deepStrictEqual(made.progress.slice(before), [last, last]);
	stalled.resolve();
	assert.deepStrictEqual(await pending, {ok: true, blob: VIDEO_BLOB});
	await flush();
	assert.ok(heartbeat.signals.every((signal) => signal.aborted));
});

test('runVideoUpload: 間隔のうちに進み具合を知らせていれば送り直さない', async () => {
	const session = deferred();
	const made = makeDeps({deps: {getSession: () => session.promise}});
	const heartbeat = controlHeartbeat(made);
	const pending = runVideoUpload(makeVideo(10), made.deps, new AbortController().signal);
	made.advance(VIDEO_UPLOAD.progressHeartbeatMs - 1);
	await heartbeat.release();
	assert.strictEqual(made.progress.length, 0);
	made.advance(1);
	await heartbeat.release();
	assert.deepStrictEqual(made.progress, [{phase: 'upload', progress: 0}]);
	session.resolve(SESSION);
	assert.strictEqual((await pending).ok, true);
});

test('runVideoUpload: 1 本の部品が諦めたら、ほかの送信中の部品の signal を鳴らす', async () => {
	const signals = new Map();
	const made = makeDeps({
		deps: {
			sendPart: (args) => {
				signals.set(args.partNumber, args.signal);
				if (args.partNumber === 1) return Promise.resolve({status: 400, json: {}});
				return new Promise((resolve, reject) => {
					args.signal.addEventListener('abort', () => reject(new Error('aborted')), {once: true});
				});
			}
		}
	});
	const result = await runVideoUpload(makeVideo(PART_SIZE * 4), made.deps, new AbortController().signal);
	assert.deepStrictEqual(result, {ok: false, reason: 'upload-failed'});
	assert.deepStrictEqual([...signals.keys()].sort(), [1, 2, 3, 4]);
	for (const [partNumber, signal] of signals) {
		assert.ok(signal instanceof AbortSignal, `部品 ${partNumber}`);
		assert.strictEqual(signal.aborted, true, `部品 ${partNumber}`);
	}
	assert.ok(!made.calls.some((c) => c.fn === 'finishUpload'));
	assert.ok(made.calls.some((c) => c.fn === 'abortUpload'));
});

test('runVideoUpload: completedJobId が無ければ jobStatus.jobId で処理の状態を引き、どちらも無ければ upload-failed', async () => {
	const byStatusId = makeDeps({
		handlers: {
			finishUpload: () => ({status: 200, json: {jobStatus: {jobId: 'done-9', state: 'JOB_STATE_ENCODING'}}})
		}
	});
	assert.deepStrictEqual(
		await runVideoUpload(makeVideo(10), byStatusId.deps, new AbortController().signal),
		{ok: true, blob: VIDEO_BLOB}
	);
	const polls = byStatusId.calls.filter((c) => c.fn === 'getJobStatus');
	assert.ok(polls.length > 0);
	assert.ok(polls.every((c) => c.opts.params.jobId === 'done-9'));

	const noId = makeDeps({
		handlers: {
			finishUpload: () => ({status: 200, json: {jobStatus: {state: 'JOB_STATE_ENCODING'}}})
		}
	});
	assert.deepStrictEqual(
		await runVideoUpload(makeVideo(10), noId.deps, new AbortController().signal),
		{ok: false, reason: 'upload-failed'}
	);
	assert.ok(!noId.calls.some((c) => c.fn === 'getJobStatus'));

	// 最初から完了を返したときは引かないため、ジョブが分からなくてもそのまま使う
	const completed = makeDeps({
		handlers: {
			finishUpload: () => ({status: 200, json: {jobStatus: {state: 'JOB_STATE_COMPLETED', blob: VIDEO_BLOB}}})
		}
	});
	assert.deepStrictEqual(
		await runVideoUpload(makeVideo(10), completed.deps, new AbortController().signal),
		{ok: true, blob: VIDEO_BLOB}
	);
});

test('runVideoUpload: upload の進み具合は 1% 以上増えたときだけ知らせ、最初の 0 と最後の 1 は必ず知らせる', async () => {
	const size = 400;
	const made = makeDeps({
		handlers: {
			startUpload: () => ({status: 200, json: {jobId: 'job-1', partSizeBytes: size, partCount: 1}})
		},
		deps: {
			// 1 バイトごとに進み具合を届ける (間引かなければ 400 回知らせることになる)
			sendPart: async (args) => {
				for (let sent = 1; sent <= args.chunk.size; sent++) args.onBytes(sent);
				return {status: 200, json: {}};
			}
		}
	});
	const result = await runVideoUpload(makeVideo(size), made.deps, new AbortController().signal);
	assert.strictEqual(result.ok, true);
	const upload = made.progress.filter((p) => p.phase === 'upload').map((p) => p.progress);
	assert.strictEqual(upload[0], 0);
	assert.strictEqual(upload[upload.length - 1], 1);
	assert.ok(upload.length <= 101, `間引かれていない: ${upload.length} 回`);
	for (let i = 1; i < upload.length - 1; i++) {
		assert.ok(upload[i] - upload[i - 1] >= 0.01 - 1e-12, `1% 未満の増えで知らせた: ${upload[i - 1]} → ${upload[i]}`);
	}
	// 段階が processing に変わったことも知らせる
	assert.ok(made.progress.some((p) => p.phase === 'processing'));
});

test('runVideoUpload: 送り直しで部品の送れた量が 0 に戻っても、合計は差分で正しく数え直す', async () => {
	let attempts = 0;
	const made = makeDeps({
		deps: {
			sendPart: async (args) => {
				args.onBytes(args.chunk.size);
				if (args.partNumber === 1 && attempts++ === 0) return {status: 500, json: {}};
				return {status: 200, json: {}};
			}
		}
	});
	const result = await runVideoUpload(makeVideo(10), made.deps, new AbortController().signal);
	assert.strictEqual(result.ok, true);
	const upload = made.progress.filter((p) => p.phase === 'upload').map((p) => p.progress);
	assert.ok(upload.every((value) => value >= 0 && value <= 1), `範囲の外: ${upload}`);
	assert.strictEqual(upload[upload.length - 1], 1);
});

test('runVideoUpload: 同じアカウントの 2 本目は PDS の DID を覚えていて getSession を省き、DID が変われば引き直す', async () => {
	forgetPdsAud();
	try {
		let did = SESSION.did;
		const run = async (overrides = {}) => {
			const made = makeDeps({...overrides, deps: {sessionDid: () => did, ...overrides.deps}});
			const result = await runVideoUpload(makeVideo(8), made.deps, new AbortController().signal);
			const auth = made.calls.find((c) => c.fn === 'getServiceAuth' && c.lxm === VIDEO_UPLOAD.nsid.uploadBlob);
			return {
				result,
				sessions: made.calls.filter((c) => c.fn === 'getSession').length,
				aud: auth ? auth.aud : null
			};
		};
		const first = await run();
		assert.strictEqual(first.result.ok, true);
		assert.strictEqual(first.sessions, 1);
		const second = await run();
		assert.strictEqual(second.result.ok, true);
		assert.strictEqual(second.sessions, 0);
		assert.strictEqual(second.aud, `did:web:${PDS_HOST}`);
		// アカウントを切り替えた (応答の did とも合わない) ときは覚えずに毎回引く
		did = 'did:plc:another';
		assert.strictEqual((await run()).sessions, 1);
		assert.strictEqual((await run()).sessions, 1);
	} finally {
		forgetPdsAud();
	}
});

test('runVideoUpload: 失敗したアップロードの後は覚えていた PDS の DID を捨てる。sessionDid が無ければ覚えない', async () => {
	forgetPdsAud();
	try {
		const deps = {sessionDid: () => SESSION.did};
		const count = async (overrides) => {
			const made = makeDeps(overrides);
			await runVideoUpload(makeVideo(8), made.deps, new AbortController().signal);
			return made.calls.filter((c) => c.fn === 'getSession').length;
		};
		assert.strictEqual(await count({deps}), 1);
		assert.strictEqual(await count({
			deps,
			handlers: {startUpload: () => ({status: 500, json: {}})}
		}), 0);
		assert.strictEqual(await count({deps}), 1);
		forgetPdsAud();
		assert.strictEqual(await count({}), 1);
		assert.strictEqual(await count({}), 1);
	} finally {
		forgetPdsAud();
	}
});
