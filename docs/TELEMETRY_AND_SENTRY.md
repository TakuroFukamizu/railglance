# 診断テレメトリと Sentry 運用

RailGlance は、長時間の実走診断を Cloudflare R2、例外と直前の状態遷移を Sentry に分離する。
正確な GPS 座標を含むデータは `diagnostic` を明示した同意済みテスターからのみ収集する。

## クライアント設定

`.env.example` を参照し、通常の本番ビルドは次の設定にする。

```env
VITE_TELEMETRY_MODE=errors-only
VITE_SENTRY_DSN=https://public-key@example.ingest.sentry.io/project-id
VITE_SENTRY_TRACES_SAMPLE_RATE=0.1
VITE_APP_RELEASE=railglance@0.1.0
VITE_APP_ENVIRONMENT=production
```

限定テスターが収集内容と保持期間に同意したビルドだけ、次を追加する。

```env
VITE_TELEMETRY_MODE=diagnostic
VITE_TELEMETRY_ENDPOINT=https://telemetry.railglance.example
VITE_TELEMETRY_UPLOAD_TOKEN=<short-lived-upload-token>
```

`diagnostic` では GPS 観測と推定結果を IndexedDB `RailGlanceTelemetry` に先に保存する。100件または20秒を
目安に Worker へ送り、100 KB を超える場合はさらに分割する。成功応答を受けたイベントだけ削除し、失敗した
イベントは次回 flush で再送する。既定で
最大3,600件・1時間を超えたデータを削除する。推定と HUD の処理は送信を待たない。
`errors-only` または `off` で起動した場合は、前回の診断セッションで残った IndexedDB を削除する。

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
pnpm dlx wrangler secret put TELEMETRY_UPLOAD_TOKEN
pnpm dlx wrangler deploy
```

`wrangler.toml` の `TELEMETRY_ALLOWED_ORIGINS` は環境ごとの正確な Origin をカンマ区切りで指定する。
Worker は Origin、Bearer token、120 KB の body 上限、200件の event 上限、schema と値域を検証してから
Queue へ送る。不明なフィールドは保存時に除外する。120 KB は
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

- ブラウザへ埋め込む upload token は恒久秘密にできない。限定配布ごとに短期化し、漏えい時は Worker secret を更新する。
- 一般公開版では `errors-only` を既定とし、診断モード、保持期間、利用目的、削除方法を提示する UI が完成するまで正確な GPS を送らない。
- Sentry Replay、D1 セッション索引、Analytics Engine 集計はこの実装の対象外。
