/**
 * chrome.storage.onChanged で保存値が消えた (newValue が undefined) とき、
 * 各機能が既定値へ戻ることの検査。
 * ポップアップの「既定に戻す」は保存値を消すため、リスナーが undefined を
 * 既定値として扱えないと、画面は既定なのに実際の機能が前の値のまま残る。
 *
 * 検査するのは機能の状態 (enabled など) だけ。DOM に触る sync() は
 * 起動時に走らせても意味が無いので、コントローラの sync だけを空にしている。
 */
import test from 'node:test';
import assert from 'node:assert';

import {EXT_CONFIG} from '../src/common/config.js';
import {ExtDebug} from '../src/common/debug.js';
import {MediaGridController} from '../src/content/media-grid.js';
import {LightboxPanel} from '../src/content/lightbox-panel.js';
import {LightboxGuard} from '../src/content/lightbox-guard.js';

/** onChanged のエリア名。リスナーは 'sync' 以外を無視する */
const AREA = 'sync';

/**
 * 偽の chrome.storage を作る。onChanged のリスナーは捕まえておき、emit() で呼ぶ。
 * @param {Record<string, unknown>} stored sync.get が返す保存値
 * @returns {{storage: Object, emit: (changes: Object) => void}}
 */
function makeFakeStorage(stored) {
	const listeners = [];
	const storage = {
		sync: {get: async () => ({...stored})},
		onChanged: {addListener: (listener) => listeners.push(listener)}
	};
	return {
		storage,
		emit: (changes) => listeners.forEach((listener) => listener(changes, AREA))
	};
}

/**
 * 偽の chrome / document / window を差し込んで body を走らせ、必ず元に戻す。
 * document と window は、ライトボックスの探索と pagehide の登録が落ちない最小限だけ持つ
 * (ライトボックスは開いていない扱い)。
 * @param {Record<string, unknown>} stored 保存値
 * @param {(emit: (changes: Object) => void) => Promise<void>} body 検査本体
 * @returns {Promise<void>}
 */
async function withFakeChrome(stored, body) {
	const saved = {};
	const fake = makeFakeStorage(stored);
	const overrides = {
		chrome: {storage: fake.storage},
		document: {
			querySelectorAll: () => [],
			documentElement: {removeAttribute: () => {}}
		},
		window: {addEventListener: () => {}, removeEventListener: () => {}, innerWidth: 1920}
	};
	for (const [name, value] of Object.entries(overrides)) {
		saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
		Object.defineProperty(globalThis, name, {value, configurable: true, writable: true});
	}
	try {
		await body(fake.emit);
	} finally {
		for (const [name, descriptor] of Object.entries(saved)) {
			if (descriptor) {
				Object.defineProperty(globalThis, name, descriptor);
			} else {
				delete globalThis[name];
			}
		}
	}
}

/**
 * 保存値が消えた通知を作る。
 * @param {string} key 保存キー
 * @returns {Object} onChanged の changes
 */
function removed(key) {
	return {[key]: {oldValue: true, newValue: undefined}};
}

test('MediaGridController: グリッドの保存値が消えたら既定値に戻る', async () => {
	const cfg = EXT_CONFIG.mediaGrid;
	await withFakeChrome({[cfg.storageKey]: !cfg.defaultEnabled}, async (emit) => {
		const controller = new MediaGridController();
		// sync() はページの DOM を読むので、状態の検査には要らない
		controller.sync = () => {};
		await controller.init();
		assert.equal(controller.enabled, !cfg.defaultEnabled);
		emit(removed(cfg.storageKey));
		assert.equal(controller.enabled, cfg.defaultEnabled);
	});
});

test('MediaGridController: ぼかし解除の保存値が消えたら既定値に戻る', async () => {
	const cfg = EXT_CONFIG.mediaGrid.unblur;
	await withFakeChrome({[cfg.storageKey]: !cfg.defaultEnabled}, async (emit) => {
		const controller = new MediaGridController();
		controller.sync = () => {};
		await controller.init();
		assert.equal(controller.grid.unblurEnabled, !cfg.defaultEnabled);
		emit(removed(cfg.storageKey));
		assert.equal(controller.grid.unblurEnabled, cfg.defaultEnabled);
	});
});

test('LightboxPanel: パネルの保存値が消えたら既定値に戻る', async () => {
	const cfg = EXT_CONFIG.lightboxPanel;
	await withFakeChrome({[cfg.storageKey]: !cfg.defaultEnabled}, async (emit) => {
		const panel = new LightboxPanel(cfg);
		await panel.init();
		assert.equal(panel.enabled, !cfg.defaultEnabled);
		emit(removed(cfg.storageKey));
		assert.equal(panel.enabled, cfg.defaultEnabled);
	});
});

test('LightboxPanel: 投稿操作の保存値が消えたら既定値に戻る', async () => {
	const cfg = EXT_CONFIG.postActions;
	await withFakeChrome({[cfg.storageKey]: !cfg.defaultEnabled}, async (emit) => {
		const panel = new LightboxPanel(EXT_CONFIG.lightboxPanel);
		await panel.init();
		assert.equal(panel.actionsEnabled, !cfg.defaultEnabled);
		emit(removed(cfg.storageKey));
		assert.equal(panel.actionsEnabled, cfg.defaultEnabled);
	});
});

test('LightboxGuard: 保存値が消えたら既定値に戻る', async () => {
	const cfg = EXT_CONFIG.lightboxGuard;
	await withFakeChrome({[cfg.storageKey]: !cfg.defaultEnabled}, async (emit) => {
		const guard = new LightboxGuard(cfg);
		await guard.init();
		assert.equal(guard.enabled, !cfg.defaultEnabled);
		emit(removed(cfg.storageKey));
		assert.equal(guard.enabled, cfg.defaultEnabled);
	});
});

test('ExtDebug: 保存値が消えたら既定値に戻る', async () => {
	const cfg = EXT_CONFIG.debug;
	const before = ExtDebug.enabled;
	try {
		await withFakeChrome({[cfg.storageKey]: !cfg.defaultEnabled}, async (emit) => {
			await ExtDebug.init();
			assert.equal(ExtDebug.enabled, !cfg.defaultEnabled);
			emit(removed(cfg.storageKey));
			assert.equal(ExtDebug.enabled, cfg.defaultEnabled);
		});
	} finally {
		ExtDebug.enabled = before;
	}
});
