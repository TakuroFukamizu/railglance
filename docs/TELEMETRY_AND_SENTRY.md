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
- release制限: `TELEMETRY_ALLOWED_RELEASES` の各エントリは完全一致（`railglance@0.1.3`）またはパッチワイルドカード（`railglance@0.1.*`）。ワイルドカードは同じ major.minor の数字パッチだけに一致し、prerelease 接尾辞や別 minor には一致しない。それ以外の位置の `*` はリテラル扱いで fail closed する。アプリ更新後はオンライン検証が完了するまで新規収集しない。
- 即時失効: 管理endpointでparticipantを失効させ、以後のtoken更新とuploadを拒否する。
- レート制限: enrollmentはcampaign単位30回/分、token更新とuploadはparticipant単位240回/分を既定とする。
- 入力制限: Origin allowlist、120 KB、200 events、schema、値域を検証する。allowlist の各エントリは通常は完全一致。末尾が `:*` のエントリだけは当該 `scheme://host` の任意の数値ポートを許可し、Even App WebView の loopback Origin（`http://127.0.0.1:<エフェメラルポート>`）に使う。裸の `*` は `:*` で終わらないためリテラル `Origin: *` への完全一致になり、ブラウザはそれを送れないので fail closed する。

Cloudflare Rate Limiting bindingのカウンタはCloudflare拠点単位であるため、これを唯一の不正利用対策とはしない。
資格照合と併用する。設定根拠は
[Rate Limiting API](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) を参照する。

## Cloudflare 構築・デプロイ

テレメトリ用R2 bucketは公開しない。Terraformはローカルで毎回環境変数を`export`して実行せず、GitHub Actionsの
`Provision Cloudflare Infrastructure` workflowから実行する。

GitHubの`Settings` → `Secrets and variables` → `Actions`で次を設定する。

| 種別 | 名前 | 用途 |
| --- | --- | --- |
| Repository Secret | `CLOUDFLARE_API_TOKEN` | R2 bucketと、独自ドメイン導入後のZone Cache Rulesを管理するCloudflare API token |
| Repository Secret | `R2_ACCOUNT_ID` | Account homeからコピーした32文字のCloudflare Account ID。Zone IDやR2 token IDではない |
| Repository Secret | `R2_ACCESS_KEY_ID` | Terraform stateとR2 CORSを操作するS3互換Access Key ID |
| Repository Secret | `R2_SECRET_ACCESS_KEY` | 上記Access KeyのSecret |
| Repository Variable | `R2_BUCKET_NAME` | Dataset bucket名。既定値は`railglance-dataset-bucket` |
| Repository Variable | `R2_CORS_ALLOWED_ORIGINS` | 完全一致Originをカンマ区切りで指定する。例外として単独の `*` だけを許可する（公開データセット bucket と Even App WebView のエフェメラルポート Origin のため。`*` と完全一致 Origin の混在は拒否） |
| Repository Variable（任意） | `TF_STATE_BUCKET_NAME` | Terraform state bucket名。未設定時は`railglance-terraform-state` |
| Repository Variable（ドメイン導入後） | `CLOUDFLARE_ZONE_ID` | Cloudflare Zone ID。ドメイン未導入中は設定しない |

`CLOUDFLARE_API_TOKEN`には少なくとも対象Accountの`Workers R2 Storage: Edit`を付与する。独自ドメイン導入後に
Cache Rulesも管理する場合は、対象Zoneに必要な権限を追加する。R2のS3互換Access Keyには、state bucketの
object read/write/deleteと、管理対象bucketのread/write権限が必要になる。

Actionsの`Provision Cloudflare Infrastructure` → `Run workflow`から、最初に`plan`を実行して差分を確認し、
続いて`apply`を実行する。workflowはstate専用R2 bucketの存在をCloudflare APIで確認し、存在しない場合だけAPACに
作成する。Terraform stateは`railglance/cloudflare/terraform.tfstate`へ保存し、lockfileにより同時実行を防ぐ。
state bucketはTerraformが自分自身のbackendを削除しないよう、Terraform管理対象には含めない。
初回実行時にDataset bucket、Telemetry bucket、Dataset CORSがすでに存在する場合は、再作成せずremote stateへ
自動importする。

ドメイン未導入中は`CLOUDFLARE_ZONE_ID`が空のため、Dataset bucket、Telemetry bucket、CORSだけを作成し、
Zone Cache Rulesはスキップする。独自ドメイン導入後の作業はIssue #31に従う。

Terraformでbucketを作成後、Queueとdead-letter Queueを作成する。

```bash
pnpm dlx wrangler queues create railglance-telemetry
pnpm dlx wrangler queues create railglance-telemetry-dlq
```

### Worker Secret

本番のSecret値はリポジトリの `.env` や `wrangler.toml` には記載しない。次のコマンドを実行すると値の入力を
求められ、入力した値はCloudflare上で暗号化されたWorker Secretとして保存される。コマンドは
`infra/cloudflare/telemetry-worker/wrangler.toml` の `name = "railglance-telemetry"` を読み込むため、現在の構成では
デフォルト環境の `railglance-telemetry` Workerが設定先となる。

| Secret | 設定する値 | 共有範囲 |
| --- | --- | --- |
| `TELEMETRY_DIAGNOSTIC_ACCESS_CODE` | キャンペーンごとに運用者が発行する、初回参加用の十分に推測困難なコード | 対象テスターへ安全な別経路で共有する |
| `TELEMETRY_TOKEN_SIGNING_SECRET` | パスワード管理ツールなどで生成した32 byte以上のランダム値 | Workerと運用者だけで管理し、テスターへ共有しない |
| `TELEMETRY_ADMIN_TOKEN` | signing secretとは別に生成した32 byte以上のランダム値 | 資格失効を実行する管理者だけで管理する |

3つの値はパスワード管理ツールなどで先に生成・保管し、各コマンドの対話プロンプトへ貼り付ける。同じ値を
使い回さない。`secret put` は既存Secretがある場合はその値を更新するため、意図しない再実行にも注意する。

```bash
cd infra/cloudflare/telemetry-worker
pnpm dlx wrangler secret put TELEMETRY_DIAGNOSTIC_ACCESS_CODE
pnpm dlx wrangler secret put TELEMETRY_TOKEN_SIGNING_SECRET
pnpm dlx wrangler secret put TELEMETRY_ADMIN_TOKEN
pnpm dlx wrangler secret list
pnpm dlx wrangler deploy
```

`secret list` では登録済みの名前だけを確認でき、値を読み戻すことはできない。特に
`TELEMETRY_ADMIN_TOKEN` は後述の失効操作でも必要になるため、Cloudflareへの登録と同時に管理者用の
パスワード管理ツールへ保管する。

ローカルでWorkerを実行する場合だけ、`infra/cloudflare/telemetry-worker/.dev.vars` に本番とは異なる開発専用値を
置く。このファイルはGit管理対象外であり、実値をコミットしない。

```dotenv
TELEMETRY_DIAGNOSTIC_ACCESS_CODE="development-only-code"
TELEMETRY_TOKEN_SIGNING_SECRET="development-only-signing-secret"
TELEMETRY_ADMIN_TOKEN="development-only-admin-token"
```

現在の `wrangler.toml` にはnamed environmentを定義していない。将来 `[env.staging]` などを追加した場合、
Secretは環境間で共有されないため、各コマンドに `--env staging` を付けて環境ごとに登録する。

### 許可releaseの運用

`TELEMETRY_ALLOWED_RELEASES` はパッチワイルドカードで minor 系列ごとに1エントリにまとめる。パッチ版の
リリースでは `wrangler.toml` を編集せず、Workerも再デプロイしない。minor または major を上げたときだけ
新しいワイルドカードエントリを追加して `pnpm dlx wrangler deploy` を実行する。古い系列の収集を終える
ときはそのエントリを削除する。特定のパッチ版だけを除外したい場合は、その系列のワイルドカードを完全一致
エントリの列挙へ戻す。

照合ロジックは `src/infrastructure/telemetry/release-allowlist.ts` にあり、アプリとWorkerが同じ関数を
import する。アプリ側も enroll/refresh 応答の `allowedReleases` を自分の release と照合する。
ワイルドカードを解釈できないクライアント（0.1.3以前）は自分の release 文字列が配列に完全一致で
含まれるかだけを見るので、ワイルドカードエントリが混ざっていても影響を受けない。したがって
`railglance@0.1.3,railglance@0.1.*` のように旧クライアント用の完全一致とワイルドカードを併記した
リストを、ワイルドカード対応版のアプリを配布する**前に** Worker へデプロイしておく。Worker のコードも
同時に更新されるため、デプロイは対応版がマージされた `main` から行う。旧クライアントが残っていない
ことを確認してから完全一致エントリを削除する。

バージョンアップ作業の手順は `.claude/skills/bumping-app-version/SKILL.md` にまとめている。

`wrangler.toml` でcampaign ID、資格日数、対象release、token TTL、Origin allowlistを設定する。allowlistは
通常完全一致だが、末尾が `:*` のエントリは当該 `scheme://host` の任意の数値ポートを許可する（Even App
WebView の loopback Origin用）。release更新前に
新旧releaseをallowlistへ追加し、移行後に旧releaseを外す。資格失効は管理tokenを外部へ露出しない管理環境から行う。

Cloudflareに登録したSecret値は読み戻せないため、失効操作を行う管理端末では、パスワード管理ツールに保管した
`TELEMETRY_ADMIN_TOKEN` と同じ値をシェル環境へ一時的に設定してから次を実行する。コマンド履歴やログへ値を
直接記録しない。

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

### Even Hub Beta 配布設定

`.github/workflows/build-evenhub-package.yml` は、GitHub Actionsの `evenhub-beta` Environmentを使って
Beta Testing用の単一成果物 `out.ehpk` を生成する。`evenhub-beta` はEven Hubが提供する画面や予約語ではなく、
このリポジトリで作成するGitHub Actions Environmentの名前である。

GitHubの `Settings` → `Environments` → `New environment` で `evenhub-beta` を作成する。そのEnvironmentの
`Environment variables` に次を設定する。

| 名前 | 設定値 | 取得元・用途 |
| --- | --- | --- |
| `VITE_RAILWAY_DATA_BASE_URL` | Datasetの公開base URL | R2の公開URL。`/datasets/...`を付けないorigin/base URL |
| `VITE_SENTRY_DSN` | Sentry projectのDSN | SentryのProject Settings → Client Keys (DSN) |
| `VITE_SENTRY_TRACES_SAMPLE_RATE` | `0.1` | performance traceの送信率 |
| `SENTRY_ORG` | Sentry organization slug | Sentry Project Settings URLのorganization部分 |
| `SENTRY_PROJECT` | Sentry project slug | Sentry Project Settings URLのproject部分 |
| `VITE_APP_ENVIRONMENT` | `beta` | SentryとTelemetry上の環境名 |
| `VITE_TELEMETRY_ENDPOINT` | Telemetry WorkerのHTTPS URL | 独自ドメイン導入前はデプロイ結果の`workers.dev` URL |
| `VITE_EVEN_SDK_VERSION` | `0.0.12`など | 使用中のEven Hub SDK version |

同じEnvironmentの `Environment secrets` に次を設定する。

| 名前 | 設定値 | 取得元・用途 |
| --- | --- | --- |
| `SENTRY_AUTH_TOKEN` | `org:ci`権限のSentry Organization Auth Token | source mapとrelease情報のupload専用。アプリへは組み込まれない |

`SENTRY_AUTH_TOKEN` は次の手順で発行・登録する。

1. Sentryの `Settings` を開き、左メニューを下までスクロールして
   `Developer Settings` → `Organization Tokens` を開く。micosys Organizationでは
   `https://micosys.sentry.io/settings/auth-tokens/` へ直接アクセスしてもよい。
   `Organization` → `Auth` はGoogle/GitHubなどのSSO設定画面であり、token発行には使用しない。
2. `Create New Token` を押し、識別名（例: `railglance-github-actions`）を入力して作成する。
   Organization Tokenのscopeは画面上で `org:ci`（Source Map Upload、Release Creation、
   Code Mappings）と表示される。発行直後に一度だけ表示されるtokenをコピーする。
3. GitHubリポジトリの `Settings` → `Environments` → `evenhub-beta` →
   `Environment secrets` → `Add environment secret` を開き、名前を `SENTRY_AUTH_TOKEN`、
   値を手順2でコピーしたtokenとして保存する。

`VITE_SENTRY_DSN`、`SENTRY_ORG`、`SENTRY_PROJECT` は秘密情報ではないためVariableへ置く。
`SENTRY_AUTH_TOKEN`だけをSecretへ置き、Repository Variable、`.env`、ログ、`.ehpk`には保存しない。

workflowは手動実行専用で、`main`以外からの配布、必須設定の不足、`app.json`と`package.json`のversion不一致、
Sentry upload後にsource mapが`dist`へ残っている状態を拒否する。`VITE_APP_RELEASE` は workflow が
`package.json` の version から `railglance@<version>` として導出するため、Environment variable には置かない。
Workerの `TELEMETRY_ALLOWED_RELEASES` がこの値に一致することを確認する。Node.js 26で
`pnpm ehpack`を実行し、成功時はWorkflow SummaryとArtifactsに未圧縮の`out.ehpk`を14日間保存する。

実行はGitHubの `Actions` → `Build Even Hub Beta Package` → `Run workflow` からbranchに`main`を選ぶ。
取得した`out.ehpk`をEven HubのPrivate Testingへ先に登録し、下記の実機ゲートを通過後にBeta Testingへ進める。

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
