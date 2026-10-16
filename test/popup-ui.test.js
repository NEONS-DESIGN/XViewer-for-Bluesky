import test from 'node:test';
import assert from 'node:assert';
import {EXT_CONFIG} from '../src/common/config.js';
import {ALL_FIELDS, POPUP_TEXT, lockMessage} from '../src/popup/sections.js';
import {renderPopup} from '../src/popup/popup-ui.js';
import {FakeDocument, click, pressKey} from './helpers/fake-dom.js';

/**
 * @param {string} role data-role
 * @returns {string} 選択子
 */
const byRole = (role) => `[data-role="${role}"]`;

/** 既定値の設定 (loadSettings の戻り値と同じ形) */
function defaultSettings(theme = 'system') {
	return {theme, values: Object.fromEntries(ALL_FIELDS.map((f) => [f.key, f.defaultValue]))};
}

/**
 * 描画して、呼ばれた onChange / onReset を記録する。
 * @param {object} [options]
 * @param {object} [options.settings] 設定
 * @param {(key: string, value: unknown) => Promise<boolean>} [options.save] onChange の結果
 * @param {boolean} [options.prefersLight] OS がライトか
 */
function setup({settings = defaultSettings(), save = async () => true, prefersLight = false, ...rest} = {}) {
	const doc = new FakeDocument({prefersLight});
	const root = doc.createElement('main');
	root.setAttribute('id', 'app');
	doc.body.append(root);
	const changes = [];
	let resets = 0;
	const screen = renderPopup({
		doc,
		root,
		settings,
		onChange: (key, value) => {
			changes.push([key, value]);
			return save(key, value);
		},
		onReset: () => {
			resets += 1;
		},
		...rest
	});
	return {doc, root, screen, changes, resets: () => resets};
}

/** 保留中の Promise の続きを流す */
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('セクション (h2)・項目 (h3)・スイッチが定義表どおりに並ぶ', () => {
	const {root} = setup();
	const panel = root.querySelector(byRole('panel-settings'));
	assert.deepStrictEqual(
		panel.querySelectorAll('h2').map((h) => h.textContent),
		['メディアグリッド', 'ライトボックス', '開発者向け']
	);
	assert.deepStrictEqual(
		panel.querySelectorAll('h3').map((h) => h.textContent),
		ALL_FIELDS.map((f) => f.label)
	);
	for (const f of ALL_FIELDS) {
		const input = root.querySelector(byRole(f.key));
		assert.ok(input, `${f.key} のスイッチが無い`);
		assert.strictEqual(input.getAttribute('role'), 'switch');
		assert.strictEqual(input.type, 'checkbox');
		assert.strictEqual(input.checked, f.defaultValue);
		// 説明と結び付いている
		const described = input.getAttribute('aria-describedby').split(' ');
		assert.ok(described.some((id) => root.querySelector(byRole(id))?.textContent === f.description));
	}
	assert.strictEqual(root.querySelector(byRole('disclaimer-brief')).textContent, 'Bluesky 公式の拡張機能ではありません。');
	assert.strictEqual(root.querySelector('h1').textContent, 'XViewer for Bluesky');
});

test('配色: 保存値が system なら OS に従って html[data-theme] を付ける', () => {
	assert.strictEqual(setup({prefersLight: true}).doc.documentElement.dataset.theme, 'light');
	assert.strictEqual(setup({prefersLight: false}).doc.documentElement.dataset.theme, 'dark');
	assert.strictEqual(setup({settings: defaultSettings('dark'), prefersLight: true}).doc.documentElement.dataset.theme, 'dark');
});

test('配色の切り替えは保存を待たずに反映し、ボタンのフォーカスを保つ', async () => {
	let finish;
	const {doc, root, changes} = setup({save: () => new Promise((resolve) => { finish = resolve; })});
	const button = root.querySelector(byRole('theme-toggle'));
	assert.strictEqual(button.getAttribute('aria-label'), 'ライトモードに切り替える');
	assert.strictEqual(button.title, 'ライトモードに切り替える');
	button.focus();
	click(button);
	assert.strictEqual(doc.documentElement.dataset.theme, 'light');
	assert.deepStrictEqual(changes, [[EXT_CONFIG.popup.themeStorageKey, 'light']]);
	assert.strictEqual(doc.activeElement, button);
	assert.ok(root.contains(button), 'ボタンを作り直していない');
	assert.strictEqual(button.getAttribute('aria-label'), 'ダークモードに切り替える');
	finish(true);
	await flush();
});

test('タブ: 選択は aria-selected と roving tabindex、左右・Home・End で動く', () => {
	const {doc, root} = setup();
	const list = root.querySelector('[role="tablist"]');
	const tabs = root.querySelectorAll('[role="tab"]');
	const settingsPanel = root.querySelector(byRole('panel-settings'));
	const licensePanel = root.querySelector(byRole('panel-license'));
	assert.deepStrictEqual(tabs.map((t) => t.textContent), ['設定', 'ライセンス']);
	assert.strictEqual(tabs[0].getAttribute('aria-controls'), settingsPanel.id);
	assert.strictEqual(settingsPanel.getAttribute('role'), 'tabpanel');
	assert.deepStrictEqual(tabs.map((t) => t.getAttribute('aria-selected')), ['true', 'false']);
	assert.deepStrictEqual(tabs.map((t) => t.getAttribute('tabindex')), ['0', '-1']);
	assert.strictEqual(licensePanel.hidden, true);

	const right = pressKey(tabs[0], 'ArrowRight');
	assert.ok(right.defaultPrevented);
	assert.deepStrictEqual(tabs.map((t) => t.getAttribute('aria-selected')), ['false', 'true']);
	assert.strictEqual(doc.activeElement, tabs[1]);
	assert.strictEqual(settingsPanel.hidden, true);
	assert.strictEqual(licensePanel.hidden, false);

	pressKey(tabs[1], 'ArrowRight');
	assert.strictEqual(doc.activeElement, tabs[0], '端で回り込む');
	pressKey(tabs[0], 'End');
	assert.strictEqual(doc.activeElement, tabs[1]);
	pressKey(tabs[1], 'Home');
	assert.strictEqual(doc.activeElement, tabs[0]);
	pressKey(tabs[0], 'ArrowLeft');
	assert.strictEqual(doc.activeElement, tabs[1]);

	// 関係ないキーは握りつぶさない
	assert.strictEqual(pressKey(list, 'a').defaultPrevented, false);
	click(tabs[0]);
	assert.strictEqual(settingsPanel.hidden, false);
});

test('スイッチを押すと 1 項目だけ保存し、成功したら通知を消す', async () => {
	const {root, changes} = setup({save: async () => true});
	const notice = root.querySelector(byRole('notice'));
	assert.strictEqual(notice.getAttribute('role'), 'alert');
	assert.strictEqual(notice.hidden, true);
	click(root.querySelector(byRole(EXT_CONFIG.debug.storageKey)));
	await flush();
	assert.deepStrictEqual(changes, [[EXT_CONFIG.debug.storageKey, true]]);
	assert.strictEqual(notice.hidden, true);
});

test('保存に失敗したら、その項目のスイッチだけを保存済みの値へ戻して通知を出し、次の成功で消す', async () => {
	let ok = false;
	const {root} = setup({save: async () => ok});
	const debug = root.querySelector(byRole(EXT_CONFIG.debug.storageKey));
	const guard = root.querySelector(byRole(EXT_CONFIG.lightboxGuard.storageKey));
	const notice = root.querySelector(byRole('notice'));

	click(debug);
	assert.strictEqual(debug.checked, true, '保存を待たずに見た目は変わる');
	await flush();
	assert.strictEqual(debug.checked, false, '保存済みの値へ戻る');
	assert.strictEqual(guard.checked, true, '他の項目は触らない');
	assert.strictEqual(notice.hidden, false);
	assert.strictEqual(notice.textContent, POPUP_TEXT.saveFailed);

	ok = true;
	click(guard);
	await flush();
	assert.strictEqual(guard.checked, false);
	assert.strictEqual(notice.hidden, true);
	assert.strictEqual(notice.textContent, '');
});

test('読み込み失敗などの通知を渡すと最初から出す', () => {
	const {root} = setup({notice: POPUP_TEXT.loadFailed});
	const notice = root.querySelector(byRole('notice'));
	assert.strictEqual(notice.hidden, false);
	assert.strictEqual(notice.textContent, POPUP_TEXT.loadFailed);
});

test('親が OFF の子はロックし、押すと警告を出して保存値を変えない', async () => {
	const settings = defaultSettings();
	settings.values[EXT_CONFIG.mediaGrid.storageKey] = false;
	settings.values[EXT_CONFIG.mediaGrid.unblur.storageKey] = true;
	const {root, changes} = setup({settings});
	const child = root.querySelector(byRole(EXT_CONFIG.mediaGrid.unblur.storageKey));
	const wrapper = root.querySelector(byRole('nsfw-unblur'));
	const warningId = `${EXT_CONFIG.mediaGrid.unblur.storageKey}-lock`;
	const warning = root.querySelector(byRole(warningId));

	assert.ok(wrapper.classList.contains('is-locked'));
	assert.strictEqual(child.getAttribute('aria-disabled'), 'true');
	assert.strictEqual(child.hasAttribute('disabled'), false, 'disabled にはしない (押して警告を出すため)');
	assert.strictEqual(warning.hidden, true);

	click(child);
	assert.strictEqual(child.checked, true, '切り替わらない');
	assert.deepStrictEqual(changes, []);
	assert.strictEqual(warning.hidden, false);
	assert.strictEqual(warning.textContent, lockMessage('メディアグリッド表示'));
	assert.ok(child.getAttribute('aria-describedby').split(' ').includes(warningId));

	// 親を ON にするとロックが外れ、警告も消える。子の値は元のまま
	click(root.querySelector(byRole(EXT_CONFIG.mediaGrid.storageKey)));
	assert.ok(!wrapper.classList.contains('is-locked'));
	assert.strictEqual(child.hasAttribute('aria-disabled'), false);
	assert.strictEqual(warning.hidden, true);
	assert.ok(!child.getAttribute('aria-describedby').split(' ').includes(warningId));
	assert.strictEqual(child.checked, true);
	await flush();
});

test('親の保存に失敗して OFF へ戻ったら、子もロックへ戻る', async () => {
	const settings = defaultSettings();
	settings.values[EXT_CONFIG.lightboxPanel.storageKey] = false;
	const {root} = setup({settings, save: async () => false});
	const wrapper = root.querySelector(byRole('post-actions'));
	click(root.querySelector(byRole(EXT_CONFIG.lightboxPanel.storageKey)));
	assert.ok(!wrapper.classList.contains('is-locked'));
	await flush();
	assert.ok(wrapper.classList.contains('is-locked'));
});

test('初期化: 確認の行を出し、やめる・Escape で戻り、初期化は 1 回だけ呼ぶ', () => {
	const {doc, root, resets} = setup();
	click(root.querySelector(byRole('reset')));
	const row = root.querySelector(byRole('reset-confirmation'));
	assert.ok(row);
	assert.strictEqual(row.getAttribute('role'), 'group');
	assert.strictEqual(row.getAttribute('aria-label'), 'すべての設定を既定に戻します。');
	const cancel = root.querySelector(byRole('reset-cancel'));
	const confirm = root.querySelector(byRole('reset-confirm'));
	assert.strictEqual(cancel.textContent, 'やめる');
	assert.strictEqual(confirm.textContent, '初期化する');
	assert.strictEqual(doc.activeElement, cancel, '開いた直後は「やめる」');

	pressKey(row, 'Escape');
	assert.strictEqual(root.querySelector(byRole('reset-confirmation')), null);
	assert.strictEqual(doc.activeElement, root.querySelector(byRole('reset')));

	click(root.querySelector(byRole('reset')));
	click(root.querySelector(byRole('reset-cancel')));
	assert.strictEqual(root.querySelector(byRole('reset-confirmation')), null);
	assert.strictEqual(resets(), 0);

	click(root.querySelector(byRole('reset')));
	const again = root.querySelector(byRole('reset-confirm'));
	click(again);
	click(again);
	assert.strictEqual(resets(), 1);
});

test('ライセンスタブ: この拡張機能 (MIT)・Material Symbols (Apache-2.0)・非公式の断り', () => {
	const {root} = setup();
	const text = root.querySelector(byRole('panel-license')).textContent;
	assert.match(text, /MIT License/);
	assert.match(text, /Copyright \(c\) 2026 NEONS/);
	assert.match(text, /Material Symbols/);
	assert.match(text, /Copyright 2023 Google LLC/);
	assert.match(text, /Apache License, Version 2\.0/);
	assert.match(text, /LICENSES\/Apache-2\.0\.txt/);
	assert.match(text, /公式/);
	for (const link of root.querySelector(byRole('panel-license')).querySelectorAll('a')) {
		assert.strictEqual(link.getAttribute('target'), '_blank');
		assert.strictEqual(link.getAttribute('rel'), 'noopener noreferrer');
	}
});

test('初期タブを渡すとそのタブで開く', () => {
	const {root, screen} = setup({initialTab: 'license'});
	assert.strictEqual(root.querySelector(byRole('panel-license')).hidden, false);
	assert.strictEqual(screen.currentTab(), 'license');
});

test('dispose で中身を片付ける', () => {
	const {root, screen} = setup();
	screen.dispose();
	assert.strictEqual(root.children.length, 0);
});
