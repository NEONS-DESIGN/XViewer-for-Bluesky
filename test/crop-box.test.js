/**
 * crop-box.js の純関数。切り抜きの枠の初期化・移動・角の変形・全体判定を確かめる。
 */

import test from 'node:test';
import assert from 'node:assert';

import {
	initialBox, moveBox, resizeBox, isFullImage, isValidImage, isUsableImage, isValidBox, isBoxInImage, matchAspect
} from '../src/content/crop-box.js';
import {openCropSheet} from '../src/content/crop-sheet.js';
import {SheetHost} from '../src/content/reply-sheets.js';
import {EXT_CONFIG} from '../src/common/config.js';
import {FakeDocument, click} from './helpers/fake-dom.js';

const IMAGE = {width: 4000, height: 3000};
const MIN = 32;

/**
 * 枠が画像の内側に収まっているか。
 * @param {{x: number, y: number, width: number, height: number}} b
 * @returns {boolean}
 */
function inside(b) {
	return b.x >= 0 && b.y >= 0 && b.x + b.width <= IMAGE.width && b.y + b.height <= IMAGE.height;
}

test('initialBox: 自由なら画像全体', () => {
	assert.deepStrictEqual(initialBox(IMAGE, null), {x: 0, y: 0, width: 4000, height: 3000});
});

test('initialBox: 4000x3000 に 1:1 は 3000x3000 で x=500', () => {
	assert.deepStrictEqual(initialBox(IMAGE, 1), {x: 500, y: 0, width: 3000, height: 3000});
});

test('initialBox: 縦長の比は高さいっぱいで中央', () => {
	const b = initialBox(IMAGE, 3 / 4);
	assert.strictEqual(b.height, 3000);
	assert.strictEqual(b.width, 2250);
	assert.strictEqual(b.x, 875);
});

test('initialBox: 横長の比は幅いっぱいで上下中央', () => {
	const b = initialBox({width: 1000, height: 1000}, 16 / 9);
	assert.strictEqual(b.width, 1000);
	assert.strictEqual(b.height, 562);
	assert.strictEqual(b.y, 219);
});

test('initialBox: 不正な画像の大きさは大きさ 0 の枠', () => {
	assert.deepStrictEqual(initialBox({width: 0, height: 10}, null), {x: 0, y: 0, width: 0, height: 0});
	assert.deepStrictEqual(initialBox({width: NaN, height: 10}, 1), {x: 0, y: 0, width: 0, height: 0});
});

test('moveBox: 通常の移動', () => {
	const box = {x: 100, y: 100, width: 500, height: 400};
	assert.deepStrictEqual(moveBox(box, 10, -20, IMAGE), {x: 110, y: 80, width: 500, height: 400});
});

test('moveBox: 右へ大きく動かしても画像の右端で止まる', () => {
	const box = {x: 100, y: 100, width: 500, height: 400};
	const moved = moveBox(box, 99999, 0, IMAGE);
	assert.strictEqual(moved.x, 3500);
	assert.strictEqual(moved.width, 500);
});

test('moveBox: 左上へ大きく動かしても 0 で止まる', () => {
	const moved = moveBox({x: 100, y: 100, width: 500, height: 400}, -99999, -99999, IMAGE);
	assert.strictEqual(moved.x, 0);
	assert.strictEqual(moved.y, 0);
});

test('moveBox: 小数の移動量は整数に丸める', () => {
	const moved = moveBox({x: 10, y: 10, width: 50, height: 50}, 0.4, 0.6, IMAGE);
	assert.ok(Number.isInteger(moved.x) && Number.isInteger(moved.y));
});

test('moveBox: NaN の移動量は入力の枠をそのまま返す', () => {
	const box = {x: 10, y: 10, width: 50, height: 50};
	assert.deepStrictEqual(moveBox(box, NaN, 5, IMAGE), box);
});

test('resizeBox: se を広げても画像の外へ出ない', () => {
	const box = {x: 1000, y: 1000, width: 500, height: 500};
	const r = resizeBox(box, 'se', 99999, 99999, IMAGE, null, MIN);
	assert.ok(inside(r));
	assert.deepStrictEqual(r, {x: 1000, y: 1000, width: 3000, height: 2000});
});

test('resizeBox: 1:1 を保つ', () => {
	const box = {x: 1000, y: 1000, width: 500, height: 500};
	const r = resizeBox(box, 'se', 200, 50, IMAGE, 1, MIN);
	assert.strictEqual(r.width, r.height);
	assert.strictEqual(r.x, 1000);
	assert.strictEqual(r.y, 1000);
});

test('resizeBox: 比があっても画像の外へ出ない', () => {
	const box = {x: 1000, y: 1000, width: 500, height: 500};
	for (const corner of ['nw', 'ne', 'sw', 'se']) {
		const r = resizeBox(box, corner, 99999, 99999, IMAGE, 16 / 9, MIN);
		assert.ok(inside(r), corner);
		const r2 = resizeBox(box, corner, -99999, -99999, IMAGE, 16 / 9, MIN);
		assert.ok(inside(r2), corner);
	}
});

test('resizeBox: 4:3 は丸めの範囲で保つ', () => {
	const box = {x: 100, y: 100, width: 400, height: 300};
	const r = resizeBox(box, 'se', 80, 0, IMAGE, 4 / 3, MIN);
	assert.ok(Math.abs(r.width / r.height - 4 / 3) < 0.01);
});

test('resizeBox: minSize より小さくならない (自由)', () => {
	const box = {x: 1000, y: 1000, width: 500, height: 500};
	const r = resizeBox(box, 'se', -99999, -99999, IMAGE, null, MIN);
	assert.strictEqual(r.width, MIN);
	assert.strictEqual(r.height, MIN);
});

test('resizeBox: minSize より小さくならない (比あり)', () => {
	const box = {x: 1000, y: 1000, width: 500, height: 500};
	const r = resizeBox(box, 'se', -99999, -99999, IMAGE, 16 / 9, MIN);
	assert.ok(r.width >= MIN && r.height >= MIN);
});

test('resizeBox: nw を動かしても se の角が動かない', () => {
	const box = {x: 1000, y: 1000, width: 500, height: 400};
	for (const [dx, dy] of [[-300, -200], [100, 50], [-99999, -99999], [99999, 99999]]) {
		const r = resizeBox(box, 'nw', dx, dy, IMAGE, null, MIN);
		assert.strictEqual(r.x + r.width, 1500);
		assert.strictEqual(r.y + r.height, 1400);
	}
});

test('resizeBox: 各角で反対の角が動かない (比あり)', () => {
	const box = {x: 1000, y: 1000, width: 500, height: 500};
	const anchors = {nw: [1500, 1500], ne: [1000, 1500], sw: [1500, 1000], se: [1000, 1000]};
	for (const corner of Object.keys(anchors)) {
		const r = resizeBox(box, corner, 37, -41, IMAGE, 1, MIN);
		const ax = corner.includes('w') ? r.x + r.width : r.x;
		const ay = corner.includes('n') ? r.y + r.height : r.y;
		assert.deepStrictEqual([ax, ay], anchors[corner], corner);
	}
});

test('resizeBox: 画像が minSize より小さくても投げず画像内に収める', () => {
	const tiny = {width: 20, height: 20};
	const r = resizeBox({x: 0, y: 0, width: 10, height: 10}, 'se', 5, 5, tiny, 1, MIN);
	assert.ok(r.x + r.width <= 20 && r.y + r.height <= 20);
});

test('resizeBox: 不正な入力は入力の枠を返す', () => {
	const box = {x: 10, y: 10, width: 50, height: 50};
	assert.deepStrictEqual(resizeBox(box, 'se', NaN, 0, IMAGE, null, MIN), box);
	assert.deepStrictEqual(resizeBox(box, 'se', 1, 1, {width: 0, height: 0}, null, MIN), box);
	assert.deepStrictEqual(resizeBox(box, 'xx', 1, 1, IMAGE, null, MIN), box);
});

test('isFullImage: 全体なら真、1 画素でも欠ければ偽', () => {
	assert.strictEqual(isFullImage({x: 0, y: 0, width: 4000, height: 3000}, IMAGE), true);
	assert.strictEqual(isFullImage({x: 1, y: 0, width: 3999, height: 3000}, IMAGE), false);
	assert.strictEqual(isFullImage({x: 0, y: 0, width: 3999, height: 3000}, IMAGE), false);
	assert.strictEqual(isFullImage({x: 0, y: 0, width: 4000, height: 2999}, IMAGE), false);
});

test('resizeBox: 比ありで dx だけ縮めると縮む', () => {
	const box = {x: 100, y: 100, width: 400, height: 300};
	const r = resizeBox(box, 'se', -8, 0, IMAGE, 4 / 3, MIN);
	assert.ok(r.width < 400 && r.height < 300);
	assert.deepStrictEqual([r.x, r.y], [100, 100]);
});

test('resizeBox: 比ありで dy だけ縮めると縮む', () => {
	const box = {x: 100, y: 100, width: 400, height: 300};
	const r = resizeBox(box, 'se', 0, -9, IMAGE, 4 / 3, MIN);
	assert.ok(r.width < 400 && r.height < 300);
});

test('resizeBox: 比ありで大きい動きが内向きなら逆向きの小さい動きがあっても縮む', () => {
	const box = {x: 100, y: 100, width: 400, height: 300};
	const r = resizeBox(box, 'se', -50, 10, IMAGE, 4 / 3, MIN);
	assert.ok(r.width < 400 && r.height < 300);
});

test('resizeBox: 比ありで大きい動きが外向きなら拡がる', () => {
	const box = {x: 100, y: 100, width: 400, height: 300};
	const r = resizeBox(box, 'se', 50, -10, IMAGE, 4 / 3, MIN);
	assert.ok(r.width > 400 && r.height > 300);
});

test('resizeBox: 比ありで各角を画像の端まで拡げても内側に止まり反対の角が動かない', () => {
	const box = {x: 1000, y: 1000, width: 400, height: 300};
	const anchors = {nw: [1400, 1300], ne: [1000, 1300], sw: [1400, 1000], se: [1000, 1000]};
	for (const corner of Object.keys(anchors)) {
		const sx = corner.includes('e') ? 1 : -1;
		const sy = corner.includes('s') ? 1 : -1;
		const r = resizeBox(box, corner, sx * 99999, sy * 99999, IMAGE, 4 / 3, MIN);
		assert.ok(inside(r), corner);
		const ax = corner.includes('w') ? r.x + r.width : r.x;
		const ay = corner.includes('n') ? r.y + r.height : r.y;
		assert.deepStrictEqual([ax, ay], anchors[corner], corner);
		assert.ok(r.width > 400, corner);
	}
});

test('resizeBox: 各角で複数の移動量でも反対の角が動かず比を保つ', () => {
	for (const ratio of [16 / 9, 3 / 4, 4 / 3]) {
		const base = initialBox({width: 600, height: 600}, ratio);
		const b = {x: 1000, y: 1000, width: base.width, height: base.height};
		const anc = {nw: [b.x + b.width, b.y + b.height], ne: [b.x, b.y + b.height], sw: [b.x + b.width, b.y], se: [b.x, b.y]};
		for (const corner of Object.keys(anc)) {
			for (const [dx, dy] of [[37, -41], [-60, 25], [120, 90]]) {
				const r = resizeBox(b, corner, dx, dy, IMAGE, ratio, MIN);
				const ax = corner.includes('w') ? r.x + r.width : r.x;
				const ay = corner.includes('n') ? r.y + r.height : r.y;
				assert.deepStrictEqual([ax, ay], anc[corner], corner + dx);
				assert.ok(Math.abs(r.width / r.height - ratio) < 0.02, ratio + corner);
			}
		}
	}
});

test('isValidImage / isUsableImage: 有限の正数か、1 画素以上か', () => {
	assert.strictEqual(isValidImage({width: 0.5, height: 2}), true);
	assert.strictEqual(isUsableImage({width: 0.5, height: 2}), false);
	assert.strictEqual(isUsableImage({width: 1, height: 1}), true);
	assert.strictEqual(isUsableImage({width: Infinity, height: 10}), false);
	assert.strictEqual(isUsableImage(undefined), false);
	assert.strictEqual(isValidImage(null), false);
});

test('isValidBox / isBoxInImage: 4 値が有限で、画像の中に収まる大きさのある枠か', () => {
	assert.strictEqual(isValidBox({x: 0, y: 0, width: NaN, height: 1}), false);
	assert.strictEqual(isBoxInImage({x: 0, y: 0, width: 4000, height: 3000}, IMAGE), true);
	assert.strictEqual(isBoxInImage({x: 1, y: 0, width: 4000, height: 3000}, IMAGE), false);
	assert.strictEqual(isBoxInImage({x: 0, y: 0, width: 0, height: 10}, IMAGE), false);
	assert.strictEqual(isBoxInImage({x: -1, y: 0, width: 10, height: 10}, IMAGE), false);
	assert.strictEqual(isBoxInImage(null, IMAGE), false);
});

const ASPECTS = EXT_CONFIG.lightboxReplies.compose.crop.aspects;

test('matchAspect: 比で作った枠には、その比を選ぶ (丸めの 1 画素は許す)', () => {
	for (const aspect of ASPECTS.filter((one) => one.ratio)) {
		assert.strictEqual(matchAspect(initialBox(IMAGE, aspect.ratio), ASPECTS), aspect, aspect.id);
		const resized = resizeBox(initialBox(IMAGE, aspect.ratio), 'se', -517, -233, IMAGE, aspect.ratio, MIN);
		assert.strictEqual(matchAspect(resized, ASPECTS), aspect, `${aspect.id} を変形した後`);
	}
});

test('matchAspect: どの比にも当てはまらなければ自由、不正な枠でも自由', () => {
	const free = ASPECTS.find((one) => one.ratio === null);
	assert.strictEqual(matchAspect({x: 0, y: 0, width: 1000, height: 300}, ASPECTS), free);
	assert.strictEqual(matchAspect({x: 0, y: 0, width: 0, height: 300}, ASPECTS), free);
	assert.strictEqual(matchAspect(null, ASPECTS), free);
	assert.strictEqual(matchAspect({x: 0, y: 0, width: 10, height: 10}, []), undefined);
});

/**
 * 切り抜きの画面を開き、比のボタンの押下状態を返す。
 * @param {{x: number, y: number, width: number, height: number}|null} crop 今の切り抜き
 * @returns {{pressed: string|undefined, host: SheetHost, buttons: object[]}}
 */
function openCropWith(crop) {
	const compose = EXT_CONFIG.lightboxReplies.compose;
	const doc = new FakeDocument();
	doc.defaultView = {...doc.defaultView, URL: {createObjectURL: () => 'blob:x', revokeObjectURL: () => {}}};
	// 偽の DOM は style を持たないため、枠の位置を書き込める入れ物を足す
	const create = doc.createElement.bind(doc);
	doc.createElement = (tagName) => Object.assign(create(tagName), {style: {}});
	const panel = doc.createElement('aside');
	const opener = doc.createElement('button');
	panel.append(opener);
	doc.body.append(panel);
	const host = new SheetHost(panel, compose);
	openCropSheet(host, {source: {}, image: IMAGE, crop}, opener, () => {});
	const buttons = panel.querySelectorAll(`.${compose.classes.cropAspect}`);
	const pressed = buttons.find((button) => button.getAttribute('aria-pressed') === 'true');
	return {pressed: pressed && pressed.textContent, host, buttons};
}

test('openCropSheet: 開き直すと、前の枠に当てはまる比のボタンを選んだ状態で開く', () => {
	const names = EXT_CONFIG.lightboxReplies.compose.text.aspectNames;
	assert.strictEqual(openCropWith(initialBox(IMAGE, 1)).pressed, names['1:1']);
	assert.strictEqual(openCropWith(initialBox(IMAGE, 16 / 9)).pressed, names['16:9']);
	assert.strictEqual(openCropWith({x: 10, y: 10, width: 1000, height: 300}).pressed, names.free);
	assert.strictEqual(openCropWith(null).pressed, names.free);
});

test('openCropSheet: 「元に戻す」で自由に戻る', () => {
	const {host, buttons} = openCropWith(initialBox(IMAGE, 1));
	const names = EXT_CONFIG.lightboxReplies.compose.text.aspectNames;
	const panel = host.panelEl;
	const reset = panel.querySelectorAll('button').find((button) => button.textContent === EXT_CONFIG.lightboxReplies.compose.text.cropReset);
	click(reset);
	const pressed = buttons.find((button) => button.getAttribute('aria-pressed') === 'true');
	assert.strictEqual(pressed.textContent, names.free);
	host.close(false);
});
