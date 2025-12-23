# Pick Lab（対戦・選出シミュレーター）

静的サイトで動く「チーム作成 + 簡易シミュレーション」MVPです。
GitHub + Cloudflare Pages にそのまま置いて動く前提（ビルド不要）。

## できること（MVP）
- 左右2チーム（各6体）を作る
- ポケモン名（日本語/英語）で検索して選択
- 特性は図鑑データから選択肢を出す
- 技は「覚える技のみ」/「全技」切替（自由入力も可）
- セット候補（おすすめ）を3つ提案 → ワンクリックで反映
- 3体選出をチェックして、簡易バトルシミュ（勝率）
- JSONでエクスポート/インポート

## 重要：これは“簡易シミュ”です
以下は未対応（いずれ拡張用）：
- 状態異常、積み技、急所、天候/フィールド、持ち物/特性の効果、追加効果、交代読み など
- ダブル特有要素

「選出が良さそうか」をざっくり見る用途向けです。

## データソース
- Pokémon Showdown 公開データ（pokedex / moves / learnsets / sets）
- motemen/pokemon-data（日本語名・ID対応、持ち物名）

※このMVPは “コード流用” ではなく、公開データを取得して参照します。

## 使い方
1. GitHub/Cloudflare Pages に置いて開く（推奨）
   - ※ブラウザの制限で `file://` 直開きだと図鑑JSONが読み込めないことがあります。ローカルで試すなら簡易サーバを使ってください（例：PCなら `python -m http.server`）。
2. 右上の「図鑑データ読み込み」を押す（初回は少し重い）
3. チームを埋めて、必要なら「選出」にチェック
4. 「シミュレーション実行」

## Cloudflare Pages（GitHub連携）
- Framework preset：None
- Build command：空欄
- Output directory：`/`

（＝リポジトリのルートにこのファイル群を置くだけ）


## 図鑑データ（オフライン同梱）
このパッケージは、図鑑データをリポジトリ内に同梱する「オフライン運用」版です。
外部サイト（Showdown / GitHub raw）へのアクセスがブロックされる環境でも動く想定。

配置：
- `dex/ps/` … `pokedex.json`, `moves.json`, `learnsets.json`
- `dex/ps/sets/` … `gen9ou.json`（セット候補用）
- `dex/jp/` … `POKEMON_ALL.json`, `ITEM_ALL.json`（日本語名検索/表示用）

## データ出典
- Pokémon Showdown 公開データ（pokedex/moves/learnsets/sets）
- motemen/pokemon-data（日本語名・アイテム名の統合データ）
