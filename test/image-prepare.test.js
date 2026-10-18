/**
 * image-prepare.js の純関数。寸法の丸めと、品質・寸法を探る縮小の手順を確かめる。
 * 画像の読み込みと canvas への描画 (prepareImage) は DOM 依存のため実機で確認する。
 */

import test from 'node:test';
import assert from 'node:assert';

import { fitDimensions, compressToLimit, resolveSourceRect } from '../src/content/image-prepare.js';
import { EXT_CONFIG } from '../src/common/config.js';

const RULES = EXT_CONFIG.lightboxReplies.compose.image;

/** size = width * height * quality / 4 の大きさの Blob を返す偽の encode。呼び出しを記録する */
function makeEncode(calls) {
	return async (width, height, quality) => {
		calls.push({ width, height, quality });
		return new Blob([new Uint8Array(Math.floor(width * height * quality / 4))]);
	};
}

test('fitDimensions: 長辺を上限に収め、比を保つ', () => {
	assert.deepStrictEqual(fitDimensions(8000, 6000, 4000), { width: 4000, height: 3000 });
	assert.deepStrictEqual(fitDimensions(6000, 8000, 4000), { width: 3000, height: 4000 });
});

test('fitDimensions: 小さい画像は拡大しない', () => {
	assert.deepStrictEqual(fitDimensions(100, 50, 4000), { width: 100, height: 50 });
});

test('fitDimensions: 極端な比でも 1 未満にならない', () => {
	assert.deepStrictEqual(fitDimensions(10000, 1, 4000), { width: 4000, height: 1 });
});

test('fitDimensions: 常に 1 以上の整数を返す', () => {
	const sizes = [[7, 3], [10000, 1], [1, 10000], [3999.4, 0.4], [4001, 3], [1234, 5678], [0.2, 0.2]];
	for (const [w, h] of sizes) {
		const r = fitDimensions(w, h, 4000);
		assert.ok(Number.isInteger(r.width) && r.width >= 1, `width ${w}x${h} -> ${r.width}`);
		assert.ok(Number.isInteger(r.height) && r.height >= 1, `height ${w}x${h} -> ${r.height}`);
	}
});

test('compressToLimit: 最高品質で収まれば 1 回の encode で返す', async () => {
	const calls = [];
	const result = await compressToLimit(makeEncode(calls), { width: 1000, height: 1000 }, RULES);
	assert.strictEqual(calls.length, 1);
	assert.strictEqual(calls[0].quality, 1);
	assert.deepStrictEqual([result.width, result.height], [1000, 1000]);
});

test('compressToLimit: 二分探索で上限以下の最も高い品質に近づく', async () => {
	const calls = [];
	const result = await compressToLimit(makeEncode(calls), { width: 3000, height: 3000 }, RULES);
	assert.ok(result);
	assert.ok(result.blob.size <= RULES.maxBytes);
	// size = w * h * q / 4 が maxBytes に等しくなる品質
	const threshold = RULES.maxBytes * 4 / (3000 * 3000);
	const chosen = result.blob.size * 4 / (3000 * 3000);
	const tolerance = (1 - RULES.minQuality) / Math.pow(2, RULES.qualitySteps);
	assert.ok(chosen <= threshold);
	assert.ok(threshold - chosen <= tolerance, `${threshold} - ${chosen}`);
});

test('compressToLimit: 最低品質でも収まらない大きさでは辺を縮めて再試行する', async () => {
	// 品質ごとの大きさを 2 倍にして、最初の 2 段階では最低品質でも上限を超えさせる
	const encode = async (width, height, quality) => new Blob([new Uint8Array(Math.floor(width * height * quality * 2))]);
	const result = await compressToLimit(encode, { width: 4000, height: 3000 }, RULES);
	assert.ok(result);
	assert.ok(result.blob.size <= RULES.maxBytes);
	const expected = fitDimensions(4000 * Math.pow(RULES.scaleStep, 2), 3000 * Math.pow(RULES.scaleStep, 2), RULES.maxDimension);
	assert.deepStrictEqual({ width: result.width, height: result.height }, expected);
});

test('compressToLimit: 8000x6000 でも辺を縮めて上限以下になる', async () => {
	const calls = [];
	const result = await compressToLimit(makeEncode(calls), { width: 8000, height: 6000 }, RULES);
	assert.ok(result);
	assert.ok(result.blob.size <= RULES.maxBytes);
	assert.ok(Math.max(result.width, result.height) <= RULES.maxDimension);
});

test('compressToLimit: 収まらなければ null で、encode の回数に上限がある', async () => {
	const calls = [];
	const hopeless = async (width, height, quality) => {
		calls.push({ width, height, quality });
		return new Blob([new Uint8Array(RULES.maxBytes + 1)]);
	};
	const result = await compressToLimit(hopeless, { width: 8000, height: 6000 }, RULES);
	assert.strictEqual(result, null);
	assert.ok(calls.length <= (RULES.maxScaleRetries + 1) * (RULES.qualitySteps + 1));
});

test('compressToLimit: encode が null や例外でも落ちない', async () => {
	const nullEncode = async () => null;
	assert.strictEqual(await compressToLimit(nullEncode, { width: 100, height: 100 }, RULES), null);
	const throwing = async () => { throw new Error('encode failed'); };
	assert.strictEqual(await compressToLimit(throwing, { width: 100, height: 100 }, RULES), null);
});

test('resolveSourceRect: 大きさが 0 や数でなければ null', () => {
	assert.strictEqual(resolveSourceRect({ width: 0, height: 0 }, null), null);
	assert.strictEqual(resolveSourceRect({ width: 100, height: 0 }, null), null);
	assert.strictEqual(resolveSourceRect({ width: NaN, height: 100 }, null), null);
	assert.strictEqual(resolveSourceRect(null, null), null);
	assert.strictEqual(resolveSourceRect({ width: 100, height: 100 }, { x: 0, y: 0, width: 0, height: 50 }), null);
	assert.strictEqual(resolveSourceRect({ width: 100, height: 100 }, { x: 0, y: 0, width: NaN, height: 50 }), null);
});

test('resolveSourceRect: 切り抜きなしは全体', () => {
	assert.deepStrictEqual(resolveSourceRect({ width: 640, height: 480 }, null), { x: 0, y: 0, width: 640, height: 480 });
});

test('resolveSourceRect: 切り抜きを画像の内側に収めて整数にする', () => {
	assert.deepStrictEqual(
		resolveSourceRect({ width: 100, height: 100 }, { x: -10, y: -5.5, width: 50, height: 40 }),
		{ x: 0, y: 0, width: 40, height: 35 }
	);
	assert.deepStrictEqual(
		resolveSourceRect({ width: 100, height: 100 }, { x: 80.4, y: 10.2, width: 50, height: 20.5 }),
		{ x: 80, y: 10, width: 20, height: 21 }
	);
});

test('resolveSourceRect: 切り抜きが画像の外なら null', () => {
	assert.strictEqual(resolveSourceRect({ width: 100, height: 100 }, { x: 100, y: 0, width: 10, height: 10 }), null);
	assert.strictEqual(resolveSourceRect({ width: 100, height: 100 }, { x: -50, y: 0, width: 40, height: 10 }), null);
});
