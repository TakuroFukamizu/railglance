import { JourneyState } from '../../domain/models/railway';
import { SpeedEstimate } from '../../domain/models/location';
import { HudViewModel } from '../../domain/models/hud';

export class HudRenderer {
  public createViewModel(
    speed: SpeedEstimate,
    journey: JourneyState,
    currentTimeMs: number
  ): HudViewModel {
    // 1. Check GPS Availability
    if (!speed.isValid || journey.status === 'GPS_UNAVAILABLE' || journey.status === 'GPS_LOW_ACCURACY') {
      return {
        mode: 'NO_GPS',
        speedKmh: null,
        speedText: '  -- km/h',
        lineNameText: 'GPS信号なし',
        stationProgressText: '位置情報を確認してください',
        nextDistanceText: '',
        gpsStatusSymbol: 'GPS ✕',
        confidence: 0.0,
        updatedAtMs: currentTimeMs,
      };
    }

    const speedStr = speed.isStopped
      ? '   0 km/h'
      : speed.speedKmh !== null
      ? `${Math.round(speed.speedKmh).toString().padStart(4, ' ')} km/h`
      : '  -- km/h';

    const gpsSymbol = speed.isValid ? 'GPS ●' : 'GPS ○';

    // 2. Check Route Confidence / Status
    if (journey.confidence < 0.55 || journey.status === 'ROUTE_UNCERTAIN' || !journey.line) {
      return {
        mode: 'UNCERTAIN',
        speedKmh: speed.speedKmh,
        speedText: speedStr,
        lineNameText: '路線判定中',
        stationProgressText: 'GPSから路線を確認中',
        nextDistanceText: '',
        gpsStatusSymbol: gpsSymbol,
        confidence: journey.confidence,
        updatedAtMs: currentTimeMs,
      };
    }

    // 3. Normal Tracking Display
    const lineName = journey.line.name;
    const dirName = journey.directionName ? ` ${journey.directionName}` : '';
    const lineNameText = `${lineName}${dirName}`;

    const prevName = journey.previousStation ? journey.previousStation.name : '???';
    const nextName = journey.nextStation ? journey.nextStation.name : '???';
    const stationProgressText = `${prevName} → ${nextName}`;

    let nextDistanceText = '';
    if (journey.distanceToNextStationMeters !== null) {
      const distKm = (journey.distanceToNextStationMeters / 1000).toFixed(1);
      nextDistanceText = `NEXT ${distKm} km`;
    }

    return {
      mode: 'NORMAL',
      speedKmh: speed.speedKmh,
      speedText: speedStr,
      lineNameText,
      stationProgressText,
      nextDistanceText,
      gpsStatusSymbol: gpsSymbol,
      confidence: journey.confidence,
      updatedAtMs: currentTimeMs,
    };
  }

  public formatHudText(vm: HudViewModel): string {
    if (vm.mode === 'NO_GPS') {
      return `${vm.speedText}\n\n${vm.lineNameText}\n${vm.stationProgressText}`;
    }

    if (vm.mode === 'UNCERTAIN') {
      return `${vm.speedText}\n\n${vm.lineNameText}\n${vm.stationProgressText}`;
    }

    const distGpsLine = vm.nextDistanceText
      ? `${vm.nextDistanceText.padEnd(14, ' ')} ${vm.gpsStatusSymbol}`
      : `${vm.gpsStatusSymbol}`;

    return `${vm.speedText}\n\n${vm.lineNameText}\n${vm.stationProgressText}\n\n${distGpsLine}`;
  }
}
