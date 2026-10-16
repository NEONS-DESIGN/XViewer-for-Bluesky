/**
 * package.json の version を Chrome 拡張の manifest が受け付ける形へ整える。
 *
 * テストから読むので副作用を持たせない。
 *
 * manifest の version の規則:
 *   - 1 個から 4 個の整数をドットで繋いだもの
 *   - 各整数は 0 以上 65535 以下
 *   - 0 以外の整数は 0 で始められない (032 は不正)
 *   - 全ての整数が 0 ではいけない (0 と 0.0.0.0 は不正。0.1.0.0 は正しい)
 *
 * semver の prerelease / build metadata (0.2.0-beta.1+abc) は version には書けない。
 * 落としたうえで、表示用の version_name に元の文字列を残す。
 *
 * version の規則は Chrome のほうが狭い (Firefox は各成分 9 桁まで) ので、Chrome の規則だけを見れば両方に通る。
 * ブラウザごとのキー (minimum_chrome_version / browser_specific_settings) の差し込みもここに置く。
 */

/** version の成分として認める形。0 か、0 で始まらない整数。 */
const VERSION_PART_PATTERN = /^(?:0|[1-9]\d*)$/;

/** ドットで区切った成分の数の下限と上限。 */
const VERSION_PART_MIN_COUNT = 1;
const VERSION_PART_MAX_COUNT = 4;

/** 各成分の上限。 */
const VERSION_PART_MAX = 65535;

/** semver の prerelease / build metadata。version には書けないので落とす。 */
const SEMVER_SUFFIX_PATTERN = /[-+].*$/;

/** 雛形 (src/manifest.json) に書いてはいけないキー。出どころが 2 つに割れるのを防ぐ。 */
const VERSION_KEYS = ['version', 'version_name'];

/**
 * package.json の version を manifest の version へ変換する。
 * @param {string} version package.json の version
 * @returns {string} manifest に書ける version
 * @throws {Error} manifest の規則に合わないとき
 */
export function toManifestVersion(version) {
	if (typeof version !== 'string' || version.trim() === '') {
		throw new Error('package.json に version がありません');
	}

	const core = version.trim().replace(SEMVER_SUFFIX_PATTERN, '');
	const parts = core.split('.');

	if (parts.length < VERSION_PART_MIN_COUNT || parts.length > VERSION_PART_MAX_COUNT) {
		throw new Error(
			`version はドット区切りで ${VERSION_PART_MIN_COUNT}-${VERSION_PART_MAX_COUNT} 個の整数にしてください: ${version}`,
		);
	}
	for (const part of parts) {
		if (!VERSION_PART_PATTERN.test(part)) {
			throw new Error(`version の成分が整数でないか 0 で始まっています: ${version}`);
		}
		if (Number(part) > VERSION_PART_MAX) {
			throw new Error(`version の成分は ${VERSION_PART_MAX} 以下にしてください: ${version}`);
		}
	}
	if (parts.every((part) => part === '0')) {
		throw new Error(`version を全て 0 にはできません: ${version}`);
	}

	return core;
}

/**
 * manifest の内容に version を差し込む。
 * 渡された manifest は書き換えず、新しいオブジェクトを返す。
 * 雛形に version / version_name が残っていたら止める。黙って上書きすると、
 * 書き戻した人が「出どころは package.json 1 か所」の決まりに気づけない。
 * @param {object} manifest src/manifest.json の内容 (version を持たない)
 * @param {string} packageVersion package.json の version
 * @returns {object} version を差し込んだ manifest
 * @throws {Error} 雛形に version があるとき、version が manifest の規則に合わないとき
 */
export function applyVersion(manifest, packageVersion) {
	for (const key of VERSION_KEYS) {
		if (key in manifest) {
			throw new Error(`src/manifest.json に ${key} を書かないでください (出どころは package.json の version)`);
		}
	}
	const version = toManifestVersion(packageVersion);
	const applied = { ...manifest, version };
	// prerelease を落としたときだけ、元の文字列を表示用に残す。
	// 常に付けると version と同じ文字列が二重に並ぶだけになる
	const original = packageVersion.trim();
	if (original !== version) applied.version_name = original;
	return applied;
}

/**
 * manifest の内容に minimum_chrome_version を差し込む。
 * 出どころは scripts/targets.mjs。(esbuild の target と同じ値) 雛形に書いてあったら止める。
 * @param {object} manifest manifest の内容 (minimum_chrome_version を持たない)
 * @param {string} minimumChromeVersion 差し込む値 ("120" のようなメジャーバージョン)
 * @returns {object} 差し込んだ manifest
 * @throws {Error} 雛形に minimum_chrome_version があるとき、値がメジャーバージョンの形でないとき
 */
export function applyMinimumChromeVersion(manifest, minimumChromeVersion) {
	if ('minimum_chrome_version' in manifest) {
		throw new Error('src/manifest.json に minimum_chrome_version を書かないでください (出どころは scripts/targets.mjs)');
	}
	if (!VERSION_PART_PATTERN.test(String(minimumChromeVersion))) {
		throw new Error(`minimum_chrome_version はメジャーバージョンの整数にしてください: ${minimumChromeVersion}`);
	}
	return { ...manifest, minimum_chrome_version: String(minimumChromeVersion) };
}

/** AMO のアドオン ID として認める形。(メールアドレス風の形。Firefox の manifest スキーマの規則) */
const GECKO_ID_PATTERN = /^[a-zA-Z0-9-._]*@[a-zA-Z0-9-._]+$/;

/** strict_min_version として認める形。("140.0" のようなメジャー.マイナー) */
const GECKO_VERSION_PATTERN = /^[1-9]\d*\.\d+$/;

/**
 * manifest の内容に Firefox 用の browser_specific_settings を差し込む。
 * Chrome 系の manifest には入れない。(Chrome は知らないキーとして拡張機能のページに警告を出す)
 * 雛形 (src/manifest.json) に書いてあったら止める。Chrome 系の出力へ漏れるため。
 * データは集めないので data_collection_permissions は "none" だけを宣言する。(AMO が新規登録に求める)
 * @param {object} manifest manifest の内容 (browser_specific_settings を持たない)
 * @param {{id: string, strictMinVersion: string}} settings アドオン ID と対応する Firefox の下限
 * @returns {object} 差し込んだ manifest
 * @throws {Error} 雛形に browser_specific_settings があるとき、ID や版の形が正しくないとき
 */
export function applyFirefoxSettings(manifest, { id, strictMinVersion }) {
	if ('browser_specific_settings' in manifest) {
		throw new Error('src/manifest.json に browser_specific_settings を書かないでください (Firefox 用の出力だけにビルドが差し込む)');
	}
	if (!GECKO_ID_PATTERN.test(String(id))) {
		throw new Error(`Firefox のアドオン ID の形が正しくありません: ${id}`);
	}
	if (!GECKO_VERSION_PATTERN.test(String(strictMinVersion))) {
		throw new Error(`strict_min_version は "140.0" の形にしてください: ${strictMinVersion}`);
	}
	return {
		...manifest,
		browser_specific_settings: {
			gecko: {
				id,
				strict_min_version: strictMinVersion,
				data_collection_permissions: { required: ['none'] },
			},
		},
	};
}

/**
 * ブラウザごとにビルドが差し込むキー。雛形 (src/manifest.json) に書くと、差し込み先でないブラウザの出力へ漏れる。
 * (browser_specific_settings が Chrome 系の dist やストアへ上げる CRX に入る、など)
 */
const BROWSER_ONLY_KEYS = Object.freeze(['minimum_chrome_version', 'browser_specific_settings']);

/**
 * 雛形にブラウザごとのキーが無いことを確かめる。どのブラウザ向けのビルドでも最初に通す。
 * (Firefox 向けを作らない `--target=chrome` / pack:crx でも止まるように)
 * @param {object} manifest src/manifest.json の内容
 * @returns {object} 渡された manifest (そのまま)
 * @throws {Error} ブラウザごとのキーがあるとき
 */
export function assertNoBrowserOnlyKeys(manifest) {
	for (const key of BROWSER_ONLY_KEYS) {
		if (key in manifest) {
			throw new Error(`src/manifest.json に ${key} を書かないでください (ビルドがブラウザごとの出力にだけ差し込む)`);
		}
	}
	return manifest;
}
