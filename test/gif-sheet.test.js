/**
 * gif-sheet.js の GifSearch (間引き・古い応答の破棄・ページング・失敗と再試行) を確かめる。
 */

import test from 'node:test';
import assert from 'node:assert';

import {GifSearch, openGifSheet} from '../src/content/gif-sheet.js';
import {SheetHost} from '../src/content/reply-sheets.js';
import {EXT_CONFIG} from '../src/common/config.js';
import {FakeDocument, FakeEvent} from './helpers/fake-dom.js';

const RULE = {
	origin: 'https://api.example.test',
	paths: {featured: '/v2/featured', search: '/v2/search'},
	clientKey: 'bluesky-web',
	limit: 30,
	contentFilter: 'low',
	debounceMs: 750,
	sourceHost: 'static.klipy.com',
	playerHost: 'k.gifs.bsky.app',
};

/**
 * Klipy 形式の応答を作る。
 * @param {string[]} ids
 * @param {string|null} next
 * @returns {Object}
 */
function response(ids, next) {
	return {
		results: ids.map((id) => ({
			id,
			title: `t${id}`,
			content_description: `d${id}`,
			media_formats: {
				gif: {url: `https://static.klipy.com/ii/${id}.gif`, dims: [100, 100]},
				tinygif: {url: `https://static.klipy.com/ii/${id}-t.gif`, dims: [50, 50]},
				preview: {url: `https://static.klipy.com/ii/${id}.jpg`, dims: [50, 50]},
			},
		})),
		next: next || '',
	};
}

/** 偽の timer と、応答を手で返せる fetchJson を作る。 */
function setup() {
	const timers = [];
	let nextId = 1;
	const calls = [];
	const states = [];
	const search = new GifSearch({
		fetchJson: (url, signal) => new Promise((resolve) => calls.push({url, signal, resolve})),
		rule: RULE,
		locale: 'ja',
		setTimer: (fn, ms) => {
			const id = nextId++;
			timers.push({id, fn, ms, live: true});
			return id;
		},
		clearTimer: (id) => {
			const timer = timers.find((entry) => entry.id === id);
			if (timer) timer.live = false;
		},
		onChange: (state) => states.push(state),
	});
	const fire = () => {
		for (const timer of timers) {
			if (timer.live) {
				timer.live = false;
				timer.fn();
			}
		}
	};
	return {search, timers, calls, states, fire};
}

/** マイクロタスクを流す。 */
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('GifSearch: 750ms 以内の連打は最後の 1 回だけ search を引く', async () => {
	const {search, timers, calls, fire} = setup();
	search.setQuery('ね');
	search.setQuery('ねこ');
	search.setQuery('ねこ！');
	assert.strictEqual(timers.filter((timer) => timer.live).length, 1);
	assert.strictEqual(timers.at(-1).ms, 750);
	assert.strictEqual(calls.length, 0);
	fire();
	assert.strictEqual(calls.length, 1);
	const url = new URL(calls[0].url);
	assert.strictEqual(url.pathname, '/v2/search');
	assert.strictEqual(url.searchParams.get('q'), 'ねこ！');
	assert.strictEqual(url.searchParams.get('locale'), 'ja');
	calls[0].resolve(response(['1'], null));
	await flush();
	assert.deepStrictEqual(search.state.items.map((item) => item.id), ['1']);
	assert.strictEqual(search.state.loading, false);
});

test('GifSearch: 空の問い合わせは featured を引く', async () => {
	const {search, calls, fire} = setup();
	search.start();
	assert.strictEqual(new URL(calls[0].url).pathname, '/v2/featured');
	calls[0].resolve(response(['1'], null));
	await flush();
	search.setQuery('x');
	fire();
	search.setQuery('');
	fire();
	assert.strictEqual(new URL(calls[2].url).pathname, '/v2/featured');
});

test('GifSearch: 今と同じ語 (前後の空白を除く) では引き直さず、失敗していれば引き直す', async () => {
	const {search, timers, calls, fire, states} = setup();
	search.setQuery(' ねこ ');
	fire();
	assert.strictEqual(new URL(calls[0].url).searchParams.get('q'), 'ねこ');
	calls[0].resolve(response(['1'], null));
	await flush();
	const count = states.length;
	search.setQuery('ねこ  ');
	assert.strictEqual(timers.filter((timer) => timer.live).length, 0, '同じ語では待たない');
	fire();
	assert.strictEqual(calls.length, 1);
	assert.strictEqual(states.length, count, '一覧を空にしない');
	assert.deepStrictEqual(search.state.items.map((item) => item.id), ['1']);
	// 別の語を打ちかけて元の語へ戻したときも、待っていた取得を取り消して引かない
	search.setQuery('ねこ！');
	search.setQuery('ねこ');
	fire();
	assert.strictEqual(calls.length, 1);
	search.setQuery('いぬ');
	fire();
	calls[1].resolve(null);
	await flush();
	assert.strictEqual(search.state.failed, true);
	search.setQuery('いぬ');
	fire();
	assert.strictEqual(calls.length, 3, '失敗した語は同じ語でも引き直す');
});

test('GifSearch: 新しい取得を始めると前の取得を打ち切り、destroy でも打ち切る', async () => {
	const {search, calls, fire} = setup();
	search.start();
	assert.ok(calls[0].signal, 'signal を渡す');
	assert.strictEqual(calls[0].signal.aborted, false);
	search.setQuery('a');
	fire();
	assert.strictEqual(calls[0].signal.aborted, true, '問い合わせを変えたら前の取得を打ち切る');
	assert.strictEqual(calls[1].signal.aborted, false);
	calls[1].resolve(response(['1'], 'P2'));
	await flush();
	search.loadMore();
	assert.strictEqual(calls[1].signal.aborted, false, '終わった取得は打ち切らない');
	search.destroy();
	assert.strictEqual(calls[2].signal.aborted, true, 'destroy で飛行中の取得を打ち切る');
});


test('GifSearch: 問い合わせを変えた後に届いた古い応答は捨てる', async () => {
	const {search, calls, fire} = setup();
	search.setQuery('a');
	fire();
	search.setQuery('b');
	fire();
	assert.strictEqual(calls.length, 2);
	calls[1].resolve(response(['b1'], null));
	await flush();
	calls[0].resolve(response(['a1'], 'N'));
	await flush();
	assert.deepStrictEqual(search.state.items.map((item) => item.id), ['b1']);
	assert.strictEqual(search.state.next, null);
	assert.strictEqual(search.state.query, 'b');
});

test('GifSearch: next が null なら loadMore は引かず、引いた分は items の後ろに足す', async () => {
	const {search, calls} = setup();
	search.start();
	calls[0].resolve(response(['1', '2'], 'P2'));
	await flush();
	search.loadMore();
	assert.strictEqual(new URL(calls[1].url).searchParams.get('pos'), 'P2');
	search.loadMore();
	assert.strictEqual(calls.length, 2, '読み込み中の loadMore は引かない');
	calls[1].resolve(response(['3'], null));
	await flush();
	assert.deepStrictEqual(search.state.items.map((item) => item.id), ['1', '2', '3']);
	search.loadMore();
	assert.strictEqual(calls.length, 2, 'next が null なら引かない');
});

test('GifSearch: 失敗したら failed、retry で同じ問い合わせを引き直す', async () => {
	const {search, calls, fire} = setup();
	search.setQuery('cat');
	fire();
	calls[0].resolve(null);
	await flush();
	assert.strictEqual(search.state.failed, true);
	assert.strictEqual(search.state.loading, false);
	search.retry();
	assert.strictEqual(calls.length, 2);
	assert.strictEqual(new URL(calls[1].url).searchParams.get('q'), 'cat');
	assert.strictEqual(search.state.failed, false);
	calls[1].resolve(response(['1'], null));
	await flush();
	assert.deepStrictEqual(search.state.items.map((item) => item.id), ['1']);
});

test('GifSearch: destroy の後は応答も timer も無視する', async () => {
	const {search, calls, fire, states} = setup();
	search.setQuery('a');
	fire();
	search.setQuery('b');
	search.destroy();
	fire();
	const count = states.length;
	calls[0].resolve(response(['1'], null));
	await flush();
	assert.strictEqual(calls.length, 1);
	assert.strictEqual(states.length, count);
});

test('GifSearch: loadMore が失敗した後、failed のままでは loadMore が引かず、retry の後は引ける', async () => {
	const {search, calls} = setup();
	search.start();
	calls[0].resolve(response(['1'], 'P2'));
	await flush();
	search.loadMore();
	calls[1].resolve(null);
	await flush();
	assert.strictEqual(search.state.failed, true);
	search.loadMore();
	assert.strictEqual(calls.length, 2, 'failed のあいだは引かない');
	search.retry();
	assert.strictEqual(calls.length, 3);
	assert.strictEqual(new URL(calls[2].url).searchParams.get('pos'), 'P2');
	calls[2].resolve(response(['2'], null));
	await flush();
	assert.deepStrictEqual(search.state.items.map((item) => item.id), ['1', '2']);
});

/**
 * GIF の画面をパネルに開く。timer は手で進める。
 * @param {(url: string, signal?: AbortSignal) => Promise<any>} fetchJson
 * @returns {{panel: object, host: SheetHost, input: object, status: object, fire: () => void, compose: object}}
 */
function openSheet(fetchJson) {
	const compose = EXT_CONFIG.lightboxReplies.compose;
	const doc = new FakeDocument();
	const timers = [];
	doc.defaultView = {
		...doc.defaultView,
		setTimeout: (fn) => timers.push(fn),
		clearTimeout: () => {},
		addEventListener: () => {},
		removeEventListener: () => {}
	};
	const panel = doc.createElement('aside');
	const opener = doc.createElement('button');
	panel.append(opener);
	doc.body.append(panel);
	const host = new SheetHost(panel, compose);
	openGifSheet(host, {fetchJson, locale: null, rule: RULE}, opener, () => {});
	const input = panel.querySelector(`.${compose.classes.gifSearch}`);
	const status = panel.querySelector(`.${compose.classes.gifStatus}`);
	const fire = () => timers.splice(0).forEach((fn) => fn());
	return {panel, host, input, status, fire, compose};
}

test('openGifSheet: 最初の取得中は「読み込み中」を出し、届いたら消す', async () => {
	let resolve = null;
	const {host, status, compose} = openSheet(() => new Promise((done) => { resolve = done; }));
	assert.strictEqual(status.hidden, false);
	assert.strictEqual(status.getAttribute('role'), 'status');
	assert.strictEqual(status.textContent, compose.text.gifLoading);
	resolve(response(['1'], 'P2'));
	await flush();
	assert.strictEqual(status.hidden, true);
	host.close(false);
});

test('openGifSheet: 変換中の入力では問い合わせず、確定 (compositionend) で問い合わせる', () => {
	const urls = [];
	const {host, input, fire} = openSheet((url) => {
		urls.push(url);
		return new Promise(() => {});
	});
	assert.strictEqual(urls.length, 1, '最初の featured');
	input.value = 'ねこ';
	const composing = new FakeEvent('input');
	composing.isComposing = true;
	input.dispatchEvent(composing);
	fire();
	assert.strictEqual(urls.length, 1, '変換中は問い合わせない');
	input.dispatchEvent(new FakeEvent('compositionend'));
	fire();
	assert.strictEqual(urls.length, 2);
	assert.strictEqual(new URL(urls[1]).searchParams.get('q'), 'ねこ');
	host.close(false);
});

test('openGifSheet: 閉じると飛行中の取得を打ち切る', () => {
	const signals = [];
	const {host} = openSheet((url, signal) => {
		signals.push(signal);
		return new Promise(() => {});
	});
	assert.strictEqual(signals[0].aborted, false);
	host.close(false);
	assert.strictEqual(signals[0].aborted, true);
});

test('openGifSheet: 開いたボタンに付く吹き出しで開き、検索欄を送られる部分の外 (上) に置く', () => {
	const compose = EXT_CONFIG.lightboxReplies.compose;
	const doc = new FakeDocument();
	const panel = doc.createElement('aside');
	const opener = doc.createElement('button');
	panel.append(opener);
	doc.body.append(panel);
	const host = new SheetHost(panel, compose);
	openGifSheet(host, {fetchJson: () => new Promise(() => {}), locale: null, rule: RULE}, opener, () => {});
	const layer = panel.querySelector(`[data-role="${compose.sheetRoles.layer}"]`);
	assert.ok(layer.classList.contains(compose.classes.popover));
	const body = layer.querySelector(`.${compose.classes.body}`);
	const [input, scroll] = body.children;
	assert.ok(input.classList.contains(compose.classes.gifSearch));
	assert.ok(scroll.classList.contains(compose.classes.gifScroll));
	assert.ok(scroll.querySelector(`.${compose.classes.gifGrid}`));
	assert.strictEqual(doc.activeElement, input);
	host.close(false);
});
