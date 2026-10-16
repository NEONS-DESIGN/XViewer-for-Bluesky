import test from 'node:test';
import assert from 'node:assert';
import {EXT_CONFIG} from '../src/common/config.js';
import {POPUP_TEXT} from '../src/popup/sections.js';
import {MANAGED_KEYS} from '../src/popup/settings-store.js';
import {main} from '../src/popup/app.js';

/**
 * chrome.storage.sync の偽物。
 * @param {Object<string, unknown>} initial 最初の値
 * @param {{failGet?: boolean, failSet?: boolean, failRemove?: boolean}} [faults] 失敗させる操作
 */
function fakeStorage(initial, faults = {}) {
	const data = {...initial};
	return {
		data,
		async get(keys) {
			if (faults.failGet) throw new Error('get');
			return Object.fromEntries(keys.filter((key) => key in data).map((key) => [key, data[key]]));
		},
		async set(items) {
			if (faults.failSet) throw new Error('set');
			Object.assign(data, items);
		},
		async remove(keys) {
			if (faults.failRemove) throw new Error('remove');
			for (const key of [keys].flat()) delete data[key];
		}
	};
}

/**
 * 描画を差し替えて main を走らせる。受け皿と描画の呼ばれ方を記録する。
 * @param {object} storage 保存領域
 * @param {{noRoot?: boolean}} [options]
 */
async function run(storage, {noRoot = false} = {}) {
	const focused = [];
	const root = {
		querySelector: (selector) => ({focus: () => focused.push(selector)})
	};
	const doc = {getElementById: (id) => (noRoot || id !== 'app' ? null : root)};
	const renders = [];
	const reports = [];
	await main({
		doc,
		storage,
		renderPopup: (args) => {
			renders.push(args);
			return {dispose: () => renders.at(-1) && (renders.at(-1).disposed = true), currentTab: () => 'settings'};
		},
		report: (...args) => reports.push(args)
	});
	return {renders, reports, focused, root};
}

/** console.error を黙らせて呼ぶ */
async function quietly(runner) {
	const original = console.error;
	console.error = () => {};
	try {
		return await runner();
	} finally {
		console.error = original;
	}
}

test('保存済みの値で 1 回描く', async () => {
	const {renders} = await run(fakeStorage({debugEnabled: true, popupTheme: 'light'}));
	assert.strictEqual(renders.length, 1);
	assert.strictEqual(renders[0].settings.theme, 'light');
	assert.strictEqual(renders[0].settings.values.debugEnabled, true);
	assert.strictEqual(renders[0].notice, null);
});

test('読み込みに失敗しても既定値で描き、通知を出す', async () => {
	const {renders} = await quietly(() => run(fakeStorage({}, {failGet: true})));
	assert.strictEqual(renders.length, 1);
	assert.strictEqual(renders[0].settings.values.mediaGridEnabled, true);
	assert.strictEqual(renders[0].notice, POPUP_TEXT.loadFailed);
});

test('受け皿が無ければ何も描かない', async () => {
	const {renders} = await run(fakeStorage({}), {noRoot: true});
	assert.strictEqual(renders.length, 0);
});

test('onChange は 1 項目を保存して成否を返す', async () => {
	const storage = fakeStorage({});
	const {renders} = await run(storage);
	assert.strictEqual(await renders[0].onChange(EXT_CONFIG.debug.storageKey, true), true);
	assert.strictEqual(storage.data.debugEnabled, true);

	const failing = await quietly(() => run(fakeStorage({}, {failSet: true})));
	assert.strictEqual(await quietly(() => failing.renders[0].onChange('debugEnabled', true)), false);
});

test('初期化: 扱うキーを消し、保存済みの値 (既定) で描き直し、設定タブのまま初期化ボタンへフォーカス', async () => {
	const storage = fakeStorage({debugEnabled: true, popupTheme: 'light', [EXT_CONFIG.lightboxPanel.collapsedStorageKey]: true});
	const {renders, focused} = await run(storage);
	await renders[0].onReset();
	for (const key of MANAGED_KEYS) assert.ok(!(key in storage.data), `${key} が残っている`);
	assert.strictEqual(storage.data[EXT_CONFIG.lightboxPanel.collapsedStorageKey], true);
	assert.strictEqual(renders.length, 2);
	assert.ok(renders[0].disposed, '前の画面を片付ける');
	assert.strictEqual(renders[1].settings.theme, 'system');
	assert.strictEqual(renders[1].settings.values.debugEnabled, false);
	assert.strictEqual(renders[1].initialTab, 'settings');
	assert.strictEqual(renders[1].notice, null);
	assert.deepStrictEqual(focused, ['[data-role="reset"]']);
});

test('初期化に失敗したら保存済みの値で描き直して通知を出す', async () => {
	const storage = fakeStorage({debugEnabled: true}, {failRemove: true});
	const {renders} = await run(storage);
	await quietly(() => renders[0].onReset());
	assert.strictEqual(renders.length, 2);
	assert.strictEqual(renders[1].settings.values.debugEnabled, true);
	assert.strictEqual(renders[1].notice, POPUP_TEXT.resetFailed);
});

test('描画が投げても report に記録して落ちない', async () => {
	const reports = [];
	await main({
		doc: {getElementById: () => ({})},
		storage: fakeStorage({}),
		renderPopup: () => {
			throw new Error('描画失敗');
		},
		report: (...args) => reports.push(args)
	});
	assert.strictEqual(reports.length, 1);
});
