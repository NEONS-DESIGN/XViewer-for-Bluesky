import test from 'node:test';
import assert from 'node:assert';
import {EXT_CONFIG} from '../src/common/config.js';
import {ALL_FIELDS} from '../src/popup/sections.js';
import {loadSettings, saveSetting, resetSettings, MANAGED_KEYS} from '../src/popup/settings-store.js';
import {resolveTheme} from '../src/popup/popup-ui.js';

/**
 * chrome.storage.sync の偽物。get / set / remove だけを持つ。
 * @param {Object<string, unknown>} initial 最初に入っている値
 * @param {{failGet?: boolean, failSet?: boolean, failRemove?: boolean}} [faults] 失敗させる操作
 * @returns {{data: Object<string, unknown>, removed: string[], get: Function, set: Function, remove: Function}}
 */
function fakeStorage(initial, faults = {}) {
	const data = {...initial};
	const removed = [];
	return {
		data,
		removed,
		async get(keys) {
			if (faults.failGet) throw new Error('get に失敗');
			return Object.fromEntries(keys.filter((key) => key in data).map((key) => [key, data[key]]));
		},
		async set(items) {
			if (faults.failSet) throw new Error('set に失敗');
			Object.assign(data, items);
		},
		async remove(keys) {
			if (faults.failRemove) throw new Error('remove に失敗');
			for (const key of [keys].flat()) {
				removed.push(key);
				delete data[key];
			}
		}
	};
}

/** console.error を黙らせて呼ぶ (失敗の経路はログを出す) */
async function quietly(run) {
	const original = console.error;
	console.error = () => {};
	try {
		return await run();
	} finally {
		console.error = original;
	}
}

test('保存値が無ければ既定値を返す', async () => {
	const s = await loadSettings(fakeStorage({}));
	assert.strictEqual(s.theme, EXT_CONFIG.popup.defaultTheme);
	assert.strictEqual(s.failed, false);
	for (const f of ALL_FIELDS) assert.strictEqual(s.values[f.key], f.defaultValue);
});

test('保存値をそのまま読む', async () => {
	const s = await loadSettings(fakeStorage({popupTheme: 'light', debugEnabled: true, mediaGridEnabled: false}));
	assert.strictEqual(s.theme, 'light');
	assert.strictEqual(s.values.debugEnabled, true);
	assert.strictEqual(s.values.mediaGridEnabled, false);
});

test('壊れた保存値は既定へ倒す', async () => {
	const s = await loadSettings(fakeStorage({popupTheme: 'sepia', mediaGridEnabled: 'yes'}));
	assert.strictEqual(s.theme, 'system');
	assert.strictEqual(s.values.mediaGridEnabled, true);
});

test('get が投げても既定値と failed: true を返す', async () => {
	const s = await quietly(() => loadSettings(fakeStorage({debugEnabled: true}, {failGet: true})));
	assert.strictEqual(s.failed, true);
	assert.strictEqual(s.theme, EXT_CONFIG.popup.defaultTheme);
	for (const f of ALL_FIELDS) assert.strictEqual(s.values[f.key], f.defaultValue);
});

test('保存領域が無くても既定値と failed: true を返す', async () => {
	const s = await quietly(() => loadSettings(null));
	assert.strictEqual(s.failed, true);
	assert.strictEqual(s.values.mediaGridEnabled, true);
});

test('saveSetting は成否を真偽値で返し、投げない', async () => {
	const ok = fakeStorage({});
	assert.strictEqual(await saveSetting(ok, 'debugEnabled', true), true);
	assert.strictEqual(ok.data.debugEnabled, true);
	assert.strictEqual(await quietly(() => saveSetting(fakeStorage({}, {failSet: true}), 'debugEnabled', true)), false);
	assert.strictEqual(await quietly(() => saveSetting(null, 'debugEnabled', true)), false);
});

test('初期化は扱うキーだけを remove する', async () => {
	const storage = fakeStorage({});
	assert.strictEqual(await resetSettings(storage), true);
	assert.deepStrictEqual([...storage.removed].sort(), [...MANAGED_KEYS].sort());
	assert.strictEqual(MANAGED_KEYS.length, 7);
});

test('初期化は扱わないキー (パネルの畳み状態) を残す', async () => {
	const storage = fakeStorage({[EXT_CONFIG.lightboxPanel.collapsedStorageKey]: true, debugEnabled: true});
	await resetSettings(storage);
	assert.strictEqual(storage.data[EXT_CONFIG.lightboxPanel.collapsedStorageKey], true);
	assert.ok(!('debugEnabled' in storage.data));
});

test('MANAGED_KEYS は 6 項目の保存キーと配色の保存キー', () => {
	assert.deepStrictEqual(
		new Set(MANAGED_KEYS),
		new Set([...ALL_FIELDS.map((f) => f.key), EXT_CONFIG.popup.themeStorageKey])
	);
});

test('remove が投げたら false を返す', async () => {
	assert.strictEqual(await quietly(() => resetSettings(fakeStorage({}, {failRemove: true}))), false);
});

test('resolveTheme は保存値が system なら OS に従う', () => {
	assert.strictEqual(resolveTheme('system', {matchMedia: () => ({matches: true})}), 'light');
	assert.strictEqual(resolveTheme('system', {matchMedia: () => ({matches: false})}), 'dark');
	assert.strictEqual(resolveTheme('dark', {matchMedia: () => ({matches: true})}), 'dark');
	assert.strictEqual(resolveTheme('light', {matchMedia: () => ({matches: false})}), 'light');
});

test('resolveTheme は判定できない環境ではダークへ倒す', () => {
	assert.strictEqual(resolveTheme('system', undefined), 'dark');
	assert.strictEqual(resolveTheme('system', {matchMedia: () => { throw new Error('x'); }}), 'dark');
});
