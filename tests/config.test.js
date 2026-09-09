const test = require('node:test');
const assert = require('node:assert');
const {EXT_VIEWS, EXT_CONFIG} = require('../config.js');

test('EXT_VIEWS は 4 種のページ種別を持つ', () => {
    assert.deepStrictEqual(EXT_VIEWS, {
        POSTS: 'posts',
        MEDIA: 'media',
        VIDEOS: 'videos',
        OTHER: 'other'
    });
});

test('EXT_CONFIG は取得ペースの歯止めを既定値どおり持つ', () => {
    const api = EXT_CONFIG.mediaGrid.api;
    assert.strictEqual(api.limit, 100);
    assert.strictEqual(api.cooldownMs, 1000);
    assert.strictEqual(api.bootstrapLimit, 3);
    assert.strictEqual(api.maxConsecutiveErrors, 3);
    assert.strictEqual(api.retryAfterMs, 60000);
    assert.strictEqual(api.nearEndPx, 600);
    assert.deepStrictEqual(api.stopStatuses, [429]);
});

test('EXT_CONFIG はぼかし対象ラベルを持つ', () => {
    assert.deepStrictEqual(
        EXT_CONFIG.mediaGrid.blurLabels,
        ['porn', 'sexual', 'nudity', 'graphic-media']
    );
});

test('ぼかし解除の設定は既定で無効 (従来どおりぼかす)', () => {
    const unblur = EXT_CONFIG.mediaGrid.unblur;
    assert.strictEqual(unblur.storageKey, 'nsfwUnblurEnabled');
    assert.strictEqual(unblur.defaultEnabled, false);
    assert.strictEqual(unblur.containerClass, 'ext-media-unblur');
    // グリッド表示の保存キーと衝突しないこと (別々に保存・監視するため)
    assert.notStrictEqual(unblur.storageKey, EXT_CONFIG.mediaGrid.storageKey);
});

test('橋渡しのイベント名と操作名が定義されている', () => {
    const bridge = EXT_CONFIG.mediaGrid.bridge;
    assert.strictEqual(bridge.requestEvent, 'ext:bridge-request');
    assert.strictEqual(bridge.resultEvent, 'ext:bridge-result');
    assert.strictEqual(bridge.actions.openLightbox, 'open-lightbox');
    assert.strictEqual(bridge.actions.switchTab, 'switch-tab');
    assert.strictEqual(bridge.timeoutMs, 15000);
});

test('profileTabs は Bluesky 本体と同じ順序で定義されている', () => {
    const names = EXT_CONFIG.profileTabs.map((t) => t.name);
    assert.deepStrictEqual(names, [
        'labels', 'listsForLabeler', 'posts', 'replies', 'media',
        'videos', 'likes', 'feeds', 'starterPacks', 'lists'
    ]);
});

test('デバッグモードは既定で無効', () => {
    const debug = EXT_CONFIG.debug;
    assert.strictEqual(debug.storageKey, 'debugEnabled');
    assert.strictEqual(debug.defaultEnabled, false);
    assert.strictEqual(debug.prefix, '[Bluesky拡張][debug]');
    assert.strictEqual(debug.stateAttribute, 'data-bsky-ext-state');
});

test('ポップアップの配色は既定でダーク', () => {
    assert.strictEqual(EXT_CONFIG.popup.themeStorageKey, 'popupTheme');
    assert.strictEqual(EXT_CONFIG.popup.defaultTheme, 'dark');
});

test('保存キーは互いに衝突しない', () => {
    const keys = [
        EXT_CONFIG.mediaGrid.storageKey,
        EXT_CONFIG.mediaGrid.unblur.storageKey,
        EXT_CONFIG.debug.storageKey,
        EXT_CONFIG.popup.themeStorageKey,
        EXT_CONFIG.lightboxPanel.storageKey,
        EXT_CONFIG.lightboxPanel.collapsedStorageKey
    ];
    assert.strictEqual(new Set(keys).size, keys.length);
});

test('ライトボックスのパネルは既定で有効', () => {
    const panel = EXT_CONFIG.lightboxPanel;
    assert.equal(typeof panel, 'object');
    assert.equal(panel.defaultEnabled, true);
    assert.equal(panel.defaultCollapsed, false);
});

test('ライトボックスのパネルは寸法と識別子を持つ', () => {
    const panel = EXT_CONFIG.lightboxPanel;
    assert.equal(panel.widthPx, 360);
    // SITE_SPEC.md 8.2 の gtMobile (minWidth: 800) に揃える
    assert.equal(panel.minWindowWidthPx, 800);
    // #ext-media-grid (9998) < #ext-nav-btn-container (9999) < パネル
    assert.ok(panel.zIndex > 9999);
    assert.equal(typeof panel.panelId, 'string');
    assert.equal(typeof panel.dialogSelector, 'string');
});

test('ライトボックスのパネルは投稿日時の書式を持つ', () => {
    const panel = EXT_CONFIG.lightboxPanel;
    assert.equal(panel.locale, 'ja-JP');
    assert.deepEqual(panel.dateFormat, {dateStyle: 'long', timeStyle: 'short'});
});

test('ライトボックスのパネルは facets の対応表を持つ', () => {
    const facets = EXT_CONFIG.lightboxPanel.facets;
    assert.equal(facets['app.bsky.richtext.facet#link'].kind, 'link');
    assert.equal(facets['app.bsky.richtext.facet#link'].valueKey, 'uri');
    assert.equal(facets['app.bsky.richtext.facet#mention'].kind, 'mention');
    assert.equal(facets['app.bsky.richtext.facet#mention'].valueKey, 'did');
    assert.equal(facets['app.bsky.richtext.facet#tag'].kind, 'tag');
    assert.equal(facets['app.bsky.richtext.facet#tag'].valueKey, 'tag');
});

test('本文中のリンクは http と https だけを押せるようにする', () => {
    // facets の uri は投稿者が自由に決められる値のため、scheme を絞る
    assert.deepEqual(EXT_CONFIG.lightboxPanel.allowedLinkProtocols, ['http:', 'https:']);
});

test('橋渡しはライトボックスの読み取りと閉じる操作を持つ', () => {
    const actions = EXT_CONFIG.mediaGrid.bridge.actions;
    assert.equal(actions.getLightbox, 'get-lightbox');
    assert.equal(actions.closeLightbox, 'close-lightbox');
});

test('橋渡しの遷移先は白名簿になっている', () => {
    const routes = EXT_CONFIG.mediaGrid.bridge.routes;
    // 2026-09-09 に実機で push() が成功することを確認した 3 つだけ
    assert.deepEqual(Object.values(routes).sort(), ['Hashtag', 'PostThread', 'Profile']);
});
