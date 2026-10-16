/**
 * 対応するブラウザの下限。(Chrome 系と Firefox)
 *
 * 対応する Chrome の下限。esbuild の target と manifest の minimum_chrome_version の出どころはここ 1 か所。
 *
 * 下限を決めている機能:
 *   - content_scripts の "world": "MAIN" (111+)。これより古いと world が無視され、page-bridge.js が黙って壊れる
 *   - color-mix() (111+)、CSS nesting (120+)
 * 上限側の機能 (appearance: base-select 等) は進行的強化で、無くても動く。
 */

/** Chrome のメジャーバージョンの下限。 */
export const MINIMUM_CHROME_MAJOR = 120;

/** esbuild の target。構文の変換をこの版に合わせる。 */
export const ESBUILD_TARGET = `chrome${MINIMUM_CHROME_MAJOR}`;

/** manifest の minimum_chrome_version。ビルド時に差し込む。(src/manifest.json には書かない) */
export const MINIMUM_CHROME_VERSION = String(MINIMUM_CHROME_MAJOR);

/*
 * 対応する Firefox の下限。esbuild の target と manifest の strict_min_version の出どころはここ 1 か所。
 *
 * 下限を決めている機能:
 *   - content_scripts の "world": "MAIN" (128+)
 *   - content_scripts を manifest の登録順に走らせる保証 (139+)
 *   - browser_specific_settings.gecko.data_collection_permissions の組み込みの同意画面 (140+)
 * color-mix() (113+)、CSS nesting (117+)、:has() (121+) はこれより前に揃っている。
 * appearance: base-select は Firefox では既定で無効。Chrome と同じく進行的強化として無くても動く。
 */

/** Firefox のメジャーバージョンの下限。 */
export const MINIMUM_FIREFOX_MAJOR = 140;

/** Firefox 用の esbuild の target。 */
export const ESBUILD_TARGET_FIREFOX = `firefox${MINIMUM_FIREFOX_MAJOR}`;

/** manifest の browser_specific_settings.gecko.strict_min_version。ビルド時に差し込む。 */
export const FIREFOX_STRICT_MIN_VERSION = `${MINIMUM_FIREFOX_MAJOR}.0`;
