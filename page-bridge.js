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
            closeLightbox: 'close-lightbox',
            callXrpc: 'call-xrpc',
            openComposer: 'open-composer',
            getSession: 'get-session'
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
        maxWalkDepth: 250,
        /**
         * call-xrpc が通す XRPC の白名簿。**config.js の
         * EXT_CONFIG.postActions.nsid と同じ値。片方を変えたら両方直す。**
         *
         * ここを緩めると、この橋渡しは「本体のセッションで任意の XRPC を
         * 呼べる汎用の穴」になる。ext:bridge-request は document 上の
         * CustomEvent であり、bsky.app 上で動く誰でも撃てる
         */
        xrpc: {
            'app.bsky.feed.getPosts': {target: 'appview', method: 'GET'},
            /**
             * recordWrite: true は checkXrpcRequest() が collection / repo の
             * 検査を課す目印。**文字列リテラルで別置きしない (修正ラウンド 1 C1/I2)。**
             * ここに新しく repo 書き込み系の NSID を足すときは必ず付けること
             */
            'com.atproto.repo.createRecord': {target: 'pds', method: 'POST', recordWrite: true},
            'com.atproto.repo.deleteRecord': {target: 'pds', method: 'POST', recordWrite: true},
            'app.bsky.bookmark.createBookmark': {target: 'appview', method: 'POST'},
            'app.bsky.bookmark.deleteBookmark': {target: 'appview', method: 'POST'}
        },
        /**
         * createRecord / deleteRecord で触れるコレクション。
         * **config.js の EXT_CONFIG.postActions.collections と同じ値。**
         * ここに無いものは通さないため、投稿・削除・フォロー・ブロックは
         * この橋渡しでは行えない
         */
        recordCollections: ['app.bsky.feed.like', 'app.bsky.feed.repost'],
        /**
         * open-composer が受け付けるモード。
         * **config.js の EXT_CONFIG.postActions.composerModes と同じ値**
         */
        composerModes: ['reply', 'quote']
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

    /**
     * 本体の認証済みクライアント一式を探す。
     *
     * **走査結果をキャッシュしない。** getLightbox と同じ理由で、React は
     * 状態が変わるたび Context の value を作り直す。アカウントを切り替えたあとも
     * 古いクライアントを返し続けると、別人の repo へ書き込む事故になる。
     * 走査は利用者が押したときにしか走らないため、毎回歩いて構わない
     * @returns {Object|null} {session, appviewClient, pdsClient, ...}
     */
    function findClients() {
        return findContextValue((value) => typeof value.pdsClient === 'object'
            && value.pdsClient !== null
            && typeof value.appviewClient === 'object'
            && value.appviewClient !== null);
    }

    /**
     * 投稿作成モーダルの開閉制御を探す。
     * @returns {Object|null} {openComposer, closeComposer}
     */
    function findComposerControls() {
        return findContextValue((value) => typeof value.openComposer === 'function');
    }

    /**
     * ログイン中の DID を読む。**トークンには触らない。**
     * @param {Object|null} clients findClients() の結果
     * @returns {string|null} 未ログインなら null
     */
    function readSessionDid(clients) {
        try {
            const did = clients
                && clients.appviewClient
                && clients.appviewClient.agent
                && clients.appviewClient.agent.did;
            return typeof did === 'string' && did ? did : null;
        } catch (error) {
            return null;
        }
    }

    /**
     * call-xrpc の要求を検査する。**通らないものはここで落とす。**
     * NSID の白名簿、レコード書き込みの collection、repo が本人かの 3 段。
     * @param {Object} payload {nsid, params, body}
     * @param {string|null} sessionDid ログイン中の DID
     * @returns {{ok: true, rule: {target: string, method: string}}
     *   |{ok: false, reason: string}}
     */
    function checkXrpcRequest(payload, sessionDid) {
        if (!payload || typeof payload !== 'object') {
            return {ok: false, reason: 'invalid-payload'};
        }
        if (typeof payload.nsid !== 'string') {
            // hasOwnProperty はプロパティキーの ToString 変換で照合するため、
            // 配列 (["com.atproto.repo.createRecord"] 等) を渡すと白名簿には
            // hit しつつ、下の rule.recordWrite が undefined になり
            // collection / repo の検査を素通りしてしまう (修正ラウンド 1 C1)
            return {ok: false, reason: 'invalid-nsid'};
        }
        const rule = Object.prototype.hasOwnProperty.call(EXT_BRIDGE.xrpc, payload.nsid)
            ? EXT_BRIDGE.xrpc[payload.nsid]
            : null;
        if (!rule) {
            return {ok: false, reason: 'nsid-not-allowed'};
        }
        // 白名簿 (rule.recordWrite) から導く。文字列リテラルを別置きすると
        // 白名簿に NSID を足しても検査が追随しない事故が起きる (修正ラウンド 1 I2)
        const isRecordWrite = rule.recordWrite === true;
        if (!isRecordWrite) {
            return {ok: true, rule};
        }
        const body = payload.body;
        if (!body || typeof body !== 'object') {
            return {ok: false, reason: 'invalid-body'};
        }
        if (EXT_BRIDGE.recordCollections.indexOf(body.collection) === -1) {
            return {ok: false, reason: 'collection-not-allowed'};
        }
        if (!sessionDid || body.repo !== sessionDid) {
            return {ok: false, reason: 'repo-not-self'};
        }
        return {ok: true, rule};
    }

    /**
     * GET の問い合わせ文字列を組み立てる。
     * 配列は同じ名前を繰り返す (uris=a&uris=b。XRPC の約束)。
     * @param {Object|undefined} params
     * @returns {string} 先頭の ? を含む。空なら空文字
     */
    function buildQuery(params) {
        if (!params || typeof params !== 'object') {
            return '';
        }
        const search = new URLSearchParams();
        Object.keys(params).forEach((key) => {
            const value = params[key];
            if (Array.isArray(value)) {
                value.forEach((item) => search.append(key, String(item)));
                return;
            }
            if (value !== undefined && value !== null) {
                search.append(key, String(value));
            }
        });
        const query = search.toString();
        return query ? `?${query}` : '';
    }

    /**
     * 本体の認証済み fetchHandler を借りて XRPC を 1 回呼ぶ。
     * **白名簿を通ったものだけが実際に飛ぶ。**
     * @param {Object} payload {nsid, params, body}
     * @returns {Promise<{ok: boolean, status?: number, json?: Object|null,
     *   reason: string|null}>}
     */
    async function callXrpc(payload) {
        const clients = findClients();
        if (!clients) {
            return {ok: false, reason: 'no-client'};
        }
        const checked = checkXrpcRequest(payload, readSessionDid(clients));
        if (!checked.ok) {
            return {ok: false, reason: checked.reason};
        }
        const client = checked.rule.target === 'pds'
            ? clients.pdsClient
            : clients.appviewClient;
        const agent = client && client.agent;
        if (!agent || typeof agent.fetchHandler !== 'function') {
            return {ok: false, reason: 'no-agent'};
        }
        const init = {
            method: checked.rule.method,
            headers: {accept: 'application/json'}
        };
        let path = `/xrpc/${payload.nsid}`;
        if (checked.rule.method === 'GET') {
            path += buildQuery(payload.params);
        } else {
            init.headers['content-type'] = 'application/json';
            init.body = JSON.stringify(payload.body || {});
        }
        try {
            const response = await agent.fetchHandler(path, init);
            let json = null;
            try {
                json = await response.json();
            } catch (error) {
                json = null;
            }
            return {
                ok: response.ok === true,
                status: response.status,
                json,
                reason: response.ok === true ? null : 'http-error'
            };
        } catch (error) {
            return {ok: false, reason: 'fetch-failed'};
        }
    }

    /**
     * 本体の投稿作成モーダルを返信・引用モードで開く。
     *
     * **findComposerControls() の結果をキャッシュしない。** findClients() と
     * 同じ理由 (React が状態が変わるたび Context の value を作り直すこと) に加え、
     * アンマウント済みのツリー由来の openComposer は例外を投げずに何もしない
     * ことがあり、キャッシュを取り直すきっかけ (throw) が来ないまま
     * 「押しても何も起きないのに成功扱い」になる事故を防ぐ (修正ラウンド 1 I4)。
     * 押下時にしか走らないため、毎回歩くコストは findClients() と同様に許容する
     * @param {{mode: string, post: Object}} payload
     * @returns {{ok: boolean, reason: string|null}}
     */
    function openComposer(payload) {
        const mode = payload && payload.mode;
        if (EXT_BRIDGE.composerModes.indexOf(mode) === -1) {
            return {ok: false, reason: 'unknown-mode'};
        }
        const post = payload && payload.post;
        if (!post || typeof post !== 'object'
            || typeof post.uri !== 'string' || typeof post.cid !== 'string') {
            return {ok: false, reason: 'invalid-payload'};
        }
        const controls = findComposerControls();
        if (!controls) {
            return {ok: false, reason: 'no-composer'};
        }
        try {
            controls.openComposer(
                mode === 'reply' ? {replyTo: post} : {quote: post}
            );
            return {ok: true, reason: null};
        } catch (error) {
            return {ok: false, reason: 'open-failed'};
        }
    }

    /**
     * ログイン状態と自分の DID を返す。**トークンは絶対に返さない。**
     * @returns {{ok: boolean, hasSession: boolean, did: string|null}}
     */
    function getSession() {
        const did = readSessionDid(findClients());
        return {ok: true, hasSession: did !== null, did};
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
        if (detail.action === EXT_BRIDGE.actions.callXrpc) {
            callXrpc(detail.payload).then(
                (result) => reply(detail.id, result),
                () => reply(detail.id, {ok: false, reason: 'call-failed'})
            );
            return;
        }
        if (detail.action === EXT_BRIDGE.actions.openComposer) {
            reply(detail.id, openComposer(detail.payload));
            return;
        }
        if (detail.action === EXT_BRIDGE.actions.getSession) {
            reply(detail.id, getSession());
            return;
        }
        reply(detail.id, {ok: false, reason: 'unknown-action'});
    }

    // tests から require するためだけの分岐。**typeof window === 'undefined' を
    // 必ず先に見る。** page-bridge.js は MAIN ワールドの document_end で動くため、
    // これが無いと先に window.module を仕込んだページ側コードに白名簿を含む
    // EXT_BRIDGE への参照を渡してしまう (修正ラウンド 1 I3)。Node には window が
    // 存在しないため、この条件は Node からの require でしか成立しない
    if (typeof window === 'undefined' && typeof module !== 'undefined' && module.exports) {
        module.exports = {EXT_BRIDGE, checkXrpcRequest, buildQuery};
    }

    // 橋渡しとしての起動。Node のテストからは document が無いため実行されない
    if (typeof document !== 'undefined') {
        try {
            document.addEventListener(EXT_BRIDGE.requestEvent, handleRequest);
        } catch (error) {
            console.error('[Bluesky拡張] 橋渡しの起動に失敗しました', error);
        }
    }
}());
