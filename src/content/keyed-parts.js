/**
 * 入れ物の子を、鍵の付いた部品の並びに合わせる。前回と同じ鍵の部品は作り直さずに使い回す
 * (動画を作り直すと再生が最初に戻り、画像を作り直すと読み込み直すため)。
 * 鍵が変わった部品だけを作り、並びが変わったときだけ入れ替える。
 *
 * 依存: なし
 */

/**
 * 部品 1 つ。key が同じあいだは build を呼ばない。
 * @typedef {Object} KeyedPart
 * @property {string} key 描き分けが要る変化を表す鍵
 * @property {() => (HTMLElement|null)} build 部品を作る
 */

/** 入れ物ごとの、前回描いた鍵と要素 @type {WeakMap<HTMLElement, Map<string, HTMLElement>>} */
const rendered = new WeakMap();

/**
 * 入れ物の子を parts の並びにする。作れなかった部品 (build が null を返す・例外) は飛ばす。
 * 入れ物の外から子を入れ替えられていても、前回の要素が入れ物の子でなければ作り直す。
 * @param {HTMLElement} container
 * @param {KeyedPart[]} parts
 * @returns {HTMLElement[]} 並べた部品
 */
export function syncKeyedParts(container, parts) {
	const previous = rendered.get(container) || new Map();
	/** @type {Map<string, HTMLElement>} */
	const next = new Map();
	const nodes = [];
	for (const part of Array.isArray(parts) ? parts : []) {
		if (!part || typeof part.key !== 'string' || next.has(part.key)) continue;
		let element = previous.get(part.key) || null;
		if (!element || element.parentNode !== container) {
			try {
				element = part.build() || null;
			} catch (error) {
				console.error('[XViewer] 部品を作れませんでした', error);
				element = null;
			}
		}
		if (!element) continue;
		next.set(part.key, element);
		nodes.push(element);
	}
	const current = Array.from(container.children);
	const same = current.length === nodes.length && current.every((node, index) => node === nodes[index]);
	if (!same) {
		// 残す部品は付け外しせずに並べ直す (付け外しすると動画の再生が止まる)
		for (const node of current) {
			if (nodes.indexOf(node) === -1) node.remove();
		}
		nodes.forEach((node, index) => {
			const at = container.children[index] || null;
			if (at !== node) container.insertBefore(node, at);
		});
	}
	rendered.set(container, next);
	return nodes;
}

/**
 * 入れ物の覚えている部品を忘れる (次の syncKeyedParts ですべて作り直す)。
 * @param {HTMLElement} container
 * @returns {void}
 */
export function forgetKeyedParts(container) {
	rendered.delete(container);
}
