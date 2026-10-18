/**
 * 添付した画像の切り抜きの画面。パネルに重ねる画面 (reply-sheets.js の SheetHost) の 1 つ。
 *
 * 元の画像を画面の幅に収めて表示し、その上に枠を重ねる。枠はドラッグで動かし、
 * 四隅で大きさを変える。枠にフォーカスがあるときは矢印キーで動かし、Shift+矢印で大きさを変える。
 * 枠の値は元の画像の画素で持ち、計算は crop-box.js の純関数に任せる。
 *
 * 依存: crop-box.js (initialBox, moveBox, resizeBox, isFullImage)、sheet-dom.js
 */
import {initialBox, moveBox, resizeBox, isFullImage} from './crop-box.js';
import {createElement, createButton, formatText} from './sheet-dom.js';

/** @typedef {import('./image-prepare.js').CropRect} CropRect */

/** 矢印キーと、そのキーで動く向き */
const ARROW_DIRECTIONS = Object.freeze({
	ArrowLeft: Object.freeze({x: -1, y: 0}),
	ArrowRight: Object.freeze({x: 1, y: 0}),
	ArrowUp: Object.freeze({x: 0, y: -1}),
	ArrowDown: Object.freeze({x: 0, y: 1})
});

/** 百分率に直すときの倍率 */
const PERCENT = 100;

/**
 * 画面上の移動量 (CSS の画素) を元の画像の画素に直す。表示の幅が 0 なら動かさない。
 * @param {number} dx 横の移動量
 * @param {number} dy 縦の移動量
 * @param {number} displayWidth 画像を表示している幅
 * @param {{width: number, height: number}} image 元の画像の大きさ
 * @returns {{dx: number, dy: number}}
 */
export function toSourceDelta(dx, dy, displayWidth, image) {
	if (!(displayWidth > 0) || !image || !(image.width > 0)) return {dx: 0, dy: 0};
	const scale = image.width / displayWidth;
	return {dx: Math.round(dx * scale) || 0, dy: Math.round(dy * scale) || 0};
}

/**
 * 画面上の刻みを元の画像の画素に直す。1 を下回らない。表示の幅が分からなければそのまま返す。
 * @param {number} step 画面上の刻み
 * @param {number} displayWidth 画像を表示している幅
 * @param {number} imageWidth 元の画像の幅
 * @returns {number}
 */
export function sourceStep(step, displayWidth, imageWidth) {
	if (!(displayWidth > 0) || !(imageWidth > 0)) return step;
	return Math.max(1, Math.round(step * imageWidth / displayWidth));
}

/**
 * 枠の上で押したキーを、枠の操作に直す。矢印で移動、Shift+矢印で大きさを変える。
 * Ctrl (Mac は Command) を押していれば大きな刻みにする。矢印以外は null。
 * @param {{key: string, shiftKey?: boolean, ctrlKey?: boolean, metaKey?: boolean}} event キーの情報
 * @param {{small: number, large: number}} steps 刻み (元の画像の画素)
 * @returns {{mode: 'move'|'resize', dx: number, dy: number}|null}
 */
export function cropKeyAction(event, steps) {
	const direction = ARROW_DIRECTIONS[event?.key];
	if (!direction) return null;
	const step = event.ctrlKey || event.metaKey ? steps.large : steps.small;
	return {mode: event.shiftKey ? 'resize' : 'move', dx: direction.x * step, dy: direction.y * step};
}

/**
 * 画像の大きさが使えるか (幅・高さが 1 画素以上の有限の数)。
 * @param {{width: number, height: number}|undefined} image 元の画像の大きさ
 * @returns {boolean}
 */
function isUsableImage(image) {
	return !!image && Number.isFinite(image.width) && Number.isFinite(image.height)
		&& image.width >= 1 && image.height >= 1;
}

/**
 * 渡された枠が画像の中に収まる正しい枠か。
 * @param {CropRect|null} crop 枠
 * @param {{width: number, height: number}} image 元の画像の大きさ
 * @returns {boolean}
 */
function isUsableCrop(crop, image) {
	return !!crop && [crop.x, crop.y, crop.width, crop.height].every(Number.isFinite)
		&& crop.x >= 0 && crop.y >= 0 && crop.width > 0 && crop.height > 0
		&& crop.x + crop.width <= image.width && crop.y + crop.height <= image.height;
}

/**
 * 切り抜きの画面の状態と描画を持つ。枠の値が変わるたびに render() で表示へ写す。
 */
class CropEditor {
	/**
	 * @param {Document} doc 対象の文書
	 * @param {Object} config EXT_CONFIG.lightboxReplies.compose
	 * @param {{width: number, height: number}} image 元の画像の大きさ
	 * @param {CropRect|null} crop 今の切り抜き
	 */
	constructor(doc, config, image, crop) {
		this.doc = doc;
		this.config = config;
		this.image = {width: Math.floor(image.width), height: Math.floor(image.height)};
		this.aspect = config.crop.aspects[0];
		this.box = isUsableCrop(crop, this.image) ? {...crop} : initialBox(this.image, this.aspect.ratio);
		this.drag = null;
		this.aspectButtons = [];
	}

	/**
	 * 画面の中身 (比のボタン・画像と枠・大きさ・「元に戻す」) を組む。
	 * @param {string} imageUrl 表示する画像の URL
	 * @returns {HTMLElement[]} 本文へ足す要素
	 */
	build(imageUrl) {
		const {classes, text} = this.config;
		const doc = this.doc;
		const aspects = createElement(doc, 'div', classes.cropAspects);
		aspects.setAttribute('role', 'group');
		aspects.setAttribute('aria-label', text.cropAspects);
		for (const aspect of this.config.crop.aspects) {
			const button = createButton(doc, classes.cropAspect, text.aspectNames[aspect.id] || aspect.id);
			button.addEventListener('click', () => this.selectAspect(aspect));
			this.aspectButtons.push({aspect, button});
			aspects.append(button);
		}

		this.stage = createElement(doc, 'div', classes.cropStage);
		this.frame = createElement(doc, 'div', classes.cropFrame);
		this.img = createElement(doc, 'img', classes.cropImage);
		this.img.setAttribute('alt', '');
		this.img.setAttribute('draggable', 'false');
		this.shadeClip = createElement(doc, 'div', classes.cropShadeClip);
		this.shade = createElement(doc, 'div', classes.cropShade);
		this.shadeClip.append(this.shade);
		this.boxEl = this.buildBox();
		this.frame.append(this.img, this.shadeClip, this.boxEl);
		this.stage.append(this.frame);
		this.error = createElement(doc, 'p', classes.error, text.cropFailed);
		this.error.setAttribute('role', 'alert');
		this.error.hidden = true;
		this.img.addEventListener('error', () => {
			this.stage.hidden = true;
			this.error.hidden = false;
		});
		this.img.setAttribute('src', imageUrl);

		const tools = createElement(doc, 'div', classes.cropTools);
		this.size = createElement(doc, 'span', classes.cropSize);
		this.size.setAttribute('aria-live', 'polite');
		const reset = createButton(doc, classes.button, text.cropReset);
		reset.addEventListener('click', () => this.reset());
		tools.append(this.size, reset);

		this.frame.addEventListener('pointermove', (event) => this.onPointerMove(event));
		this.frame.addEventListener('pointerup', (event) => this.endDrag(event));
		this.frame.addEventListener('pointercancel', (event) => this.endDrag(event));
		this.frame.addEventListener('lostpointercapture', (event) => this.endDrag(event));
		this.render();
		return [aspects, this.stage, this.error, tools];
	}

	/**
	 * 枠の要素と四隅のつまみを組む。枠はフォーカスを受け、キーで動かせる。
	 * @returns {HTMLElement}
	 */
	buildBox() {
		const {classes, text} = this.config;
		const box = createElement(this.doc, 'div', classes.cropBox);
		box.setAttribute('tabindex', '0');
		box.setAttribute('role', this.config.cropBoxRole);
		box.setAttribute('aria-label', text.cropBox);
		box.addEventListener('pointerdown', (event) => this.startDrag(event, box, null));
		box.addEventListener('keydown', (event) => this.onKeyDown(event));
		for (const corner of this.config.cropCorners) {
			const handle = createElement(this.doc, 'span', classes.cropHandle);
			handle.dataset.corner = corner;
			handle.setAttribute('title', text.cropCorner[corner] || corner);
			handle.setAttribute('aria-hidden', 'true');
			handle.addEventListener('pointerdown', (event) => this.startDrag(event, handle, corner));
			box.append(handle);
		}
		return box;
	}

	/**
	 * 画像を表示している幅 (CSS の画素)。
	 * @returns {number}
	 */
	displayWidth() {
		try {
			return this.img.getBoundingClientRect().width;
		} catch (error) {
			return 0;
		}
	}

	/**
	 * 比を選ぶ。枠はその比で中央に入る最大の大きさにする。
	 * @param {{id: string, ratio: number|null}} aspect 比
	 * @returns {void}
	 */
	selectAspect(aspect) {
		this.aspect = aspect;
		this.box = initialBox(this.image, aspect.ratio);
		this.render();
	}

	/**
	 * 切り抜きを外す (比を自由に戻し、枠を画像全体にする)。
	 * @returns {void}
	 */
	reset() {
		this.selectAspect(this.config.crop.aspects[0]);
	}

	/**
	 * 枠かつまみの上で押したときに、ドラッグを始める。
	 * @param {PointerEvent} event
	 * @param {HTMLElement} target 押された要素 (ポインタを捕まえる先)
	 * @param {string|null} corner つまみの角。null は枠ごと動かす
	 * @returns {void}
	 */
	startDrag(event, target, corner) {
		if (event.button !== 0 || this.drag) return;
		event.preventDefault();
		event.stopPropagation();
		try {
			target.setPointerCapture(event.pointerId);
		} catch (error) {
			// 捕まえられなくても、frame の中で動かすかぎりは追える
		}
		this.boxEl.focus();
		this.drag = {
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			startBox: {...this.box},
			corner,
			width: this.displayWidth()
		};
	}

	/**
	 * ドラッグ中のポインタの移動。押し始めからの移動量で枠を作り直す (丸めの誤差をためない)。
	 * @param {PointerEvent} event
	 * @returns {void}
	 */
	onPointerMove(event) {
		const drag = this.drag;
		if (!drag || event.pointerId !== drag.pointerId) return;
		try {
			const delta = toSourceDelta(event.clientX - drag.startX, event.clientY - drag.startY, drag.width, this.image);
			this.box = drag.corner
				? resizeBox(drag.startBox, drag.corner, delta.dx, delta.dy, this.image, this.aspect.ratio, this.config.crop.minSize)
				: moveBox(drag.startBox, delta.dx, delta.dy, this.image);
			this.render();
		} catch (error) {
			console.error('[XViewer] 切り抜きの枠を動かせませんでした', error);
		}
	}

	/**
	 * ドラッグを終える。
	 * @param {PointerEvent} event
	 * @returns {void}
	 */
	endDrag(event) {
		if (this.drag && event.pointerId === this.drag.pointerId) this.drag = null;
	}

	/**
	 * 枠の上のキー。矢印で動かし、Shift+矢印で右下の角を動かして大きさを変える。
	 * @param {KeyboardEvent} event
	 * @returns {void}
	 */
	onKeyDown(event) {
		const width = this.displayWidth();
		const crop = this.config.crop;
		const action = cropKeyAction(event, {
			small: sourceStep(crop.keyStep, width, this.image.width),
			large: sourceStep(crop.keyStepLarge, width, this.image.width)
		});
		if (!action) return;
		event.preventDefault();
		try {
			this.box = action.mode === 'resize'
				? resizeBox(this.box, this.config.cropKeyCorner, action.dx, action.dy, this.image, this.aspect.ratio, crop.minSize)
				: moveBox(this.box, action.dx, action.dy, this.image);
			this.render();
		} catch (error) {
			console.error('[XViewer] 切り抜きの枠を動かせませんでした', error);
		}
	}

	/**
	 * 枠の値を表示へ写す (位置と大きさは画像に対する百分率)。比のボタンの押下状態も直す。
	 * @returns {void}
	 */
	render() {
		const {box, image} = this;
		for (const element of [this.boxEl, this.shade]) {
			element.style.left = `${box.x / image.width * PERCENT}%`;
			element.style.top = `${box.y / image.height * PERCENT}%`;
			element.style.width = `${box.width / image.width * PERCENT}%`;
			element.style.height = `${box.height / image.height * PERCENT}%`;
		}
		this.size.textContent = formatText(this.config.text.cropSize, {width: box.width, height: box.height});
		for (const {aspect, button} of this.aspectButtons) {
			button.setAttribute('aria-pressed', String(aspect === this.aspect));
		}
	}

	/**
	 * 保存する切り抜き。画像全体なら切り抜かない (null)。
	 * @returns {CropRect|null}
	 */
	result() {
		return isFullImage(this.box, this.image) ? null : {...this.box};
	}
}

/**
 * 切り抜きの画面を開く。元の画像を object URL で表示し、閉じたら破棄する。
 * 「完了」で枠を返す。画像全体なら null (切り抜かない)。
 * @param {import('./reply-sheets.js').SheetHost} host 重ねる画面の持ち主
 * @param {{source: File, image: {width: number, height: number}, crop: CropRect|null}} input 元の画像・その大きさ・今の切り抜き
 * @param {HTMLElement} opener 開いたボタン
 * @param {(crop: CropRect|null) => void} onSave 「完了」で枠を受け取る
 * @param {import('./reply-sheets.js').SheetOptions} [options] 持ち主とフォーカスの戻し先
 * @returns {void}
 */
export function openCropSheet(host, input, opener, onSave, options) {
	const config = host.config;
	let editor = null;
	host.open({
		title: config.text.cropTitle,
		build: (body) => {
			const doc = body.ownerDocument;
			const win = doc.defaultView;
			if (!isUsableImage(input?.image)) {
				const error = createElement(doc, 'p', config.classes.error, config.text.cropFailed);
				error.setAttribute('role', 'alert');
				body.append(error);
				host.setDoneDisabled(true);
				return undefined;
			}
			const url = win.URL.createObjectURL(input.source);
			try {
				editor = new CropEditor(doc, config, input.image, input.crop);
				body.append(...editor.build(url));
			} catch (error) {
				win.URL.revokeObjectURL(url);
				throw error;
			}
			return () => win.URL.revokeObjectURL(url);
		},
		onDone: () => {
			if (!editor) return;
			try {
				onSave(editor.result());
			} catch (error) {
				console.error('[XViewer] 切り抜きを保存できませんでした', error);
			}
		}
	}, opener, options);
}
