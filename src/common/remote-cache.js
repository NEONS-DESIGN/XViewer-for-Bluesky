/**
 * 通信の結果をメモリに覚える小さなキャッシュ。
 * 同じキーの飛行中の要求は 1 本にまとめ、**成功 (null 以外) だけを覚える** (失敗は次に引き直す)。
 * 上限を超えたら古いものから捨てる。ttlMs を過ぎたものは無いものとして扱う。
 *
 * 依存: なし
 */

export class RemoteCache {
	/**
	 * @param {{limit: number, ttlMs?: number, now?: () => number}} options ttlMs を省くと期限なし
	 */
	constructor(options) {
		this.limit = Math.max(1, options.limit);
		this.ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : Infinity;
		this.now = options.now || (() => Date.now());
		/** @type {Map<string, {value: *, at: number}>} */
		this.entries = new Map();
		/** @type {Map<string, Promise<*>>} */
		this.inflight = new Map();
		/** clear() のたびに進め、clear() より前に出た要求の結果を覚えない */
		this.epoch = 0;
	}

	/**
	 * 覚えている値を返す。無い・期限切れなら undefined。
	 * @param {string} key
	 * @returns {*}
	 */
	peek(key) {
		const entry = this.entries.get(key);
		if (!entry) {
			return undefined;
		}
		if (this.now() - entry.at > this.ttlMs) {
			this.entries.delete(key);
			return undefined;
		}
		return entry.value;
	}

	/**
	 * 値を覚える。null / undefined は覚えない。
	 * @param {string} key
	 * @param {*} value
	 * @returns {void}
	 */
	set(key, value) {
		if (value === null || value === undefined) {
			return;
		}
		this.entries.delete(key);
		this.entries.set(key, {value, at: this.now()});
		while (this.entries.size > this.limit) {
			this.entries.delete(this.entries.keys().next().value);
		}
	}

	/**
	 * 覚えていればそれを、無ければ load() で引いて返す。飛行中の同じキーは同じ Promise を返す。
	 * @template T
	 * @param {string} key
	 * @param {() => Promise<T|null>} load 失敗は null を返すか投げる
	 * @returns {Promise<T|null>}
	 */
	get(key, load) {
		const cached = this.peek(key);
		if (cached !== undefined) {
			return Promise.resolve(cached);
		}
		const pending = this.inflight.get(key);
		if (pending) {
			return pending;
		}
		const epoch = this.epoch;
		const promise = (async () => {
			try {
				// 同期で投げる load でも、promise を登録し終えてから走らせる
				const value = await Promise.resolve().then(load);
				if (epoch === this.epoch) {
					this.set(key, value);
				}
				return value === undefined ? null : value;
			} catch (error) {
				return null;
			} finally {
				if (this.inflight.get(key) === promise) {
					this.inflight.delete(key);
				}
			}
		})();
		this.inflight.set(key, promise);
		return promise;
	}

	/**
	 * 1 件を忘れる。
	 * @param {string} key
	 * @returns {void}
	 */
	delete(key) {
		this.entries.delete(key);
		this.inflight.delete(key);
	}

	/** すべて忘れる。飛行中の要求の結果も覚えない。 */
	clear() {
		this.epoch += 1;
		this.entries.clear();
		this.inflight.clear();
	}
}
