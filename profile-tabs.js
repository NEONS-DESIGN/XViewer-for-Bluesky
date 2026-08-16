/**
 * getProfile のレスポンスと画面の状態から、Bluesky 本体と同じ可視タブ列を組み立てる。
 * 順序と条件は EXT_CONFIG.profileTabs が持つ (設計文書 2.5)。
 * @param {Object|null} profile app.bsky.actor.getProfile のレスポンス
 * @param {{isMe: boolean, hasSession: boolean}} context
 * @param {Object} config EXT_CONFIG
 * @returns {Array<{name: string, view: string|undefined}>} 可視タブ列 (index が画面上の並び)
 */
function buildTabList(profile, context, config) {
    try {
        // profile が null の場合は例外扱い
        if (!profile) {
            throw new Error('profile is required');
        }
        const associated = (profile && profile.associated) || {};
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
        console.error('[Bluesky拡張] タブ列の組み立てに失敗しました', error);
        // 壊れていても posts タブだけは返す (config から導出)
        try {
            const postsTab = config.profileTabs.find((t) => t.name === 'posts');
            if (postsTab) {
                return [{name: postsTab.name, view: postsTab.view}];
            }
        } catch (e) {
            // さらに失敗しても例外を投げない
        }
        return [];
    }
}

/**
 * 可視タブ列から、指定した種別のタブが何番目かを返す。
 * @param {Array<{name: string, view: string|undefined}>} tabs
 * @param {string} view EXT_VIEWS のいずれか
 * @returns {number} 見つからなければ -1
 */
function findTabIndex(tabs, view) {
    if (!Array.isArray(tabs)) {
        return -1;
    }
    return tabs.findIndex((tab) => tab.view === view);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {buildTabList, findTabIndex};
}
