# 乗車履歴（記録・一覧・エクスポート）実装計画

> **For agentic workers:** この計画は ultracode ワークフローで実行する。各タスクのコードは Grok Build（`grok_implement`）または
> Codex（`codex`）が書き、Claude のサブエージェントは仕様の受け渡し・差分レビュー・検証（`pnpm test && pnpm lint && pnpm build`）を担う。
> ステップは `- [ ]` で追跡する。

**Goal:** 路線判定の結果から乗車を自動記録して端末内に保存し、ホームカードと `#/history` に表示し、JSON でエクスポートできるようにする。

**Architecture:** 純粋な reducer（`reduceRideTick`）が `EstimationLogEntry` 由来の tick から乗車の開始・終了を判定し、
効果（persist / close / discard）を返す。調停役 `createRideHistoryController` がそれを Dexie ストアに直列で流し、購読者に一覧を配る。
表示は `build*View` 純関数 + `main.ts` の DOM 書き込みという既存パターンに従う。エクスポートは共有 → クリップボード → テキスト表示の順に
実行時検出する。

**Tech Stack:** TypeScript, Vite, Dexie (IndexedDB), Vitest (`environment: 'node'`, `fake-indexeddb/auto`), ESLint。

**Spec:** `docs/superpowers/specs/2026-09-26-ride-history-design.md`（各タスクの実装者は必ず spec の該当節を読む）

## Global Constraints

- テストは Node 環境。jsdom はない。DOM / `navigator` は差し込み可能な最小インターフェースにし、手書きフェイクで検証する（`tests/ui/router.test.ts` 参照）。
- 既定値は spec の表のとおり: 開始確定 30 000 ms、ロック喪失終了 180 000 ms、停止終了 600 000 ms、最短 120 000 ms / 500 m、
  精度上限 100 m、跳び上限 5 000 m、persist 間隔 30 000 ms、保持 90 日 / 500 件、ホームカード 3 件。
- Dexie DB 名は `RailGlanceRideHistory`、テーブルは `rides: 'id,startedAtMs,status'`。テストの DB 名は `RailGlanceTest-${crypto.randomUUID()}`。
- 履歴は `TelemetrySink` を通さず、テレメトリの同意状態を読まない。
- UI 文言は日本語。`innerHTML` は使わず `createElement` / `replaceChildren` で組む。
- 受け入れゲートは `pnpm test && pnpm lint && pnpm build` がすべて成功すること（`--max-warnings=0`）。
- 既存の `main.ts` の購読・配線・診断まわりの挙動を変えない。`src/ui/diagnostic-panel.ts`、`src/app/app-controller.ts` は変更しない。
- コミットメッセージは英語の命令形 1 行（既存ログと同じ）。

## Review Focus

spec が暗に要求するが、どのタスクのテストにも無いと壊れやすい入力。各行のテストを担当タスクに入れてある。

1. **committed のまま `journey.status` が `GPS_UNAVAILABLE` になる（トンネル）**: 乗車は続く。→ Task 1 のテスト「tracking でない committed tick で継続」。
2. **`rawLocation` が `null` の tick が混ざる**: 距離は増えず、判定は続く。→ Task 1。
3. **同じ `EstimationLogEntry` の `timestampMs` が前 tick 以下（時計の巻き戻り）**: 距離・タイマーは負にならず、例外も出ない。→ Task 1。
4. **IndexedDB の `put` が reject する（容量不足・プライベートモード）**: `onError` に渡り、後続の tick でも処理が続き、UI は最後のキャッシュを出す。→ Task 4。
5. **`navigator.share` が存在するが `AbortError` 以外で reject する（WebView が未対応で TypeError）**: クリップボードに落ちる。→ Task 3。

---

## 実行フェーズ（ultracode）

| フェーズ | タスク | 実装者 | 並列 | 作業場所 |
| --- | --- | --- | --- | --- |
| A | Task 0 型と設定 | Codex | – | `issue-63` を直接 |
| B | Task 1 reducer / Task 2 ストア / Task 3 ビューとエクスポート | Codex / Grok / Grok | 3 並列 | タスクごとの git worktree（`issue-63-t1` 等）。ファイルが重ならないので後で `issue-63` にマージ |
| C | Task 4 コントローラ | Codex | – | `issue-63` を直接 |
| D | Task 5 配線（`main.ts` / `index.html` / CSS / README / docs） | Codex | – | `issue-63` を直接 |
| E | レビュー: `ask_grok` による差分レビュー + Claude の反証レビュー、指摘の修正は該当セッションに `grok_reply` / `codex-reply` | – | 並列 | `issue-63` |

各実装者への依頼文には次を必ず含める: spec の該当節の全文、タスクの「Files」「Interfaces」「Tests」、Global Constraints、
「質問はできないので迷ったら spec の既定に従う」、検証コマンド、コミット指示。

---

### Task 0: 型と設定

**Files:**
- Create: `src/domain/history/ride-record.ts`
- Create: `src/config/ride-history-config.ts`

**Interfaces:**
- Produces: spec「データモデル」の `RideEndReason`、`RideStationRef`、`RideRecord`（そのまま）。
  spec「乗車判定」の `RideHistoryConfig` と `DEFAULT_RIDE_HISTORY_CONFIG`（値は Global Constraints）。
- 追加で `export function createRideId(): string` を `ride-record.ts` に置く。`globalThis.crypto?.randomUUID` があればそれ、
  なければ `` `ride-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}` ``。

- [ ] **Step 1: 2 ファイルを作る**（テストは Task 1 以降が担う。型だけなので単体テストは書かない）
- [ ] **Step 2: `pnpm lint && pnpm build`** を通す
- [ ] **Step 3: Commit** — `Add ride history record types and config`

---

### Task 1: 乗車判定 reducer

**Files:**
- Create: `src/domain/history/ride-recorder.ts`
- Test: `tests/history/ride-recorder.test.ts`

**Interfaces:**
- Consumes: Task 0 の型と設定。`EstimationLogEntry`（`src/infrastructure/logging/logger.ts`）、
  `isCommittedRouteLock`（`src/domain/models/railway.ts`）、`haversineDistance`（`src/domain/geo/distance.ts`）。
- Produces:
  ```ts
  export type RideTick = { /* spec のとおり。committed と tracking を分ける */ };
  export type RideRecorderPhase = 'idle' | 'candidate' | 'riding';
  export type RideRecorderState = {
    phase: RideRecorderPhase;
    record: RideRecord | null;
    candidateSinceMs: number | null;
    sawMovingTick: boolean;
    lostSinceMs: number | null;
    stoppedSinceMs: number | null;
    lastCommittedAtMs: number | null;
    lastLocation: { latitude: number; longitude: number; timestampMs: number } | null;
    lastPersistedAtMs: number | null;
    firstStation: RideStationRef | null;     // candidate 以降に最初に見た previousStation
    lastStation: RideStationRef | null;      // 最後に見た非 null の previousStation
    candidateLine: RideTick['line'];
    candidateDirectionName: string | null;
    candidateDistanceMeters: number;         // riding 昇格前に積んだ距離
    candidateMaxSpeedKmh: number | null;
  };
  export type RideRecorderEffect =
    | { type: 'persist'; record: RideRecord }
    | { type: 'close'; record: RideRecord }
    | { type: 'discard'; recordId: string };
  export function createInitialRideRecorderState(): RideRecorderState;
  export function toRideTick(entry: EstimationLogEntry): RideTick;
  export function reduceRideTick(state: RideRecorderState, tick: RideTick, config: RideHistoryConfig, newId?: () => string):
    { state: RideRecorderState; effects: RideRecorderEffect[] };
  export function finalizeDanglingRecord(record: RideRecord, config: RideHistoryConfig): RideRecord | null;
  ```
- `reduceRideTick` は入力 state を変更しない（新しいオブジェクトを返す）。`newId` の既定は `createRideId`。
- 時計の巻き戻り: `tick.timestampMs` が `lastCommittedAtMs` / `lastLocation.timestampMs` 以下なら距離加算とタイマー進行をスキップし、
  例外を出さない。

**Tests（`tests/history/ride-recorder.test.ts`）:** ヘルパー `tick(overrides)` と `run(ticks)` を作り、spec「テスト」節の各項目を 1 `it` ずつ。
加えて Review Focus 1〜3:
- `committed: true, tracking: false` の tick を riding 中に 120 秒流しても閉じない。idle 中に流しても candidate にならない。
- `location: null` の tick で距離が変わらず、phase は維持される。
- `timestampMs` が前 tick より小さい tick を挟んでも `distanceMeters` は減らず、`effects` は空、例外なし。

- [ ] **Step 1: テストを書く**（まず `toRideTick` と昇格 30 秒のケース）
- [ ] **Step 2: `pnpm vitest run tests/history`** で失敗を確認
- [ ] **Step 3: reducer を実装**
- [ ] **Step 4: 残りのケースを追加し、`pnpm vitest run tests/history` を通す**
- [ ] **Step 5: `pnpm lint && pnpm build`**
- [ ] **Step 6: Commit** — `Add the ride recorder reducer`

---

### Task 2: 乗車履歴ストア

**Files:**
- Create: `src/infrastructure/storage/ride-history-store.ts`
- Test: `tests/storage/ride-history-store.test.ts`

**Interfaces:**
- Consumes: Task 0 の `RideRecord`。Dexie（`IndexedDbTelemetryStore` in `src/infrastructure/telemetry/sinks.ts:49-76` が手本）。
- Produces: spec「保存」の `RideHistoryStore`、`IndexedDbRideHistoryStore`、`InMemoryRideHistoryStore`。
  `listRecent` / `listAll` は `status === 'closed'` だけを `startedAtMs` 降順で返す。`prune(cutoffStartedAtMs, maxRecords)` は
  `closed` かつ `startedAtMs < cutoff` を消し、残りの `closed` が `maxRecords` を超えたら古い順に消す。`open` は消さない。
  `InMemoryRideHistoryStore` は `Map<string, RideRecord>` で同じ契約。

**Tests:** 2 実装に同じケース集合を `describe.each` で流す。spec「テスト」節の項目 + `listRecent(limit)` の件数、`listAll` が open を含まない、
`prune` が open を残す、`clear` 後に空。

- [ ] **Step 1: テストを書く** — [ ] **Step 2: 失敗確認** — [ ] **Step 3: 実装** — [ ] **Step 4: `pnpm vitest run tests/storage/ride-history-store.test.ts`**
- [ ] **Step 5: `pnpm lint && pnpm build`** — [ ] **Step 6: Commit** — `Add the IndexedDB ride history store`

---

### Task 3: ビューモデルとエクスポート

**Files:**
- Create: `src/ui/ride-history-view.ts`
- Create: `src/ui/ride-export.ts`
- Test: `tests/ui/ride-history-view.test.ts`, `tests/ui/ride-export.test.ts`

**Interfaces:**
- Consumes: Task 0 の型。`formatLocalDateTime`（`src/ui/diagnostic-panel.ts`）と同じ `ja-JP` / `hourCycle: 'h23'` 固定。
- Produces: spec「表示」「エクスポート」の関数群をそのままの名前と型で。追加の整形規則:
  - `when`: `MM/DD HH:mm`（`toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })`）。
  - `formatRideDuration`: 60 秒未満は「1分未満」、60 分未満は「N分」、以上は「H時間MM分」（分は 2 桁ゼロ埋め）。
  - `formatRideDistance`: 1000 m 未満は 10 m 丸めで「620m」、以上は小数 1 桁で「12.3km」（`src/ui/route-candidates.ts` と同じ）。
  - `maxSpeed`: `null` は「--」、それ以外は四捨五入整数 + 「 km/h」。
  - `exportRideHistoryText`: `share` の reject が `{ name: 'AbortError' }` なら `'cancelled'`。
- テスト時に時刻表示がタイムゾーンで揺れないよう、`buildHistoryCardView` / `buildHistoryListView` / `buildRideDetailView` は
  第 3 引数 `timeZone?: string` を受け、`main.ts` は渡さない（端末の TZ）。テストは `'Asia/Tokyo'` を渡す。

**Tests:** spec「テスト」節の項目。Review Focus 5 として「`share` が `TypeError` で reject → `copy` が呼ばれ `'copied'`」を含める。

- [ ] **Step 1: テストを書く** — [ ] **Step 2: 失敗確認** — [ ] **Step 3: 実装** — [ ] **Step 4: `pnpm vitest run tests/ui/ride-history-view.test.ts tests/ui/ride-export.test.ts`**
- [ ] **Step 5: `pnpm lint && pnpm build`** — [ ] **Step 6: Commit** — `Add ride history view builders and export helpers`

---

### Task 4: 乗車履歴コントローラ

**Files:**
- Create: `src/app/ride-history-controller.ts`
- Test: `tests/app/ride-history-controller.test.ts`

**Interfaces:**
- Consumes: Task 1 の reducer、Task 2 の `RideHistoryStore`、Task 0 の設定。
- Produces: spec「調停役」の `createRideHistoryController`。実装要点:
  - `queue: Promise<void>` に `.then(() => op()).catch((e) => onError?.(e, ctx))` でつなぐ。`persist` / `close` / `discard` の順序を保つ。
  - `close` 後に `prune` → `listRecent(config.maxRecords)` → キャッシュ更新 → `listeners` へ通知。
  - `subscribe` は購読時に現在のキャッシュを即 1 回再生する（ホームカードの初期描画のため）。返り値で解除。
  - `getRecent()` は配列のコピーを返す。
  - store の失敗後もキャッシュは前回値のまま。次の tick は通常どおり処理する。

**Tests:** spec「テスト」節 + Review Focus 4: `put` が 1 回 reject するフェイク store で `onError` が `'ride-history-persist'` で呼ばれ、
次の tick 以降の `put` は成功し、`getRecent()` が前回値のままであること。

- [ ] **Step 1: テストを書く** — [ ] **Step 2: 失敗確認** — [ ] **Step 3: 実装** — [ ] **Step 4: `pnpm vitest run tests/app/ride-history-controller.test.ts`**
- [ ] **Step 5: `pnpm lint && pnpm build`** — [ ] **Step 6: Commit** — `Add the ride history controller`

---

### Task 5: 画面配線

**Files:**
- Modify: `index.html`（`#history-card-body` はそのまま、`<section data-view="history">` を spec「表示」の構造に差し替え）
- Modify: `src/index.css`（spec「表示」の CSS を「Home cards」ブロックの後に追加）
- Modify: `src/main.ts`（`bootstrapApp` の後にコントローラ生成、`logger.subscribe` の隣に `rideHistory.onTick`、描画関数 `renderHistory`、ボタン配線、`await rideHistory.start()` を `controller.start()` の前）
- Modify: `README.md:118-140`（モジュール一覧に `domain/history/`、`storage/ride-history-store.ts`、`app/ride-history-controller.ts`、`ui/ride-history-view.ts`、`ui/ride-export.ts` を追記）
- Modify: `docs/TELEMETRY_AND_SENTRY.md`（「乗車履歴は端末内のみ（`RailGlanceRideHistory`）で、診断収集の対象外」を 1 行）

**Interfaces:**
- Consumes: Task 3 の `buildHistoryCardView` / `buildHistoryListView` / `buildRideHistoryExport` / `serializeRideHistoryExport` / `exportRideHistoryText`、
  Task 4 のコントローラ、`readBuildInfo().version ?? 'unknown'`。
- 実装要点:
  - `let expandedId: string | null = null;` を `main.ts` に持ち、`renderHistory(rides)` はカードと一覧を両方描く。
  - 一覧のクリックは `#history-list` への委譲 1 つ: `button[data-ride-delete]` なら `window.confirm('この乗車履歴を削除します。よろしいですか？')` → `removeRide`、
    `button[data-ride-id]` なら `expandedId` トグル → 再描画。
  - カードのクリックは `#history-card-body` への委譲: `button[data-ride-id]` で `expandedId` を設定し `router.navigate('history')`。
  - エクスポート: `caps.share = typeof navigator.share === 'function' ? (text, title) => navigator.share({ title, text }) : undefined`、
    `caps.copy = typeof navigator.clipboard?.writeText === 'function' ? (text) => navigator.clipboard.writeText(text) : undefined`。
  - 「すべて削除」は `window.confirm('端末内の乗車履歴をすべて削除します。よろしいですか？')`。
  - IndexedDB を開けない（`new IndexedDbRideHistoryStore()` の `open()` が reject）なら `captureRuntimeError(error, 'ride-history-open')` して
    `InMemoryRideHistoryStore` に切り替える。

- [ ] **Step 1: `index.html` と CSS** — [ ] **Step 2: `main.ts` 配線** — [ ] **Step 3: README / docs**
- [ ] **Step 4: `pnpm test && pnpm lint && pnpm build`**
- [ ] **Step 5: `pnpm dev:web` でホームに空状態文言、`#/history` にボタンと空状態が出ることを `curl`/目視で確認**（自動化不要）
- [ ] **Step 6: Commit** — `Wire ride history into the home card and history view`

---

### Task 6: レビューと修正（フェーズ E）

- [ ] `git diff main...issue-63` を `ask_grok` に渡し、spec との差異・バグ・WebView 非対応 API を指摘させる。
- [ ] Claude のサブエージェント 3 名が「反証」観点（正しさ / 仕様適合 / WebView 実行環境）で差分をレビューする。
- [ ] 確認された指摘は、担当セッションへ `grok_reply` / `codex-reply` で戻して修正させる。修正後に受け入れゲートを再実行。
- [ ] 手動確認項目（spec「テスト」末尾）は PR 本文に未実施として明記する。
