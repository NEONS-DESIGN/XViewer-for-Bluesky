/**
 * bridge-client.js の callBridge の進み具合の扱い。
 * 同じ id の進み具合で待ち時間が延びること、別の id は無視すること、
 * 解決したら購読を外すことを偽の document で確かめる。
 */

import test from 'node:test';
import assert from 'node:assert';

import {BRIDGE_PROTOCOL} from '../src/common/bridge-protocol.js';
import {callBridge} from '../src/content/bridge-client.js';

/**
 * 型ごとに複数の購読を持てる偽の document を globalThis に置く。
 * @returns {{requests: Array, count: Function, fire: Function, restore: Function}}
 */
function installFakes() {
	const listeners = new Map();
	const requests = [];
	const saved = globalThis.document;
	globalThis.document = {
		addEventListener: (type, fn) => {
			if (!listeners.has(type)) {
				listeners.set(type, new Set());
			}
			listeners.get(type).add(fn);
		},
		removeEventListener: (type, fn) => {
			if (listeners.has(type)) {
				listeners.get(type).delete(fn);
			}
		},
		dispatchEvent: (event) => {
			requests.push(JSON.parse(event.detail));
			return true;
		}
	};
	return {
		requests,
		count: (type) => (listeners.has(type) ? listeners.get(type).size : 0),
		fire: (type, detail) => {
			for (const fn of [...(listeners.get(type) || [])]) {
				fn({detail: typeof detail === 'string' ? detail : JSON.stringify(detail)});
			}
		},
		restore: () => {
			globalThis.document = saved;
		}
	};
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PROGRESS = BRIDGE_PROTOCOL.progressEvent;
const RESULT = BRIDGE_PROTOCOL.resultEvent;

test('callBridge: idleTimeoutMs は同じ id の進み具合で延び、届かなければ timeout', async () => {
	const fakes = installFakes();
	try {
		const received = [];
		const promise = callBridge('x', {}, {
			idleTimeoutMs: 120,
			onProgress: (p) => received.push(p)
		});
		const id = fakes.requests[0].id;
		let settled = false;
		promise.then(() => {
			settled = true;
		});
		for (let i = 0; i < 3; i += 1) {
			await sleep(40);
			fakes.fire(PROGRESS, {id, phase: 'upload', progress: (i + 1) / 4});
		}
		assert.strictEqual(settled, false);
		assert.strictEqual(received.length, 3);
		assert.deepStrictEqual(received[2], {phase: 'upload', progress: 0.75});
		const result = await promise;
		assert.deepStrictEqual(result, {ok: false, reason: 'timeout'});
		// 打ち切った後に届いた進み具合は呼び出し側へ渡さない
		fakes.fire(PROGRESS, {id, phase: 'upload', progress: 1});
		assert.strictEqual(received.length, 3);
	} finally {
		fakes.restore();
	}
});

test('callBridge: 別の id の進み具合と解析できない detail は無視する', async () => {
	const fakes = installFakes();
	try {
		const received = [];
		const promise = callBridge('x', {}, {
			idleTimeoutMs: 100,
			onProgress: (p) => received.push(p)
		});
		const id = fakes.requests[0].id;
		fakes.fire(PROGRESS, {id: id + 1000, phase: 'upload', progress: 0.5});
		fakes.fire(PROGRESS, 'not json');
		assert.strictEqual(received.length, 0);
		fakes.fire(RESULT, {id, ok: true});
		assert.deepStrictEqual(await promise, {id, ok: true});
	} finally {
		fakes.restore();
	}
});

test('callBridge: 購読は document ごとに 1 本で、解決した要求には以後の応答を渡さない', async () => {
	const fakes = installFakes();
	try {
		const first = callBridge('x', {}, {idleTimeoutMs: 1000, onProgress: () => {}});
		const second = callBridge('y', {});
		const [a, b] = fakes.requests.map((request) => request.id);
		assert.strictEqual(fakes.count(RESULT), 1);
		assert.strictEqual(fakes.count(PROGRESS), 1);
		fakes.fire(RESULT, {id: b, ok: true, n: 2});
		fakes.fire(RESULT, {id: a, ok: true, n: 1});
		assert.deepStrictEqual(await first, {id: a, ok: true, n: 1});
		assert.deepStrictEqual(await second, {id: b, ok: true, n: 2});
		fakes.fire(RESULT, {id: a, ok: false});
		assert.strictEqual(fakes.count(RESULT), 1);
	} finally {
		fakes.restore();
	}
});
