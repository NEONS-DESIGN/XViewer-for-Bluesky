/**
 * 返信の入力欄のうち DOM に触れない部分。貼り付け・ドロップの中身から画像と動画を取り出すこと、
 * 画像の順次アップロード、送信の手順 (世代が変わったとき・失敗したときに何を呼ぶか)。
 * 入力欄 (reply-composer.js) が使い、そこから再び公開する。
 */
import {THREAD_UNCONFIRMED_REASON} from './post-actions.js';

/**
 * 送信の手順の段。runSubmit が順に呼ぶ。
 * @typedef {Object} SubmitSteps
 * @property {Array<{blob: Blob}>} images 送る画像 (並びのまま送る)
 * @property {(blob: Blob) => Promise<{ok: boolean, blob: Object|null, reason: string|null}>} upload
 * @property {(current: number, total: number) => void} onProgress いま送っている枚目 (1 始まり)
 * @property {() => boolean} isCurrent 応答を使ってよいか (世代が変わっていないか)
 * @property {(blobs: Object[]) => Promise<Object>} buildRecord BlobRef から返信の record を作る
 * @property {(record: Object) => Promise<{ok: boolean, uri: string|null, cid: string|null, reason: string|null}>} createReply
 * @property {(result: {uri: string, cid: string}, record: Object, blobs: Object[]) => void} onPosted
 * @property {(kind: 'upload'|'post', reason: string) => void} onFailed
 */

/**
 * 2 件以上の送信の段。runThreadSubmit が順に呼ぶ。
 * @typedef {Object} ThreadSubmitSteps
 * @property {Array<{images: Array<{blob: Blob}>, buildRecord: (blobs: Object[]) => Promise<Object>, onUploadFailed: (reason: string) => void}>} posts 送る投稿 (並びのまま)
 * @property {(blob: Blob) => Promise<{ok: boolean, blob: Object|null, reason: string|null}>} upload
 * @property {(current: number, total: number) => void} onProgress 全投稿を通した画像の番号 (1 始まり)
 * @property {() => boolean} isCurrent 応答を使ってよいか (世代が変わっていないか)
 * @property {(records: Object[]) => Promise<{ok: boolean, results: Array<{uri: string, cid: string}>|null, writes: Object[]|null, reason: string|null}>} send
 * @property {(results: Array<{uri: string, cid: string}>, records: Object[], blobsByPost: Object[][]) => void} onPosted
 * @property {(kind: 'post'|'unconfirmed', reason: string) => void} onFailed
 */

/** アップロードが例外で止まったときの理由 */
const UPLOAD_EXCEPTION = 'upload-exception';
/** 返信の作成が例外で止まったときの理由 */
const POST_EXCEPTION = 'post-exception';
/** 連なりの送信が通ったか確かめられなかった (届いたかもしれない) ときの理由。送る側 (post-actions.js) と同じ値 */
export const THREAD_UNCONFIRMED = THREAD_UNCONFIRMED_REASON;
/** 取り込む候補にするファイルの MIME タイプの接頭辞 (画像と動画) */
const MEDIA_TYPE_PREFIXES = ['image/', 'video/'];
/** DataTransferItem のファイルの種類 */
const FILE_KIND = 'file';

/**
 * DataTransferItemList のような形を配列にする。読めなければ空。
 * @param {*} items clipboardData.items / dataTransfer.items
 * @returns {Array<Object>}
 */
function toItemArray(items) {
	if (!items || typeof items !== 'object' || typeof items.length !== 'number') return [];
	try {
		return Array.from(items);
	} catch (error) {
		return [];
	}
}

/**
 * DataTransferItem が画像か動画のファイルか。形式が受け付けるものかは取り込む側が確かめる。
 * @param {*} item DataTransferItem
 * @returns {boolean}
 */
function isMediaItem(item) {
	return !!item && item.kind === FILE_KIND && typeof item.type === 'string'
		&& MEDIA_TYPE_PREFIXES.some((prefix) => item.type.startsWith(prefix));
}

/**
 * 貼り付けの中身から画像と動画のファイルだけを取り出す。空なら呼び出し側は既定の貼り付け
 * (文字) を止めない。
 * @param {*} items clipboardData.items (DataTransferItemList のような形)
 * @returns {File[]}
 */
export function pickPastedMedia(items) {
	const files = [];
	for (const item of toItemArray(items)) {
		if (!isMediaItem(item)) continue;
		try {
			const file = item.getAsFile();
			if (file) files.push(file);
		} catch (error) {
			// 読めないものは取り込まない
		}
	}
	return files;
}

/**
 * ドラッグ中の中身に画像か動画のファイルがあるか (ドロップを受けるか)。
 * @param {*} items dataTransfer.items
 * @returns {boolean}
 */
export function hasMediaItems(items) {
	return toItemArray(items).some(isMediaItem);
}

/**
 * 画像を 1 枚ずつアップロードする。1 枚でも失敗したらそこで止め、残りは送らない。
 * @param {Array<{blob: Blob}>} images 送る画像
 * @param {(blob: Blob) => Promise<{ok: boolean, blob: Object|null, reason: string|null}>} upload
 * @param {(current: number, total: number) => void} onProgress 1 枚ごとに、送り始める前に
 *   いま送っている枚目 (1 始まり) を知らせる
 * @returns {Promise<{ok: true, blobs: Object[]}|{ok: false, reason: string}>}
 */
export async function uploadAll(images, upload, onProgress) {
	const list = Array.isArray(images) ? images : [];
	const blobs = [];
	for (const image of list) {
		try {
			onProgress(blobs.length + 1, list.length);
		} catch (error) {
			console.error('[XViewer] 送信の進み具合を出せませんでした', error);
		}
		let result = null;
		try {
			result = await upload(image.blob);
		} catch (error) {
			return {ok: false, reason: UPLOAD_EXCEPTION};
		}
		if (!result || result.ok !== true || !result.blob) {
			return {ok: false, reason: (result && result.reason) || UPLOAD_EXCEPTION};
		}
		blobs.push(result.blob);
	}
	return {ok: true, blobs};
}

/**
 * 送る投稿 1 件分の段 (uploadBuildSend が使う)。
 * @typedef {Object} FlowPost
 * @property {Array<{blob: Blob}>} images 送る画像 (並びのまま)
 * @property {(blobs: Object[]) => Promise<Object>} buildRecord BlobRef から record を作る
 * @property {(reason: string) => void} onUploadFailed この投稿の画像を送れなかったときに呼ぶ
 */

/**
 * 1 件の送信と連なりの送信が共有する流れ。
 * 投稿ごとに順にアップロード → 世代の確認 → 投稿ごとに record を組み立てて世代の確認 → 送信 → 世代の確認。
 * 世代が変わっていたら以後の何も呼ばずに stale で抜ける。アップロードの失敗はその投稿の onUploadFailed だけを呼ぶ。
 * 組み立てか送信が投げたときは exception を返す (送信の結果の扱いは呼び出し側が決める)
 * @param {{posts: FlowPost[], upload: SubmitSteps['upload'], onProgress: (current: number, total: number) => void,
 *   isCurrent: () => boolean, send: (records: Object[]) => Promise<any>, errorMessage: string}} flow
 *   onProgress には全投稿を通した画像の番号 (1 始まり) と総数を渡す
 * @returns {Promise<{status: 'stale'|'upload-failed'|'exception'}
 *   |{status: 'sent', sent: any, records: Object[], blobsByPost: Object[][]}>}
 */
async function uploadBuildSend(flow) {
	const {posts, isCurrent} = flow;
	const total = posts.reduce((sum, post) => sum + (Array.isArray(post.images) ? post.images.length : 0), 0);
	const blobsByPost = [];
	let offset = 0;
	for (const post of posts) {
		const base = offset;
		const uploaded = await uploadAll(post.images, flow.upload, (current) => flow.onProgress(base + current, total));
		if (!isCurrent()) return {status: 'stale'};
		if (!uploaded.ok) {
			post.onUploadFailed(uploaded.reason);
			return {status: 'upload-failed'};
		}
		blobsByPost.push(uploaded.blobs);
		offset += uploaded.blobs.length;
	}
	const records = [];
	let sent = null;
	try {
		for (let i = 0; i < posts.length; i++) {
			records.push(await posts[i].buildRecord(blobsByPost[i]));
			if (!isCurrent()) return {status: 'stale'};
		}
		sent = await flow.send(records);
	} catch (error) {
		console.error(flow.errorMessage, error);
		return {status: isCurrent() ? 'exception' : 'stale'};
	}
	if (!isCurrent()) return {status: 'stale'};
	return {status: 'sent', sent, records, blobsByPost};
}

/**
 * 返信を送る手順。アップロード → 世代の確認 → record の組み立て → 作成 → 世代の確認、の順。
 * 世代が変わっていたら何も呼ばずに抜ける。失敗したら onFailed だけを呼び、何も消さない。
 * @param {SubmitSteps} steps 段
 * @returns {Promise<'posted'|'stale'|'upload-failed'|'post-failed'>}
 */
export async function runSubmit(steps) {
	const flow = await uploadBuildSend({
		posts: [{
			images: steps.images,
			buildRecord: steps.buildRecord,
			onUploadFailed: (reason) => steps.onFailed('upload', reason)
		}],
		upload: steps.upload,
		onProgress: steps.onProgress,
		isCurrent: steps.isCurrent,
		send: (records) => steps.createReply(records[0]),
		errorMessage: '[XViewer] 返信の投稿に失敗しました'
	});
	if (flow.status === 'stale' || flow.status === 'upload-failed') return flow.status;
	const result = flow.status === 'sent' ? flow.sent : null;
	if (!result || !result.ok) {
		steps.onFailed('post', (result && result.reason) || POST_EXCEPTION);
		return 'post-failed';
	}
	steps.onPosted(result, flow.records[0], flow.blobsByPost[0]);
	return 'posted';
}

/**
 * 2 件以上の返信を連なりとして送る手順。投稿ごとに順にアップロードし (進み具合は全投稿を通した番号)、
 * 1 件でも失敗したらその投稿だけに知らせて止める。世代が変わったら以後の何も呼ばずに抜ける。
 * 届いたか確かめられなかった (THREAD_UNCONFIRMED) ときは unconfirmed で知らせ、送り直させない
 * @param {ThreadSubmitSteps} steps 段
 * @returns {Promise<'posted'|'stale'|'upload-failed'|'post-failed'|'unconfirmed'>}
 */
export async function runThreadSubmit(steps) {
	const flow = await uploadBuildSend({
		posts: steps.posts,
		upload: steps.upload,
		onProgress: steps.onProgress,
		isCurrent: steps.isCurrent,
		send: steps.send,
		errorMessage: '[XViewer] 返信の連なりの投稿に失敗しました'
	});
	if (flow.status === 'stale' || flow.status === 'upload-failed') return flow.status;
	const sent = flow.status === 'sent' ? flow.sent : null;
	if (!sent || !sent.ok) {
		const reason = (sent && sent.reason) || POST_EXCEPTION;
		if (reason === THREAD_UNCONFIRMED) {
			steps.onFailed('unconfirmed', reason);
			return 'unconfirmed';
		}
		steps.onFailed('post', reason);
		return 'post-failed';
	}
	const sentRecords = Array.isArray(sent.writes) ? sent.writes.map((write) => write.value) : flow.records;
	steps.onPosted(sent.results, sentRecords, flow.blobsByPost);
	return 'posted';
}
