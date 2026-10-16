/**
 * ブラウザごとのビルド設定。build.mjs がこの表を回して出力を作る。
 * テストからも読むので副作用を持たせない。
 *
 * **Firefox 用のキーや target は Firefox の出力 (dist-firefox) にだけ入れ、Chrome 系 (dist) へは何も足さない。**
 */
import { applyVersion, applyMinimumChromeVersion, applyFirefoxSettings, assertNoBrowserOnlyKeys } from './manifest-version.mjs';
import { OUT_DIR, FIREFOX_OUT_DIR } from './static-files.mjs';
import { ESBUILD_TARGET, MINIMUM_CHROME_VERSION, ESBUILD_TARGET_FIREFOX, FIREFOX_STRICT_MIN_VERSION } from './targets.mjs';

/**
 * AMO (addons.mozilla.org) のアドオン ID。
 * **AMO へ一度提出したら変えられない。** storage.sync の保存先もこの ID に紐づくので、変えると設定が引き継がれない。
 * neonsdesign.com の持ち主であることを示す形にしてある。
 */
export const FIREFOX_ADDON_ID = 'bluesky-extension@neonsdesign.com';

/**
 * @typedef {object} BrowserTarget
 * @property {string} name --target に渡す名前
 * @property {string} outDir 出力先
 * @property {string} esbuildTarget esbuild の target
 * @property {(manifest: object, packageVersion: string) => object} buildManifest 雛形から出力用の manifest を作る
 */

/** @type {Readonly<Record<string, Readonly<BrowserTarget>>>} */
export const BROWSER_TARGETS = Object.freeze({
	chrome: Object.freeze({
		name: 'chrome',
		outDir: OUT_DIR,
		esbuildTarget: ESBUILD_TARGET,
		buildManifest: (manifest, packageVersion) =>
			applyMinimumChromeVersion(applyVersion(assertNoBrowserOnlyKeys(manifest), packageVersion), MINIMUM_CHROME_VERSION),
	}),
	firefox: Object.freeze({
		name: 'firefox',
		outDir: FIREFOX_OUT_DIR,
		esbuildTarget: ESBUILD_TARGET_FIREFOX,
		// minimum_chrome_version は入れない。(Firefox は無視するが、Firefox 用の出力に Chrome の下限を書く意味が無い)
		buildManifest: (manifest, packageVersion) =>
			applyFirefoxSettings(applyVersion(assertNoBrowserOnlyKeys(manifest), packageVersion), {
				id: FIREFOX_ADDON_ID,
				strictMinVersion: FIREFOX_STRICT_MIN_VERSION,
			}),
	}),
});

/** --target 以外に受け付ける引数。これ以外の引数は打ち間違いとして止める。 */
export const OTHER_BUILD_FLAGS = Object.freeze(['--watch']);

/** --target を省いたときに作るブラウザ。(両方) */
export const DEFAULT_TARGET_NAMES = Object.freeze(['chrome', 'firefox']);

/**
 * コマンドライン引数から作るブラウザを決める。
 * `--target=chrome` / `--target firefox` / `--target=chrome,firefox` を受け付ける。省けば両方。
 * それ以外の引数は OTHER_BUILD_FLAGS (`--watch`) だけを通す。`--targets=chrome` のような打ち間違いを
 * 黙って無視すると、両方を作り直して意図しない出力先を消すため。
 * @param {string[]} argv process.argv.slice(2) 相当
 * @returns {Readonly<BrowserTarget>[]} 作るブラウザの設定 (Chrome 系が先)
 * @throws {Error} 知らない名前・知らない引数、または --target の値が空のとき
 */
export function resolveTargets(argv) {
	const names = [];
	for (let at = 0; at < argv.length; at += 1) {
		const arg = argv[at];
		let value;
		if (arg.startsWith('--target=')) {
			value = arg.slice('--target='.length);
		} else if (arg === '--target') {
			value = argv[at + 1] ?? '';
			// 値として使った次の要素は読み飛ばす
			at += 1;
		} else if (OTHER_BUILD_FLAGS.includes(arg)) {
			continue;
		} else {
			throw new Error(`知らない引数です: ${arg} (--target=chrome|firefox / --watch)`);
		}
		const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
		if (parts.length === 0) throw new Error('--target に値がありません (chrome / firefox)');
		names.push(...parts);
	}
	const wanted = names.length > 0 ? names : [...DEFAULT_TARGET_NAMES];
	for (const name of wanted) {
		if (!Object.hasOwn(BROWSER_TARGETS, name)) {
			throw new Error(`知らない --target です: ${name} (chrome / firefox)`);
		}
	}
	// 並びは表の順に揃える。(重複も落とす) Chrome 系を先に作り、Firefox 側の失敗より先に dist を出す
	return Object.values(BROWSER_TARGETS).filter((target) => wanted.includes(target.name));
}
