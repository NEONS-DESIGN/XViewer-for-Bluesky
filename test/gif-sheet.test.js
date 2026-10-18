/**
 * gif-sheet.js の GifSearch (間引き・古い応答の破棄・ページング・失敗と再試行) を確かめる。
 */

import test from 'node:test';
import assert from 'node:assert';

import {GifSearch} from '../src/content/gif-sheet.js';

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
		fetchJson: (url) => new Promise((resolve) => calls.push({url, resolve})),
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
	search.setQuery('');
	fire();
	assert.strictEqual(new URL(calls[1].url).pathname, '/v2/featured');
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
