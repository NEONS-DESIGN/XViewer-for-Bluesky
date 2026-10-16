import test from 'node:test';
import assert from 'node:assert';
import {readFileSync} from 'node:fs';
import {readBlock, assertLightBlocksMatch} from './helpers/css-blocks.js';

const css = readFileSync(new URL('../src/popup/popup.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../src/popup/popup.html', import.meta.url), 'utf8');

test('popup.css のライトの宣言 2 か所が同じ中身', () => {
	assertLightBlocksMatch(css, ":root[data-theme='light']");
});

test('[hidden] を !important で 1 本にまとめている', () => {
	assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
});

test('スイッチの色は本体の Switch の実測値', () => {
	const dark = readBlock(css, ':root');
	const light = readBlock(css, ":root[data-theme='light']");
	assert.strictEqual(dark['--switch-on'], '#006aff');
	assert.strictEqual(dark['--switch-off'], '#313f54');
	assert.strictEqual(dark['--switch-knob'], '#ffffff');
	assert.strictEqual(light['--switch-on'], '#006aff');
	assert.strictEqual(light['--switch-off'], '#c0cad8');
	assert.strictEqual(light['--switch-knob'], '#ffffff');
});

test('寸法を持たない svg に受け皿で既定の寸法を当てている', () => {
	const base = readBlock(css, ':where(#app) svg');
	assert.ok(base, ':where(#app) svg の規則が無い');
	assert.ok(base.width && base.height, 'width / height が無い');
});

test('svg の既定の寸法は個別の規則 (クラス + svg) に負ける詳細度で書く', () => {
	// #app svg (1,0,1) のままだと .theme-toggle svg (0,1,1) の 18px が効かない。:where() で 0,0,1 に落とす
	assert.doesNotMatch(css, /(^|[\s,}])#app svg\s*[{,]/m, '#app svg を素のまま書いている');
	assert.strictEqual(readBlock(css, '.theme-toggle svg').width, '18px');
	assert.strictEqual(readBlock(css, '.field-lock-warning svg').width, '14px');
});

test('ライセンスの項目は地を塗らない (リンク色 --accent を --bg の上に置き 4.5:1 を保つ)', () => {
	const item = readBlock(css, '.license-item');
	assert.ok(item, '.license-item の規則が無い');
	assert.ok(!('background' in item) && !('background-color' in item), '.license-item が地を塗っている');
	assert.strictEqual(readBlock(css, '.license a').color, 'var(--accent)');
});

test('ポップアップの幅は 320px に固定している', () => {
	assert.strictEqual(readBlock(css, 'body').width, '320px');
});

test('popup.html は tokens.css → popup.css → #app → module の順', () => {
	const order = ['href="../common/tokens.css"', 'href="popup.css"', 'id="app"', '<script type="module" src="popup.js">'];
	const positions = order.map((part) => html.indexOf(part));
	assert.ok(positions.every((p) => p >= 0), `欠けている: ${order.filter((_, i) => positions[i] < 0)}`);
	assert.deepStrictEqual([...positions].sort((a, b) => a - b), positions);
	assert.match(html, /<title>Blueskyカスタム拡張機能<\/title>/);
});
