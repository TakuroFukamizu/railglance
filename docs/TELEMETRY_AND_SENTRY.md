# 診断テレメトリと Sentry 運用

RailGlance は、長時間の実走診断を Cloudflare R2、例外と直前の状態遷移を Sentry に分離する。
配布成果物は1種類だけを作り、起動時は必ず `errors-only` とする。正確な GPS 座標を含むデータは、
同じアプリ上で収集内容に同意し、テスターコードを入力して診断セッションを開始した場合だけ収集する。

## クライアント設定

`.env.example` を参照し、本番・Beta Testing 共通の `.ehpk` を次の設定で作る。

```env
VITE_SENTRY_DSN=https://public-key@example.ingest.sentry.io/project-id
VITE_SENTRY_TRACES_SAMPLE_RATE=0.1
VITE_APP_RELEASE=railglance@0.1.0
VITE_APP_ENVIRONMENT=production
```

診断用 Worker の公開 URL を設定する。この値は送信先であり秘密ではない。

```env
VITE_TELEMETRY_ENDPOINT=https://telemetry.railglance.example
```

ビルド時にモードを切り替える環境変数や upload token は使用しない。テスターが画面上で同意してコードを
入力すると、Worker の `/v1/telemetry/session` が session/release/environment に限定された HMAC 署名付き
短期 token を返す。token はメモリにだけ保持し、`.ehpk`、localStorage、IndexedDB には保存しない。

診断セッション中は GPS 観測と推定結果を IndexedDB `RailGlanceTelemetry` に先に保存する。100件または20秒を
目安に Worker へ送り、100 KB を超える場合はさらに分割する。成功応答を受けたイベントだけ削除し、失敗した
イベントは次回 flush で再送する。既定で
最大3,600件・1時間を超えたデータを削除する。推定と HUD の処理は送信を待たない。
起動時、停止時、token 期限切れ時には端末内の未送信診断データを削除する。

Sentry Breadcrumb には route、segment、navigation mode、次駅、Even G2 接続状態の変化を記録する。
`telemetry.session_id` により Sentry イベントから同一 R2 セッションを参照できる。Sentry の `beforeSend` は
緯度・経度・raw location フィールドを再帰的に除外し、`sendDefaultPii` も無効にする。

## Cloudflare 構築・デプロイ

テレメトリ用 R2 bucket は公開しない。Terraform で `railglance-telemetry-bucket` を作成した後、Queue と
dead-letter Queue を作成する。

```bash
pnpm dlx wrangler queues create railglance-telemetry
pnpm dlx wrangler queues create railglance-telemetry-dlq
cd infra/cloudflare/telemetry-worker
pnpm dlx wrangler secret put TELEMETRY_DIAGNOSTIC_ACCESS_CODE
pnpm dlx wrangler secret put TELEMETRY_TOKEN_SIGNING_SECRET
pnpm dlx wrangler deploy
```

`wrangler.toml` の `TELEMETRY_ALLOWED_ORIGINS` は環境ごとの正確な Origin をカンマ区切りで指定する。
Worker は診断開始時の同意とテスターコードを検証し、既定6時間（5分〜24時間に制限）の token を発行する。
アップロード時は署名・期限・session/release/environment の scope、Origin、120 KB の body 上限、200件の
event 上限、schema と値域を検証してから Queue へ送る。不明なフィールドは保存時に除外する。120 KB は
[Cloudflare Queues の128 KBメッセージ上限](https://developers.cloudflare.com/queues/platform/limits/)に
serialization 分の余裕を確保した値である。

Queue consumer はイベントを gzip 圧縮 NDJSON として次へ保存する。

```text
telemetry/YYYY/MM/DD/{sessionId}/chunk-{batchId}.ndjson.gz
```

`batchId` から決定的に key を作るため、Queue の再配送で同じ batch が処理されても同じ object を上書きし、
重複 chunk を増やさない。R2 lifecycle rule で prototype/private の保持期間を14〜30日に制限する。

## Sentry source map

source map upload 用の認証情報は CI/build 環境にのみ保存する。`VITE_` prefix を付けない。

```env
SENTRY_ORG=<org-slug>
SENTRY_PROJECT=<project-slug>
SENTRY_AUTH_TOKEN=<organization-token>
```

3値が揃った production build だけ hidden source map を生成・アップロードし、完了後に `dist/**/*.map` を削除する。
クライアントの `VITE_APP_RELEASE` と build 時の release を必ず一致させる。

## 運用上の注意

- `.ehpk` には秘密情報を入れない。テスターコードは別経路で配布し、漏えい時は Worker secret を更新する。
- 診断の開始・停止は実行時の明示操作とし、別の diagnostic ビルドを作らない。
- `pnpm ehpack` は build に使った URL から exact origin を抽出し、実際に package する `dist/app.json` の
  network whitelist を生成する。追加 Origin は `EVENHUB_NETWORK_ORIGINS` に列挙する。wildcard は使わない。
- Sentry Replay、D1 セッション索引、Analytics Engine 集計はこの実装の対象外。

Even Hub の要件は [Packaging](https://hub.evenrealities.com/docs/ship/packaging) と
[Networking](https://hub.evenrealities.com/docs/build/networking) を参照する。前者は package に API key や
secret を含めないこと、後者は各通信先を full origin で manifest に列挙し wildcard を使わないことを求めている。
