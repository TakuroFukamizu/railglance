export type HudDisplayMode = 'NORMAL' | 'UNCERTAIN' | 'NO_GPS' | 'INITIALIZING';

export type HudViewModel = {
  mode: HudDisplayMode;
  speedKmh: number | null;
  speedText: string;              // e.g. "93 km/h" or "-- km/h"
  lineNameText: string;           // e.g. "小田急小田原線 上り" or "路線判定中" or "GPS信号なし"
  stationProgressText: string;    // e.g. "海老名 → 座間" or "GPSから路線を確認中" or "位置情報を確認してください"
  nextDistanceText: string;       // e.g. "NEXT 4.2 km"
  gpsStatusSymbol: string;        // e.g. "GPS ●" or "GPS ○" or "GPS ✕"
  confidence: number;
  updatedAtMs: number;
};
