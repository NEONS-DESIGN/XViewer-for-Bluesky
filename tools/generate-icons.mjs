/**
 * 拡張機能アイコン (icons/*.png と icons/icon.svg) の生成器。
 *
 * このファイルは拡張機能パッケージの一部ではない。tests/ と同じく、リポジトリに
 * 同梱してあるだけの補助スクリプトで、Chrome には読み込まれない。
 *
 * 依存関係を増やさない方針 (開発メモ) のため、SVG ラスタライザを外から持ち込まず、
 * Node の組み込みモジュール (node:zlib / node:fs) だけで PNG を書き出す。
 * 形の定義は下の GEOMETRY 1 か所だけに持ち、PNG と SVG の両方をそこから作る。
 *
 * 使い方:
 *   node tools/generate-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'icons');

/** 形の定義に使う正方形の一辺。実際の出力寸法へはこの比率で拡大縮小する */
const UNIT = 128;

/**
 * 意匠の定義。座標はすべて UNIT (128) 四方の中での位置。
 * 左半分だけを書き、右の羽は x 軸で鏡像にして作る (左右対称を崩さないため)。
 */
const GEOMETRY = Object.freeze({
    /** 地の角丸四角。半径は一辺に対する比率 */
    badge: Object.freeze({ radiusRatio: 0.225 }),

    /** 配色。ポップアップの --accent と同じ値を使う */
    colors: Object.freeze({
        background: [0x4e, 0xa3, 0xd6],
        foreground: [0xff, 0xff, 0xff],
    }),

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
     * 羽に通す目地 (メディア格子の隙間に相当)。
     * 胴には掛けない (胴が分断されて壊れて見えるため)。
     *
     * 位置は「羽の真ん中」であって、外接矩形を機械的に 3 等分した位置ではない。
     * 等分すると胴のすぐ脇に帯が来て、蝶ではなく縞模様に見えてしまう
     * (実際に出力して読めなくなった)。
     *
     * 太さも同じ理由で控えめにしてある。太くすると格子が勝って羽が板の寄せ集めに
     * 見える。羽 1 枚が縦横 1 本ずつで 4 分割され、上下の羽で 8 タイルになる。
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
 * 出力する寸法の一覧と、その寸法で目地を描くかどうか。
 *
 * 目地を描くのは 128 だけ。同じ絵をそのまま縮めると目地が 1 画素前後になり、
 * 羽が灰色の粒に砕けて蝶にも格子にも読めなくなる (16 / 32 / 48 の 3 通りを
 * 実際に出力して比べ、48 でも砕けることを確認した)。
 * 細部を大きい寸法にだけ残すのは、アイコンの作り分けとして普通の判断。
 * @type {ReadonlyArray<{size: number, gutters: boolean}>}
 */
const OUTPUT_SIZES = Object.freeze([
    { size: 16, gutters: false },
    { size: 32, gutters: false },
    { size: 48, gutters: false },
    { size: 128, gutters: true },
]);

/**
 * 目地の最低の太さ (実画素)。
 * 目地の幅は UNIT 座標で決めてあるが、小さい寸法ではそれが 1 画素を割り、
 * 白と地色が混ざった灰色の線になって濁る。実寸でこの値を下回るときは、
 * 比率を崩してでも太らせる。
 */
const MIN_GUTTER_DEVICE_WIDTH = 1.4;

/** 1 画素あたりの走査線の分割数。輪郭の滑らかさを決める */
const SUPERSAMPLE = 8;

/** 曲線を折れ線に直すときの分割数 */
const CURVE_STEPS = 16;

/* ------------------------------------------------------------------ *
 * 形の組み立て
 * ------------------------------------------------------------------ */

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
 * @param {ReadonlyArray<{x: number, y: number, r: number}>} points 頂点の列
 * @returns {Array<{type: string, to: {x: number, y: number}, control?: {x: number, y: number}}>} 命令の列
 */
function roundedPolygon(points) {
    const n = points.length;
    const commands = [];
    for (let i = 0; i < n; i += 1) {
        const prev = points[(i - 1 + n) % n];
        const cur = points[i];
        const next = points[(i + 1) % n];
        // 隣の辺より長く削ると形が裏返るため、辺の半分を上限にする
        const limit = Math.min(distance(cur, prev) / 2, distance(cur, next) / 2);
        const r = Math.min(cur.r, limit);
        const dPrev = distance(cur, prev);
        const dNext = distance(cur, next);
        const toPrev = { x: (prev.x - cur.x) / dPrev, y: (prev.y - cur.y) / dPrev };
        const toNext = { x: (next.x - cur.x) / dNext, y: (next.y - cur.y) / dNext };
        const entry = { x: cur.x + toPrev.x * r, y: cur.y + toPrev.y * r };
        const exit = { x: cur.x + toNext.x * r, y: cur.y + toNext.y * r };
        commands.push({ type: i === 0 ? 'M' : 'L', to: entry });
        commands.push({ type: 'Q', to: exit, control: { x: cur.x, y: cur.y } });
    }
    return commands;
}

/**
 * 角丸の正方形を多角形の定義に直す。
 * @param {number} size 一辺
 * @param {number} radius 角の半径
 * @returns {Array<{x: number, y: number, r: number}>} 頂点の列
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
 * 円を多角形の定義に直す (辺の数で近似する)。
 * @param {{x: number, y: number, r: number}} circle 円
 * @param {number} segments 分割数
 * @returns {Array<{x: number, y: number, r: number}>} 頂点の列
 */
function circlePoints(circle, segments = 24) {
    const points = [];
    for (let i = 0; i < segments; i += 1) {
        const t = (i / segments) * Math.PI * 2;
        points.push({ x: circle.x + Math.cos(t) * circle.r, y: circle.y + Math.sin(t) * circle.r, r: 0 });
    }
    return points;
}

/**
 * 頂点の列を x = UNIT / 2 で鏡像にする。左右対称を手で二重に書かないため。
 * 鏡像にすると周回の向きが逆になるので、列の順序も逆にして揃える。
 * @param {ReadonlyArray<{x: number, y: number, r: number}>} points 頂点の列
 * @returns {Array<{x: number, y: number, r: number}>} 鏡像
 */
function mirrorPoints(points) {
    return points.map((p) => ({ x: UNIT - p.x, y: p.y, r: p.r })).reverse();
}

/**
 * 命令の列を折れ線 (輪郭) に直す。
 * @param {ReadonlyArray<{type: string, to: {x: number, y: number}, control?: {x: number, y: number}}>} commands 命令の列
 * @returns {Array<{x: number, y: number}>} 折れ線の頂点
 */
function flatten(commands) {
    const out = [];
    let cursor = null;
    for (const cmd of commands) {
        if (cmd.type === 'M' || cmd.type === 'L') {
            out.push(cmd.to);
            cursor = cmd.to;
            continue;
        }
        // 2 次ベジェを等間隔で刻む
        for (let i = 1; i <= CURVE_STEPS; i += 1) {
            const t = i / CURVE_STEPS;
            const u = 1 - t;
            out.push({
                x: u * u * cursor.x + 2 * u * t * cmd.control.x + t * t * cmd.to.x,
                y: u * u * cursor.y + 2 * u * t * cmd.control.y + t * t * cmd.to.y,
            });
        }
        cursor = cmd.to;
    }
    return out;
}

/**
 * 輪郭の周回の向きを揃える。塗りつぶしを nonzero で行うため、
 * 複数の輪郭を重ねて 1 つの形にする (和をとる) には向きが同じである必要がある。
 * @param {Array<{x: number, y: number}>} contour 折れ線
 * @returns {Array<{x: number, y: number}>} 向きを揃えた折れ線
 */
function normalizeWinding(contour) {
    let area = 0;
    for (let i = 0; i < contour.length; i += 1) {
        const a = contour[i];
        const b = contour[(i + 1) % contour.length];
        area += a.x * b.y - b.x * a.y;
    }
    return area < 0 ? contour.slice().reverse() : contour;
}

/* ------------------------------------------------------------------ *
 * ラスタライズ
 * ------------------------------------------------------------------ */

/**
 * 折れ線の集まりを塗りつぶし、画素ごとの被覆率 (0..1) を返す。
 * 走査線を 1 画素あたり SUPERSAMPLE 本引き、交点の間を nonzero 規則で埋める。
 * @param {ReadonlyArray<Array<{x: number, y: number}>>} contours 輪郭の集まり (UNIT 座標)
 * @param {number} size 出力の一辺 (画素)
 * @returns {Float64Array} 長さ size * size の被覆率
 */
function rasterize(contours, size) {
    const scale = size / UNIT;
    const coverage = new Float64Array(size * size);
    const sampleWeight = 1 / (SUPERSAMPLE * SUPERSAMPLE);
    // 辺を [x0, y0, x1, y1] の配列に展開しておく
    const edges = [];
    for (const contour of contours) {
        for (let i = 0; i < contour.length; i += 1) {
            const a = contour[i];
            const b = contour[(i + 1) % contour.length];
            if (a.y === b.y) continue; // 水平な辺は走査線と交わらない
            edges.push([a.x * scale, a.y * scale, b.x * scale, b.y * scale]);
        }
    }
    const crossings = [];
    for (let sy = 0; sy < size * SUPERSAMPLE; sy += 1) {
        const y = (sy + 0.5) / SUPERSAMPLE;
        crossings.length = 0;
        for (const edge of edges) {
            const [x0, y0, x1, y1] = edge;
            const lo = Math.min(y0, y1);
            const hi = Math.max(y0, y1);
            if (y < lo || y >= hi) continue;
            const t = (y - y0) / (y1 - y0);
            crossings.push({ x: x0 + t * (x1 - x0), dir: y1 > y0 ? 1 : -1 });
        }
        if (crossings.length === 0) continue;
        crossings.sort((a, b) => a.x - b.x);
        const row = Math.floor(sy / SUPERSAMPLE) * size;
        let winding = 0;
        for (let i = 0; i < crossings.length - 1; i += 1) {
            winding += crossings[i].dir;
            if (winding === 0) continue;
            // 区間 [x0, x1) に入る標本列を数える
            const from = Math.ceil(crossings[i].x * SUPERSAMPLE - 0.5);
            const to = Math.ceil(crossings[i + 1].x * SUPERSAMPLE - 0.5);
            const begin = Math.max(0, from);
            const end = Math.min(size * SUPERSAMPLE, to);
            for (let sx = begin; sx < end; sx += 1) {
                coverage[row + Math.floor(sx / SUPERSAMPLE)] += sampleWeight;
            }
        }
    }
    for (let i = 0; i < coverage.length; i += 1) {
        if (coverage[i] > 1) coverage[i] = 1;
    }
    return coverage;
}

/**
 * 被覆率から矩形ぶんを差し引く (目地を抜く)。
 * @param {Float64Array} coverage 被覆率
 * @param {number} size 一辺 (画素)
 * @param {{x: number, y: number, w: number, h: number}} rect 抜く矩形 (UNIT 座標)
 * @returns {void}
 */
function subtractRect(coverage, size, rect) {
    const outline = normalizeWinding(flatten(roundedPolygon([
        { x: rect.x, y: rect.y, r: 0 },
        { x: rect.x + rect.w, y: rect.y, r: 0 },
        { x: rect.x + rect.w, y: rect.y + rect.h, r: 0 },
        { x: rect.x, y: rect.y + rect.h, r: 0 },
    ])));
    const mask = rasterize([outline], size);
    for (let i = 0; i < coverage.length; i += 1) {
        coverage[i] = Math.max(0, coverage[i] - mask[i]);
    }
}

/* ------------------------------------------------------------------ *
 * PNG の書き出し
 * ------------------------------------------------------------------ */

/** CRC32 の表 */
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c >>> 0;
    }
    return table;
})();

/**
 * CRC32 を求める。
 * @param {Buffer} buf 対象
 * @returns {number} CRC32
 */
function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i += 1) {
        c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

/**
 * PNG のチャンクを 1 つ作る。
 * @param {string} type 4 文字の型名
 * @param {Buffer} data 中身
 * @returns {Buffer} チャンク
 */
function chunk(type, data) {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([head, body, tail]);
}

/**
 * RGBA の画素列を PNG (8bit RGBA) に直す。
 * @param {Buffer} rgba 長さ size * size * 4
 * @param {number} size 一辺
 * @returns {Buffer} PNG のバイト列
 */
function encodePng(rgba, size) {
    const stride = size * 4;
    // 各行の先頭にフィルタ種別 0 (無変換) を置く
    const raw = Buffer.alloc((stride + 1) * size);
    for (let y = 0; y < size; y += 1) {
        raw[y * (stride + 1)] = 0;
        rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8; // ビット深度
    ihdr[9] = 6; // 色種別 RGBA
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

/* ------------------------------------------------------------------ *
 * 組み立て
 * ------------------------------------------------------------------ */

/**
 * 羽 4 枚の輪郭を返す。
 * @returns {Array<Array<{x: number, y: number}>>} 輪郭の集まり
 */
function wingContours() {
    const parts = [
        GEOMETRY.upperWing,
        GEOMETRY.lowerWing,
        mirrorPoints(GEOMETRY.upperWing),
        mirrorPoints(GEOMETRY.lowerWing),
    ];
    return parts.map((points) => normalizeWinding(flatten(roundedPolygon(points))));
}

/**
 * 胴と頭の輪郭を返す。
 * @returns {Array<Array<{x: number, y: number}>>} 輪郭の集まり
 */
function bodyContours() {
    return [
        normalizeWinding(flatten(roundedPolygon(GEOMETRY.body))),
        normalizeWinding(flatten(roundedPolygon(circlePoints(GEOMETRY.head)))),
    ];
}

/**
 * 目地の帯 (抜く矩形) を返す。羽の真ん中を縦横に 1 本ずつ通す。
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
            rects.push({
                x: UNIT / 2 + sign * offset - half,
                y: gutter.top,
                w: width,
                h: gutter.bottom - gutter.top,
            });
        }
    }
    for (const y of gutter.rowsY) {
        rects.push({
            x: gutter.left,
            y: y - half,
            w: gutter.right - gutter.left,
            h: width,
        });
    }
    return rects;
}

/**
 * 1 枚ぶんの PNG を作る。
 * @param {number} size 一辺 (画素)
 * @param {boolean} withGutters 目地を描くか
 * @returns {Buffer} PNG のバイト列
 */
function renderPng(size, withGutters) {
    const badgeOutline = normalizeWinding(flatten(roundedPolygon(
        roundedSquarePoints(UNIT, UNIT * GEOMETRY.badge.radiusRatio),
    )));
    const badge = rasterize([badgeOutline], size);
    const wings = rasterize(wingContours(), size);
    if (withGutters) {
        for (const rect of gutterRects(size)) {
            subtractRect(wings, size, rect);
        }
    }
    const body = rasterize(bodyContours(), size);
    const bgColor = GEOMETRY.colors.background;
    const fgColor = GEOMETRY.colors.foreground;
    const rgba = Buffer.alloc(size * size * 4);
    for (let i = 0; i < size * size; i += 1) {
        const alpha = badge[i];
        if (alpha <= 0) continue;
        // 蝶は地からはみ出さない (角丸の外へ出ないよう地の被覆率で頭打ちにする)
        const mark = Math.min(Math.max(wings[i], body[i]), alpha) / alpha;
        for (let c = 0; c < 3; c += 1) {
            rgba[i * 4 + c] = Math.round(bgColor[c] + (fgColor[c] - bgColor[c]) * mark);
        }
        rgba[i * 4 + 3] = Math.round(alpha * 255);
    }
    return encodePng(rgba, size);
}

/**
 * 命令の列を SVG のパス文字列に直す。
 * @param {ReadonlyArray<{type: string, to: {x: number, y: number}, control?: {x: number, y: number}}>} commands 命令の列
 * @returns {string} d 属性の値
 */
function toPathData(commands) {
    const num = (v) => Number(v.toFixed(2)).toString();
    const parts = commands.map((cmd) => (cmd.type === 'Q'
        ? `Q${num(cmd.control.x)} ${num(cmd.control.y)} ${num(cmd.to.x)} ${num(cmd.to.y)}`
        : `${cmd.type}${num(cmd.to.x)} ${num(cmd.to.y)}`));
    return `${parts.join('')}Z`;
}

/**
 * 原本の SVG を作る。PNG と同じ GEOMETRY から作るため、両者が食い違わない。
 * 目地は mask で抜く (パスの引き算を書かずに済ませるため)。
 * @returns {string} SVG の文字列
 */
function renderSvg() {
    const wingPaths = [
        GEOMETRY.upperWing,
        GEOMETRY.lowerWing,
        mirrorPoints(GEOMETRY.upperWing),
        mirrorPoints(GEOMETRY.lowerWing),
    ].map((points) => `            <path d="${toPathData(roundedPolygon(points))}" />`).join('\n');
    const gutters = gutterRects(UNIT)
        .map((r) => `            <rect x="${r.x.toFixed(2)}" y="${r.y.toFixed(2)}" width="${r.w.toFixed(2)}" height="${r.h.toFixed(2)}" fill="#000" />`)
        .join('\n');
    const badgePath = toPathData(roundedPolygon(roundedSquarePoints(UNIT, UNIT * GEOMETRY.badge.radiusRatio)));
    const bodyPath = toPathData(roundedPolygon(GEOMETRY.body));
    const hex = (rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${UNIT} ${UNIT}" width="${UNIT}" height="${UNIT}">
    <!-- tools/generate-icons.mjs が生成した原本。直接編集せず、生成器の GEOMETRY を直すこと -->
    <defs>
        <mask id="ext-icon-gutter">
            <rect x="0" y="0" width="${UNIT}" height="${UNIT}" fill="#fff" />
${gutters}
        </mask>
    </defs>
    <path d="${badgePath}" fill="${hex(GEOMETRY.colors.background)}" />
    <g fill="${hex(GEOMETRY.colors.foreground)}">
        <g mask="url(#ext-icon-gutter)">
${wingPaths}
        </g>
        <path d="${bodyPath}" />
        <circle cx="${GEOMETRY.head.x}" cy="${GEOMETRY.head.y}" r="${GEOMETRY.head.r}" />
    </g>
</svg>
`;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const entry of OUTPUT_SIZES) {
    const path = join(OUT_DIR, `icon${entry.size}.png`);
    writeFileSync(path, renderPng(entry.size, entry.gutters));
    console.log(`書き出し: icons/icon${entry.size}.png (目地: ${entry.gutters ? 'あり' : 'なし'})`);
}
writeFileSync(join(OUT_DIR, 'icon.svg'), renderSvg(), 'utf8');
console.log('書き出し: icons/icon.svg');
