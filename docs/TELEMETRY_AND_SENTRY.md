# 診断テレメトリと Sentry 運用

RailGlance は、長時間の実走診断を Cloudflare R2、例外と直前の状態遷移を Sentry に分離する。
配布成果物は1種類だけで、キャンペーン未参加時は正確な GPS を収集しない。

## キャンペーン参加と自動更新

Even G2で定期的なコード再入力を求めない。診断参加は次の2段階に分ける。

1. テスターはキャンペーン初回参加時だけ、収集内容へ同意して参加コードを入力する。
2. Worker は7〜30日（既定14日）のキャンペーン資格を発行する。クライアントは資格credentialと同意状態を
   IndexedDB `RailGlanceTelemetryControl` に保存する。
3. 起動時は保存済みcredentialで資格を確認し、5〜60分（既定15分）の短期upload tokenを自動取得する。
4. tokenは有効期限の5分前に自動更新し、メモリにだけ保持する。参加コードの再入力は不要である。

credentialはEven Appのアプリ領域に保存されるBearer資格であり、恒久秘密とは扱わない。サーバー側で期限、
release allowlist、participant単位の失効、レート制限を必ず検証する。

## 収集状態と端末内データ

スマートフォン画面下部に診断状態を常時表示する。

- `有効`: 収集・送信中。短期tokenは自動更新する。
- `端末保存中`: オフラインまたは一時的なサーバー障害。収集を続け、復旧後に再送する。
- `一時停止`: テスターが停止。資格と未送信ログは保持し、コードなしで再開できる。
- `停止`: 未参加、期限切れ、即時失効、または対象外release。

起動時、強制終了後、短期token期限切れ時に未送信ログを削除しない。GPS観測と推定結果はIndexedDB
`RailGlanceTelemetry` に先に保存し、100件または20秒を目安に送る。送信成功したイベントだけ削除し、
失敗分は次回起動・接続回復後に再送する。既定の端末上限は50,000件・3日で、超過分は古い順に削除する。

「診断収集を停止」は新規収集だけを止め、未送信ログを保持する。「端末内ログを削除」は確認後に未送信ログだけを
削除し、キャンペーン資格は維持する。この2操作を分離し、意図しないデータ消失を避ける。

## Worker の資格・制限

Cloudflare Worker はparticipant単位のDurable Objectを資格台帳に使う。発行済みtokenの有効期間中も、
各uploadで台帳を読み、失効済み資格を直ちに拒否する。

- enrollment: 同意、初回参加コード、対象releaseを検証する。
- qualification: 7〜30日、既定14日。participant ID、campaign ID、credential hash、許可release、失効日時を保持する。
- upload token: HMAC署名、5〜60分、既定15分。campaign、participant、environment、許可releaseをscopeに含める。
- release制限: `TELEMETRY_ALLOWED_RELEASES` の完全一致。アプリ更新後はオンライン検証が完了するまで新規収集しない。
- 即時失効: 管理endpointでparticipantを失効させ、以後のtoken更新とuploadを拒否する。
- レート制限: enrollmentはcampaign単位30回/分、token更新とuploadはparticipant単位240回/分を既定とする。
- 入力制限: exact Origin、120 KB、200 events、schema、値域を検証する。

Cloudflare Rate Limiting bindingのカウンタはCloudflare拠点単位であるため、これを唯一の不正利用対策とはしない。
資格照合と併用する。設定根拠は
[Rate Limiting API](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) を参照する。

## Cloudflare 構築・デプロイ

テレメトリ用R2 bucketは公開しない。Terraformでbucketを作成後、Queueとdead-letter Queueを作成する。

```bash
pnpm dlx wrangler queues create railglance-telemetry
pnpm dlx wrangler queues create railglance-telemetry-dlq
cd infra/cloudflare/telemetry-worker
pnpm dlx wrangler secret put TELEMETRY_DIAGNOSTIC_ACCESS_CODE
pnpm dlx wrangler secret put TELEMETRY_TOKEN_SIGNING_SECRET
pnpm dlx wrangler secret put TELEMETRY_ADMIN_TOKEN
pnpm dlx wrangler deploy
```

`wrangler.toml` でcampaign ID、資格日数、対象release、token TTL、exact Originを設定する。release更新前に
新旧releaseをallowlistへ追加し、移行後に旧releaseを外す。資格失効は管理tokenを外部へ露出しない管理環境から行う。

```bash
curl -X POST https://telemetry.example/v1/telemetry/campaign/revoke \
  -H "Authorization: Bearer ${TELEMETRY_ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{"participantId":"p_xxx"}'
```

Queue consumerはgzip NDJSONを次の決定的keyへ保存し、再配送を冪等に扱う。

```text
telemetry/YYYY/MM/DD/{sessionId}/chunk-{batchId}.ndjson.gz
```

R2 lifecycle ruleで保持期間を14〜30日に制限する。

## Sentry

Sentry Breadcrumbにはroute、segment、navigation mode、次駅、Even G2接続状態の変化を記録する。
`telemetry.session_id` によりR2セッションと相互参照できる。`beforeSend` は緯度・経度・raw locationを
再帰的に除外し、`sendDefaultPii`も無効にする。Replayは使用しない。

source map upload用の `SENTRY_AUTH_TOKEN` はCI/build環境だけに保存し、`.ehpk`へ含めない。

## Even G2 実機ゲート

ブラウザ上のIndexedDB再生成テストだけでは、Even Appコンテナのlock・強制終了・package更新時の永続性を
保証できない。Private TestingとBeta Testingの両方で次を確認する。

1. 初回参加後、画面lock/unlockでコードなしに資格を復元できる。
2. オフラインでログを蓄積し、Even Appを強制終了して再起動しても件数・資格が残り、自動再送される。
3. 同じpackage IDの新releaseへ更新後もIndexedDBが残り、serverのrelease確認後に再送される。
4. 失効操作後、発行済みtokenが残っていても次のuploadが拒否され、状態表示が停止へ変わる。
5. 停止で新規収集が止まりログが残ること、明示削除でログだけが消えることを確認する。

この実機試験がPrivate/Betaの双方で完了するまでは、長期無人収集をサポート済みと判断しない。いずれかで
IndexedDBまたは資格が維持されない場合、そのEven App/Even Hubバージョンでは長期無人収集を不可とし、
短時間の有人試験だけに限定する。

Even Hubの要件は [Packaging](https://hub.evenrealities.com/docs/ship/packaging)、
[Networking](https://hub.evenrealities.com/docs/build/networking)、
[Private Testing](https://hub.evenrealities.com/docs/test/private-testing)、
[Beta Testing](https://hub.evenrealities.com/docs/test/beta-testing) を参照する。
