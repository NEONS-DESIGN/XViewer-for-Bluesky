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
            navigate: 'navigate',
            getLightbox: 'get-lightbox',
            closeLightbox: 'close-lightbox'
        },
        rootId: 'root',
        containerKeyPrefix: '__reactContainer$',
        tabTestIdPrefix: 'profilePager-selector-',
        /**
         * navigate で行ける先の白名簿。**ここに無いルート名は受け付けない。**
         * config.js の EXT_CONFIG.mediaGrid.bridge.routes と同じ値。
         * 2026-09-09 に実機で push() の成功を確認した 3 つだけ
         */
        routeNames: ['PostThread', 'Profile', 'Hashtag'],
        /** route を省略したときの行き先 (従来の呼び出しとの互換) */
        defaultRouteName: 'PostThread',
        maxWalkNodes: 60000,
        maxWalkDepth: 250
    };

    let lightboxControls = null;
    let navigationControls = null;

    /**
     * React の fiber ツリーを深さ優先で辿り、述語に合う Context の value を返す。
     * findLightboxControls / findNavigationControls / findLightboxState の共通部分。
     * @param {(value: Object) => boolean} predicate
     * @returns {Object|null}
     */
    function findContextValue(predicate) {
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
                if (value && typeof value === 'object' && predicate(value)) {
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
     * ライトボックスの開閉制御 (openLightbox / closeLightbox) を探す。
     * @returns {Object|null}
     */
    function findLightboxControls() {
        return findContextValue((value) => typeof value.openLightbox === 'function');
    }

    /**
     * Bluesky のナビゲーションオブジェクトを探す。
     * @returns {Object|null}
     */
    function findNavigationControls() {
        return findContextValue((value) => typeof value.push === 'function'
            && typeof value.navigate === 'function'
            && typeof value.getState === 'function');
    }

    /**
     * 本体のルーターで SPA 遷移する (history.pushState は使わない)。
     * route は白名簿 (EXT_BRIDGE.routeNames) のものだけを受け付ける。
     * 省略時は PostThread として扱い、従来の呼び出しとの互換を保つ。
     * @param {{route?: string, handle?: string, rkey?: string, params?: Object}} payload
     * @returns {{ok: boolean, reason: string|null}}
     */
    function navigate(payload) {
        const route = (payload && payload.route) || EXT_BRIDGE.defaultRouteName;
        if (EXT_BRIDGE.routeNames.indexOf(route) === -1) {
            return {ok: false, reason: 'unknown-route'};
        }
        let params = payload && payload.params;
        if (!params) {
            // 従来の呼び出し (handle と rkey を直に渡す形) との互換
            const handle = payload && payload.handle;
            const rkey = payload && payload.rkey;
            if (typeof handle !== 'string' || !handle
                || typeof rkey !== 'string' || !rkey) {
                return {ok: false, reason: 'invalid-payload'};
            }
            params = {name: handle, rkey};
        }
        if (typeof params !== 'object') {
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
                navigationControls.push(route, params);
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
                    index: payload.index || 0,
                    // 本体が自分で開くときと同じ形。パネルはこれを読んで投稿を引く
                    metricsContext: payload.metricsContext || undefined
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
     * いま開いているライトボックスの情報を返す。
     *
     * **走査結果をキャッシュしない。** React は状態が変わるたび Context の
     * value オブジェクトを作り直すため、lightboxControls と同じ要領で
     * 覚えておくと古い activeLightbox を返し続ける。実測で到達は 100 ノードなので
     * 毎回歩いて構わない (SITE_SPEC.md 7.3)。
     * @returns {{ok: boolean, open?: boolean, postUri?: string|null,
     *   postAuthorDid?: string|null, index?: number, count?: number, reason?: string}}
     */
    function getLightbox() {
        const holder = findContextValue((value) => 'activeLightbox' in value);
        if (!holder) {
            return {ok: false, reason: 'no-lightbox-state'};
        }
        const active = holder.activeLightbox;
        if (!active || !Array.isArray(active.images)) {
            // 投稿作成などの別モーダルが出ているだけ
            return {ok: true, open: false};
        }
        const metrics = active.metricsContext || {};
        return {
            ok: true,
            open: true,
            postUri: typeof metrics.postUri === 'string' ? metrics.postUri : null,
            postAuthorDid: typeof metrics.postAuthorDid === 'string'
                ? metrics.postAuthorDid
                : null,
            index: typeof active.index === 'number' ? active.index : 0,
            count: active.images.length
        };
    }

    /**
     * ライトボックスを閉じる。遷移の前に確実に畳むために使う。
     * @returns {{ok: boolean, reason: string|null}}
     */
    function closeLightbox() {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            if (!lightboxControls) {
                lightboxControls = findLightboxControls();
            }
            if (!lightboxControls || typeof lightboxControls.closeLightbox !== 'function') {
                lightboxControls = null;
                if (attempt === 1) {
                    return {ok: false, reason: 'no-lightbox'};
                }
                continue;
            }
            try {
                lightboxControls.closeLightbox();
                return {ok: true, reason: null};
            } catch (error) {
                lightboxControls = null;
            }
        }
        return {ok: false, reason: 'close-failed'};
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
        if (detail.action === EXT_BRIDGE.actions.getLightbox) {
            reply(detail.id, getLightbox());
            return;
        }
        if (detail.action === EXT_BRIDGE.actions.closeLightbox) {
            reply(detail.id, closeLightbox());
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
