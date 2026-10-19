/**
 * chrome.storage.sync の設定の読み込みと変更の監視。
 * content script の各機能が「既定値付きで読む」「ポップアップでの変更をリロードなしで受ける」を同じ形で書く。
 *
 * 依存: なし (chrome.storage)
 */

/**
 * 設定を読む。読めなかったキーは既定値。読み込み自体に失敗しても既定値で返す (投げない)。
 * @param {Object<string, *>} defaults {保存キー: 既定値}
 * @param {string} label 失敗のログに出す名前
 * @returns {Promise<Object<string, *>>}
 */
export async function loadSyncSettings(defaults, label) {
	const values = {...defaults};
	try {
		const stored = await chrome.storage.sync.get(Object.keys(defaults));
		for (const key of Object.keys(defaults)) {
			if (stored && stored[key] !== undefined && stored[key] !== null) {
				values[key] = stored[key];
			}
		}
	} catch (error) {
		console.error(`[XViewer] ${label}の設定の読み込みに失敗しました`, error);
	}
	return values;
}

/**
 * 設定の変更を受ける。listener には変わったキーだけを {保存キー: 新しい値 (消えたら既定値)} で渡す。
 * defaults に無いキーの変更では呼ばない。
 * @param {Object<string, *>} defaults {保存キー: 既定値}
 * @param {(changed: Object<string, *>) => void} listener
 * @param {string} label 失敗のログに出す名前
 * @returns {() => void} 監視をやめる関数 (始められなかったときは何もしない関数)
 */
export function watchSyncSettings(defaults, listener, label) {
	const onChanged = (changes, area) => {
		if (area !== 'sync') {
			return;
		}
		const changed = {};
		let any = false;
		for (const key of Object.keys(defaults)) {
			if (changes[key]) {
				changed[key] = changes[key].newValue ?? defaults[key];
				any = true;
			}
		}
		if (any) {
			listener(changed);
		}
	};
	try {
		chrome.storage.onChanged.addListener(onChanged);
		return () => {
			try {
				chrome.storage.onChanged.removeListener(onChanged);
			} catch (error) {
				// 拡張機能の文脈が無くなった後は外すものも無い
			}
		};
	} catch (error) {
		console.error(`[XViewer] ${label}の設定の監視の開始に失敗しました`, error);
		return () => {};
	}
}
