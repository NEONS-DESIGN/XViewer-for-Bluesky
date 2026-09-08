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
        EXT_CONFIG.popup.themeStorageKey
    ];
    assert.strictEqual(new Set(keys).size, keys.length);
});
