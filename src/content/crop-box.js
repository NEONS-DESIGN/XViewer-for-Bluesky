/**
 * 切り抜きの枠の計算 (純関数)。
 * 枠は元の画像の画素で表し、結果はすべて整数に丸める (後段の切り抜きで
 * 丸め直しても変わらない)。**DOM も config も知らない。** 縦横比・最小の辺は引数で受け取る。
 */

/** @typedef {import('./image-prepare.js').CropRect} CropRect */

/** 画像の大きさ */
/** @typedef {{width: number, height: number}} ImageSize */

/** 角の名前と、その角が動く向き (x は東が正、y は南が正) */
const CORNER_DIRECTIONS = {
	nw: {sx: -1, sy: -1},
	ne: {sx: 1, sy: -1},
	sw: {sx: -1, sy: 1},
	se: {sx: 1, sy: 1}
};

/**
 * 画像の大きさが使えるか (幅・高さが有限の正数)。
 * @param {ImageSize} image
 * @returns {boolean}
 */
function isValidImage(image) {
	return !!image && Number.isFinite(image.width) && Number.isFinite(image.height)
		&& image.width > 0 && image.height > 0;
}

/**
 * 枠の 4 値がすべて有限の数か。
 * @param {CropRect} box
 * @returns {boolean}
 */
function isValidBox(box) {
	return !!box && [box.x, box.y, box.width, box.height].every(Number.isFinite);
}

/**
 * 値を範囲に収める。上限が下限より小さければ上限を優先する。
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
	return Math.min(max, Math.max(min, value));
}

/**
 * 比が使えるか (有限の正数)。
 * @param {number|null} ratio
 * @returns {boolean}
 */
function hasRatio(ratio) {
	return Number.isFinite(ratio) && ratio > 0;
}

/**
 * 切り抜きの枠の初期値。比が無ければ画像全体、あれば中央に入る最大の枠。
 * 端数は切り捨てて整数にする。画像の大きさが不正なら大きさ 0 の枠を返す。
 * @param {ImageSize} image
 * @param {number|null} ratio 幅 / 高さ。null は自由
 * @returns {CropRect}
 */
export function initialBox(image, ratio) {
	if (!isValidImage(image)) return {x: 0, y: 0, width: 0, height: 0};
	const imageWidth = Math.floor(image.width);
	const imageHeight = Math.floor(image.height);
	if (!hasRatio(ratio)) return {x: 0, y: 0, width: imageWidth, height: imageHeight};
	let width = Math.min(imageWidth, Math.floor(imageHeight * ratio));
	let height = Math.min(imageHeight, Math.floor(width / ratio));
	width = Math.max(1, width);
	height = Math.max(1, height);
	return {
		x: Math.floor((imageWidth - width) / 2),
		y: Math.floor((imageHeight - height) / 2),
		width,
		height
	};
}

/**
 * 枠を動かす。画像からはみ出さないよう端で止め、位置は整数に丸める。
 * 入力が不正 (NaN の移動量・画像の大きさが不正) なら入力の枠をそのまま返す。
 * @param {CropRect} box
 * @param {number} dx
 * @param {number} dy
 * @param {ImageSize} image
 * @returns {CropRect}
 */
export function moveBox(box, dx, dy, image) {
	if (!isValidBox(box) || !isValidImage(image) || !Number.isFinite(dx) || !Number.isFinite(dy)) return box;
	return {
		x: clamp(Math.round(box.x + dx), 0, Math.max(0, Math.floor(image.width - box.width))),
		y: clamp(Math.round(box.y + dy), 0, Math.max(0, Math.floor(image.height - box.height))),
		width: box.width,
		height: box.height
	};
}

/**
 * 角をつかんで枠を変形する。反対の角を固定し、比があれば保つ。
 * 画像からはみ出さず minSize を下回らない (画像側の余地が足りないときは入る最大の枠)。
 * 比ありのときは幅・高さのうち大きく動いた側に合わせ、幅を整数に丸めてから高さを求める。
 * 入力の枠は整数とする。比ありで枠が小さいときは、丸めのため比から最大 1 画素ずれることがある。
 * 入力が不正 (未知の角・NaN の移動量・画像の大きさが不正) なら入力の枠をそのまま返す。
 * @param {CropRect} box
 * @param {'nw'|'ne'|'sw'|'se'} corner
 * @param {number} dx 角の移動量 (x)
 * @param {number} dy 角の移動量 (y)
 * @param {ImageSize} image
 * @param {number|null} ratio 幅 / 高さ。null は自由
 * @param {number} minSize 1 辺の最小 (画素)
 * @returns {CropRect}
 */
export function resizeBox(box, corner, dx, dy, image, ratio, minSize) {
	const dir = CORNER_DIRECTIONS[corner];
	if (!dir || !isValidBox(box) || !isValidImage(image) || !Number.isFinite(dx) || !Number.isFinite(dy)) return box;
	const {sx, sy} = dir;
	const anchorX = sx > 0 ? box.x : box.x + box.width;
	const anchorY = sy > 0 ? box.y : box.y + box.height;
	const availW = Math.max(0, Math.floor(sx > 0 ? image.width - anchorX : anchorX));
	const availH = Math.max(0, Math.floor(sy > 0 ? image.height - anchorY : anchorY));
	const wantW = box.width + sx * dx;
	const wantH = box.height + sy * dy;
	const min = Number.isFinite(minSize) && minSize > 0 ? minSize : 1;
	let width;
	let height;
	if (hasRatio(ratio)) {
		const followW = pickRatioWidth(box, wantW, wantH, ratio);
		const maxW = Math.min(availW, availH * ratio);
		const minW = Math.min(Math.max(min, min * ratio), maxW);
		width = Math.min(Math.floor(maxW), Math.round(clamp(followW, minW, maxW)));
		height = Math.min(availH, Math.round(width / ratio));
	} else {
		width = Math.round(clamp(wantW, Math.min(min, availW), availW));
		height = Math.round(clamp(wantH, Math.min(min, availH), availH));
	}
	return {
		x: sx > 0 ? anchorX : anchorX - width,
		y: sy > 0 ? anchorY : anchorY - height,
		width,
		height
	};
}

/**
 * 比ありの変形で採る幅を決める。元の枠に対する変化の割合が大きい軸に従い (同じなら幅)、
 * 他方の軸は比から求める。縮める向きの動きも拡げる向きの動きも同じ基準で選べる。
 * @param {CropRect} box
 * @param {number} wantW 動かした後の幅
 * @param {number} wantH 動かした後の高さ
 * @param {number} ratio 幅 / 高さ
 * @returns {number}
 */
function pickRatioWidth(box, wantW, wantH, ratio) {
	if (!(box.width > 0) || !(box.height > 0)) return Math.max(wantW, wantH * ratio);
	const relW = Math.abs(wantW / box.width - 1);
	const relH = Math.abs(wantH / box.height - 1);
	return relW >= relH ? wantW : wantH * ratio;
}

/**
 * 枠が画像全体か (画像の大きさは initialBox と同じく切り捨てて比べる)。全体なら切り抜き無しとして扱える。
 * @param {CropRect} box
 * @param {ImageSize} image
 * @returns {boolean}
 */
export function isFullImage(box, image) {
	if (!isValidBox(box) || !isValidImage(image)) return false;
	return box.x === 0 && box.y === 0 && box.width === Math.floor(image.width) && box.height === Math.floor(image.height);
}
