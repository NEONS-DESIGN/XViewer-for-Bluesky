import test from 'node:test';
import assert from 'node:assert';
import {FakeDocument, FakeEvent, click, pressKey} from './helpers/fake-dom.js';
import {EXT_CONFIG} from '../src/common/config.js';
import {
	SheetHost, formatText, altState, languageName, orderLanguages, filterLanguages,
	openAltSheet, openLabelSheet, openLanguageSheet,
	isLanguageLocked, isEmojiMessage, buildEmojiUrl, pickEmojiTheme, extensionOrigin
} from '../src/content/reply-sheets.js';
import {toSourceDelta, sourceStep, cropKeyAction} from '../src/content/crop-sheet.js';

const COMPOSE = EXT_CONFIG.lightboxReplies.compose;
const ROLES = COMPOSE.sheetRoles;

/**
 * パネル・開くボタン・パネルのキー監視を持つ偽の画面を作る。
 * @returns {{doc: FakeDocument, panel: object, opener: object, panelKeys: string[]}}
 */
function setup() {
	const doc = new FakeDocument();
	const panel = doc.createElement('aside');
	const opener = doc.createElement('button');
	panel.append(opener);
	doc.body.append(panel);
	const panelKeys = [];
	panel.addEventListener('keydown', (event) => panelKeys.push(event.key));
	opener.focus();
	return {doc, panel, opener, panelKeys};
}

/**
 * 入力欄を 1 つだけ持つ画面の定義を作る。
 * @param {object} doc 偽の文書
 * @param {object} calls 呼ばれた回数を数える先
 * @returns {object} SheetSpec
 */
function inputSpec(doc, calls) {
	return {
		title: '題',
		build: (body) => {
			const input = doc.createElement('textarea');
			input.dataset.role = 'test-input';
			body.append(input);
		},
		onDone: () => { calls.done += 1; },
		onCancel: () => { calls.cancel += 1; }
	};
}

test('SheetHost: 開くと最初の操作要素へフォーカスが移る', () => {
	const {doc, panel, opener} = setup();
	const host = new SheetHost(panel, COMPOSE);
	host.open(inputSpec(doc, {done: 0, cancel: 0}), opener);
	assert.ok(host.isOpen());
	assert.strictEqual(doc.activeElement, panel.querySelector('[data-role="test-input"]'));
});

test('SheetHost: Escape で閉じ、opener にフォーカスが戻り、イベントがパネルへ伝わらない', () => {
	const {doc, panel, opener, panelKeys} = setup();
	const host = new SheetHost(panel, COMPOSE);
	const calls = {done: 0, cancel: 0};
	host.open(inputSpec(doc, calls), opener);
	const event = pressKey(panel.querySelector('[data-role="test-input"]'), 'Escape');
	assert.strictEqual(host.isOpen(), false);
	assert.strictEqual(panel.querySelector(`[data-role="${ROLES.layer}"]`), null);
	assert.strictEqual(doc.activeElement, opener);
	assert.deepStrictEqual(panelKeys, []);
	assert.ok(event.stopped);
	assert.deepStrictEqual(calls, {done: 0, cancel: 1});
});

test('SheetHost: 開いているあいだのキーはパネルへ伝わらない', () => {
	const {doc, panel, opener, panelKeys} = setup();
	const host = new SheetHost(panel, COMPOSE);
	host.open(inputSpec(doc, {done: 0, cancel: 0}), opener);
	pressKey(panel.querySelector('[data-role="test-input"]'), 'ArrowLeft');
	assert.deepStrictEqual(panelKeys, []);
	assert.ok(host.isOpen());
});

test('SheetHost: 同時に 2 つ開くと前のものが閉じる', () => {
	const {doc, panel, opener} = setup();
	const host = new SheetHost(panel, COMPOSE);
	const first = {done: 0, cancel: 0};
	const second = {done: 0, cancel: 0};
	host.open(inputSpec(doc, first), opener);
	host.open(inputSpec(doc, second), opener);
	assert.strictEqual(panel.querySelectorAll(`[data-role="${ROLES.layer}"]`).length, 1);
	assert.deepStrictEqual(first, {done: 0, cancel: 1});
	assert.deepStrictEqual(second, {done: 0, cancel: 0});
	assert.ok(host.isOpen());
});

test('SheetHost: 「完了」で onDone を呼んで閉じる。「キャンセル」で onCancel を呼んで閉じる', () => {
	const {doc, panel, opener} = setup();
	const host = new SheetHost(panel, COMPOSE);
	const calls = {done: 0, cancel: 0};
	host.open(inputSpec(doc, calls), opener);
	click(panel.querySelector(`[data-role="${ROLES.done}"]`));
	assert.deepStrictEqual(calls, {done: 1, cancel: 0});
	assert.strictEqual(host.isOpen(), false);
	assert.strictEqual(doc.activeElement, opener);
	host.open(inputSpec(doc, calls), opener);
	click(panel.querySelector(`[data-role="${ROLES.cancel}"]`));
	assert.deepStrictEqual(calls, {done: 1, cancel: 1});
	assert.strictEqual(host.isOpen(), false);
});

test('SheetHost: 「完了」が disabled のあいだは押しても閉じない', () => {
	const {doc, panel, opener} = setup();
	const host = new SheetHost(panel, COMPOSE);
	const calls = {done: 0, cancel: 0};
	host.open(inputSpec(doc, calls), opener);
	host.setDoneDisabled(true);
	click(panel.querySelector(`[data-role="${ROLES.done}"]`));
	assert.strictEqual(calls.done, 0);
	assert.ok(host.isOpen());
});

test('SheetHost: build が返した後始末は閉じるときに 1 回だけ呼ぶ', () => {
	const {panel, opener} = setup();
	const host = new SheetHost(panel, COMPOSE);
	let cleaned = 0;
	host.open({title: '題', build: () => () => { cleaned += 1; }}, opener);
	host.close(false);
	host.close(false);
	host.destroy();
	assert.strictEqual(cleaned, 1);
});

test('SheetHost: IME の変換中の Escape では閉じない', () => {
	const {doc, panel, opener} = setup();
	const host = new SheetHost(panel, COMPOSE);
	host.open(inputSpec(doc, {done: 0, cancel: 0}), opener);
	const event = new FakeEvent('keydown', {key: 'Escape'});
	event.isComposing = true;
	panel.querySelector('[data-role="test-input"]').dispatchEvent(event);
	assert.ok(host.isOpen());
});

test('formatText: {名前} を値で置き換える', () => {
	assert.strictEqual(formatText('選択中 {count}/{max}', {count: 1, max: 3}), '選択中 1/3');
	assert.strictEqual(formatText('{a}{a}', {a: 'x'}), 'xx');
	assert.strictEqual(formatText('{unknown}', {}), '{unknown}');
});

test('formatText: 日本語の名前も置き換える', () => {
	assert.strictEqual(formatText('{言語}で返信しますか？', {言語: '英語'}), '英語で返信しますか？');
});

test('altState: 書記素で残りを数え、上限を超えたら over', () => {
	assert.deepStrictEqual(altState('あい', 3), {remaining: 1, over: false});
	// 結合子でつないだ家族の絵文字 (書記素 1 つ)
	assert.deepStrictEqual(altState('\u{1F468}‍\u{1F469}‍\u{1F467}', 1), {remaining: 0, over: false});
	assert.deepStrictEqual(altState('abcd', 3), {remaining: -1, over: true});
});

test('languageName: 表示名を出し、使えないコードはそのまま返す', () => {
	assert.strictEqual(languageName('ja', 'ja'), '日本語');
	assert.strictEqual(languageName('en', 'en'), 'English');
	assert.strictEqual(languageName('!!', 'ja'), '!!');
	assert.strictEqual(languageName('ja', '!!bad-locale!!'), 'ja');
});

test('orderLanguages: 選んでいるものを先頭に、残りは元の並び', () => {
	assert.deepStrictEqual(orderLanguages(['aa', 'en', 'ja', 'zh'], ['ja', 'en']), ['ja', 'en', 'aa', 'zh']);
	assert.deepStrictEqual(orderLanguages(['aa', 'en'], ['xx']), ['aa', 'en']);
});

test('filterLanguages: 表示名かコードの部分一致 (大文字小文字を区別しない)', () => {
	const entries = [{code: 'ja', name: '日本語'}, {code: 'en', name: 'English'}, {code: 'de', name: 'Deutsch'}];
	assert.deepStrictEqual(filterLanguages(entries, '').map((e) => e.code), ['ja', 'en', 'de']);
	assert.deepStrictEqual(filterLanguages(entries, '日本').map((e) => e.code), ['ja']);
	assert.deepStrictEqual(filterLanguages(entries, 'EN').map((e) => e.code), ['en']);
	assert.deepStrictEqual(filterLanguages(entries, '  de ').map((e) => e.code), ['de']);
});

test('isLanguageLocked: 上限まで選んだら、選んでいないものだけ止める', () => {
	assert.strictEqual(isLanguageLocked('de', ['ja', 'en', 'fr'], 3), true);
	assert.strictEqual(isLanguageLocked('ja', ['ja', 'en', 'fr'], 3), false);
	assert.strictEqual(isLanguageLocked('de', ['ja', 'en'], 3), false);
});

test('isEmojiMessage: 送り主の window と origin と型が合うときだけ受ける', () => {
	const frameWindow = {};
	const origin = 'chrome-extension://abc';
	const ok = {source: frameWindow, origin, data: {type: COMPOSE.emoji.selectType, native: 'x'}};
	assert.strictEqual(isEmojiMessage(ok, frameWindow, origin, COMPOSE.emoji), true);
	assert.strictEqual(isEmojiMessage({...ok, source: {}}, frameWindow, origin, COMPOSE.emoji), false);
	assert.strictEqual(isEmojiMessage({...ok, origin: 'https://evil.example'}, frameWindow, origin, COMPOSE.emoji), false);
	assert.strictEqual(isEmojiMessage({...ok, data: 'text'}, frameWindow, origin, COMPOSE.emoji), false);
	assert.strictEqual(isEmojiMessage({...ok, data: {type: 'other'}}, frameWindow, origin, COMPOSE.emoji), false);
	assert.strictEqual(isEmojiMessage(ok, null, origin), false);
});

test('buildEmojiUrl: 配色と言語を問い合わせに付ける', () => {
	const q = COMPOSE.emoji.query;
	const url = buildEmojiUrl('chrome-extension://abc/emoji/emoji.html', 'light', 'ja-JP', COMPOSE.emoji);
	const parsed = new URL(url);
	assert.strictEqual(parsed.searchParams.get(q.theme), q.themeLight);
	assert.strictEqual(parsed.searchParams.get(q.locale), q.localeJa);
	const en = new URL(buildEmojiUrl('chrome-extension://abc/emoji/emoji.html', 'dark', 'en-US', COMPOSE.emoji));
	assert.strictEqual(en.searchParams.get(q.theme), q.themeDark);
	assert.strictEqual(en.searchParams.get(q.locale), null);
});

test('pickEmojiTheme: 本体の html がライトのテーマクラスを持つときだけ light', () => {
	const doc = new FakeDocument();
	assert.strictEqual(pickEmojiTheme(doc, COMPOSE.emoji), COMPOSE.emoji.query.themeDark);
	doc.documentElement.classList.add(COMPOSE.emoji.lightThemeClass);
	assert.strictEqual(pickEmojiTheme(doc, COMPOSE.emoji), COMPOSE.emoji.query.themeLight);
});

test('toSourceDelta: 画面の移動量を元の画像の画素へ直す', () => {
	assert.deepStrictEqual(toSourceDelta(10, 5, 200, {width: 1000, height: 500}), {dx: 50, dy: 25});
	assert.deepStrictEqual(toSourceDelta(-3, 0, 300, {width: 100, height: 100}), {dx: -1, dy: 0});
	assert.deepStrictEqual(toSourceDelta(10, 10, 0, {width: 100, height: 100}), {dx: 0, dy: 0});
});

test('sourceStep: 画面上の刻みを元の画素に直し、1 を下回らない', () => {
	assert.strictEqual(sourceStep(8, 200, 1000), 40);
	assert.strictEqual(sourceStep(8, 1000, 100), 1);
	assert.strictEqual(sourceStep(8, 0, 100), 8);
});

test('cropKeyAction: 矢印で移動、Shift で伸縮、Ctrl で大きな刻み', () => {
	const steps = {small: 4, large: 16};
	assert.deepStrictEqual(cropKeyAction({key: 'ArrowLeft'}, steps), {mode: 'move', dx: -4, dy: 0});
	assert.deepStrictEqual(cropKeyAction({key: 'ArrowDown', shiftKey: true}, steps), {mode: 'resize', dx: 0, dy: 4});
	assert.deepStrictEqual(cropKeyAction({key: 'ArrowUp', ctrlKey: true}, steps), {mode: 'move', dx: 0, dy: -16});
	assert.deepStrictEqual(cropKeyAction({key: 'ArrowRight', metaKey: true, shiftKey: true}, steps), {mode: 'resize', dx: 16, dy: 0});
	assert.strictEqual(cropKeyAction({key: 'Enter'}, steps), null);
});

test('openAltSheet: 上限を超えると「完了」を押せず、戻すと前後の空白を除いて保存する', () => {
	const {doc, panel, opener} = setup();
	const host = new SheetHost(panel, COMPOSE);
	const saved = [];
	openAltSheet(host, {previewUrl: 'blob:x', alt: ''}, opener, (alt) => saved.push(alt));
	const field = panel.querySelector('textarea');
	const done = panel.querySelector(`[data-role="${ROLES.done}"]`);
	assert.strictEqual(doc.activeElement, field);
	field.value = 'a'.repeat(COMPOSE.maxAltGraphemes + 1);
	field.dispatchEvent(new FakeEvent('input'));
	assert.strictEqual(done.disabled, true);
	field.value = '  説明  ';
	field.dispatchEvent(new FakeEvent('input'));
	assert.strictEqual(done.disabled, false);
	click(done);
	assert.deepStrictEqual(saved, ['説明']);
});

test('openLabelSheet: 成人向けの 1 つと生々しいメディアを選んで保存する', () => {
	const {panel, opener} = setup();
	const host = new SheetHost(panel, COMPOSE);
	const saved = [];
	openLabelSheet(host, {adult: null, graphic: false}, opener, (selection) => saved.push(selection));
	const inputs = panel.querySelectorAll('input');
	// なし・きわどい・ヌード・成人向け・生々しいメディアの順
	assert.strictEqual(inputs.length, COMPOSE.labels.adult.length + 2);
	assert.strictEqual(inputs[0].checked, true);
	// 偽の DOM はラジオを切り替えないため、ブラウザの既定動作の代わりに選んで change を送る
	inputs[2].checked = true;
	inputs[2].dispatchEvent(new FakeEvent('change'));
	click(inputs[inputs.length - 1]);
	click(panel.querySelector(`[data-role="${ROLES.done}"]`));
	assert.deepStrictEqual(saved, [{adult: COMPOSE.labels.adult[1], graphic: true}]);
});

test('openLanguageSheet: 上限まで選ぶと残りを止め、0 個では「完了」を押せない', () => {
	const {panel, opener} = setup();
	const host = new SheetHost(panel, COMPOSE);
	const saved = [];
	openLanguageSheet(host, {selected: ['ja', 'zz']}, opener, (codes) => saved.push(codes));
	const boxes = panel.querySelectorAll('input').filter((input) => input.type === 'checkbox');
	const byCode = (code) => boxes.find((box) => box.value === code);
	const done = panel.querySelector(`[data-role="${ROLES.done}"]`);
	assert.strictEqual(boxes.length, COMPOSE.languageCodes.length);
	assert.strictEqual(boxes[0].value, 'ja');
	assert.strictEqual(byCode('ja').checked, true);
	click(byCode('en'));
	click(byCode('de'));
	assert.strictEqual(byCode('fr').disabled, true);
	assert.strictEqual(byCode('en').disabled, false);
	click(byCode('ja'));
	click(byCode('en'));
	click(byCode('de'));
	assert.strictEqual(done.disabled, true);
	click(byCode('ko'));
	click(done);
	assert.deepStrictEqual(saved, [['ko']]);
});

test('SheetHost: 両端の番兵にフォーカスが来たら反対の端の操作要素へ回す', () => {
	const {doc, panel, opener} = setup();
	const host = new SheetHost(panel, COMPOSE);
	host.open(inputSpec(doc, {done: 0, cancel: 0}), opener);
	const layer = panel.querySelector(`[data-role="${ROLES.layer}"]`);
	const sentinels = panel.querySelectorAll(`[data-role="${ROLES.sentinel}"]`);
	assert.strictEqual(sentinels.length, 2);
	assert.strictEqual(layer.children[0], sentinels[0]);
	assert.strictEqual(layer.children[layer.children.length - 1], sentinels[1]);
	sentinels[0].dispatchEvent(new FakeEvent('focus'));
	assert.strictEqual(doc.activeElement, panel.querySelector(`[data-role="${ROLES.done}"]`));
	sentinels[1].dispatchEvent(new FakeEvent('focus'));
	assert.strictEqual(doc.activeElement, panel.querySelector('[data-role="test-input"]'));
});

test('SheetHost: 選んだラジオから Shift+Tab で戻っても画面の外へ出ない', () => {
	const {doc, panel, opener} = setup();
	const host = new SheetHost(panel, COMPOSE);
	openLabelSheet(host, {adult: COMPOSE.labels.adult[1], graphic: false}, opener, () => {});
	const layer = panel.querySelector(`[data-role="${ROLES.layer}"]`);
	const checked = panel.querySelectorAll('input').find((input) => input.checked);
	checked.focus();
	// 選ばれていないラジオは Tab の順に入らないため、Shift+Tab の行き先は先頭の番兵になる
	panel.querySelectorAll(`[data-role="${ROLES.sentinel}"]`)[0].dispatchEvent(new FakeEvent('focus'));
	assert.ok(layer.contains(doc.activeElement));
	// 番兵を飛ばして画面の下のボタンへ移っても、画面へ引き戻す
	opener.focus();
	opener.dispatchEvent(new FakeEvent('focusin'));
	assert.ok(layer.contains(doc.activeElement));
	assert.notStrictEqual(doc.activeElement, opener);
});

test('SheetHost: 外枠は tabindex=-1 で、余白を押して外枠に移ったフォーカスは引き戻さない', () => {
	const {doc, panel, opener} = setup();
	const host = new SheetHost(panel, COMPOSE);
	host.open(inputSpec(doc, {done: 0, cancel: 0}), opener);
	const layer = panel.querySelector(`[data-role="${ROLES.layer}"]`);
	assert.strictEqual(layer.getAttribute('tabindex'), '-1');
	layer.focus();
	layer.dispatchEvent(new FakeEvent('focusin'));
	assert.strictEqual(doc.activeElement, layer);
	pressKey(layer, 'Escape');
	assert.strictEqual(host.isOpen(), false);
	assert.strictEqual(doc.activeElement, opener);
});

test('SheetHost: 開いたボタンが消えていたら restoreFocus、無ければパネルの最初の操作要素へ戻す', () => {
	const {doc, panel, opener} = setup();
	const host = new SheetHost(panel, COMPOSE);
	const other = doc.createElement('button');
	panel.append(other);
	const replacement = doc.createElement('button');
	panel.append(replacement);
	host.open({...inputSpec(doc, {done: 0, cancel: 0}), onDone: () => opener.remove(),
		restoreFocus: () => replacement.focus()}, opener);
	click(panel.querySelector(`[data-role="${ROLES.done}"]`));
	assert.strictEqual(doc.activeElement, replacement);
	const reopened = doc.createElement('button');
	panel.append(reopened);
	host.open({...inputSpec(doc, {done: 0, cancel: 0}), onDone: () => reopened.remove()}, reopened);
	click(panel.querySelector(`[data-role="${ROLES.done}"]`));
	assert.strictEqual(doc.activeElement, other);
});

test('extensionOrigin: getURL の末尾の / を除く', () => {
	assert.strictEqual(extensionOrigin('chrome-extension://abc/'), 'chrome-extension://abc');
	assert.strictEqual(extensionOrigin('moz-extension://1234-uuid/'), 'moz-extension://1234-uuid');
	assert.strictEqual(extensionOrigin(''), '');
});

test('isEmojiMessage: origin が空なら受けない', () => {
	const frameWindow = {};
	assert.strictEqual(isEmojiMessage({source: frameWindow, origin: '', data: {type: COMPOSE.emoji.selectType}},
		frameWindow, '', COMPOSE.emoji), false);
});

test('SheetHost: isOpenedFrom は開いたボタンが入れ物の中にあるときだけ真', () => {
	const {doc, panel, opener} = setup();
	const host = new SheetHost(panel, COMPOSE);
	const form = doc.createElement('div');
	const inner = doc.createElement('button');
	form.append(inner);
	panel.append(form);
	assert.strictEqual(host.isOpenedFrom(form), false);
	host.open(inputSpec(doc, {done: 0, cancel: 0}), inner);
	assert.strictEqual(host.isOpenedFrom(form), true);
	assert.strictEqual(host.isOpenedFrom(doc.createElement('div')), false);
	assert.strictEqual(host.isOpenedFrom(null), false);
	host.close(false);
	host.open(inputSpec(doc, {done: 0, cancel: 0}), opener);
	assert.strictEqual(host.isOpenedFrom(form), false);
});

test('SheetHost: 開いたボタンが描き直しで外れても、持ち主 (owner) で isOpenedFrom が真になる', () => {
	const {doc, panel} = setup();
	const host = new SheetHost(panel, COMPOSE);
	const form = doc.createElement('div');
	const inner = doc.createElement('button');
	form.append(inner);
	panel.append(form);
	host.open(inputSpec(doc, {done: 0, cancel: 0}), inner, {owner: form});
	inner.remove();
	assert.strictEqual(host.isOpenedFrom(form), true);
	assert.strictEqual(host.isOpenedFrom(panel), true);
	assert.strictEqual(host.isOpenedFrom(doc.createElement('div')), false);
	host.close(false);
	assert.strictEqual(host.isOpenedFrom(form), false);
});

test('SheetHost: options の restoreFocus は spec の restoreFocus より優先する', () => {
	const {doc, panel, opener} = setup();
	const host = new SheetHost(panel, COMPOSE);
	const fromSpec = doc.createElement('button');
	const fromOptions = doc.createElement('button');
	panel.append(fromSpec, fromOptions);
	host.open({...inputSpec(doc, {done: 0, cancel: 0}), onDone: () => opener.remove(),
		restoreFocus: () => fromSpec.focus()}, opener, {restoreFocus: () => fromOptions.focus()});
	click(panel.querySelector(`[data-role="${ROLES.done}"]`));
	assert.strictEqual(doc.activeElement, fromOptions);
});
