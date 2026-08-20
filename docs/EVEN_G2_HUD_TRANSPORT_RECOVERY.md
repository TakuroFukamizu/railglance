# Even G2 HUD 転送フリーズからの回復

実機の Even G2 グラス HUD だけが固まり、スマートフォン側（GPS、速度推定、路線マッチング、
JourneyState、DebugPanel）は更新され続ける、という症状への対策。

## 症状

グラスの速度画像・テキストが途中から更新されない。スマートフォンの Web プレビューと
DebugPanel の `G2 PNG Update Status` は `success` のまま進む。アプリ再起動以外に回復手段がない。

## 原因

`HybridEvenG2Adapter` のネイティブ Even Hub SDK 呼び出し（`updateImageRawData`、
`textContainerUpgrade`、ページ作成/再構築/終了）を、完了期限なしで `await` していた。
すべての BLE 操作は単一の `bridgeQueue` で直列化されているため、どれか 1 本が
resolve も reject もしないと、以降の HUD 更新がグラスへ届かない。

`lastImageResult` は最後に *完了した* 転送だけを記録するので、ハング中は DebugPanel に
手がかりが出ない。SDK にキャンセル API はなく、`Promise.race` でラッパーだけ切って
次の通常 BLE 操作を始めると、未完了の転送と次の転送が電波上で重なる。

## Watchdog の設計

すべてのネイティブ呼び出しを `runNativeOperation()` 経由にする。

- 操作種別ごとに `setTimeout` を武装する（text / image / page）。
- SDK の Promise 自体は放棄しない。キャンセルできないため、遅延完了は
  epoch ガード付きの継続としてテレメトリとログだけに使う。
- Watchdog が先に発火したら、ラッパーは `{ status: 'stalled' }` で解決する。
  呼び出し元（`connect()` / `recoverPage()` / `clear()` / HUD flush）と
  回復バックオフが進めるようにするため。
- ラッパーが解決する時点で `handleTransportStall()` はすでに
  セッション epoch を進め、キューを切断し、`pageReady` を落としている。
  タイムアウトを理由に *次の通常 HUD 操作* が始まることはない。

古いセッションの完了が新しいセッションのテキストキャッシュ、
`lastImageResult`、`lastRenderedSpeedKmh` を上書きしない。

## タイムアウト既定値

| 操作 | 既定 | オプション |
| --- | --- | --- |
| テキスト（header / segment / footer） | 5,000 ms | `textOperationTimeoutMs` |
| 速度画像 | 8,000 ms | `imageOperationTimeoutMs` |
| ページ作成 / 再構築 / 終了 | 10,000 ms | `pageOperationTimeoutMs` |
| テキスト遅延警告 | 1,000 ms | `textSlowWarnMs` |
| 画像・ページ遅延警告 | 3,000 ms | `imageSlowWarnMs` |
| 回復前の settle grace | 2,000 ms | `stallSettleGraceMs` |

値の検証は `resolvePositiveTimeoutMs` に統一している。非有限・0 以下は既定へ戻し、
`2,147,483,647` 超は `setTimeout` が即発火しないようクランプする。
実機で転送が恒常的に遅い場合はオプションを延ばす。短くしすぎると健全な転送まで
stall 扱いになり、不要なページ再構築が増える。

## 回復とバックオフ

1. ハングしたネイティブ操作に `stallSettleGraceMs` だけ完了の猶予を与える。
   永遠に待たないための妥協であり、grace 後も未完了なら 1 本の SDK Promise が
   残ったまま新しい BLE を出す可能性がある。
2. 再構築を `[0, 1,000, 3,000]` ms のバックオフで最大 3 回試す（1 回目は即時）。
   成功したらキャッシュを無効化し、最新の ViewModel をフル flush する。
3. 3 回連続で失敗したら `markDisconnected('transport stall recovery exhausted')`。
   以後は AppController の再接続ループ（1s → 10s）が `connect()` をやり直す。
   `connect()` の `createStartUpPageContainer` も watchdog 付きなので、
   アダプタ自身が再構築を無限に回し続けない。
4. 連続失敗カウンタは、回復の成功そのものではリセットせず、HUD flush が 60 秒間健全に完了した時点でリセットする。

`FOREGROUND_ENTER` の既存回復は残す。初回失敗で即 disconnect するのは
フォアグラウンド復帰経路だけ。transport-stall 経路は上記バックオフが担当する。

## DebugPanel

既存の `G2 PNG Update Status` は動かさない。新しいカード
「Even G2 Bridge Transport」に次を出す。

G2 Connection status、Page Ready、Session Epoch、Current Native Operation、
Operation Age（秒、小数 1 桁。画像タイムアウト超過時は赤 `#FF6666`）、
Last Completed Operation、Last Completed、Last Operation Duration、
Last Image Result、Last Image Completed、Render Generation、Flushed Generation、
HUD Flush Scheduled、HUD Flush In Flight、HUD Dirty、Recovery Count、
Last Recovery Reason。

## テレメトリ

- `bridge-operation` イベント: すべてのネイティブ操作の完了 / エラー / stall。
  `SentryTelemetrySink` は `state-transition` 以外を捨て、診断シンクは診断モード中だけ
  記録するので本番コストは小さい。診断キャプチャで所要時間の分布を取れる。
- `state-transition`（category `bridge`）はライフサイクルだけ:
  `bridge-page-ready`、`bridge-operation-slow`、`bridge-operation-stalled`、
  `bridge-recovery-start`、`bridge-recovery-success`、`bridge-recovery-failed`。
- 既存の `addRuntimeBreadcrumb` はそのまま。stall 時に warning breadcrumb を 1 本足す。
- `estimation.bridge` に任意フィールド `stalled` / `currentOperation` /
  `sessionEpoch` / `recoveryCount` を足す。`TELEMETRY_SCHEMA_VERSION = 1` のまま。

## 既知の制約

SDK にキャンセルがないため、本当に固まったネイティブ呼び出しは
未解決の Promise を 1 本残す。回復後の新しい BLE と時間的に重なり得る。
アダプタはそれをセッション epoch で隔離し、古い完了が新しい HUD 状態へ
書き戻らないことだけを保証する。アプリ再起動や速度画像の恒久無効化、
キューの並列化は行わない。
