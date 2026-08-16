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
