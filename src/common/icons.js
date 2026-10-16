/**
 * アイコンを DOM へ起こす役。図形データ (icon-shapes.js) と使う側の間に立つ。
 *
 * 姉妹プロジェクトと共通の createIcon() を、このプロジェクトの方針に合わせて
 * 2 点だけ変えている:
 * 1. innerHTML を使わず createElementNS + setAttribute で組む。図形データは
 *    定数だけで外部入力が混ざらないため innerHTML でも安全だが、
 *    「マークアップを文字列で組み立てない」という方針をそのまま守れるうえ、
 *    Trusted Types を強制する環境でも例外が出ない
 * 2. 図形データは markup (SVG 文字列) ではなく path (d 属性の値) を持つ。
 *    原本から写したデータの形がそうなっているため (icon-shapes.js 冒頭)
 *
 * 依存: icon-shapes.js (ICON_SHAPES)
 */
import {ICON_SHAPES} from './icon-shapes.js';

/** SVG の名前空間。createElementNS に渡す */
export const ICON_SVG_NS = 'http://www.w3.org/2000/svg';

/** 図形が見つからないときに使う空の描画領域 */
export const ICON_EMPTY_VIEW_BOX = '0 0 24 24';

/**
 * アイコンの svg 要素を作る。
 * viewBox は図形ごとの値をそのまま使う (Material Symbols は 0 -960 960 960)。
 * **返す svg は寸法を持たない。** 大きさは使う側の CSS が決める約束のため、
 * 受け皿に既定のサイズを必ず置くこと (固有サイズの無い置換要素は
 * 300x150px で描かれ、画面が崩れる)。
 * 未知の名前でも例外を投げず中身の空な svg を返す。アイコン 1 つの取り違えで
 * 画面全体が落ちてはいけない。
 * @param {Document} doc 対象のドキュメント
 * @param {string} name ICON_SHAPES のキー
 * @returns {SVGSVGElement} svg 要素
 */
export function createIcon(doc, name) {
	const shape = ICON_SHAPES[name];
	const svg = doc.createElementNS(ICON_SVG_NS, 'svg');
	svg.setAttribute('viewBox', shape?.viewBox ?? ICON_EMPTY_VIEW_BOX);
	svg.setAttribute('fill', 'currentColor');
	// アイコンは常に装飾。意味は親のテキストか aria-label が持つ
	svg.setAttribute('aria-hidden', 'true');
	svg.setAttribute('focusable', 'false');
	if (!shape) {
		console.error('[XViewer] 未知のアイコン名です', name);
		return svg;
	}
	const path = doc.createElementNS(ICON_SVG_NS, 'path');
	path.setAttribute('d', shape.path);
	svg.appendChild(path);
	return svg;
}
