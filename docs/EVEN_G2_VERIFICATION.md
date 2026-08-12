# Even G2 SDK 検証手順

RailGlance は `@evenrealities/even_hub_sdk` 0.0.12 以上を前提とし、`app.json` の
`min_sdk_version` も 0.0.12 に合わせる。SDK オブジェクトの monkey patch は行わない。

## Simulator

1. `pnpm install --frozen-lockfile`
2. `pnpm test`
3. `pnpm dev`
4. HUD の4コンテナが表示され、速度変化時も text/image 更新が交差しないことを確認する。
5. foreground exit/enter を発生させ、ページ再構築後に最新の HUD が再送されることを確認する。
6. `pnpm ehpack` で SDK 最低 version と、設定済み通信先の exact origin network whitelist を含む
   パッケージを1つ生成する。

## 実機

チーム外テスターへの配布は Even Hub の
[Beta Testing](https://hub.evenrealities.com/docs/test/beta-testing) を使う。
[Private Testing](https://hub.evenrealities.com/docs/test/private-testing) は開発者本人の確認に限る。
Beta グループで全項目を確認した同一 `.ehpk` を審査へ提出し、`errors-only` / `diagnostic` の別成果物は作らない。

1. location 権限を許可し、SDK App Location が1秒間隔で届くことをログで確認する。
2. 移動中にアプリを background/foreground へ切り替え、二重 subscription が発生しないことを確認する。
3. 画像転送を意図的に遅延させても、次の `updateImageRawData` が先行しないことを確認する。
4. 画面終了時に location updates、Hub event listener、page container が解放されることを確認する。
5. SDK が利用できない通常ブラウザでは `navigator.geolocation` へ切り替わり、Even App 内では
   Browser provider を先に使用しないことを確認する。
6. 起動直後は「エラーのみ」であり、診断同意前には GPS・判定・DR event が送信されないことを確認する。
7. 同意と有効なテスターコードで診断を開始し、停止または token 期限切れで収集が止まることを確認する。

ページ定義は全コンテナに一意な `zOrderIndex` を付け、`isEventCapture: 1` は1コンテナだけにする。
画像は 200×100 PNG とし、SDK の公式 `ImageRawDataUpdateResult` で成功を判定する。SDK が
キャンセル API を提供しないため、ローカル timeout で Promise だけを打ち切る実装は禁止する。
