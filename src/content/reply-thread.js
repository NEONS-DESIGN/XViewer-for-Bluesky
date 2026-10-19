/**
 * reply-thread.js
 * 返信欄の「投稿を追加」で作るスレッドの純関数。空の投稿の判定、追加ボタンの出し分け、
 * 送信可否、record の連結 (rkey・createdAt・root・parent)、一覧への差し込み先の連なりを決める。
 */

/**
 * 1 件の投稿の要約。
 * @typedef {Object} PostSummary
 * @property {string} text 本文
 * @property {number} contentCount 添付 (画像・GIF・動画・カード・引用) の数
 * @property {boolean} preparing 添付を準備中か
 */

/**
 * 投稿が空か。本文が空白だけで、添付が無く、準備中でもないとき真。
 * @param {PostSummary} summary
 * @returns {boolean}
 */
export function isEmptyPost(summary) {
	return String(summary.text || '').trim() === '' && !(summary.contentCount > 0) && !summary.preparing;
}

/**
 * 空でない投稿の位置を順に返す。空でない投稿のあいだに空の投稿があれば skippedMiddle を真にする。
 * @param {PostSummary[]} summaries
 * @returns {{indexes: number[], skippedMiddle: boolean}}
 */
export function splitEmptyPosts(summaries) {
	const indexes = [];
	let skippedMiddle = false;
	let sawEmptyAfterContent = false;
	summaries.forEach((summary, index) => {
		if (isEmptyPost(summary)) {
			if (indexes.length > 0) sawEmptyAfterContent = true;
			return;
		}
		if (sawEmptyAfterContent) skippedMiddle = true;
		indexes.push(index);
	});
	return {indexes, skippedMiddle};
}

/**
 * 「＋」で投稿を足せるか。アクティブな投稿が空でなく、次の投稿が無いか空でなく、上限未満のとき真。
 * @param {PostSummary[]} summaries
 * @param {number} activeIndex
 * @param {number} maxPosts
 * @returns {boolean}
 */
export function canAddPost(summaries, activeIndex, maxPosts) {
	if (summaries.length >= maxPosts) return false;
	const active = summaries[activeIndex];
	if (!active || isEmptyPost(active)) return false;
	const next = summaries[activeIndex + 1];
	return !next || !isEmptyPost(next);
}

/**
 * スレッドを送れるか。空でない投稿が 1 件以上あり、空でない投稿がすべて送れる状態のとき真。
 * @param {Array<{empty: boolean, ok: boolean}>} checks
 * @returns {boolean}
 */
export function canSubmitThread(checks) {
	const filled = checks.filter((check) => !check.empty);
	return filled.length > 0 && filled.every((check) => check.ok);
}

/**
 * record を返信の連なりに連結して applyWrites の writes を作る。
 * 先頭の reply はそのまま使い、2 件目以降は root を引き継ぎ、parent を直前の投稿にする。入力は書き換えない。
 * @param {Object[]} records 先頭の reply が宛先に対する root と parent を持つ record
 * @param {{repo: string, collection: string, createType: string, nowMs: number, rkeys: string[], computeCid: function(Object): Promise<string>}} options
 * @returns {Promise<{writes: Object[], refs: Array<{uri: string, cid: string}>}>}
 */
export async function chainThreadRecords(records, options) {
	const {repo, collection, createType, nowMs, rkeys, computeCid} = options;
	const writes = [];
	const refs = [];
	for (let i = 0; i < records.length; i++) {
		const value = {...records[i], createdAt: new Date(nowMs + i).toISOString()};
		if (i >= 1) value.reply = {root: records[0].reply.root, parent: refs[i - 1]};
		const ref = {uri: `at://${repo}/${collection}/${rkeys[i]}`, cid: await computeCid(value)};
		refs.push(ref);
		writes.push({$type: createType, collection, rkey: rkeys[i], value});
	}
	return {writes, refs};
}

/**
 * 送った連なりの各投稿の返信先 (一覧への差し込み先) を返す。
 * i 件目の戻り値は、i 件目の投稿が返信した相手。先頭は first、以降は直前に送った投稿。
 * @param {import('./lightbox-replies.js').ReplyTarget} first 最初の返信先
 * @param {Array<{uri: string, cid: string}>} results 送った投稿の uri と cid
 * @param {Object[]} records 送った record (reply を読む)
 * @param {string|null} selfHandle 自分のハンドル
 * @returns {import('./lightbox-replies.js').ReplyTarget[]}
 */
export function chainTargets(first, results, records, selfHandle) {
	const anchorUri = first.isPost ? (results[0] ? results[0].uri : null) : first.anchorUri;
	return results.map((_, i) => {
		if (i === 0) return first;
		return {
			uri: results[i - 1].uri,
			cid: results[i - 1].cid,
			replyRef: records[i - 1].reply,
			isPost: false,
			anchorUri,
			handle: selfHandle
		};
	});
}
