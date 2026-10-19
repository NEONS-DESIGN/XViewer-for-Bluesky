import {EXT_VIEWS} from '../common/config.js';

/**
 * getProfile のレスポンスと画面の状態から、Bluesky 本体と同じ可視タブ列を組み立てる。
 * 順序と条件は EXT_CONFIG.profileTabs が持つ。
 * @param {Object|null} profile app.bsky.actor.getProfile のレスポンス
 * @param {{isMe: boolean, hasSession: boolean}} context
 * @param {Object} config EXT_CONFIG
 * @returns {Array<{name: string, view: string|undefined}>} 可視タブ列 (index が画面上の並び)
 */
export function buildTabList(profile, context, config) {
	try {
		if (!profile) {
			// 制御のために例外を投げない (console.error にスタックトレースのノイズが出る)
			return postsOnlyTabList(config);
		}
		const associated = profile.associated || {};
		const starterPackCount = associated.starterPacks || 0;
		const listCount = (associated.lists || 0) - starterPackCount;
		const hasLabeler = !!associated.labeler;
		const isMe = !!(context && context.isMe);
		const hasSession = !!(context && context.hasSession);

		const criteria = {
			isMe,
			hasSession,
			hasLabeler,
			feedGenCount: associated.feedgens || 0,
			starterPackCount,
			listCount,
			showLists: hasSession && (isMe || listCount > 0)
		};

		return config.profileTabs
			.filter((tab) => tab.when(criteria))
			.map((tab) => ({name: tab.name, view: tab.view}));
	} catch (error) {
		console.error('[XViewer] タブ列の組み立てに失敗しました', error);
		return postsOnlyTabList(config);
	}
}

/**
 * profile が無い・壊れているときの受け皿。posts タブだけの列を config から導く。
 * @param {Object} config EXT_CONFIG
 * @returns {Array<{name: string, view: string|undefined}>} 導けなければ空配列 (例外は投げない)
 */
function postsOnlyTabList(config) {
	try {
		const postsTab = config.profileTabs.find((t) => t.view === EXT_VIEWS.POSTS);
		return postsTab ? [{name: postsTab.name, view: postsTab.view}] : [];
	} catch (error) {
		return [];
	}
}

/**
 * 可視タブ列から、指定した種別のタブが何番目かを返す。
 * @param {Array<{name: string, view: string|undefined}>} tabs
 * @param {string} view EXT_VIEWS のいずれか
 * @returns {number} 見つからなければ -1
 */
export function findTabIndex(tabs, view) {
	if (!Array.isArray(tabs)) {
		return -1;
	}
	return tabs.findIndex((tab) => tab.view === view);
}
