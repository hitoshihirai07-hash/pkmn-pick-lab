# Pick Lab / 対戦・選出シミュレーター（オフライン同梱）

## デプロイ（Cloudflare Pages / GitHub Pages）
- Framework preset: None
- Build command: (空欄)
- Output directory: /

> 注意: ブラウザで `file://` から直接 index.html を開くと、fetch の制限で図鑑JSONが読めません。
> 必ず http(s) で配信（Cloudflare Pages等）してください。

## 図鑑データ
`dex/` 以下に同梱済みです。外部サイトに取りに行きません。

## 保存/読込
上部の「保存（JSON）」で構築を保存できます。読込で復元できます。

## 簡易シミュ
- それぞれのチームから3体をチェックして「選出でシミュする」
- タイプ相性 + 入力した技タイプを元に「ざっくり」評価します（本気の対戦エンジンではありません）
