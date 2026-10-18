import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

/** manifest のパスの起点。src/ の配置がそのまま出力先 (dist/) の配置になる */
const ROOT = path.join(import.meta.dirname, '..', 'src');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

/** PNG のシグネチャ (先頭 8 バイト) */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * PNG の IHDR から幅と高さを読む。
 * IHDR は必ず最初のチャンクで、シグネチャ 8 + 長さ 4 + 型 4 の直後から始まる。
 * @param {Buffer} buf PNG のバイト列
 * @returns {{width: number, height: number}} 実寸
 */
function readPngSize(buf) {
	return {width: buf.readUInt32BE(16), height: buf.readUInt32BE(20)};
}

// manifest に書いた寸法と PNG の実寸が食い違うと、Chrome は縮小して表示するため
// 気づきにくい。生成器の設定を変えたときに取り違えないよう、ここで検算する
test('manifest の icons と action.default_icon が同じ一覧を指す', () => {
	assert.deepStrictEqual(manifest.icons, manifest.action.default_icon);
});

test('宣言した寸法の PNG が存在し、実寸が宣言と一致する', () => {
	const entries = Object.entries(manifest.icons);
	assert.ok(entries.length > 0, 'icons が空');
	for (const [declared, relative] of entries) {
		const file = path.join(ROOT, relative);
		assert.ok(fs.existsSync(file), `${relative} が無い`);
		const buf = fs.readFileSync(file);
		assert.ok(buf.subarray(0, 8).equals(PNG_SIGNATURE), `${relative} が PNG でない`);
		const size = readPngSize(buf);
		assert.strictEqual(size.width, Number(declared), `${relative} の幅`);
		assert.strictEqual(size.height, Number(declared), `${relative} の高さ`);
	}
});

test('Chrome が使う 16 / 32 / 48 / 128 がすべて揃っている', () => {
	assert.deepStrictEqual(Object.keys(manifest.icons).sort(), ['128', '16', '32', '48']);
});

test('使う図形がすべて揃っている', async () => {
	const {ICON_SHAPES} = await import('../src/common/icon-shapes.js');
	for (const name of ['lightMode', 'darkMode', 'gridView', 'visibility', 'bugReport', 'chatBubble', 'repeat',
		'favorite', 'formatQuote', 'chevronRight', 'chevronLeft', 'openInNew', 'viewSidebar', 'lock', 'bookmark', 'error',
		'image', 'mood', 'crop', 'close', 'translate', 'warning', 'check']) {
		assert.match(ICON_SHAPES[name].path, /^M/i, name);
		assert.strictEqual(ICON_SHAPES[name].viewBox, '0 -960 960 960', name);
	}
});
