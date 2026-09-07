# Phone UI 再構成（公開版に向けた画面整理）

日付: 2026-09-08
ブランチ: `control-phone-ui-redesign`

## 目的

Even App の WebView に表示されるスマートフォン側画面（Control Interface / Phone UI）を、公開版として
一般ユーザが見て分かる構成に整理する。

- トップは「ユーザ操作が必要なもの」と「シンプルな状態表示」だけにする。
- テスター向け診断記録と、推定状態の詳細（デバッグパネル）は全画面の詳細画面に移す。
- 乗車履歴を、現在の乗車状態と同じ優先度でトップに置く。ただし履歴の一覧・エクスポート機能そのものは
  別 Issue で設計・実装するため、本 spec ではカードの枠と空状態だけを用意する。

## 現状

`index.html` は 1 枚の縦長ページで、ヘッダー（5 ボタン）、576px 固定の HUD プレビュー、路線再検出、
テスター向け診断記録、デバッグパネル（7 カード）が上から順に並ぶ。スマホ幅では HUD プレビューが横スクロールになり、
候補路線ボタンにはセグメント ID と生スコアが出る。デバッグパネルはログ更新のたびに innerHTML を丸ごと再描画する。
診断状態インジケータ（`#diagnostic-indicator`）は診断セクションの内側にありながら `position: fixed` で画面下部に出ている。

## 制約

- 診断収集の状態は全画面で常時見える必要がある（`docs/TELEMETRY_AND_SENTRY.md`「スマートフォン画面下部に診断状態を常時表示する」）。
- `app.json` の entrypoint は `index.html` 1 つ。画面遷移はページ内で行い、各詳細画面に自前の「戻る」を置く。
  Even App WebView にネイティブの戻る操作がある証拠はないため、それに依存しない。
- iOS の DeviceMotion 許可はユーザのタップ起点でしか取得できない。モーションセンサー有効化はユーザ操作として残す。
- `docs/HUD_UI_UX_REQUIREMENTS.md` 21 章（13 状態をワンタップで切り替える開発用プレビュー）と 22 章（視認性確認モード
  5 種）はいずれも現状未実装で、本 spec 以前からの未達である。本 spec では実装せず、推定状態の詳細画面にその置き場を
  確保するにとどめ、別 Issue で追跡する（「スコープ外」参照）。
- テスターはヘッダーのビルド情報でパッケージ更新を確認している。全画面で見えるようにする。
- テストは Vitest の `environment: 'node'` で動き、jsdom 等の DOM 実装は入っていない。DOM を触るコードは
  差し込み可能な最小インターフェースにし、既存の `tests/ui/debug-panel.test.ts` と同じく手書きのフェイクで検証する。

## 画面構成

4 画面をハブ & スポーク構成で持つ。ホームから各詳細へ入り、詳細から「‹ 戻る」でホームに戻る。

| 画面 | ルート | 内容 |
| --- | --- | --- |
| ホーム | `#/` | 現在の乗車カード、路線再検出、乗車履歴カード、副次入口 2 行 |
| 乗車履歴 | `#/history` | 空状態のみ（別 Issue で一覧・エクスポートを実装） |
| テスター向け診断記録 | `#/diagnostics` | 現在の診断フォーム（説明、同意、参加コード、開始 / 停止 / 削除）を移設 |
| 推定状態の詳細 | `#/debug` | HUD プレビュー、位置ソース切替、デモ、デバッグパネル 7 カード |

ルーティング対象の 4 ビューはそれぞれ `<section data-view="home|history|diagnostics|debug">` とし、表示中以外は
`hidden` にする。次の 2 つはどのビューにも属さず、`<section data-view>` の外に置いて常時表示する。

- **共通ヘッダー**: アプリ名とビルド情報（`#build-info`）。ホーム以外では、アプリ名の左に「‹ 戻る」ボタンを出す。
  ビューごとの見出し（「乗車履歴」など）は各 `<section>` 内の `<h2>` が持つ。
- **診断状態チップ**: 現在の `#diagnostic-indicator`（`#diagnostic-status` と `#diagnostic-detail` を含む `aria-live`
  領域）を、診断セクションの外に出して画面下部固定のまま残す。`main.ts` が同意未チェックや停止失敗時の説明文を
  `#diagnostic-detail` に書く挙動、`is-active` / `is-error` のスタイルも維持する。チップ全体を `<button type="button">`
  にし、タップで `#/diagnostics` へ移動する。`body` の `padding-bottom` は `calc(<チップ高さの上限> + env(safe-area-inset-bottom))`
  とし、`@media (max-width: 720px)` の `padding: 12px` が下パディングを潰さないよう、モバイル側でも `padding-bottom` を
  明示的に指定する。チップ高さの上限は、参加済み状態の最長の `#diagnostic-detail`（キャンペーン ID、同意日時、資格期限）
  が 320px 幅で折り返した高さを基準に決める。

## ホーム

```
┌──────────────────────────┐
│ RailGlance        v0.1.3 │
├──────────────────────────┤
│ ⚠ モーションセンサーを有効化 [有効化] │  ← 表示条件は「モーションセンサーバナー」参照
├──────────────────────────┤
│ 小田急小田原線      上り  │  ← 現在の乗車カード 1 行目: 路線 + 方向
│ 93 km/h            GPS ● │  ← 2 行目: 速度 + 補足状態
└──────────────────────────┘
        [ 路線を再検出 ]      ← 候補があるときだけ下に候補リストを展開
┌──────────────────────────┐
│ 乗車履歴          すべて ›│  ← 乗車履歴カード（現在の乗車カードと同じ大きさ・階層）
│ 乗車履歴はまもなく        │
│ 利用できるようになります   │
└──────────────────────────┘
  テスター向け診断記録 ›       ← 副次入口。控えめな 1 行リンク
  推定状態の詳細 ›
┌──────────────────────────┐
│ 診断収集: 停止           │  ← 常時表示チップ（固定下部）
└──────────────────────────┘
```

### 現在の乗車カード

`HudViewModel` と `DatasetSyncStatus` だけから組み立てる（`buildHomeStatusView`）。

| 行 | 左 | 右 |
| --- | --- | --- |
| 1 | `header.lineName` | `header.serviceOrDirection` |
| 2 | `speed.displaySpeedKmhText` + ` km/h`。`speed.isEstimated` のとき先頭に `~` | `footer.statusRight`（+ データ同期の追記） |

- 速度の空白化（`--`）や路線名の「路線判定中」などの文言は `HudRenderer` が `HudViewModel` に入れた値をそのまま使う。
  ホーム側では `statusMode` や路線状態から速度や文言を推測しない。
- 補足状態の色は `statusMode` で決める: `GPS` は通常色、`GPS_DEGRADED` / `DR` / `REACQUIRING` / `UNCERTAIN` は注意色、
  `SPEED_UNKNOWN` / `LOST` は警告色。7 値すべてを CSS クラス `status-<tone>`（`ok` / `warn` / `alert`）に写像する。
- データ同期の追記は `DatasetSyncStatus` の観測可能なフィールドから決める。
  - `status === 'downloading'` → `· データ取得中`
  - `status === 'error'` または `status === 'unavailable'` または `errorMessage` が非空 → `· データ取得エラー`
  - それ以外（`bundled` / `cached` / `cloud` でエラーなし）→ 追記なし
  - 現在の `DexieRailwayDatabase` は manifest 取得失敗時に `status: 'bundled'` と `errorMessage` を同時に返すので、
    上の規則でその状態は「データ取得エラー」として見える。タイル取得失敗は `getSyncStatus()` に反映されないため
    ホームには出ない（データベース側の変更は本 spec の範囲外）。
- 初期表示: 最初の `HudViewModel` を受け取るまで、1 行目は `路線判定中` / 右は空、2 行目は `-- km/h` / `測位中`、
  色は `alert`。`index.html` にサンプル路線名や駅名を書かない。

### 路線再検出

カードの直下に「路線を再検出」ボタンを 1 つ置く。現在の挙動（`startManualReacquire` → 候補リスト表示 → 候補タップで
`lockSelectedRoute` → `MANUAL_LOCK` 中は「自動判定に戻す」で `unlockManualRoute`、`manualLockAway` 時の離脱警告）は
そのまま維持する。候補リストの表示可否条件（`REACQUIRING` / `UNRESOLVED`、または `scoreMargin < routeCandidateTieMargin`
かつ候補 2 件以上）も `main.ts` から `buildRouteCandidateItems` に移すだけで変えない。

候補 1 件の表示は次の 2 要素に絞り、スコアは出さない。

- 主表示: `line.name`
- 副表示: 距離。`distanceMeters < 1000` なら 10 m 単位に四捨五入して `約120m`、`1000` 以上なら小数 1 桁の
  `約1.2km`。
- 同じ `line.name` の候補が 2 件以上あるときだけ、そのグループの全員の副表示末尾に `· <segment.id>` を添える。
- ボタンの `data-segment-id` には常に `segment.id` を入れる（選択キー）。並び順は `match.candidates` の順のまま。

### モーションセンサーバナー

`DeviceMotionSensorFusionProvider` の許可状態を次の公開型にし、状態変化を購読できるようにする。

```ts
export type MotionPermissionState = 'unknown' | 'granted' | 'denied' | 'unsupported' | 'insecure-context';
onPermissionChange(listener: (state: MotionPermissionState) => void): () => void;
```

プロバイダ側の変更は状態の割り当てを完全にすることに限る: `window.isSecureContext === false` なら `insecure-context`、
`requestPermission()` 中の例外でイベントも来なければ `denied`。`main.ts` の許可要求用インスタンスと `SpeedEstimator`
内部のインスタンスが別物である点は変えない。DeviceMotion の許可はページ単位なので、片方で許可を得ればもう片方にも
イベントが届く。

`onPermissionChange` は購読時に現在の状態を再生しない（購読直後に `getPermissionStatus()` を読む）。

バナーは `buildMotionBannerView(state: MotionPermissionState, phase: MotionBannerPhase)` で組み立てる。
`MotionBannerPhase = 'idle' | 'requesting' | 'just-granted'` で、遷移は次のとおり。

- 起動時は `idle`。このとき `state === 'granted'` ならバナーを出さない。
- [有効化] / [再試行] タップで `requesting`。`requestPermission()` の解決後、結果が `granted` なら `just-granted`、
  それ以外は `idle` に戻す。
- `just-granted` は 3 秒のタイマーで `idle` に戻す（`granted` + `idle` なので非表示になる）。タイマー中に再度
  `just-granted` へ入ったら前のタイマーを取り消して張り直す。`phase` の遷移とタイマーは `motion-banner.ts` の
  小さな状態機械（`createMotionBannerController({ provider, setTimeout, clearTimeout })`）に閉じ込め、フェイクタイマーで検証する。

バナーの表示規則:

| 状態 | 表示 |
| --- | --- |
| `unknown` | 「モーションセンサーを有効にすると、トンネル内でも速度を推定できます」+ [有効化] |
| `requesting`（状態は問わない） | 直前の文言のまま、ボタンは無効 |
| `granted` + `just-granted` | 「有効化しました」。ボタンなし |
| `granted` + `idle` | 非表示 |
| `denied` | 「許可されませんでした。端末の設定で Even App のモーションアクセスを許可してください」+ [再試行] |
| `unsupported` | 「この端末ではモーションセンサーを利用できません」。ボタンなし |
| `insecure-context` | 「安全な接続（https）でないためモーションセンサーを利用できません」。ボタンなし |

現在の `alert()` は使わない。

### 乗車履歴カード

見出し「乗車履歴」、右上の「すべて ›」リンク（`#/history`）、空状態テキストだけを持つ。カード内の中身は別 Issue が
差し替える前提で、`#history-card-body` という 1 つの差し替え領域として作る。カードの外形（余白、枠、見出しのサイズ）は
現在の乗車カードと同じクラスを使い、同じ視覚的階層にする。

## 乗車履歴（詳細）

`<h2>乗車履歴</h2>` と空状態テキストだけ。一覧、詳細、エクスポートは別 Issue。エクスポート手段（共有シート / クリップボード /
ダウンロード）は WebView での可否が未確認のため、本 spec では決めない。

## テスター向け診断記録

現在の `diagnostic-section` から、説明文、同意チェック、参加コード、開始 / 停止 / 削除ボタンをこの画面へ移す。
状態インジケータだけは共通チップとして外に出す（「画面構成」参照）。`buildDiagnosticPanelView` と
`RuntimeTelemetryManager` の連携、各ボタンのハンドラは変更しない。

## 推定状態の詳細

開発者・テスター向け。上から順に:

1. **HUD プレビュー（576×288 論理サイズの縮小表示）。** 外側ラッパーは `width: min(100%, 576px)` で中央寄せ、
   `aspect-ratio: 2 / 1`、`overflow: hidden`（現在の `.preview-section { overflow-x: auto }` は削除する）。内側の
   `#hud-root` は 576×288 のまま `position: absolute; transform-origin: top left` にし、`scale = min(1, ラッパー幅 / 576)`
   を `ResizeObserver`（無ければ `resize` イベント）で計算して `transform: scale()` に入れる。レイアウト上の幅は
   ラッパーが持つので横スクロールは出ない。見出しは「Even G2 HUD プレビュー（576×288 を縮小表示）」とし、
   「実寸」とは呼ばない。プレビュー直下に `#hud-preview-controls` という空の領域を置く（21 章の状態切替、22 章の
   視認性モードの将来の置き場）。
2. **位置ソース**: `実機GPS開始`（Browser Geolocation へ切替）、`停止`、`小田急線デモ`、`新幹線デモ`。現在の挙動のまま。
3. **デバッグパネル 7 カード**（`DebugPanel`）。

### DebugPanel の遅延描画

`DebugPanel` に次を加える。

- コンストラクタは要素 ID に加えて、`{ innerHTML: string }` を満たす要素そのものも受け取れる（テスト用の差し込み口）。
- `setVisible(visible: boolean)`。初期値は `false`。
- `update(...)` は引数一式を `latestArgs` に保存する。表示中なら即描画、非表示中なら `dirty = true` にして描画しない。
- `setVisible(true)` は、`dirty` のときだけ `latestArgs` で 1 回描画して `dirty = false` にする。すでに表示中の
  `setVisible(true)` や、`dirty` でない場合は描画しない。`setVisible(false)` は描画しない。

## ナビゲーション

- `location.hash` をルートとして使う。`resolveRoute(hash)` は `#/` → `home`、`#/history` → `history`、
  `#/diagnostics` → `diagnostics`、`#/debug` → `debug`、それ以外（空を含む）→ `null` を返す純粋関数。
- 起動時: hash が有効ならそのビューを表示する（テスターがリロードしても `#/debug` に留まれる）。無効または空なら
  `history.replaceState` で `#/` に正規化する（履歴エントリを積まない）。
- `hashchange` 時: 有効なら表示ビューを切り替える。無効なら同じく `replaceState` で `#/` に正規化する。
- 表示切替（`applyRoute`）は、対象ビューだけ `hidden` を外し、`window.scrollTo(0, 0)` してから、そのビューの `<h2>`
  （`tabindex="-1"`）にフォーカスを移す。ホームでは「‹ 戻る」を隠し、それ以外では出す。`document.title` は
  `RailGlance – <ビュー名>` にする。
- ルート切替の調停役（`createRouter({ location, history, views, chrome, onRouteApplied })`）を `router.ts` に置く。
  `location` / `history` / `views` は最小インターフェースで差し込み、起動時と `hashchange` の両経路を Node で検証する。
  無効 hash のときは `replaceState` で URL を直した直後に、同期的に `applyRoute(home)` を呼ぶ（`replaceState` は
  `hashchange` を発火しないため、別イベントを待たない）。
- `onRouteApplied(route)` で `main.ts` が `debugPanel.setVisible(route === 'debug')` を呼び、`debug` に入るたびに
  プレビューのスケールを再計算する。非表示中に測った幅が 0 のときは `requestAnimationFrame` で 1 フレーム遅らせて
  測り直す。この連携はフェイクの `DebugPanel` とスケーラを差し込んで検証する。
- 「‹ 戻る」は `location.hash = '#/'` にする（`history.back()` に依存しない）。
- `src/index.css` に `[hidden] { display: none !important; }` を入れ、後続の CSS が `display` を上書きしても
  非表示が壊れないようにする。
- `onLaunchSource` による初期画面の切替は今回は行わない。

## 実装構成

既存の「純粋関数でビューモデルを作り、`main.ts` で DOM に流し込む」パターンに合わせる。

| ファイル | 役割 |
| --- | --- |
| `index.html` | 共通ヘッダー、4 つの `<section data-view>`、共通の診断チップに再構成。サンプル路線・駅名を置かない |
| `src/index.css` | カード、副次入口、バナー、戻るボタン、縮小プレビュー、`[hidden]` のスタイルを追加。デバッグ系スタイルは維持 |
| `src/ui/router.ts` | `resolveRoute(hash): ViewName \| null`、`applyRoute(views, route, chrome)`。DOM は `{ hidden, focus?, scrollTo? }` 相当の最小インターフェースで受け取る |
| `src/ui/home-status-card.ts` | `buildHomeStatusView(model: HudViewModel \| null, sync?: DatasetSyncStatus): HomeStatusView` |
| `src/ui/route-candidates.ts` | `shouldShowRouteCandidates(match, tieMargin)` と `buildRouteCandidateItems(match)`（`main.ts` から移す） |
| `src/ui/motion-banner.ts` | `buildMotionBannerView(state, phase): MotionBannerView` |
| `src/ui/hud-preview-scale.ts` | `computePreviewScale(wrapperWidth): number`（純粋関数）と ResizeObserver の配線 |
| `src/ui/debug-panel.ts` | 要素の差し込み、`setVisible`、`latestArgs` / `dirty` による遅延描画 |
| `src/infrastructure/sensors/device-motion-sensor-fusion-provider.ts` | `MotionPermissionState` の公開、`insecure-context` / `denied` の割り当て、`onPermissionChange` |
| `src/main.ts` | ルーター初期化、各ビルダーの結果を DOM に反映、イベント配線 |

`src/ui/diagnostic-panel.ts` は変更しない。

## テスト

すべて Node 環境の Vitest で、DOM は手書きのフェイクを差し込む。

- `tests/ui/router.test.ts`: `resolveRoute` の 4 ルートと無効・空 hash。`applyRoute` をフェイク要素で呼び、
  対象だけ `hidden=false` になること、ホーム以外で戻るボタンが出ること、スクロールとフォーカスが呼ばれること。
  `createRouter` をフェイクの `location` / `history` で起動し、有効 hash での起動、無効 hash での `replaceState` と
  同期的なホーム表示、`hashchange` 後の切替、`onRouteApplied` の呼び出しを検証する。
- `tests/ui/debug-view.test.ts`: ルート適用後に `setVisible` と `refreshScale` がフェイク経由で呼ばれること、幅 0 のとき
  1 フレーム後に再測定すること。
- `tests/ui/home-status-card.test.ts`: `null` モデルの初期表示、7 つの `statusMode` それぞれの色クラス、`isEstimated` の
  `~`、同期状態 6 値と `errorMessage` の組み合わせでの追記文言。`HudViewModel` の文言をそのまま通すこと。
- `tests/ui/route-candidates.test.ts`: 表示可否条件 3 通りと非表示条件、距離の整形（999m / 1000m 境界、10 m 丸め）、
  同名路線グループ全員への ID 付与と単独路線への非付与、`segmentId` の保持。
- `tests/ui/motion-banner.test.ts`: 5 状態 × `phase` の表示可否・文言・ボタン有無。コントローラをフェイクタイマーで
  動かし、`just-granted` から 3 秒後に非表示になること、タイマーの張り直し、起動時 `granted` で最初から非表示なこと。
- `tests/ui/hud-preview-scale.test.ts`: 幅 320 / 375 / 576 / 800 でのスケール（上限 1）。
- `tests/ui/debug-panel.test.ts`（既存に追加）: 非表示中の `update` が `innerHTML` を書かないこと、`setVisible(true)` で
  最新引数により 1 回だけ書くこと、`dirty` でない再表示で書かないこと、表示中の `update` が即書くこと。
- `tests/sensors/device-motion-sensor-fusion-provider.test.ts`（既存に追加）: `unsupported`、API が `granted` / `denied` を
  返す場合、`requestPermission` API がない環境での `granted`、`denied` 後にイベントが届いたときの `granted` への昇格、
  `insecure-context`、例外時 `denied`、`onPermissionChange` の通知と解除。
- 手動確認（`pnpm dev` の公式シミュレーターと実機 Even App）: 4 画面の遷移、コールドスタート・リロード・`#/debug`
  復元・不明 hash、診断チップが全画面で見えてタップで診断画面に移ること、幅 320px / 375px と横向きでプレビューが
  横スクロールしないこと、参加済みで詳細文が最長のときも診断チップが最後のボタンに被らないこと、
  路線再検出の候補展開と手動ロック解除、モーション許可の各結果。

## スコープ外

- 乗車履歴の記録・一覧・エクスポート（別 Issue）。
- HUD プレビューの 13 状態切替（`HUD_UI_UX_REQUIREMENTS.md` 21 章）と視認性確認モード（同 22 章）。いずれも
  本 spec 以前から未実装。置き場 `#hud-preview-controls` だけ用意し、別 Issue で追跡する。
- タイル取得失敗を `getSyncStatus()` に反映するデータベース側の変更。
- `onLaunchSource` に応じた初期画面の切替。
- 英語ローカライズ（`app.json` は `ja` / `en` を宣言しているが、現在の UI は日本語のみ。本 spec も日本語のまま）。
