import test from 'node:test';
import assert from 'node:assert';
import {EXT_CONFIG} from '../src/common/config.js';
import {parseProfilePath, hasVisibleSiteDialog, isInsideExtensionPanel} from '../src/content/page.js';

const parse = (path) => parseProfilePath(path, EXT_CONFIG);

test('プロフィールページ (2 段ちょうど) だけを対象にする', () => {
	assert.deepStrictEqual(parse('/profile/alice.test'), {actor: 'alice.test'});
	assert.deepStrictEqual(parse('/profile/alice.test/'), {actor: 'alice.test'});
	assert.deepStrictEqual(parse('/profile/did:plc:abc123'), {actor: 'did:plc:abc123'});
});

test('3 段以上のページは対象外', () => {
	assert.strictEqual(parse('/profile/alice.test/post/abc'), null);
	assert.strictEqual(parse('/profile/alice.test/followers'), null);
	assert.strictEqual(parse('/profile/alice.test/follows'), null);
	assert.strictEqual(parse('/profile/alice.test/lists/xyz'), null);
	assert.strictEqual(parse('/profile/alice.test/feed/xyz'), null);
});

test('プロフィール以外のページは対象外', () => {
	assert.strictEqual(parse('/'), null);
	assert.strictEqual(parse('/search'), null);
	assert.strictEqual(parse('/notifications'), null);
	assert.strictEqual(parse('/messages'), null);
	assert.strictEqual(parse('/settings/appearance'), null);
});

test('壊れた入力でも例外を投げず null を返す', () => {
	assert.strictEqual(parse(null), null);
	assert.strictEqual(parse(''), null);
	assert.strictEqual(parse('/profile/'), null);
});

/** 投稿情報パネルのセレクタ */
const PANEL = '#' + EXT_CONFIG.lightboxPanel.panelId;

/**
 * ダイアログの候補を作る。
 * @param {{visible: boolean, inPanel?: boolean}} spec
 * @returns {Object} getClientRects と closest だけを持つ要素の代わり
 */
const dialog = ({visible, inPanel = false}) => ({
	getClientRects: () => (visible ? [{width: 1, height: 1}] : []),
	closest: (selector) => (inPanel && selector === PANEL ? {id: 'panel'} : null)
});

test('見えている本体のダイアログがあれば true', () => {
	assert.strictEqual(hasVisibleSiteDialog([dialog({visible: true})], PANEL), true);
});

test('display:none で残っているだけのダイアログは数えない', () => {
	assert.strictEqual(hasVisibleSiteDialog([dialog({visible: false})], PANEL), false);
});

test('パネルの中の画面 (role="dialog") は本体のライトボックスと取り違えない', () => {
	// ALT などの画面を開いたままブラウザバックすると、本体のダイアログは消えて
	// パネルの中の画面だけが残る。これを開いたままと判定してはいけない
	assert.strictEqual(hasVisibleSiteDialog([dialog({visible: true, inPanel: true})], PANEL), false);
	assert.strictEqual(hasVisibleSiteDialog([
		dialog({visible: true, inPanel: true}),
		dialog({visible: true})
	], PANEL), true);
});

test('closest を持たない・投げる要素はパネルの外とみなす', () => {
	assert.strictEqual(isInsideExtensionPanel({}, PANEL), false);
	assert.strictEqual(isInsideExtensionPanel({closest: () => { throw new Error('x'); }}, PANEL), false);
});
