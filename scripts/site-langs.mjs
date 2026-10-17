/**
 * 紹介サイト (site/) の言語まわりの重複をまとめて書き直す。
 *
 * 全ページが同じ言語の一覧を 3 か所 (head の canonical と hreflang / ヘッダーの言語メニュー / フッターのリンク)
 * に持ち、sitemap.xml も同じ一覧を持つ。手で揃えると必ずずれるので、SITE_LANGUAGES の表 1 つから起こす。
 * ページ側は `<!-- lang:名前 -->` と `<!-- /lang:名前 -->` で囲んだ範囲だけが書き換わり、本文には触れない。
 *
 * 使い方: node scripts/site-langs.mjs          ページと sitemap.xml を書き直す
 *         node scripts/site-langs.mjs --check  書き直しが要るかだけを見る (要れば終了コード 1)
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** サイトの公開 URL。末尾のスラッシュまで含める。 */
export const SITE_ORIGIN = 'https://xvbluesky.neonsdesign.com/';

/**
 * サイトの言語。並びがメニューとフッターの並びになる。先頭が x-default (ルートに置く言語)。
 * dir: site/ からのフォルダ (末尾スラッシュ付き。ルートは空文字)
 * hreflang: hreflang と lang 属性の値
 * name: その言語自身での名前 (メニューに出す)
 * menuPrefix: メニューのボタンの読み上げで言語名の前に足す語。区切りの記号まで含める
 * @type {ReadonlyArray<{dir: string, hreflang: string, name: string, menuPrefix: string}>}
 */
export const SITE_LANGUAGES = Object.freeze([
	Object.freeze({ dir: '', hreflang: 'ja', name: '日本語', menuPrefix: '表示言語: ' }),
	Object.freeze({ dir: 'en/', hreflang: 'en', name: 'English', menuPrefix: 'Language: ' }),
]);

/** 言語ごとに持つページ。index.html はフォルダの URL (末尾スラッシュ) で指す。 */
export const SITE_PAGES = Object.freeze(['index.html', 'privacy.html']);

/** 目印の中身を差し替えるブロックの名前。 */
const BLOCKS = Object.freeze({ HEAD: 'head', MENU: 'menu', FOOTER: 'footer' });

/** ボタンに出す地球儀の図形。(Material Symbols の language) */
const GLOBE_PATH = 'M323-111.5Q250-143 196-197t-85-127.5Q80-398 80-482t31-156.5Q142-711 196-765t127-84.5Q396-880 480-880t157 30.5Q710-819 764-765t85 126.5Q880-566 880-482t-31 157.5Q818-251 764-197t-127 85.5Q564-80 480-80t-157-31.5ZM480-138q35-36 58.5-82.5T577-331H384q14 60 37.5 108t58.5 85Zm-85-12q-25-38-43-82t-30-99H172q38 71 88 111.5T395-150Zm171-1q72-23 129.5-69T788-331H639q-13 54-30.5 98T566-151ZM152-391h159q-3-27-3.5-48.5T307-482q0-25 1-44.5t4-43.5H152q-7 24-9.5 43t-2.5 45q0 26 2.5 46.5T152-391Zm221 0h215q4-31 5-50.5t1-40.5q0-20-1-38.5t-5-49.5H373q-4 31-5 49.5t-1 38.5q0 21 1 40.5t5 50.5Zm275 0h160q7-24 9.5-44.5T820-482q0-26-2.5-45t-9.5-43H649q3 35 4 53.5t1 34.5q0 22-1.5 41.5T648-391Zm-10-239h150q-33-69-90.5-115T565-810q25 37 42.5 80T638-630Zm-254 0h194q-11-53-37-102.5T480-820q-32 27-54 71t-42 119Zm-212 0h151q11-54 28-96.5t43-82.5q-75 19-131 64t-91 115Z';

/** ボタンの開閉を示す山形の図形。(Material Symbols の keyboard_arrow_down) */
const CARET_PATH = 'M469-358q-5-2-10-7L261-563q-9-9-8.5-21.5T262-606q9-9 21.5-9t21.5 9l175 176 176-176q9-9 21-8.5t21 9.5q9 9 9 21.5t-9 21.5L501-365q-5 5-10 7t-11 2q-6 0-11-2Z';

/**
 * ページの公開 URL の、サイトのルートからの相対パス。
 * @param {{dir: string}} language 言語
 * @param {string} page SITE_PAGES のどれか
 * @returns {string} 'en/' / 'en/privacy.html' / '' など
 */
function sitePath(language, page) {
	return language.dir + (page === 'index.html' ? '' : page);
}

/**
 * あるページから別の言語の同じページへの相対リンク。
 * @param {{dir: string}} from 今のページの言語
 * @param {{dir: string}} to 行き先の言語
 * @param {string} page SITE_PAGES のどれか
 * @returns {string} './' / '../' / 'ko/privacy.html' など
 */
export function relativeHref(from, to, page) {
	const target = from.dir === to.dir
		? sitePath({ dir: '' }, page)
		: (from.dir ? '../' : '') + sitePath(to, page);
	return target === '' ? './' : target;
}

/**
 * head に置く canonical と hreflang の行。
 * @param {{dir: string}} current 今のページの言語
 * @param {string} page SITE_PAGES のどれか
 * @returns {string[]} 行 (インデントなし)
 */
function renderHead(current, page) {
	const lines = [`<link rel="canonical" href="${SITE_ORIGIN}${sitePath(current, page)}">`];
	for (const language of SITE_LANGUAGES) {
		lines.push(`<link rel="alternate" hreflang="${language.hreflang}" href="${SITE_ORIGIN}${sitePath(language, page)}">`);
	}
	lines.push(`<link rel="alternate" hreflang="x-default" href="${SITE_ORIGIN}${sitePath(SITE_LANGUAGES[0], page)}">`);
	return lines;
}

/**
 * ヘッダーの言語メニュー。
 * @param {{dir: string, hreflang: string, name: string, menuPrefix: string}} current 今のページの言語
 * @param {string} page SITE_PAGES のどれか
 * @returns {string[]} 行 (インデントなし)
 */
function renderMenu(current, page) {
	const lines = [
		'<details class="lang-menu">',
		'\t<summary>',
		`\t\t<svg class="lang-menu-globe" viewBox="0 -960 960 960" aria-hidden="true"><path d="${GLOBE_PATH}"/></svg>`,
		`\t\t<span class="visually-hidden">${current.menuPrefix}</span><span>${current.name}</span>`,
		`\t\t<svg class="lang-menu-caret" viewBox="0 -960 960 960" aria-hidden="true"><path d="${CARET_PATH}"/></svg>`,
		'\t</summary>',
		'\t<ul class="lang-menu-list">',
	];
	for (const language of SITE_LANGUAGES) {
		const currentMark = language === current ? ' aria-current="true"' : '';
		lines.push(`\t\t<li><a href="${relativeHref(current, language, page)}" hreflang="${language.hreflang}" lang="${language.hreflang}"${currentMark}>${language.name}</a></li>`);
	}
	lines.push('\t</ul>', '</details>');
	return lines;
}

/**
 * フッターのリンク一覧に並べる、他の言語へのリンク。
 * @param {{dir: string}} current 今のページの言語
 * @param {string} page SITE_PAGES のどれか
 * @returns {string[]} 行 (インデントなし)
 */
function renderFooter(current, page) {
	return SITE_LANGUAGES
		.filter((language) => language !== current)
		.map((language) => `<li><a href="${relativeHref(current, language, page)}" hreflang="${language.hreflang}" lang="${language.hreflang}">${language.name}</a></li>`);
}

/**
 * 目印で囲んだ範囲を差し替える。目印の行のインデントを中身にも付ける。
 * @param {string} html ページの中身
 * @param {string} name ブロックの名前
 * @param {string[]} lines 中身の行 (インデントなし)
 * @param {string} eol 改行
 * @returns {string} 差し替えた中身
 * @throws {Error} 目印が無いか、2 組以上あるとき
 */
function replaceBlock(html, name, lines, eol) {
	const pattern = new RegExp(`([ \\t]*)<!-- lang:${name} -->[\\s\\S]*?<!-- /lang:${name} -->`, 'g');
	const matches = [...html.matchAll(pattern)];
	if (matches.length !== 1) throw new Error(`<!-- lang:${name} --> の目印が ${matches.length} 組あります (1 組だけ置いてください)`);
	const [match] = matches;
	const indent = match[1];
	const body = [`<!-- lang:${name} -->`, ...lines, `<!-- /lang:${name} -->`].map((line) => indent + line).join(eol);
	return html.slice(0, match.index) + body + html.slice(match.index + match[0].length);
}

/**
 * 1 ページ分の言語まわりを書き直した中身を返す。改行はページのものに合わせる。
 * @param {string} html ページの中身
 * @param {{dir: string, hreflang: string, name: string, menuPrefix: string}} current そのページの言語
 * @param {string} page SITE_PAGES のどれか
 * @returns {string} 書き直した中身
 */
export function renderPage(html, current, page) {
	const eol = html.includes('\r\n') ? '\r\n' : '\n';
	let result = replaceBlock(html, BLOCKS.HEAD, renderHead(current, page), eol);
	result = replaceBlock(result, BLOCKS.MENU, renderMenu(current, page), eol);
	result = replaceBlock(result, BLOCKS.FOOTER, renderFooter(current, page), eol);
	return result;
}

/**
 * sitemap.xml の中身。lastmod は元のファイルにあった値を引き継ぎ、無ければ today を使う。
 * @param {string} previous 今の sitemap.xml (無ければ空文字)
 * @param {string} today 'YYYY-MM-DD'
 * @returns {string} sitemap.xml の中身 (改行は LF)
 */
export function renderSitemap(previous, today) {
	const lastmods = new Map();
	for (const match of previous.matchAll(/<loc>([^<]+)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/g)) {
		lastmods.set(match[1], match[2]);
	}
	const lines = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
		'        xmlns:xhtml="http://www.w3.org/1999/xhtml">',
	];
	for (const current of SITE_LANGUAGES) {
		for (const page of SITE_PAGES) {
			const loc = SITE_ORIGIN + sitePath(current, page);
			lines.push('', '\t<url>', `\t\t<loc>${loc}</loc>`, `\t\t<lastmod>${lastmods.get(loc) ?? today}</lastmod>`);
			for (const language of SITE_LANGUAGES) {
				lines.push(`\t\t<xhtml:link rel="alternate" hreflang="${language.hreflang}" href="${SITE_ORIGIN}${sitePath(language, page)}"/>`);
			}
			lines.push(`\t\t<xhtml:link rel="alternate" hreflang="x-default" href="${SITE_ORIGIN}${sitePath(SITE_LANGUAGES[0], page)}"/>`, '\t</url>');
		}
	}
	lines.push('', '</urlset>', '');
	return lines.join('\n');
}

/**
 * 手元の日付を 'YYYY-MM-DD' にする。(UTC ではなく実行した場所の日付)
 * @param {Date} [date] 日時
 * @returns {string} 'YYYY-MM-DD'
 */
export function localDate(date = new Date()) {
	const pad = (value) => String(value).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * ページと sitemap.xml を書き直す。check が真なら書かずに、差のあるファイルを返すだけにする。
 * sitemap.xml の改行は元のファイルに合わせる。(無ければ CRLF)
 * @param {{siteDir: string, check?: boolean, today?: string}} options site/ の場所など
 * @returns {Promise<string[]>} 中身が変わる (変わった) ファイルのパス
 */
export async function syncSiteLanguages({ siteDir, check = false, today = localDate() }) {
	const changed = [];
	for (const language of SITE_LANGUAGES) {
		for (const page of SITE_PAGES) {
			const file = path.join(siteDir, language.dir, page);
			const html = await readFile(file, 'utf8');
			const next = renderPage(html, language, page);
			if (next === html) continue;
			changed.push(file);
			if (!check) await writeFile(file, next);
		}
	}
	const sitemapFile = path.join(siteDir, 'sitemap.xml');
	const sitemap = await readFile(sitemapFile, 'utf8').catch(() => '');
	const sitemapEol = sitemap === '' || sitemap.includes('\r\n') ? '\r\n' : '\n';
	const nextSitemap = renderSitemap(sitemap.replace(/\r\n/g, '\n'), today);
	if (nextSitemap !== sitemap.replace(/\r\n/g, '\n')) {
		changed.push(sitemapFile);
		if (!check) await writeFile(sitemapFile, nextSitemap.replace(/\n/g, sitemapEol));
	}
	return changed;
}

if (import.meta.main) {
	const check = process.argv.includes('--check');
	const siteDir = fileURLToPath(new URL('../site/', import.meta.url));
	try {
		const changed = await syncSiteLanguages({ siteDir, check });
		for (const file of changed) console.log(`${check ? '要更新' : '更新'}: ${path.relative(process.cwd(), file)}`);
		if (changed.length === 0) console.log('言語まわりは揃っています');
		if (check && changed.length > 0) process.exitCode = 1;
	} catch (error) {
		console.error(`[site-langs] ${error?.message ?? error}`);
		process.exitCode = 1;
	}
}
