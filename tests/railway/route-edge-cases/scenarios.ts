import { GpsQuality, LatLon, TraceRun } from './trace';

/**
 * Line ids in dataset v1.4.0. MLIT splits one physical corridor into several
 * "lines" (legal line + parallel track pairs), so a run usually accepts a set.
 */
export const LINES = {
  yamanote: 'mlit-line-5056b45e38d9', // JR山手線 (legal line: 田端〜品川 via 新宿 only)
  tohokuTabataNippori1: 'mlit-line-fcd9992bcab0', // 東北線（田端〜日暮里・1）Yamanote/Keihin-Tohoku tracks
  tohokuTabataNippori2: 'mlit-line-6e6c24249082', // 東北線（田端〜日暮里・2）Utsunomiya/Takasaki tracks
  tohokuNipporiUeno: 'mlit-line-860c10a6084c', // 東北線（日暮里〜上野）
  tohokuTabataHigashiJujo1: 'mlit-line-485f3c8ed3b8', // 東北線（田端〜東十条・1）via 尾久 (Utsunomiya/Takasaki)
  tohokuTabataHigashiJujo2: 'mlit-line-c58d65291502', // 東北線（田端〜東十条・2）via 王子 (Keihin-Tohoku)
  tohokuTokyoAkihabara: 'mlit-line-09be4853884a', // 東北線（東京〜秋葉原）
  tohokuUenoAkihabara1: 'mlit-line-c51b6e954b3f', // 東北線（上野〜秋葉原・1）
  tohokuUenoAkihabara2: 'mlit-line-a6c78751ae3a', // 東北線（上野〜秋葉原・2）
  tokaidoShimbashiLoop: 'mlit-line-efb4245c43e0', // 東海道線（新橋・循環）
  tokaidoShimbashiShinagawa: 'mlit-line-fd7425256ac7', // 東海道線（新橋〜品川）
  tokaidoTamachiShimbashi: 'mlit-line-a2c5eac5b287', // 東海道線（田町〜新橋）
  tokaidoTamachiShinagawa1: 'mlit-line-e19f4a814b4d', // 東海道線（田町〜品川・1）
  tokaidoTamachiShinagawa2: 'mlit-line-d869cff35c54', // 東海道線（田町〜品川・2）
  tokaidoOimachiShinagawa: 'mlit-line-b47507a4f4a7', // 東海道線（大井町〜品川）
  chuo: 'mlit-line-59c38d061b4c', // 中央線（神田〜高尾）
  sobuOchanomizuRyogoku: 'mlit-line-a6580baa4053', // 総武線（御茶ノ水〜両国）local tracks
  sobuRyogokuTokyo: 'mlit-line-3e374ba2fe23', // 総武線（両国〜東京）rapid tunnel
  sobuRyogokuChoshi: 'mlit-line-0e2f98a0b43e', // 総武線（両国〜銚子）
  tohokuShinkansen: 'mlit-line-70283fe2cb3c', // 東北新幹線（大宮〜東京）
  tohokuShinkansenBundled: 'jreast-tohoku-shinkansen', // bundled sample: 3-point straight 東京→上野
  tokaidoShinkansenShinagawa: 'mlit-line-858f33787343', // 東海道新幹線（品川〜新横浜）
  tokaidoShinkansenSynthetic: 'synthetic-tokaido-shinkansen-tokyo-shinagawa', // see fixture meta.notes
} as const;

const SHINKANSEN_LINES = [
  LINES.tohokuShinkansen,
  LINES.tohokuShinkansenBundled,
  LINES.tokaidoShinkansenShinagawa,
  LINES.tokaidoShinkansenSynthetic,
];

export type EdgeScenario = {
  id: string;
  title: string;
  runs: TraceRun[];
  /** Lines that must never be shown at any point of the ride. */
  forbiddenLineIds?: string[];
  initialDwellS?: number;
  settleS?: number;
};

/** Where the MLIT Yamanote stub south of Shinagawa ends and the Yamanote/Tokaido tracks part. */
const GOTENYAMA_FORK: LatLon = [35.62049, 139.73762];
/** End of the 五反田-大崎 Yamanote segment; the 900 m curve from the fork is missing in the data. */
const OSAKI: LatLon = [35.62077, 139.72761];

const TUNNEL_GPS: GpsQuality = { accuracyMeters: [40, 90], noiseSigmaMeters: 30 };
/** Deep tunnel: no fix reaches the app at all. */
const NO_FIX_GPS: GpsQuality = { accuracyMeters: [400, 900], noiseSigmaMeters: 150, dropFixes: true };
/**
 * Just after a tunnel exit: positions come back far outside maxGpsAccuracyMeters (500 m),
 * so MapMatcher rejects them, and the device reports neither speed nor heading yet.
 */
const REACQUIRING_GPS: GpsQuality = { accuracyMeters: [520, 900], noiseSigmaMeters: 150, nullSpeedHeading: true };
/** Accuracy back inside the limit, still no speed/heading from the device. */
const DEGRADED_GPS: GpsQuality = { accuracyMeters: [60, 150], noiseSigmaMeters: 45, nullSpeedHeading: true };

const nipporiToTabata: TraceRun[] = [
  {
    label: '日暮里→西日暮里',
    path: ['mlit-segment-407c78205c86'],
    maxSpeedKmh: 55,
    accept: [LINES.tohokuTabataNippori1, LINES.tohokuTabataNippori2, LINES.tohokuNipporiUeno],
    dwellAtEndS: 30,
  },
  {
    label: '西日暮里→田端',
    path: ['mlit-segment-93191c6a8b55'],
    maxSpeedKmh: 60,
    accept: [LINES.tohokuTabataNippori1, LINES.tohokuTabataNippori2],
    dwellAtEndS: 35,
  },
];

const tamachiToShinagawa: TraceRun[] = [
  {
    label: '田町→高輪ゲートウェイ',
    path: ['mlit-segment-e3c0d8717098'],
    maxSpeedKmh: 60,
    accept: [LINES.tokaidoTamachiShinagawa1, LINES.tokaidoTamachiShinagawa2, LINES.tokaidoShimbashiShinagawa],
    dwellAtEndS: 30,
  },
  {
    label: '高輪ゲートウェイ→品川',
    path: ['mlit-segment-9a5b3a3e8963'],
    maxSpeedKmh: 55,
    accept: [LINES.tokaidoTamachiShinagawa1, LINES.tokaidoTamachiShinagawa2, LINES.tokaidoShimbashiShinagawa],
    dwellAtEndS: 40,
  },
  {
    // Yamanote, Keihin-Tohoku and Tokaido share this stretch; the data labels it JR山手線.
    label: '品川→御殿山分岐',
    path: ['mlit-segment-2006bd6b189c'],
    maxSpeedKmh: 50,
    accept: [
      LINES.yamanote,
      LINES.tokaidoOimachiShinagawa,
      LINES.tokaidoTamachiShinagawa1,
      LINES.tokaidoTamachiShinagawa2,
      LINES.tokaidoShimbashiShinagawa,
    ],
  },
];

export const FORWARD_SCENARIOS: EdgeScenario[] = [
  {
    // MapMatcher must not resolve the line from rejected fixes, and must recover once
    // usable fixes return east of 両国 rather than staying on whatever it held.
    id: 'sobu-rapid-tunnel-outage',
    title: '総武快速線 東京→錦糸町: 地下で測位が途切れ、出口で精度不良のまま復帰する',
    runs: [
      { label: '東京→新日本橋（測位なし）', path: ['mlit-segment-609c610c74b9'], maxSpeedKmh: 60, accept: [LINES.sobuRyogokuTokyo], dwellAtEndS: 30, gps: NO_FIX_GPS },
      { label: '新日本橋→馬喰町（測位なし）', path: ['mlit-segment-90360139449f'], maxSpeedKmh: 55, accept: [LINES.sobuRyogokuTokyo], dwellAtEndS: 30, gps: NO_FIX_GPS },
      { label: '馬喰町→両国（精度不良で復帰）', path: ['mlit-segment-04883a324733'], maxSpeedKmh: 70, accept: [LINES.sobuRyogokuTokyo], gps: REACQUIRING_GPS },
      { label: '両国→錦糸町（精度回復中）', path: ['mlit-segment-7683be07ad58'], maxSpeedKmh: 75, accept: [LINES.sobuRyogokuChoshi], dwellAtEndS: 30, gps: DEGRADED_GPS },
      { label: '錦糸町→亀戸', path: ['mlit-segment-3cfed8720eca'], maxSpeedKmh: 70, accept: [LINES.sobuRyogokuChoshi] },
    ],
    forbiddenLineIds: SHINKANSEN_LINES,
  },
  {
    id: 'tabata-fork-yamanote',
    title: '山手線 日暮里→田端→巣鴨: 京浜東北線と並走後、田端で西へ分離',
    runs: [
      ...nipporiToTabata,
      { label: '田端→駒込', path: ['mlit-segment-bf95eabf7b71'], maxSpeedKmh: 60, accept: [LINES.yamanote], dwellAtEndS: 30 },
      { label: '駒込→巣鴨', path: ['mlit-segment-c8b4cf25d168'], maxSpeedKmh: 55, accept: [LINES.yamanote], dwellAtEndS: 20 },
    ],
    forbiddenLineIds: SHINKANSEN_LINES,
  },
  {
    id: 'tabata-fork-keihin-tohoku',
    title: '京浜東北線 日暮里→田端→王子: 山手線と並走後、田端で北へ分離（尾久経由の東北線とも別）',
    runs: [
      ...nipporiToTabata,
      { label: '田端→上中里', path: ['mlit-segment-61541445fd4c'], maxSpeedKmh: 70, accept: [LINES.tohokuTabataHigashiJujo2], dwellAtEndS: 30 },
      { label: '上中里→王子', path: ['mlit-segment-9d29ffa6c36b'], maxSpeedKmh: 60, accept: [LINES.tohokuTabataHigashiJujo2], dwellAtEndS: 20 },
    ],
    forbiddenLineIds: SHINKANSEN_LINES,
  },
  {
    id: 'shinagawa-fork-yamanote',
    title: '山手線 田町→品川→五反田: 京浜東北線・東海道線と並走後、御殿山で西へ分離',
    runs: [
      ...tamachiToShinagawa,
      { label: '御殿山分岐→大崎', path: [GOTENYAMA_FORK, OSAKI], maxSpeedKmh: 55, accept: [LINES.yamanote], dwellAtEndS: 30 },
      { label: '大崎→五反田', path: ['mlit-segment-9673dddf5064'], maxSpeedKmh: 55, accept: [LINES.yamanote], dwellAtEndS: 20 },
    ],
    forbiddenLineIds: SHINKANSEN_LINES,
  },
  {
    id: 'shinagawa-fork-keihin-tohoku',
    title: '京浜東北線 田町→品川→大井町方面: 山手線と分離し、東海道新幹線と並走',
    runs: [
      ...tamachiToShinagawa,
      { label: '御殿山分岐→大井町方面', path: ['mlit-segment-7cd5a4d0e053'], maxSpeedKmh: 70, accept: [LINES.tokaidoOimachiShinagawa] },
    ],
    forbiddenLineIds: SHINKANSEN_LINES,
  },
  {
    id: 'tokyo-shinagawa-keihin-tohoku',
    title: '京浜東北線 東京→品川（各駅）: 東海道新幹線と並走しても新幹線と判定しない',
    runs: [
      { label: '東京→有楽町', path: ['mlit-segment-c64806aa8ed2'], maxSpeedKmh: 50, accept: [LINES.tokaidoShimbashiLoop, LINES.tohokuTokyoAkihabara], dwellAtEndS: 30 },
      { label: '有楽町→新橋', path: ['mlit-segment-e226dec05ff8'], maxSpeedKmh: 60, accept: [LINES.tokaidoShimbashiLoop], dwellAtEndS: 30 },
      { label: '新橋→浜松町', path: ['mlit-segment-99811a2ca443'], maxSpeedKmh: 65, accept: [LINES.tokaidoTamachiShimbashi, LINES.tokaidoShimbashiShinagawa], dwellAtEndS: 30 },
      { label: '浜松町→田町', path: ['mlit-segment-b8e5061b7ff1'], maxSpeedKmh: 65, accept: [LINES.tokaidoTamachiShimbashi, LINES.tokaidoShimbashiShinagawa], dwellAtEndS: 30 },
      ...tamachiToShinagawa.slice(0, 2),
    ],
    forbiddenLineIds: SHINKANSEN_LINES,
  },
  {
    id: 'tokyo-shinagawa-tokaido-rapid',
    title: '東海道線 東京→品川（通過運転 90km/h）: 並走する東海道新幹線と判定しない',
    runs: [
      {
        label: '東京→新橋→品川',
        path: ['mlit-segment-d28b146ffcb4', 'mlit-segment-0759db0575b7'],
        maxSpeedKmh: 90,
        accept: [
          LINES.tokaidoShimbashiLoop,
          LINES.tokaidoShimbashiShinagawa,
          LINES.tokaidoTamachiShimbashi,
          LINES.tokaidoTamachiShinagawa1,
          LINES.tokaidoTamachiShinagawa2,
        ],
      },
    ],
    forbiddenLineIds: SHINKANSEN_LINES,
  },
  {
    // 東京〜品川 runs at ~110 km/h, below routeConventionalMaxSpeedKmh (160), so the
    // speed penalty cannot tell it apart from the conventional lines; geometry must.
    id: 'tokyo-shinagawa-tokaido-shinkansen',
    title: '東海道新幹線 東京→品川→新横浜方面: 在来線と35m間隔で並走',
    runs: [
      { label: '東京→品川', path: ['synthetic-segment-tokaido-shinkansen-tokyo-shinagawa'], maxSpeedKmh: 110, accept: [LINES.tokaidoShinkansenSynthetic], dwellAtEndS: 60 },
      { label: '品川→新横浜', path: ['mlit-segment-9ce729141b87'], maxSpeedKmh: 150, accept: [LINES.tokaidoShinkansenShinagawa] },
    ],
  },
  {
    id: 'tokyo-ueno-keihin-tohoku',
    title: '京浜東北線 東京→上野: 高架の東北新幹線（MLIT + 同梱サンプルの直線近似）と並走',
    runs: [
      { label: '東京→神田', path: ['mlit-segment-b8334a524745'], maxSpeedKmh: 60, accept: [LINES.tohokuTokyoAkihabara, LINES.tokaidoShimbashiLoop], dwellAtEndS: 30 },
      { label: '神田→秋葉原', path: ['mlit-segment-811bda66c865'], maxSpeedKmh: 45, accept: [LINES.tohokuTokyoAkihabara], dwellAtEndS: 30 },
      { label: '秋葉原→御徒町', path: ['mlit-segment-15529180bed5'], maxSpeedKmh: 55, accept: [LINES.tohokuUenoAkihabara1, LINES.tohokuUenoAkihabara2], dwellAtEndS: 30 },
      { label: '御徒町→上野', path: ['mlit-segment-a720eb8aa2be'], maxSpeedKmh: 45, accept: [LINES.tohokuUenoAkihabara1, LINES.tohokuUenoAkihabara2], dwellAtEndS: 20 },
    ],
    forbiddenLineIds: SHINKANSEN_LINES,
  },
  {
    id: 'ochanomizu-ryogoku-sobu-local',
    title: '中央・総武線各駅停車 水道橋→御茶ノ水→両国→亀戸: 御茶ノ水で中央線と分離、両国で総武本線に合流',
    runs: [
      { label: '水道橋→御茶ノ水', path: ['mlit-segment-37f18e3fada9'], maxSpeedKmh: 55, accept: [LINES.chuo], dwellAtEndS: 30 },
      { label: '御茶ノ水→秋葉原', path: ['mlit-segment-985d48f84578'], maxSpeedKmh: 50, accept: [LINES.sobuOchanomizuRyogoku], dwellAtEndS: 30 },
      { label: '秋葉原→浅草橋', path: ['mlit-segment-bb8462c5020a'], maxSpeedKmh: 55, accept: [LINES.sobuOchanomizuRyogoku], dwellAtEndS: 30 },
      { label: '浅草橋→両国', path: ['mlit-segment-aa772ddff9c4'], maxSpeedKmh: 55, accept: [LINES.sobuOchanomizuRyogoku], dwellAtEndS: 30 },
      { label: '両国→錦糸町', path: ['mlit-segment-7683be07ad58'], maxSpeedKmh: 65, accept: [LINES.sobuRyogokuChoshi], dwellAtEndS: 30 },
      { label: '錦糸町→亀戸', path: ['mlit-segment-3cfed8720eca'], maxSpeedKmh: 60, accept: [LINES.sobuRyogokuChoshi], dwellAtEndS: 20 },
    ],
    forbiddenLineIds: SHINKANSEN_LINES,
  },
  {
    id: 'ryogoku-sobu-rapid',
    title: '総武快速線 東京→馬喰町（地下・GPS劣化）→両国通過→錦糸町→亀戸',
    runs: [
      { label: '東京→新日本橋', path: ['mlit-segment-609c610c74b9'], maxSpeedKmh: 60, accept: [LINES.sobuRyogokuTokyo], dwellAtEndS: 30, gps: TUNNEL_GPS },
      { label: '新日本橋→馬喰町', path: ['mlit-segment-90360139449f'], maxSpeedKmh: 55, accept: [LINES.sobuRyogokuTokyo], dwellAtEndS: 30, gps: TUNNEL_GPS },
      { label: '馬喰町→両国（通過）', path: ['mlit-segment-04883a324733'], maxSpeedKmh: 75, accept: [LINES.sobuRyogokuTokyo] },
      { label: '両国→錦糸町', path: ['mlit-segment-7683be07ad58'], maxSpeedKmh: 80, accept: [LINES.sobuRyogokuChoshi], dwellAtEndS: 30 },
      { label: '錦糸町→亀戸（通過）', path: ['mlit-segment-3cfed8720eca'], maxSpeedKmh: 85, accept: [LINES.sobuRyogokuChoshi] },
    ],
    forbiddenLineIds: SHINKANSEN_LINES,
  },
];

/** Same corridor ridden the other way: forks become merges, which waver differently. */
export function reverseScenario(scenario: EdgeScenario): EdgeScenario {
  const runs = scenario.runs;
  const reversed = runs
    .map((run, index): TraceRun => ({
      ...run,
      label: run.label.split('→').reverse().join('→'),
      path: [...run.path].reverse(),
      // The stop at the start of a forward run is the stop at the end of its reversed run.
      dwellAtEndS: runs[index - 1]?.dwellAtEndS,
    }))
    .reverse();
  return { ...scenario, id: `${scenario.id}-reverse`, title: `${scenario.title}（逆方向）`, runs: reversed };
}

export const EDGE_SCENARIOS: EdgeScenario[] = FORWARD_SCENARIOS.flatMap((scenario) => [
  scenario,
  reverseScenario(scenario),
]);
