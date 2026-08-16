/**
 * MAIN ワールドで動く橋渡し。
 * 分離ワールドから見えない React の内部状態 (ライトボックス制御) を扱う。
 * config.js の EXT_CONFIG.mediaGrid.bridge と同じ値をここにも書いてある。
 * 片方を変えたら必ず両方直すこと。
 */
(function () {
    'use strict';

    const EXT_BRIDGE = {
        requestEvent: 'ext:bridge-request',
        resultEvent: 'ext:bridge-result',
        actions: {
            openLightbox: 'open-lightbox',
            switchTab: 'switch-tab',
            navigate: 'navigate'
        },
        rootId: 'root',
        containerKeyPrefix: '__reactContainer$',
        tabTestIdPrefix: 'profilePager-selector-',
        /** 投稿ページのルート名。getState() で実測済み (Task 8 修正ラウンド 4) */
        postThreadRouteName: 'PostThread',
        maxWalkNodes: 60000,
        maxWalkDepth: 250
    };

    let lightboxControls = null;
    let navigationControls = null;

    /**
     * React の fiber ツリーを走査して openLightbox を持つ Context の value を探す。
     * @returns {Object|null} {openLightbox, closeLightbox}
     */
    function findLightboxControls() {
        try {
            const rootEl = document.getElementById(EXT_BRIDGE.rootId)
                || document.body.firstElementChild;
            if (!rootEl) {
                return null;
            }
            const containerKey = Object.keys(rootEl)
                .find((key) => key.startsWith(EXT_BRIDGE.containerKeyPrefix));
            if (!containerKey) {
                return null;
            }

            let found = null;
            let visited = 0;
            const walk = (node, depth) => {
                if (!node || found || visited > EXT_BRIDGE.maxWalkNodes
                    || depth > EXT_BRIDGE.maxWalkDepth) {
                    return;
                }
                visited += 1;
                const value = node.memoizedProps && node.memoizedProps.value;
                if (value && typeof value === 'object'
                    && typeof value.openLightbox === 'function') {
                    found = value;
                    return;
                }
                walk(node.child, depth + 1);
                walk(node.sibling, depth);
            };
            walk(rootEl[containerKey], 0);
            return found;
        } catch (error) {
            return null;
        }
    }

    /**
     * React の fiber ツリーを走査して push / navigate / getState を持つ
     * Context の value (Bluesky のナビゲーションオブジェクト) を探す。
     * findLightboxControls() と同じ走査方式。
     * @returns {Object|null} {push, navigate, getState, ...}
     */
    function findNavigationControls() {
        try {
            const rootEl = document.getElementById(EXT_BRIDGE.rootId)
                || document.body.firstElementChild;
            if (!rootEl) {
                return null;
            }
            const containerKey = Object.keys(rootEl)
                .find((key) => key.startsWith(EXT_BRIDGE.containerKeyPrefix));
            if (!containerKey) {
                return null;
            }

            let found = null;
            let visited = 0;
            const walk = (node, depth) => {
                if (!node || found || visited > EXT_BRIDGE.maxWalkNodes
                    || depth > EXT_BRIDGE.maxWalkDepth) {
                    return;
                }
                visited += 1;
                const value = node.memoizedProps && node.memoizedProps.value;
                if (value && typeof value === 'object'
                    && typeof value.push === 'function'
                    && typeof value.navigate === 'function'
                    && typeof value.getState === 'function') {
                    found = value;
                    return;
                }
                walk(node.child, depth + 1);
                walk(node.sibling, depth);
            };
            walk(rootEl[containerKey], 0);
            return found;
        } catch (error) {
            return null;
        }
    }

    /**
     * 投稿ページへ SPA 遷移する。ルーターの push を直接呼ぶ (history.pushState は使わない)。
     * @param {{handle: string, rkey: string}} payload
     * @returns {{ok: boolean, reason: string|null}}
     */
    function navigate(payload) {
        const handle = payload && payload.handle;
        const rkey = payload && payload.rkey;
        if (typeof handle !== 'string' || !handle || typeof rkey !== 'string' || !rkey) {
            return {ok: false, reason: 'invalid-payload'};
        }
        for (let attempt = 0; attempt < 2; attempt += 1) {
            if (!navigationControls) {
                navigationControls = findNavigationControls();
            }
            if (!navigationControls) {
                return {ok: false, reason: 'no-router'};
            }
            try {
                navigationControls.push(EXT_BRIDGE.postThreadRouteName, {name: handle, rkey});
                return {ok: true, reason: null};
            } catch (error) {
                // 制御が古くなっている可能性があるので 1 度だけ取り直して再試行する
                navigationControls = null;
            }
        }
        return {ok: false, reason: 'navigate-failed'};
    }

    /**
     * ライトボックスを開く。制御が見つからなければ ok:false を返す。
     * @param {{images: Object[], index: number}} payload
     * @returns {{ok: boolean, reason: string|null}}
     */
    function openLightbox(payload) {
        if (!payload || !Array.isArray(payload.images) || payload.images.length === 0) {
            return {ok: false, reason: 'invalid-payload'};
        }
        for (let attempt = 0; attempt < 2; attempt += 1) {
            if (!lightboxControls) {
                lightboxControls = findLightboxControls();
            }
            if (!lightboxControls) {
                return {ok: false, reason: 'no-lightbox'};
            }
            try {
                lightboxControls.openLightbox({
                    images: payload.images,
                    index: payload.index || 0
                });
                return {ok: true, reason: null};
            } catch (error) {
                // 制御が古くなっている可能性があるので 1 度だけ取り直して再試行する
                lightboxControls = null;
            }
        }
        return {ok: false, reason: 'open-failed'};
    }

    /**
     * プロフィールのタブを切り替える。
     * @param {{index: number}} payload
     * @returns {{ok: boolean, reason: string|null}}
     */
    function switchTab(payload) {
        try {
            const index = payload && payload.index;
            if (typeof index !== 'number' || index < 0) {
                return {ok: false, reason: 'invalid-payload'};
            }
            const tab = document.querySelector(
                `[data-testid="${EXT_BRIDGE.tabTestIdPrefix}${index}"]`
            );
            if (!tab) {
                return {ok: false, reason: 'no-tab'};
            }
            tab.click();
            return {ok: true, reason: null};
        } catch (error) {
            return {ok: false, reason: 'click-failed'};
        }
    }

    function reply(id, payload) {
        try {
            document.dispatchEvent(new CustomEvent(EXT_BRIDGE.resultEvent, {
                detail: JSON.stringify(Object.assign({id}, payload))
            }));
        } catch (error) {
            // 返せない場合は分離ワールド側のタイムアウトに回収させる
        }
    }

    function handleRequest(event) {
        let detail = null;
        try {
            detail = JSON.parse(event.detail);
        } catch (error) {
            return;
        }
        if (!detail || typeof detail.id !== 'number') {
            return;
        }
        if (detail.action === EXT_BRIDGE.actions.openLightbox) {
            reply(detail.id, openLightbox(detail.payload));
            return;
        }
        if (detail.action === EXT_BRIDGE.actions.switchTab) {
            reply(detail.id, switchTab(detail.payload));
            return;
        }
        if (detail.action === EXT_BRIDGE.actions.navigate) {
            reply(detail.id, navigate(detail.payload));
            return;
        }
        reply(detail.id, {ok: false, reason: 'unknown-action'});
    }

    try {
        document.addEventListener(EXT_BRIDGE.requestEvent, handleRequest);
    } catch (error) {
        console.error('[Bluesky拡張] 橋渡しの起動に失敗しました', error);
    }
}());
