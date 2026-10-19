/**
 * 返信に添える画像の縮小。選んだ画像を、Bluesky が受け付ける大きさの JPEG に直す。
 * fitDimensions / compressToLimit は純関数で、prepareImage だけが DOM (Image・canvas) に触れる。
 *
 * 依存: object-url.js
 */
import {createObjectUrl, revokeObjectUrl} from './object-url.js';

/**
 * 元画像の画素単位の切り抜き範囲。
 * @typedef {Object} CropRect
 * @property {number} x 左端
 * @property {number} y 上端
 * @property {number} width 幅
 * @property {number} height 高さ
 */

/**
 * 縮小を終えた画像。
 * @typedef {Object} PreparedImage
 * @property {Blob} blob 縮小後の JPEG
 * @property {number} width 縮小後の幅 (1 以上の整数)
 * @property {number} height 縮小後の高さ (1 以上の整数)
 * @property {string} previewUrl blob の object URL。使い終わったら呼び出し側が捨てる (作らなかったときは空文字)
 * @property {File|Blob} source 選ばれた元のファイル
 * @property {CropRect|null} crop 切り抜き範囲。無ければ null
 * @property {{width: number, height: number}} natural 元の画像の大きさ (切り抜きの画面に渡す)
 */

/** 書き出す画像の形式 */
const OUTPUT_TYPE = 'image/jpeg';

/** 透過部分を埋める色 (JPEG は透過を持てない) */
const BACKGROUND_COLOR = '#ffffff';

/**
 * 長辺を maxDimension 以下に、比を保って整数に丸める。小さい画像は拡大しない。
 * @param {number} width
 * @param {number} height
 * @param {number} maxDimension
 * @returns {{width: number, height: number}} どちらも 1 以上の整数
 */
export function fitDimensions(width, height, maxDimension) {
	const longSide = Math.max(width, height);
	const ratio = longSide > maxDimension ? maxDimension / longSide : 1;
	return {
		width: Math.max(1, Math.round(width * ratio)),
		height: Math.max(1, Math.round(height * ratio))
	};
}

/**
 * encode を呼ぶ。例外と null は「収まらなかった」として null を返す。
 * @param {function(number, number, number): Promise<Blob|null>} encode
 * @param {{width: number, height: number}} dims
 * @param {number} quality
 * @returns {Promise<Blob|null>}
 */
async function safeEncode(encode, dims, quality) {
	try {
		return (await encode(dims.width, dims.height, quality)) || null;
	} catch (error) {
		return null;
	}
}

/**
 * 上限のバイト数に収まるまで、品質の二分探索と辺の縮小を繰り返す。
 * 各段階でまず最高品質を試し、収まれば探索せずにそれを返す。
 * @param {function(number, number, number): Promise<Blob|null>} encode 幅・高さ・品質から Blob を作る
 * @param {{width: number, height: number}} size 元の大きさ
 * @param {{maxDimension: number, maxBytes: number, minQuality: number, scaleStep: number, maxScaleRetries: number, qualitySteps: number}} rules
 * @returns {Promise<{blob: Blob, width: number, height: number}|null>} どうしても収まらなければ null
 */
export async function compressToLimit(encode, size, rules) {
	for (let retry = 0; retry <= rules.maxScaleRetries; retry++) {
		const scale = Math.pow(rules.scaleStep, retry);
		const dims = fitDimensions(size.width * scale, size.height * scale, rules.maxDimension);
		const fullQuality = await safeEncode(encode, dims, 1);
		if (fullQuality && fullQuality.size <= rules.maxBytes) {
			return { blob: fullQuality, width: dims.width, height: dims.height };
		}
		let low = rules.minQuality;
		let high = 1;
		let best = null;
		for (let step = 0; step < rules.qualitySteps; step++) {
			const quality = (low + high) / 2;
			const blob = await safeEncode(encode, dims, quality);
			if (blob && blob.size <= rules.maxBytes) {
				best = blob;
				low = quality;
			} else {
				high = quality;
			}
		}
		if (best) {
			return { blob: best, width: dims.width, height: dims.height };
		}
	}
	return null;
}

/**
 * 描画する元画像の範囲を決める。切り抜きは画像の内側に収め、整数にそろえる。
 * @param {{width: number, height: number}} natural 元画像の大きさ
 * @param {CropRect|null} crop 切り抜き範囲。null なら全体
 * @returns {CropRect|null} 大きさが 0 や数でない場合、切り抜きが画像の外の場合は null
 */
export function resolveSourceRect(natural, crop) {
	const naturalWidth = Number(natural && natural.width);
	const naturalHeight = Number(natural && natural.height);
	if (!(Number.isFinite(naturalWidth) && Number.isFinite(naturalHeight) && naturalWidth > 0 && naturalHeight > 0)) {
		return null;
	}
	if (!crop) {
		return { x: 0, y: 0, width: Math.round(naturalWidth), height: Math.round(naturalHeight) };
	}
	const values = [crop.x, crop.y, crop.width, crop.height].map(Number);
	if (!values.every(Number.isFinite)) {
		return null;
	}
	const [cropX, cropY, cropWidth, cropHeight] = values;
	const left = Math.max(0, Math.floor(cropX));
	const top = Math.max(0, Math.floor(cropY));
	const right = Math.min(Math.floor(naturalWidth), Math.ceil(cropX + cropWidth));
	const bottom = Math.min(Math.floor(naturalHeight), Math.ceil(cropY + cropHeight));
	if (right <= left || bottom <= top) {
		return null;
	}
	return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * ファイルを Image として読み込む。読み込み用の object URL は読み終えたら捨てる。
 * @param {File} file
 * @returns {Promise<HTMLImageElement>}
 */
async function decodeFile(file) {
	const url = createObjectUrl(file);
	if (!url) {
		throw new Error('画像の URL を作れませんでした');
	}
	try {
		const image = new Image();
		image.src = url;
		await image.decode();
		return image;
	} finally {
		revokeObjectUrl(url);
	}
}

/**
 * canvas に描いて JPEG の Blob を取り出す encode を作る。
 * canvas は 1 枚を使い回し、描くのは寸法が変わったときだけ (品質だけを変える間は toBlob だけを呼び直す)。
 * @param {CanvasImageSource} image
 * @param {CropRect} source 描画する元画像の範囲
 * @param {() => HTMLCanvasElement} createCanvas canvas を作る
 * @returns {{encode: function(number, number, number): Promise<Blob|null>, release: () => void}}
 *   release は canvas の画素を手放す (使い終わったら呼ぶ)
 */
export function createCanvasEncoder(image, source, createCanvas) {
	/** @type {HTMLCanvasElement|null} */
	let canvas = null;
	/** 描いてある寸法 (まだ描いていなければ null) */
	let drawn = null;
	const draw = (width, height) => {
		if (!canvas) canvas = createCanvas();
		if (drawn && drawn.width === width && drawn.height === height) return true;
		canvas.width = width;
		canvas.height = height;
		const context = canvas.getContext('2d');
		if (!context) {
			drawn = null;
			return false;
		}
		context.imageSmoothingEnabled = true;
		context.imageSmoothingQuality = 'high';
		context.fillStyle = BACKGROUND_COLOR;
		context.fillRect(0, 0, width, height);
		context.drawImage(image, source.x, source.y, source.width, source.height, 0, 0, width, height);
		drawn = {width, height};
		return true;
	};
	return {
		encode: (width, height, quality) => new Promise((resolve) => {
			if (!draw(width, height)) {
				resolve(null);
				return;
			}
			canvas.toBlob((blob) => resolve(blob), OUTPUT_TYPE, quality);
		}),
		release: () => {
			if (!canvas) return;
			canvas.width = 0;
			canvas.height = 0;
			canvas = null;
			drawn = null;
		}
	};
}

/**
 * prepareImage の指定。
 * @typedef {Object} PrepareOptions
 * @property {boolean} [preview] false ならプレビューの object URL を作らない (送るだけのサムネイルなど)。既定は true
 */

/**
 * 選ばれた画像を、切り抜いたうえで上限に収まる JPEG にする。
 * @param {File|Blob} file
 * @param {CropRect|null} crop 切り抜き範囲。null なら全体
 * @param {Object} rules compressToLimit と同じ規則
 * @param {PrepareOptions} [options]
 * @returns {Promise<PreparedImage|null>} 失敗は null。preview: false なら previewUrl は空文字
 */
export async function prepareImage(file, crop, rules, options = {}) {
	let encoder = null;
	try {
		const image = await decodeFile(file);
		const natural = {
			width: image.naturalWidth || image.width,
			height: image.naturalHeight || image.height
		};
		const source = resolveSourceRect(natural, crop);
		if (!source) {
			console.error('[XViewer] 画像の大きさまたは切り抜き範囲が不正です', natural, crop);
			return null;
		}
		encoder = createCanvasEncoder(image, source, () => document.createElement('canvas'));
		const result = await compressToLimit(encoder.encode, { width: source.width, height: source.height }, rules);
		if (!result) {
			return null;
		}
		const wantPreview = !(options && options.preview === false);
		return {
			blob: result.blob,
			width: result.width,
			height: result.height,
			previewUrl: wantPreview ? createObjectUrl(result.blob) : '',
			source: file,
			crop: crop || null,
			natural
		};
	} catch (error) {
		console.error('[XViewer] 画像の縮小に失敗しました', error);
		return null;
	} finally {
		if (encoder) encoder.release();
	}
}
