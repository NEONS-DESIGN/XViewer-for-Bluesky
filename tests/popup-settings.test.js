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

/**
 * 設定項目 (role) と、その保存キー・既定値の出どころ (EXT_CONFIG) の対応表。
 * 配列順が表示順。項目を足したらここに 1 行足す (SETTING_ITEMS と件数を突き合わせる)
 */
const EXPECTED_ITEMS = [
    {role: 'media-grid', source: EXT_CONFIG.mediaGrid},
    {role: 'nsfw-unblur', source: EXT_CONFIG.mediaGrid.unblur},
    {role: 'debug', source: EXT_CONFIG.debug},
    {role: 'lightbox-panel', source: EXT_CONFIG.lightboxPanel},
    {role: 'lightbox-guard', source: EXT_CONFIG.lightboxGuard},
    {role: 'post-actions', source: EXT_CONFIG.postActions}
];

test('設定項目は対応表と同じ件数・同じ順で、保存キーと既定値は EXT_CONFIG と一致する (二重に持たない)', () => {
    assert.deepStrictEqual(
        SETTING_ITEMS.map((item) => item.role),
        EXPECTED_ITEMS.map((expected) => expected.role)
    );
    EXPECTED_ITEMS.forEach((expected, index) => {
        const item = SETTING_ITEMS[index];
        assert.strictEqual(item.storageKey, expected.source.storageKey, `${expected.role} の保存キー`);
        assert.strictEqual(item.defaultValue, expected.source.defaultEnabled, `${expected.role} の既定値`);
        assert.strictEqual(typeof item.defaultValue, 'boolean', `${expected.role} の既定値の型`);
    });
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
        /*
         * Material Symbols の原本には M で始まるものと m で始まるものの両方が
         * 実在する。SVG 仕様では、小文字の m で始まるパスの最初の moveto は
         * 絶対座標として扱われるため、両方とも有効。M に揃えると、直後の
         * 暗黙 lineto が相対から絶対に変わり、図形が壊れる恐れがある
         */
        assert.ok(/^[Mm]/.test(shape.path), `${name} のパスが空か形式違い`);
    });
});
