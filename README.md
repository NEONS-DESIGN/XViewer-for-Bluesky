# Bluesky-Extension

Bluesky (bsky.app) 向けの Chrome 拡張機能 (Manifest V3)。

プロフィールのメディアタブを、AT Protocol の公開 API から取得したデータで
サムネイル格子表示に置き換える。あわせて「メディアへ / ビデオへ / 投稿へ /
ページ先頭へ」の固定ボタンを右下に追加する。

ポップアップから 3 つの設定を ON/OFF できる (メディアグリッドの表示 /
NSFW のぼかしの解除 / デバッグモード)。

姉妹プロジェクト `X-Custom-Extension-API` は同じ機能を X (旧 Twitter) 向けに実装したもの。
**取得方法が根本的に違うため、あちらのコードをそのまま持ち込まないこと。**

詳細設計は `SPEC.md`、Bluesky 側の実測 (API・DOM・レイアウト) は `SITE_SPEC.md`、
作業規約は `開発メモ` を参照。
