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
6. 初回参加前は「診断収集: 停止」であり、GPS・判定・DR event が送信されないことを確認する。
7. 初回だけ同意とキャンペーンコードで参加し、以後の起動・短期token更新でコード入力を要求しないことを確認する。
8. 画面lock、Even App強制終了、同一package IDのrelease更新後も資格と未送信IndexedDBが維持され、自動再送されることを
   Private TestingとBeta Testingの両方で確認する。
9. participantを管理endpointから失効し、発行済みtokenでも次のuploadが拒否されることを確認する。
10. 常時状態表示、停止、コードなし再開、未送信ログの明示削除がそれぞれ独立して動くことを確認する。

実機結果は日時、Even App version、`.ehpk` release、操作、残存event数、再送結果とともに記録する。Private/Betaの
双方で8を通過するまでは長期無人収集をサポート対象にしない。資格またはIndexedDBが失われた場合は、その環境での
長期無人収集を不可と判定する。

## 現在の検証判定

| 項目 | 状態 | 根拠 |
| --- | --- | --- |
| IndexedDB再起動・再送の自動テスト | 合格 | Vitestで未送信eventと永続資格を別manager instanceから復元 |
| Worker資格期限・自動token更新・即時失効・release/rate制限 | 合格 | Worker unit test |
| Private Testingでのlock・強制終了・更新 | 未実施 | Even G2実機操作が必要 |
| Beta Testingでのlock・強制終了・更新 | 未実施 | Beta groupへの実機配布が必要 |

したがって、現時点の長期無人収集の判定は「不可（実機ゲート未通過）」である。実機結果をこの表へ追記し、
Private/Betaの双方が合格した時点でのみ判定を変更する。

ページ定義は全コンテナに一意な `zOrderIndex` を付け、`isEventCapture: 1` は1コンテナだけにする。
画像は 200×100 PNG とし、SDK の公式 `ImageRawDataUpdateResult` で成功を判定する。SDK が
キャンセル API を提供しないため、ローカル timeout で Promise だけを打ち切る実装は禁止する。
