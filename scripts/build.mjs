/**
 * 拡張機能をビルドする。
 * content script は MV3 で ESM を読めないため IIFE 1 本にまとめる。
 * page world へ注入する page-bridge.js は world が違うので別の束にし、こちらだけ strict にする。
 * content.css とポップアップの HTML / CSS / 配色トークンは静的ファイルとして置く。(static-files.mjs)
 * popup・絵文字・動画の再生は拡張のページとして開くので ESM で束ねる。束の作り方は BUNDLES の表 1 つにまとめ、
 * 通常のビルドと監視モードの両方がこの表を回す。
 *
 * 出力はブラウザごとに分ける。(scripts/browsers.mjs) Chrome 系は dist、Firefox は dist-firefox。
 * 束ねる元のソースは同じで、違うのは esbuild の target と manifest に差し込むキーだけ。
 *   node scripts/build.mjs                    両方
 *   node scripts/build.mjs --target=chrome    Chrome 系だけ
 *   node scripts/build.mjs --target=firefox   Firefox だけ
 *
 * version の出どころは package.json 1 か所。src/manifest.json は version を持たず、
 * ここで差し込む。minimum_chrome_version / strict_min_version も同様に
 * scripts/targets.mjs から差し込む。
 */
import { build as bundle, context } from 'esbuild';
import { copyFile, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { toManifestVersion } from './manifest-version.mjs';
// コピーする静的ファイルの表は static-files.mjs にある。(副作用なしのモジュールにしてテストからも読む)
import { staticFilesFor } from './static-files.mjs';
import { resolveTargets } from './browsers.mjs';
import { minifyCssText } from './css-text-plugin.mjs';
// 入口の表は副作用なしのモジュールに置く。(テストが manifest の参照先との突き合わせに読む)
import { CONTENT_ENTRY_POINTS, INJECT_ENTRY_POINTS, POPUP_ENTRY_POINTS, EMOJI_ENTRY_POINTS, VIDEO_ENTRY_POINTS } from './entry-points.mjs';

/** 監視モードで起動するか。 */
const WATCH = process.argv.includes('--watch');

/** version の出どころ。 */
const PACKAGE_JSON = 'package.json';

/** manifest の雛形。version を差し込むので静的ファイルの表とは別に扱う。 */
const MANIFEST_SOURCE = 'src/manifest.json';

/** 静的ファイルのうち、コピーの代わりに圧縮して書き出すもの。(popup が <link> で読む CSS) 監視中は素のまま置く。 */
const CSS_FILE_PATTERN = /\.css$/;

/**
 * MAIN world の束だけに付ける先頭行。2.8.1 までの page-bridge.js が明示していた strict を保つ。
 * content script の束には付けない。(2.8.1 までの content script は sloppy mode だった)
 */
const INJECT_BANNER = '"use strict";';

/**
 * 束 1 本の作り方。
 * @typedef {Object} BundleSpec
 * @property {string} name 束の名前 (表の中の目印)
 * @property {Record<string, string>|string[]} entryPoints 入口
 * @property {'iife'|'esm'} format content script と MAIN world は IIFE、拡張のページは ESM。どれも分割はしない
 * @property {{js: string}} [banner] 先頭に足す行
 */

/**
 * 束の表。出力先は同じでも書き出すファイルが重ならないため、並べて作れる。
 * content script は MV3 で ESM を読めないため IIFE。inject (MAIN world) は content と同じ作りに strict の先頭行だけ足す。
 * popup・絵文字ピッカーのページ・動画の再生 (hls.js を含む) は拡張のページなので ESM。
 * @type {readonly BundleSpec[]}
 */
const BUNDLES = Object.freeze([
	{ name: 'content', entryPoints: CONTENT_ENTRY_POINTS, format: 'iife' },
	{ name: 'inject', entryPoints: INJECT_ENTRY_POINTS, format: 'iife', banner: { js: INJECT_BANNER } },
	{ name: 'popup', entryPoints: POPUP_ENTRY_POINTS, format: 'esm' },
	{ name: 'emoji', entryPoints: EMOJI_ENTRY_POINTS, format: 'esm' },
	{ name: 'video', entryPoints: VIDEO_ENTRY_POINTS, format: 'esm' },
]);

/**
 * 束 1 本のブラウザごとの esbuild の設定を作る。
 * @param {import('./browsers.mjs').BrowserTarget} target 作るブラウザ
 * @param {BundleSpec} spec 束の作り方
 * @returns {import('esbuild').BuildOptions} esbuild の設定
 */
function bundleOptionsFor(target, spec) {
	return {
		entryPoints: spec.entryPoints,
		outdir: target.outDir,
		bundle: true,
		format: spec.format,
		target: target.esbuildTarget,
		// 監視中は読みやすさを残す。配布物は縮める
		minify: !WATCH,
		// 日本語などの文字を \uXXXX に逃がさず UTF-8 のまま出す
		charset: 'utf8',
		logLevel: 'info',
		...(spec.banner ? { banner: spec.banner } : {}),
	};
}

/**
 * 処理をすべて待ってから、1 件でも失敗していれば最初の失敗を投げる。
 * (外側の片付けが出力先を消す最中に、残りの書き込みが続かないように)
 * @template T
 * @param {Promise<T>[]} promises 待つ処理
 * @returns {Promise<T[]>} すべて成功したときの結果
 * @throws {*} 最初に見つかった失敗の理由
 */
async function settleAll(promises) {
	const results = await Promise.allSettled(promises);
	const failed = results.find((result) => result.status === 'rejected');
	if (failed) {
		throw failed.reason;
	}
	return results.map((result) => result.value);
}

/**
 * JSON ファイルを読む。
 * @param {string} path ファイルの場所
 * @returns {Promise<object>} 中身
 * @throws {Error} 読めない・JSON として解釈できないとき
 */
async function readJson(path) {
	let text;
	try {
		text = await readFile(path, 'utf8');
	} catch (error) {
		throw new Error(`${path} を読めません: ${error.message}`);
	}
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new Error(`${path} を JSON として読めません: ${error.message}`);
	}
}

/**
 * package.json の version を読んで検証する。
 * esbuild より前に呼び、不正な version で束ね終わってから落ちるのを避ける。(fail fast)
 * @returns {Promise<string>} package.json の version (semver のまま)
 * @throws {Error} version が manifest の規則に合わないとき
 */
async function readPackageVersion() {
	const { version } = await readJson(PACKAGE_JSON);
	toManifestVersion(version);
	return version;
}

/**
 * ブラウザ向けのキーを差し込んだ manifest を出力先へ書く。
 * @param {import('./browsers.mjs').BrowserTarget} target 作るブラウザ
 * @param {string} packageVersion package.json の version
 * @returns {Promise<string>} 書き込んだ version
 * @throws {Error} 雛形に version 等が残っているとき、version が規則に合わないとき
 */
async function writeManifest(target, packageVersion) {
	const manifest = await readJson(MANIFEST_SOURCE);
	const applied = target.buildManifest(manifest, packageVersion);
	// src/manifest.json と同じくタブ字下げで書く
	await writeFile(`${target.outDir}/manifest.json`, `${JSON.stringify(applied, null, '\t')}\n`, 'utf8');
	return applied.version;
}

/**
 * 静的ファイルを出力先へ置く。manifest は version を差し込むので別。(writeManifest)
 * @param {import('./browsers.mjs').BrowserTarget} target 作るブラウザ
 * @returns {Promise<void>}
 */
async function copyStatic(target) {
	// 1 件が落ちても残りの書き込みを待ってから投げる
	await settleAll(staticFilesFor(target.outDir).map(async ([from, to]) => {
		// コピー先からディレクトリを決める。置き場所が増えても書き足さなくて済む
		await mkdir(dirname(to), { recursive: true });
		try {
			if (CSS_FILE_PATTERN.test(from) && !WATCH) {
				await writeFile(to, await minifyCssText(await readFile(from, 'utf8'), target.esbuildTarget), 'utf8');
			} else {
				await copyFile(from, to);
			}
		} catch (error) {
			// コピー元の名前を付ける。(npm run build:icons の生成忘れなどに気づけるように)
			throw new Error(`${from} をコピーできません: ${error.message}`);
		}
	}));
}

/**
 * 束ね以外の成果物 (静的ファイルと manifest) を出力先へ置く。
 * @param {import('./browsers.mjs').BrowserTarget} target 作るブラウザ
 * @param {string} packageVersion package.json の version
 * @returns {Promise<void>}
 */
async function emitAssets(target, packageVersion) {
	await copyStatic(target);
	console.log(`[${target.name}] ${target.outDir}/ manifest version ${await writeManifest(target, packageVersion)}`);
}

/**
 * 出力先を空にして作り直す。
 * @param {import('./browsers.mjs').BrowserTarget} target 作るブラウザ
 * @returns {Promise<void>}
 */
async function resetOutDir(target) {
	await rm(target.outDir, { recursive: true, force: true });
	// writeManifest が出力先の存在を esbuild 任せにしないよう、先に作っておく
	await mkdir(target.outDir, { recursive: true });
}

/**
 * 作り終えたブラウザの名前。失敗したときに、ここに入っている出力は消さずに残す。
 * @type {Set<string>}
 */
const completed = new Set();

/**
 * ビルドを実行する。1 ブラウザ作り終えるたびに completed へ入れる。
 * @param {import('./browsers.mjs').BrowserTarget[]} targets 作るブラウザ
 * @returns {Promise<void>}
 */
async function build(targets) {
	const packageVersion = await readPackageVersion();

	if (WATCH) {
		for (const target of targets) {
			await resetOutDir(target);
			const contexts = await settleAll(BUNDLES.map((spec) => context(bundleOptionsFor(target, spec))));
			await settleAll(contexts.map((ctx) => ctx.watch()));
			await emitAssets(target, packageVersion);
			completed.add(target.name);
		}
		// esbuild が見張るのは JS だけ。manifest / popup / version を変えたら再起動する
		console.log('watching... (静的ファイルと version の同期は起動時の 1 回だけ)');
		return;
	}

	// 1 ブラウザずつ最後まで作る。Chrome 系が先なので、Firefox 側で落ちても dist は作り終えている
	for (const target of targets) {
		await resetOutDir(target);
		await settleAll(BUNDLES.map((spec) => bundle(bundleOptionsFor(target, spec))));
		await emitAssets(target, packageVersion);
		completed.add(target.name);
	}
}

/** 今回作るブラウザ。引数が正しくなければ何も消さずに止める。 */
let targets;
try {
	targets = resolveTargets(process.argv.slice(2));
} catch (error) {
	console.error(`[build] ${error?.message ?? error}`);
	process.exit(1);
}

try {
	await build(targets);
} catch (error) {
	console.error(`[build] ${error?.message ?? error}`);
	// 作り終えていないブラウザの出力だけを消す。片付けの失敗は表示するだけにする
	for (const target of targets) {
		if (completed.has(target.name)) {
			console.error(`[build] ${target.outDir} は作り終えているので残します`);
			continue;
		}
		try {
			await rm(target.outDir, { recursive: true, force: true });
		} catch (cleanupError) {
			console.error(`[build] ${target.outDir} を消せませんでした: ${cleanupError?.message ?? cleanupError}`);
		}
	}
	process.exit(1);
}
