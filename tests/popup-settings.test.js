const test = require('node:test');
const assert = require('node:assert');
const {EXT_CONFIG} = require('../config.js');

// popup.js はグローバルスクリプトとして書かれており、読み込み時点で
// EXT_CONFIG を参照する (SETTING_ITEMS の保存キーを config から引くため)。
// ブラウザでは config.js が先に読み込まれてグローバルに置かれるので、
// テストでも同じ状態を作ってから require する
global.EXT_CONFIG = EXT_CONFIG;

const {ICON_SHAPES} = require('../icon-shapes.js');
const {POPUP_THEMES, POPUP_THEME_TOGGLE, SETTING_ITEMS} = require('../popup.js');

test('設定項目は 3 件で、表示順が定義順どおり', () => {
    assert.deepStrictEqual(
        SETTING_ITEMS.map((item) => item.role),
        ['media-grid', 'nsfw-unblur', 'debug']
    );
});

test('設定項目の保存キーと既定値は EXT_CONFIG と一致する (二重に持たない)', () => {
    const byRole = Object.fromEntries(SETTING_ITEMS.map((item) => [item.role, item]));

    assert.strictEqual(byRole['media-grid'].storageKey, EXT_CONFIG.mediaGrid.storageKey);
    assert.strictEqual(byRole['media-grid'].defaultValue, EXT_CONFIG.mediaGrid.defaultEnabled);

    assert.strictEqual(byRole['nsfw-unblur'].storageKey, EXT_CONFIG.mediaGrid.unblur.storageKey);
    assert.strictEqual(byRole['nsfw-unblur'].defaultValue, EXT_CONFIG.mediaGrid.unblur.defaultEnabled);

    assert.strictEqual(byRole.debug.storageKey, EXT_CONFIG.debug.storageKey);
    assert.strictEqual(byRole.debug.defaultValue, EXT_CONFIG.debug.defaultEnabled);
});

test('設定項目にはすべて 1 行の説明が付いている', () => {
    SETTING_ITEMS.forEach((item) => {
        assert.ok(item.label.length > 0, `${item.role} のラベルが空`);
        assert.ok(item.description.length > 0, `${item.role} の説明が空`);
    });
});

test('設定項目のアイコン名は ICON_SHAPES に存在する', () => {
    SETTING_ITEMS.forEach((item) => {
        assert.ok(ICON_SHAPES[item.icon], `${item.icon} が ICON_SHAPES に無い`);
    });
});

test('配色の切り替えは「押した結果」を持ち、往復して元へ戻る', () => {
    assert.deepStrictEqual(Object.keys(POPUP_THEME_TOGGLE), ['dark', 'light']);
    assert.strictEqual(POPUP_THEME_TOGGLE.dark.next, POPUP_THEMES.light);
    assert.strictEqual(POPUP_THEME_TOGGLE.light.next, POPUP_THEMES.dark);
    // 既定の配色に対する定義が必ずあること (壊れた保存値をここへ倒すため)
    assert.ok(POPUP_THEME_TOGGLE[EXT_CONFIG.popup.defaultTheme]);
});

test('配色の切り替えアイコンは ICON_SHAPES に存在し、ラベルを持つ', () => {
    Object.values(POPUP_THEME_TOGGLE).forEach((toggle) => {
        assert.ok(ICON_SHAPES[toggle.icon], `${toggle.icon} が ICON_SHAPES に無い`);
        assert.ok(toggle.label.length > 0);
    });
});

test('アイコンの図形データは Material Symbols の viewBox とパスを持つ', () => {
    Object.entries(ICON_SHAPES).forEach(([name, shape]) => {
        assert.strictEqual(shape.viewBox, '0 -960 960 960', `${name} の viewBox が違う`);
        assert.ok(shape.path.startsWith('M'), `${name} のパスが空か形式違い`);
    });
});
