import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
	SITE_LANGUAGES,
	relativeHref,
	renderPage,
	renderSitemap,
	syncSiteLanguages,
	localDate,
} from '../../scripts/site-langs.mjs';

const [JA, EN] = SITE_LANGUAGES;

/** 目印だけを持つ最小のページ。 */
const SKELETON = [
	'<head>',
	'<!-- lang:head -->',
	'<!-- /lang:head -->',
	'</head>',
	'\t<!-- lang:menu -->',
	'\t<!-- /lang:menu -->',
	'\t\t<!-- lang:footer -->',
	'\t\t<!-- /lang:footer -->',
].join('\n');

test('サイトの言語は日本語を先頭 (x-default) に 2 つ', () => {
	assert.deepEqual(SITE_LANGUAGES.map((one) => one.hreflang), ['ja', 'en']);
	assert.equal(JA.dir, '');
});

test('relativeHref はページの深さに合わせた相対リンクを返す', () => {
	assert.equal(relativeHref(JA, JA, 'index.html'), './');
	assert.equal(relativeHref(JA, EN, 'index.html'), 'en/');
	assert.equal(relativeHref(EN, JA, 'index.html'), '../');
	assert.equal(relativeHref(EN, JA, 'privacy.html'), '../privacy.html');
	// 同じ言語へのリンクは同じフォルダの中で閉じる
	assert.equal(relativeHref(EN, EN, 'privacy.html'), 'privacy.html');
	assert.equal(relativeHref(EN, EN, 'index.html'), './');
});

test('renderPage は目印の中だけを書き直し、今の言語に印を付ける', () => {
	const html = renderPage(SKELETON, EN, 'index.html');
	assert.match(html, /<link rel="canonical" href="https:\/\/xvbluesky\.neonsdesign\.com\/en\/">/);
	assert.match(html, /hreflang="x-default" href="https:\/\/xvbluesky\.neonsdesign\.com\/"/);
	assert.match(html, /<a href="\.\/" hreflang="en" lang="en" aria-current="true">English<\/a>/);
	assert.match(html, /<span class="visually-hidden">Language: <\/span>/);
	// フッターは自分以外の言語だけ
	const footer = html.slice(html.indexOf('<!-- lang:footer -->'));
	assert.equal(footer.match(/<li>/g).length, SITE_LANGUAGES.length - 1);
	assert.ok(!footer.includes('>English<'));
	// 目印の行のインデントが中身にも付く
	assert.match(html, /\n\t\t<li><a href="\.\.\/"/);
});

test('renderPage は何度かけても同じ結果になり、改行をページに合わせる', () => {
	const once = renderPage(SKELETON.replace(/\n/g, '\r\n'), JA, 'privacy.html');
	assert.equal(renderPage(once, JA, 'privacy.html'), once);
	assert.ok(!/[^\r]\n/.test(once), 'LF だけの改行が混ざっている');
});

test('renderPage は目印が欠けていれば投げる', () => {
	assert.throws(() => renderPage('<head></head>', JA, 'index.html'), /lang:head/);
});

test('renderSitemap は全ページを並べ、既存の lastmod を引き継ぐ', () => {
	const previous = '<url>\n\t\t<loc>https://xvbluesky.neonsdesign.com/</loc>\n\t\t<lastmod>2026-01-01</lastmod>';
	const xml = renderSitemap(previous, '2026-10-18');
	assert.equal(xml.match(/<url>/g).length, SITE_LANGUAGES.length * 2);
	assert.match(xml, /<loc>https:\/\/xvbluesky\.neonsdesign\.com\/<\/loc>\n\t\t<lastmod>2026-01-01<\/lastmod>/);
	assert.match(xml, /<loc>https:\/\/xvbluesky\.neonsdesign\.com\/en\/privacy\.html<\/loc>\n\t\t<lastmod>2026-10-18<\/lastmod>/);
});

test('localDate は手元の日付を 0 埋めの YYYY-MM-DD にする', () => {
	// 月と日は 1 桁でも 2 桁にする
	assert.equal(localDate(new Date(2026, 0, 5, 12, 0)), '2026-01-05');
	assert.equal(localDate(new Date(2026, 11, 31, 12, 0)), '2026-12-31');
});

test('localDate は UTC ではなく手元の時刻の日付を返す', () => {
	// 手元の 0 時台は UTC だと前日になる地域 (日本など) があるが、手元の日付を返す
	const midnight = new Date(2026, 9, 2, 0, 30);
	assert.equal(localDate(midnight), '2026-10-02');
});

test('site/ の全ページと sitemap.xml は言語の表と揃っている', async () => {
	// 揃っていなければ npm run build:site-langs を走らせる
	const siteDir = fileURLToPath(new URL('../../site/', import.meta.url));
	assert.deepEqual(await syncSiteLanguages({ siteDir, check: true }), []);
});
