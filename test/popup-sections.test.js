import test from 'node:test';
import assert from 'node:assert';
import {EXT_CONFIG} from '../src/common/config.js';
import {ICON_SHAPES} from '../src/common/icon-shapes.js';
import {SECTIONS, TABS, ALL_FIELDS, THEME_TOGGLE, lockMessage} from '../src/popup/sections.js';

/** 項目 (role) と、その保存キー・既定値の出どころ (EXT_CONFIG) の対応表 */
const EXPECTED = {
	'media-grid': EXT_CONFIG.mediaGrid,
	'nsfw-unblur': EXT_CONFIG.mediaGrid.unblur,
	'lightbox-panel': EXT_CONFIG.lightboxPanel,
	'post-actions': EXT_CONFIG.postActions,
	'lightbox-replies': EXT_CONFIG.lightboxReplies,
	'lightbox-guard': EXT_CONFIG.lightboxGuard,
	'debug': EXT_CONFIG.debug
};

test('全項目の保存キーと既定値が EXT_CONFIG と一致する', () => {
	assert.strictEqual(ALL_FIELDS.length, 7);
	for (const f of ALL_FIELDS) {
		assert.ok(EXPECTED[f.role], `${f.role} が対応表に無い`);
		assert.strictEqual(f.key, EXPECTED[f.role].storageKey, `${f.role} の保存キー`);
		assert.strictEqual(f.defaultValue, EXPECTED[f.role].defaultEnabled, `${f.role} の既定値`);
		assert.strictEqual(typeof f.defaultValue, 'boolean');
	}
	assert.deepStrictEqual(new Set(ALL_FIELDS.map((f) => f.role)), new Set(Object.keys(EXPECTED)));
});

test('子の requires は親の key を指す', () => {
	const byRole = Object.fromEntries(ALL_FIELDS.map((f) => [f.role, f]));
	assert.strictEqual(byRole['nsfw-unblur'].requires, EXT_CONFIG.mediaGrid.storageKey);
	assert.strictEqual(byRole['post-actions'].requires, EXT_CONFIG.lightboxPanel.storageKey);
	// 親の children に入っていること (requires と入れ子の位置が食い違わない)
	assert.ok(byRole['media-grid'].children.includes(byRole['nsfw-unblur']));
	assert.ok(byRole['lightbox-panel'].children.includes(byRole['post-actions']));
	assert.strictEqual(byRole['lightbox-replies'].requires, EXT_CONFIG.lightboxPanel.storageKey);
	assert.ok(byRole['lightbox-panel'].children.includes(byRole['lightbox-replies']));
	// requires を持つ項目はすべて、実在する項目の key を指す
	const keys = new Set(ALL_FIELDS.map((f) => f.key));
	for (const f of ALL_FIELDS) {
		if (f.requires !== undefined) assert.ok(keys.has(f.requires), `${f.role} の requires が実在しない`);
	}
});

test('全項目に見出しと説明がある', () => {
	for (const f of ALL_FIELDS) {
		assert.ok(f.label.length > 0, `${f.role} の見出しが空`);
		assert.ok(f.description.length > 0, `${f.role} の説明が空`);
	}
});

test('セクションの並びと見出しは設計どおり', () => {
	assert.deepStrictEqual(
		SECTIONS.map((s) => [s.title, s.fields.map((f) => f.label)]),
		[
			['メディアグリッド', ['メディアグリッド表示']],
			['ライトボックス', ['投稿情報を表示', '画像のクリックで閉じない']],
			['開発者向け', ['デバッグモード']]
		]
	);
	// id は重ならない (要素の id の元にする)
	assert.strictEqual(new Set(SECTIONS.map((s) => s.id)).size, SECTIONS.length);
});

test('ALL_FIELDS は親の直後に子が並ぶ平らな一覧', () => {
	assert.deepStrictEqual(
		ALL_FIELDS.map((f) => f.role),
		['media-grid', 'nsfw-unblur', 'lightbox-panel', 'post-actions', 'lightbox-replies',
				'lightbox-guard', 'debug']
	);
});

test('タブは「設定」「ライセンス」の 2 枚', () => {
	assert.deepStrictEqual(TABS.map((t) => t.id), ['settings', 'license']);
	assert.deepStrictEqual(TABS.map((t) => t.label), ['設定', 'ライセンス']);
});

test('親が OFF の子を押したときの警告は親の見出しを名指しする', () => {
	assert.strictEqual(lockMessage('メディアグリッド表示'), '先に『メディアグリッド表示』をオンにしてください');
});

test('配色の切り替えは「押した結果」を持ち、往復して元へ戻る', () => {
	const {themes} = EXT_CONFIG.popup;
	assert.deepStrictEqual(Object.keys(THEME_TOGGLE), [themes.dark, themes.light]);
	assert.strictEqual(THEME_TOGGLE.dark.next, themes.light);
	assert.strictEqual(THEME_TOGGLE.light.next, themes.dark);
	for (const toggle of Object.values(THEME_TOGGLE)) {
		assert.ok(ICON_SHAPES[toggle.icon], `${toggle.icon} が ICON_SHAPES に無い`);
		assert.ok(toggle.label.length > 0);
	}
});

test('アイコンの図形データは Material Symbols の viewBox とパスを持つ', () => {
	for (const [name, shape] of Object.entries(ICON_SHAPES)) {
		assert.strictEqual(shape.viewBox, '0 -960 960 960', `${name} の viewBox が違う`);
		// 原本には M で始まるものと m で始まるものの両方がある。先頭の m は SVG 仕様で絶対座標として扱われる
		assert.ok(/^[Mm]/.test(shape.path), `${name} のパスが空か形式違い`);
	}
});
