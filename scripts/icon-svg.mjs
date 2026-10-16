/**
 * 拡張機能アイコン (蝶) の SVG を組み立てる。
 * 形の定義は GEOMETRY の 1 か所だけに持ち、PNG への変換は build-icons.mjs が resvg で行う。
 * 拡張機能パッケージの一部ではなく、ビルド時にだけ読まれる。
 */

/** 形の定義に使う正方形の一辺。実際の出力寸法へは SVG の viewBox の拡縮で合わせる */
const UNIT = 128;

/**
 * アイコンの地の色。ポップアップの --accent (src/common/tokens.css) と同じ値で、
 * 食い違いは test/icon-svg.test.js が検出する。
 */
export const ICON_BACKGROUND = '#006aff';

/** 蝶の色 */
const ICON_FOREGROUND = '#ffffff';

/** 目地を描き始める最小の寸法 (px)。これより小さい寸法では目地が潰れて灰色の粒になる */
const GUTTER_MIN_SIZE = 128;

/**
 * 目地の最低の太さ (実画素)。
 * 目地の幅は UNIT 座標で決めてあるが、小さい寸法ではそれが 1 画素を割り、
 * 白と地色が混ざった灰色の線になって濁る。実寸でこの値を下回るときは、
 * 比率を崩してでも太らせる。
 */
const MIN_GUTTER_DEVICE_WIDTH = 1.4;

/** 数値を SVG に書くときの小数桁数 */
const NUMBER_DIGITS = 2;

/**
 * 意匠の定義。座標はすべて UNIT (128) 四方の中での位置。
 * 左半分だけを書き、右の羽は x 軸で鏡像にして作る (左右対称を崩さないため)。
 */
const GEOMETRY = Object.freeze({
	/** 地の角丸四角。半径は一辺に対する比率 */
	badge: Object.freeze({ radiusRatio: 0.225 }),
	/**
	 * 左上の羽。頂点を順に辿る多角形で、r は各頂点の丸め半径。
	 * 内側 (胴に接する側) は小さく、外側の輪郭は大きく丸めて羽らしくする。
	 */
	upperWing: Object.freeze([
		{ x: 58, y: 30, r: 3 },
		{ x: 23, y: 16, r: 22 },
		{ x: 12, y: 50, r: 18 },
		{ x: 58, y: 68, r: 10 },
	]),
	/**
	 * 左下の羽。上の羽と胴の近くで重なるように置く。
	 * 蝶の羽は胴の際では繋がっており、離れて見えるのは外側だけ。
	 * 上下を完全に切り離すと羽が 4 枚の別の板に見えて蝶に読めなくなる。
	 */
	lowerWing: Object.freeze([
		{ x: 58, y: 60, r: 10 },
		{ x: 28, y: 78, r: 14 },
		{ x: 39, y: 108, r: 20 },
		{ x: 58, y: 96, r: 6 },
	]),
	/**
	 * 胴。上が太く下が細い角丸の柱。
	 * 16px では 1 画素を割ると灰色の筋になって濁るため、細くしすぎない。
	 */
	body: Object.freeze([
		{ x: 60.5, y: 28, r: 3 },
		{ x: 67.5, y: 28, r: 3 },
		{ x: 66.5, y: 102, r: 2.5 },
		{ x: 61.5, y: 102, r: 2.5 },
	]),
	/** 頭。胴の上端に重ねる円 */
	head: Object.freeze({ x: 64, y: 26, r: 5.5 }),
	/**
	 * 羽に通す目地 (メディア格子の隙間に相当)。胴には掛けない。
	 * 位置は羽の真ん中で、外接矩形を 3 等分した位置ではない。
	 * 等分すると胴のすぐ脇に帯が来て、蝶ではなく縞模様に見える。
	 * 太さも控えめにしてある。太くすると格子が勝って羽が板の寄せ集めに見える。
	 */
	gutter: Object.freeze({
		/** 中心 (x = UNIT / 2) からの距離。左右対称に縦の帯を抜く */
		offsetsX: Object.freeze([28]),
		/** 横の帯を通す y 座標。上下の羽の真ん中を 1 本ずつ */
		rowsY: Object.freeze([42, 86]),
		/** 縦の帯が覆う範囲 */
		top: 10,
		bottom: 118,
		/** 横の帯が覆う範囲 */
		left: 10,
		right: 118,
		width: 2.5,
	}),
});

/**
 * @typedef {{x: number, y: number, r: number}} Vertex 頂点 (r は丸め半径)
 * @typedef {{type: 'M' | 'L' | 'Q', to: {x: number, y: number}, control?: {x: number, y: number}}} PathCommand パスの命令
 */

/**
 * 2 点の距離。
 * @param {{x: number, y: number}} a 点
 * @param {{x: number, y: number}} b 点
 * @returns {number} 距離
 */
function distance(a, b) {
	return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * 角を丸めた多角形を、直線と 2 次ベジェの列に直す。
 * 各頂点で両隣の辺を半径ぶん削り、削った 2 点を頂点を制御点とする曲線で繋ぐ。
 * @param {ReadonlyArray<Vertex>} points 頂点の列
 * @returns {PathCommand[]} 命令の列
 */
function roundedPolygon(points) {
	const n = points.length;
	const commands = [];
	for (let i = 0; i < n; i += 1) {
		const prev = points[(i - 1 + n) % n];
		const cur = points[i];
		const next = points[(i + 1) % n];
		const dPrev = distance(cur, prev);
		const dNext = distance(cur, next);
		// 隣の辺より長く削ると形が裏返るため、辺の半分を上限にする
		const r = Math.min(cur.r, dPrev / 2, dNext / 2);
		const entry = { x: cur.x + ((prev.x - cur.x) / dPrev) * r, y: cur.y + ((prev.y - cur.y) / dPrev) * r };
		const exit = { x: cur.x + ((next.x - cur.x) / dNext) * r, y: cur.y + ((next.y - cur.y) / dNext) * r };
		commands.push({ type: i === 0 ? 'M' : 'L', to: entry });
		commands.push({ type: 'Q', to: exit, control: { x: cur.x, y: cur.y } });
	}
	return commands;
}

/**
 * 頂点の列を x = UNIT / 2 で鏡像にする。左右対称を手で二重に書かないため。
 * 鏡像にすると周回の向きが逆になるので、列の順序も逆にして揃える。
 * @param {ReadonlyArray<Vertex>} points 頂点の列
 * @returns {Vertex[]} 鏡像
 */
function mirrorPoints(points) {
	return points.map((p) => ({ x: UNIT - p.x, y: p.y, r: p.r })).reverse();
}

/**
 * 数値を SVG に書く文字列にする。
 * @param {number} value 数値
 * @returns {string} 小数を丸め、末尾の 0 を落とした文字列
 */
function num(value) {
	return Number(value.toFixed(NUMBER_DIGITS)).toString();
}

/**
 * 命令の列を SVG のパス文字列に直す。
 * @param {ReadonlyArray<PathCommand>} commands 命令の列
 * @returns {string} d 属性の値
 */
function toPathData(commands) {
	const parts = commands.map((cmd) => (cmd.type === 'Q'
		? `Q${num(cmd.control.x)} ${num(cmd.control.y)} ${num(cmd.to.x)} ${num(cmd.to.y)}`
		: `${cmd.type}${num(cmd.to.x)} ${num(cmd.to.y)}`));
	return `${parts.join('')}Z`;
}

/**
 * 角丸の正方形の頂点を返す。
 * @param {number} size 一辺
 * @param {number} radius 角の半径
 * @returns {Vertex[]} 頂点の列
 */
function roundedSquarePoints(size, radius) {
	return [
		{ x: 0, y: 0, r: radius },
		{ x: size, y: 0, r: radius },
		{ x: size, y: size, r: radius },
		{ x: 0, y: size, r: radius },
	];
}

/**
 * 目地の帯 (抜く矩形) を返す。羽の真ん中を縦横に通す。
 * @param {number} size 出力の一辺 (画素)。目地の最低の太さの判定に使う
 * @returns {Array<{x: number, y: number, w: number, h: number}>} 矩形の列
 */
function gutterRects(size) {
	const gutter = GEOMETRY.gutter;
	// 実寸で MIN_GUTTER_DEVICE_WIDTH を下回るなら、UNIT 座標での幅を太らせる
	const width = Math.max(gutter.width, (MIN_GUTTER_DEVICE_WIDTH * UNIT) / size);
	const half = width / 2;
	const rects = [];
	for (const offset of gutter.offsetsX) {
		for (const sign of [-1, 1]) {
			rects.push({ x: UNIT / 2 + sign * offset - half, y: gutter.top, w: width, h: gutter.bottom - gutter.top });
		}
	}
	for (const y of gutter.rowsY) {
		rects.push({ x: gutter.left, y: y - half, w: gutter.right - gutter.left, h: width });
	}
	return rects;
}

/**
 * 指定の寸法用のアイコン SVG を返す。
 * 目地は mask で羽から抜く。GUTTER_MIN_SIZE 未満の寸法では目地を描かない。
 * 目地の要素には data-role="gutter" を付ける。
 * @param {number} size 出力の一辺 (px)
 * @returns {string} SVG 文字列 (LF 改行、タブ字下げ)
 */
export function buildIconSvg(size) {
	const withGutters = size >= GUTTER_MIN_SIZE;
	const wings = [
		GEOMETRY.upperWing,
		GEOMETRY.lowerWing,
		mirrorPoints(GEOMETRY.upperWing),
		mirrorPoints(GEOMETRY.lowerWing),
	].map((points) => `\t\t\t<path d="${toPathData(roundedPolygon(points))}"/>`);
	const badge = toPathData(roundedPolygon(roundedSquarePoints(UNIT, UNIT * GEOMETRY.badge.radiusRatio)));
	const body = toPathData(roundedPolygon(GEOMETRY.body));
	const head = GEOMETRY.head;
	const lines = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${UNIT} ${UNIT}" width="${size}" height="${size}">`];
	if (withGutters) {
		lines.push('\t<defs>', '\t\t<mask id="ext-icon-gutter">',
			`\t\t\t<rect x="0" y="0" width="${UNIT}" height="${UNIT}" fill="#fff"/>`);
		for (const r of gutterRects(size)) {
			lines.push(`\t\t\t<rect data-role="gutter" x="${num(r.x)}" y="${num(r.y)}" width="${num(r.w)}" height="${num(r.h)}" fill="#000"/>`);
		}
		lines.push('\t\t</mask>', '\t</defs>');
	}
	lines.push(`\t<path d="${badge}" fill="${ICON_BACKGROUND}"/>`, `\t<g fill="${ICON_FOREGROUND}">`);
	lines.push(withGutters ? '\t\t<g mask="url(#ext-icon-gutter)">' : '\t\t<g>', ...wings, '\t\t</g>');
	lines.push(`\t\t<path d="${body}"/>`, `\t\t<circle cx="${head.x}" cy="${head.y}" r="${head.r}"/>`, '\t</g>', '</svg>', '');
	return lines.join('\n');
}
