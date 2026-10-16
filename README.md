# XViewer for Bluesky

Bluesky (bsky.app) 向けのブラウザ拡張機能 (Manifest V3)。Chrome 系 (120 以上) と
Firefox (140 以上) に対応する。
ソースは `src/` に ES Modules で置き、Node.js (esbuild) でビルドして
`dist/` (Chrome 系) と `dist-firefox/` (Firefox) に出力する。

Bluesky 公式の拡張機能ではなく、Bluesky Social PBC とは関係が無い。

## 機能

1. **ナビゲーションボタン** — プロフィールページの右下に
   「メディアへ / ビデオへ / 投稿へ / ページ先頭へ」の固定ボタンを出す
2. **メディアグリッド** — プロフィールのメディアタブを、AT Protocol の公開 API
   (`public.api.bsky.app` の `getAuthorFeed`) から取得したデータで
   正方形のサムネイル格子に置き換える。1 投稿 1 タイルで、複数枚添付は先頭画像に
   複数枚アイコンを付ける。動画は並べない (ビデオタブがあるため)。タイルを押すと
   本体のライトボックスが開く
3. **NSFW のぼかし解除** — グリッドのタイルに掛かるぼかしと警告文を外す
   (対象はグリッドのタイルだけで、本体が出す警告には触らない)
4. **デバッグモード** — タブ判定・グリッドの起動と撤去・取得の状況を
   コンソール (`[XViewer][debug]`) に出し、内部状態を `html` 要素の
   `data-bsky-ext-state` 属性に書き出す
5. **ライトボックスの投稿情報パネル** — 画像を開いたとき、右側に本文・投稿日時・
   作者・反応数・「投稿を開く」を出す。グリッド由来に限らず、bsky.app の
   どこで画像を開いても出る。畳める
6. **ライトボックスの操作性の調整** — 画像そのものを押しても閉じないようにし、
   カーソルを「押せるところ」だけ指の形に残す。半透明の余白を押せば従来どおり閉じる
7. **ライトボックスからの投稿操作** — 画像を開いたまま、返信・リポスト・引用・
   いいね・ブックマークを行える。認証は本体の認証済みクライアントを橋渡し経由で
   借りるだけで、`localStorage` のトークンには触らない。橋渡しは白名簿で閉じてあり、
   通せるのは自分のいいね・リポスト・ブックマークの付け外しと投稿の取得だけ。
   ボタンは種別ごとに色が付き (返信 = 水色・リポスト = 緑・いいね = マゼンタ・
   ブックマーク = 黄)、反応済みのときだけでなくホバーでも色が変わる

## 設定 (ポップアップ)

ツールバーのアイコンから開く。「設定」と「ライセンス」の 2 つのタブがあり、
設定はセクションごとにスイッチで ON/OFF できる。変更はリロードせずその場で反映される。

| セクション | 項目 | 既定 |
| --- | --- | --- |
| メディアグリッド | メディアグリッド表示 | ON |
| メディアグリッド | └ NSFWのぼかしを解除 | OFF |
| ライトボックス | 投稿情報を表示 | ON |
| ライトボックス | └ 返信・いいね | ON |
| ライトボックス | 画像のクリックで閉じない | ON |
| 開発者向け | デバッグモード | OFF |

- 「└」の項目は上の項目の子で、親が OFF のあいだは押せない。(押すと理由を表示する)
  子の設定は保たれ、親を ON に戻すと元の状態に戻る
- 右上のボタンでポップアップの配色をダーク / ライトに切り替えられる。
  既定は OS の設定に従う
- 「設定を初期化」で、確認のうえ全項目と配色を既定に戻す

## 導入

Node.js 24.2 以上が要る。

```
npm install
npm run build
```

### Chrome 系

1. `chrome://extensions` を開き、デベロッパーモードを ON にする
2. 「パッケージ化されていない拡張機能を読み込む」で **`dist/`** を指定する
   (リポジトリのルートや `src/` ではない)

### Firefox

1. `about:debugging` を開き、「この Firefox」を選ぶ
2. 「一時的なアドオンを読み込む」で **`dist-firefox/manifest.json`** を選ぶ
   (一時的なアドオンは Firefox を閉じると消える)

### コードを変更したら

1. `npm run build` を走らせる (`npm run watch` を走らせておけば JS は自動で
   ビルドし直される。CSS・HTML・アイコンを変えたときは `npm run build`)
2. 拡張機能のカードのリロードボタンを押す
3. bsky.app のタブを再読み込みする (`inject.js` はページ側のワールドで動くため、
   タブを再読み込みしない限り新しい版が入らない)

必要な権限は `storage` (設定の保存) と `https://public.api.bsky.app/*`
(公開 API の呼び出し) だけ。

## npm scripts

| コマンド | 内容 |
| --- | --- |
| `npm run build` | Chrome 系と Firefox の両方をビルドする |
| `npm run build:chrome` / `build:firefox` | 片方だけビルドする |
| `npm run watch` | 監視ビルド (JS のみ) |
| `npm test` | 自動テスト |
| `npm run build:symbols` | `src/common/icon-shapes.js` を Material Symbols から生成する |
| `npm run build:icons` | 拡張機能アイコンの PNG を生成する |

## 自動テスト

```
npm test
```

Node の組み込みテストランナー (`node:test`) だけを使う。対象は解析・整形・判定の
純関数、ポップアップ (偽 DOM での描画を含む)、ビルドの道具。content script の
DOM 操作・本体レイアウトへの介入・橋渡しは実機の bsky.app で確認する。

## アイコン

拡張機能アイコン (`src/icons/icon-16.png` / `32` / `48` / `128`) は
`npm run build:icons` の生成物。**画像編集ソフトで直接触らず、`scripts/icon-svg.mjs`
の `GEOMETRY` を直して生成しなおすこと。** 地の色はポップアップのアクセント色と同じ。

ポップアップとパネルで使う図形 (`src/common/icon-shapes.js`) は
`npm run build:symbols` が `@material-symbols/svg-400` から生成する。

どちらの生成物もコミットしてあり、通常の `npm run build` では生成しない。

## 姉妹プロジェクト

[XViewer for Pixiv](https://github.com/NEONS-DESIGN/XViewer-for-Pixiv) は
pixiv 向けの拡張機能で、ビルドの方式とポップアップの作りを共通にしている。

## ライセンス

この拡張機能は MIT License。(`LICENSE`)

アイコンの図形は Material Symbols (Apache License 2.0) を使用している。
帰属は `NOTICE`、ライセンス本文は `LICENSES/Apache-2.0.txt` にある。
どちらもビルドの出力先 (`dist/` / `dist-firefox/`) に同梱される。
