export type HudStatusMode = 'GPS' | 'GPS_DEGRADED' | 'DR' | 'REACQUIRING' | 'UNCERTAIN' | 'LOST';

export type HudHeaderState = {
  lineName: string;         // e.g. "小田急小田原線" or "路線特定中"
  serviceOrDirection: string; // e.g. "快急 新宿", "上り", "列車特定中"
};

export type HudSpeedState = {
  displaySpeedKmhText: string; // e.g. "108", "0", "--"
  unitText: string;            // e.g. "km/h"
  isEstimated: boolean;        // Show '~' when dead-reckoning or interpolating
};

export type HudSegmentState = {
  previousStationName: string; // e.g. "海老名" or "前駅不明"
  nextStationName: string;     // e.g. "座間" or "次駅推定中"
  progressRatio: number | null;// 0.0 ~ 1.0 (null if uncertain)
  segmentMaxSpeedText?: string;// e.g. "区間MAX 115"
  distanceToNextText: string;  // e.g. "次まで 4.2km" or "次まで 620m"
};

export type HudFooterState = {
  leftInfo: string;            // e.g. "上り 3004列車" or "座間 停車中"
  statusRight: string;         // e.g. "GPS", "GPS弱", "DR 8s", "補正中", "測位中"
};

export type HudViewModel = {
  header: HudHeaderState;
  speed: HudSpeedState;
  segment: HudSegmentState;
  footer: HudFooterState;
  statusMode: HudStatusMode;
  rawFormattedText: string;    // Text representation for G2 glasses text mode
  timestampMs: number;
};
