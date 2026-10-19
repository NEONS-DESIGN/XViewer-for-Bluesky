/**
 * record-cid.js の確かめ。公式が作った投稿の CID と一致すること、
 * DAG-CBOR の決まり、TID の符号化を確かめる。
 */

import test from 'node:test';
import assert from 'node:assert';
import {readFileSync} from 'node:fs';

import {
	encodeDagCbor,
	computeRecordCid,
	encodeTid,
	decodeTid,
	nextTid,
} from '../src/content/record-cid.js';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/post-record-cids.json', import.meta.url), 'utf8'));

test('computeRecordCid: 実投稿 14 種の CID と一致する', async () => {
	assert.strictEqual(fixtures.length, 14);
	for (const entry of fixtures) {
		assert.strictEqual(await computeRecordCid(entry.record), entry.cid, entry.kind);
	}
});

test('encodeDagCbor: map のキーは UTF-8 の長さ → バイト列の順', () => {
	assert.deepStrictEqual(Array.from(encodeDagCbor({b: 1, aa: 2, a: 3})),
		[0xa3, 0x61, 0x61, 0x03, 0x61, 0x62, 0x01, 0x62, 0x61, 0x61, 0x02]);
});

test('encodeDagCbor: 整数の頭は最短の形', () => {
	const head = (n) => Array.from(encodeDagCbor(n));
	assert.deepStrictEqual(head(23), [0x17]);
	assert.deepStrictEqual(head(24), [0x18, 0x18]);
	assert.deepStrictEqual(head(255), [0x18, 0xff]);
	assert.deepStrictEqual(head(256), [0x19, 0x01, 0x00]);
	assert.deepStrictEqual(head(65535), [0x19, 0xff, 0xff]);
	assert.deepStrictEqual(head(65536), [0x1a, 0x00, 0x01, 0x00, 0x00]);
	assert.deepStrictEqual(head(2 ** 32), [0x1b, 0, 0, 0, 1, 0, 0, 0, 0]);
	assert.deepStrictEqual(head(-1), [0x20]);
	assert.deepStrictEqual(head(-25), [0x38, 0x18]);
});

test('encodeDagCbor: undefined のキーを落とし、$bytes はバイト列、$link はタグ 42', () => {
	assert.deepStrictEqual(encodeDagCbor({a: 1, b: undefined}), encodeDagCbor({a: 1}));
	assert.deepStrictEqual(Array.from(encodeDagCbor({$bytes: 'AQI='})), [0x42, 0x01, 0x02]);
	const link = Array.from(encodeDagCbor({$link: fixtures[0].cid}));
	assert.deepStrictEqual(link.slice(0, 5), [0xd8, 0x2a, 0x58, 0x25, 0x00]);
	assert.strictEqual(link.length, 5 + 36);
});

test('encodeDagCbor: 小数・関数・bigint は TypeError', () => {
	for (const bad of [1.5, NaN, () => {}, 10n]) assert.throws(() => encodeDagCbor(bad), TypeError);
});

test('TID: 公式が作った rkey を decode → encode で戻せ、時刻は createdAt と 1 分以内', () => {
	for (const entry of fixtures) {
		const rkey = entry.uri.slice(entry.uri.lastIndexOf('/') + 1);
		const decoded = decodeTid(rkey);
		assert.ok(decoded, rkey);
		assert.strictEqual(encodeTid(decoded.micros, decoded.clockId), rkey);
		assert.ok(Math.abs(decoded.micros / 1000 - Date.parse(entry.record.createdAt)) < 60000, rkey);
	}
});

test('TID: 13 文字・先頭は 234567a-j、時刻が戻っても前より大きい', () => {
	assert.strictEqual(encodeTid(0, 0), '2222222222222');
	const first = nextTid(null, 1760000000000000, 5);
	assert.match(first, /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/);
	const second = nextTid(first, 1700000000000000, 5);
	assert.ok(second > first);
	assert.strictEqual(decodeTid(second).micros, decodeTid(first).micros + 1);
	assert.strictEqual(decodeTid('bad'), null);
});

test('encodeDagCbor: base32 (b で始まる) でない $link は TypeError', () => {
	assert.throws(() => encodeDagCbor({$link: 'zQmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'}), TypeError);
	assert.throws(() => encodeDagCbor({$link: ''}), TypeError);
});
