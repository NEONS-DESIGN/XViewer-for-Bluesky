/**
 * メディアグリッドの描画層・制御層のうち、DOM の実物が無くても確かめられる分岐のテスト。
 * 状態表示の決め方 (gridStatus)、取得の 1 回が終わった後の進め方 (handleBatchEnd)、
 * 「さらに読み込む」、失敗後の再試行の予約、タイルの押下と読み込み失敗の振り分け、
 * scroll と body の監視の間引き。
 */
import test from 'node:test';
import assert from 'node:assert';
import {EXT_CONFIG} from '../src/common/config.js';
import {gridStatus, MediaGrid, MediaGridController} from '../src/content/media-grid.js';

const text = EXT_CONFIG.mediaGrid.text;

/** gridStatus の入力の既定 (何も起きていない状態) */
const base = {size: 0, failed: false, exhausted: false, finished: false, stalled: false};

/**
 * globalThis に一時的な値を差し込んで body を走らせ、必ず元に戻す。
 * @param {Object<string, *>} overrides
 * @param {() => (void|Promise<void>)} body
 * @returns {Promise<void>}
 */
async function withGlobals(overrides, body) {
	const saved = {};
	for (const [name, value] of Object.entries(overrides)) {
		saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
		Object.defineProperty(globalThis, name, {value, configurable: true, writable: true});
	}
	try {
		await body();
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
 * 呼ばれた順に控える偽の setTimeout。run() で控えた関数を実行する。
 * @returns {{setTimeout: Function, timers: Array<{fn: Function, ms: number}>, run: () => void}}
 */
function fakeTimers() {
	const timers = [];
	return {
		timers,
		setTimeout: (fn, ms) => {
			timers.push({fn, ms});
			return timers.length;
		},
		run: () => timers.splice(0).forEach(({fn}) => fn())
	};
}

test('gridStatus: 蓄積が空のとき', () => {
	assert.deepStrictEqual(gridStatus(base, text), {text: text.loading, loadMore: false});
	assert.deepStrictEqual(gridStatus({...base, failed: true}, text), {text: text.error, loadMore: false});
	assert.deepStrictEqual(gridStatus({...base, exhausted: true}, text), {text: text.empty, loadMore: false});
	// 動画だけのアカウントなどで中身 0 件のページが続いたら、空の表示と「さらに読み込む」
	assert.deepStrictEqual(gridStatus({...base, stalled: true}, text), {text: text.empty, loadMore: true});
	// 終端に着いたら続きは無いので、ボタンは出さない
	assert.deepStrictEqual(gridStatus({...base, stalled: true, exhausted: true}, text),
		{text: text.empty, loadMore: false});
});

test('gridStatus: 蓄積があるとき', () => {
	const some = {...base, size: 3};
	assert.deepStrictEqual(gridStatus(some, text), {text: text.loading, loadMore: false});
	assert.deepStrictEqual(gridStatus({...some, exhausted: true}, text), {text: text.end, loadMore: false});
	assert.deepStrictEqual(gridStatus({...some, finished: true}, text), {text: text.end, loadMore: false});
	assert.deepStrictEqual(gridStatus({...some, failed: true}, text), {text: text.error, loadMore: false});
	assert.deepStrictEqual(gridStatus({...some, stalled: true}, text), {text: text.stalled, loadMore: true});
});

/**
 * 取得や DOM に触る部分を差し替えた制御層を作る。
 * @returns {{controller: MediaGridController, calls: string[]}}
 */
function makeController() {
	const controller = new MediaGridController();
	const calls = [];
	controller.updateStatus = () => calls.push('status');
	controller.scheduleRetry = () => calls.push('retry');
	controller.scheduleFailedRetry = () => calls.push('failedRetry');
	controller.active = true;
	return {controller, calls};
}

test('handleBatchEnd: 中身 0 件のページが続いたら自動では読み進めない', () => {
	const {controller, calls} = makeController();
	controller.fetcher.emptyPageStreak = EXT_CONFIG.mediaGrid.api.emptyPageLimit;
	controller.handleBatchEnd();
	assert.deepStrictEqual(calls, ['status']);
});

test('handleBatchEnd: まだ 1 件も無く止まってもいなければ、間隔を空けて読み進める', () => {
	const {controller, calls} = makeController();
	controller.fetcher.emptyPageStreak = EXT_CONFIG.mediaGrid.api.emptyPageLimit - 1;
	controller.handleBatchEnd();
	assert.deepStrictEqual(calls, ['status', 'retry']);
});

test('handleBatchEnd: 失敗で止まったら再試行を予約する', () => {
	const {controller, calls} = makeController();
	controller.fetcher.failed = true;
	controller.handleBatchEnd();
	assert.deepStrictEqual(calls, ['status', 'failedRetry']);
});

test('handleNearEnd: 止まっている間は取得しない', () => {
	const {controller, calls} = makeController();
	controller.fetcher.emptyPageStreak = EXT_CONFIG.mediaGrid.api.emptyPageLimit;
	let fetched = 0;
	controller.fetcher.fetchNext = async () => { fetched += 1; };
	controller.handleNearEnd();
	assert.strictEqual(fetched, 0);
	assert.deepStrictEqual(calls, ['status']);
});

test('handleNearEnd: 失敗中で再試行できなければ予約だけする', () => {
	const {controller, calls} = makeController();
	controller.fetcher.failed = true;
	controller.fetcher.lastRunAt = Date.now();
	controller.handleNearEnd();
	assert.deepStrictEqual(calls, ['status', 'failedRetry']);
});

test('handleLoadMore: 数え直して、クールダウンの後に 1 ページだけ取る', async () => {
	const timers = fakeTimers();
	await withGlobals({window: {setTimeout: timers.setTimeout}}, () => {
		const {controller, calls} = makeController();
		controller.fetcher.emptyPageStreak = EXT_CONFIG.mediaGrid.api.emptyPageLimit;
		let fetched = 0;
		controller.fetcher.fetchNext = async () => { fetched += 1; };
		controller.handleLoadMore();
		assert.strictEqual(controller.fetcher.stalled, false);
		assert.deepStrictEqual(calls, ['status']);
		assert.strictEqual(fetched, 0, 'その場では撃たない');
		assert.strictEqual(timers.timers.length, 1);
		assert.strictEqual(timers.timers[0].ms, controller.fetcher.cooldownRemainingMs);
		timers.run();
		assert.strictEqual(fetched, 1);
	});
});

test('handleLoadMore: 止まっていなければ何もしない', async () => {
	const timers = fakeTimers();
	await withGlobals({window: {setTimeout: timers.setTimeout}}, () => {
		const {controller, calls} = makeController();
		controller.handleLoadMore();
		assert.deepStrictEqual(calls, []);
		assert.strictEqual(timers.timers.length, 0);
	});
});

test('scheduleFailedRetry: 予約は 1 本だけで、retryAfterMs の後に 1 回だけ末尾判定をやり直す', async () => {
	const timers = fakeTimers();
	await withGlobals({window: {setTimeout: timers.setTimeout}}, () => {
		const controller = new MediaGridController();
		controller.active = true;
		controller.fetcher.failed = true;
		controller.fetcher.lastRunAt = Date.now();
		let checked = 0;
		controller.grid.checkNearEnd = () => { checked += 1; };
		controller.scheduleFailedRetry();
		controller.scheduleFailedRetry();
		assert.strictEqual(timers.timers.length, 1, '二重に予約しない');
		assert.ok(timers.timers[0].ms > 0);
		assert.ok(timers.timers[0].ms <= EXT_CONFIG.mediaGrid.api.retryAfterMs, '待つのは retryAfterMs まで');

		// 時刻が来たことにする
		controller.fetcher.lastRunAt = Date.now() - EXT_CONFIG.mediaGrid.api.retryAfterMs - 1;
		timers.run();
		assert.strictEqual(checked, 1);
		assert.strictEqual(controller.failedRetryTimerId, null);
	});
});

test('scheduleFailedRetry: 待つ間に失敗が解けた・撤去されたら何もしない', async () => {
	const timers = fakeTimers();
	await withGlobals({window: {setTimeout: timers.setTimeout}}, () => {
		const controller = new MediaGridController();
		controller.active = true;
		controller.fetcher.failed = true;
		let checked = 0;
		controller.grid.checkNearEnd = () => { checked += 1; };
		controller.scheduleFailedRetry();
		controller.fetcher.failed = false;
		timers.run();
		assert.strictEqual(checked, 0);
	});
});

/**
 * closest() でタイルを返す押下の対象と、タイルを含む listEl を作る。
 * @returns {{grid: MediaGrid, tile: Object, target: Object}}
 */
function makeGridWithTile() {
	const grid = new MediaGrid();
	const tile = {removed: false, remove() { this.removed = true; }};
	grid.listEl = {contains: (node) => node === tile};
	tile.parentElement = grid.listEl;
	const target = {tagName: 'IMG', closest: (selector) => (selector === '.' + EXT_CONFIG.mediaGrid.tileClass ? tile : null)};
	return {grid, tile, target};
}

test('handleListClick: 押されたタイルの entry で handleTileClick を呼ぶ', () => {
	const {grid, tile, target} = makeGridWithTile();
	const entry = {key: 'a'};
	grid.tileEntries.set(tile, entry);
	const seen = [];
	grid.handleTileClick = (event, gotEntry, gotTile) => seen.push([gotEntry, gotTile]);
	grid.handleListClick({target});
	assert.deepStrictEqual(seen, [[entry, tile]]);
});

test('handleListClick: タイルの外・知らないタイルは無視する', () => {
	const {grid, tile} = makeGridWithTile();
	let called = 0;
	grid.handleTileClick = () => { called += 1; };
	grid.handleListClick({target: {closest: () => null}});
	grid.handleListClick({target: {closest: () => tile}});
	grid.handleListClick({target: null});
	assert.strictEqual(called, 0);
});

test('handleImageError: 読み込めない画像のタイルだけを除去する', () => {
	const {grid, tile, target} = makeGridWithTile();
	grid.handleImageError({target: {...target, tagName: 'SPAN'}});
	assert.strictEqual(tile.removed, false);
	grid.handleImageError({target});
	assert.strictEqual(tile.removed, true);
});

test('handleScroll: 末尾判定は 1 フレームに 1 回にまとめる', async () => {
	const frames = [];
	await withGlobals({
		window: {scrollY: 120},
		requestAnimationFrame: (fn) => {
			frames.push(fn);
			return frames.length;
		}
	}, () => {
		const grid = new MediaGrid();
		let checked = 0;
		grid.checkNearEnd = () => { checked += 1; };
		Object.defineProperty(grid, 'isMounted', {get: () => true});
		grid.handleScroll();
		grid.handleScroll();
		grid.handleScroll();
		assert.strictEqual(grid.getScrollTop(), 120, 'スクロール位置の控えは毎回更新する');
		assert.strictEqual(frames.length, 1);
		frames.shift()();
		assert.strictEqual(checked, 1);
		grid.handleScroll();
		assert.strictEqual(frames.length, 1, 'フレームが終われば次を予約できる');
	});
});

test('scheduleSync: body の監視からの sync() を 1 フレームに 1 回にまとめる', async () => {
	const frames = [];
	await withGlobals({
		requestAnimationFrame: (fn) => {
			frames.push(fn);
			return frames.length;
		}
	}, () => {
		const controller = new MediaGridController();
		let synced = 0;
		controller.sync = () => { synced += 1; };
		controller.scheduleSync();
		controller.scheduleSync();
		assert.strictEqual(frames.length, 1);
		frames.shift()();
		assert.strictEqual(synced, 1);
		controller.scheduleSync();
		assert.strictEqual(frames.length, 1);
	});
});

test('createMultiBadge: 雛形を 1 度だけ作り、写しを返す', async () => {
	let created = 0;
	/** @returns {Object} createIcon が使うだけの要素の代わり */
	const makeNode = () => ({
		attrs: {},
		children: [],
		classes: [],
		setAttribute(name, value) { this.attrs[name] = value; },
		appendChild(child) { this.children.push(child); },
		classList: null,
		cloneNode() { return {cloned: true, from: this}; }
	});
	await withGlobals({
		document: {
			createElementNS: () => {
				created += 1;
				const node = makeNode();
				node.classList = {add: (name) => node.classes.push(name)};
				return node;
			}
		}
	}, () => {
		const grid = new MediaGrid();
		const first = grid.createMultiBadge();
		const second = grid.createMultiBadge();
		assert.strictEqual(created, 2, 'svg と path を 1 回ずつ');
		assert.strictEqual(first.cloned, true);
		assert.strictEqual(first.from, second.from);
		assert.deepStrictEqual(first.from.classes, [EXT_CONFIG.mediaGrid.badgeClass]);
		assert.strictEqual(first.from.attrs.viewBox, '0 -960 960 960');
	});
});
