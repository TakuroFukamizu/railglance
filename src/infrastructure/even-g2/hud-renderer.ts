import { FullSpeedState } from '../../domain/models/location';
import { JourneyState } from '../../domain/models/railway';
import { HudViewModel, HudStatusMode } from '../../domain/models/hud';

export class HudRenderer {
  public createViewModel(
    speedState: FullSpeedState,
    journeyState: JourneyState,
    currentTimeMs: number
  ): HudViewModel {
    const { selectedEstimate, smoothedSpeedKmh, navState } = speedState;
    const { line, directionName, previousStation, nextStation, distanceToNextStationMeters, confidence, status } = journeyState;

    const gpsAgeMs = navState.lastObservationTimestampMs
      ? currentTimeMs - navState.lastObservationTimestampMs
      : Infinity;

    // 1. Determine Status Mode & Footer Status Text
    let statusMode: HudStatusMode = 'GPS';
    let statusRightText = 'GPS';

    if (navState.mode === 'lost' || status === 'INITIALIZING') {
      statusMode = 'LOST';
      statusRightText = '測位中';
    } else if (navState.mode === 'reacquiring') {
      statusMode = 'REACQUIRING';
      statusRightText = '補正中';
    } else if (navState.mode === 'dead-reckoning' || navState.mode === 'dead-reckoning-low-confidence') {
      statusMode = 'DR';
      const drSec = Math.round(gpsAgeMs / 1000);
      statusRightText = `DR ${drSec}s`;
    } else if (status === 'GPS_LOW_ACCURACY' || navState.mode === 'gps-degraded') {
      statusMode = 'GPS_DEGRADED';
      statusRightText = 'GPS弱';
    } else if (confidence < 0.55) {
      statusMode = 'UNCERTAIN';
      statusRightText = '判定中';
    }

    // 2. SPEED Region Formulation
    let displaySpeedKmhText = '--';
    let isEstimated = false;

    if (smoothedSpeedKmh !== null && smoothedSpeedKmh >= 0 && statusMode !== 'LOST') {
      displaySpeedKmhText = `${Math.round(smoothedSpeedKmh)}`;
    }

    if (selectedEstimate.estimated || navState.mode === 'dead-reckoning' || navState.mode === 'dead-reckoning-low-confidence' || navState.mode === 'reacquiring') {
      isEstimated = true;
    }

    // 3. HEADER Region Formulation
    let lineName = '路線特定中';
    if (line && confidence >= 0.55) {
      lineName = line.name;
    }

    let serviceOrDirection = '方向判定中';
    if (directionName) {
      serviceOrDirection = directionName;
    }

    // 4. SEGMENT Region Formulation
    let previousStationName = '前駅不明';
    let nextStationName = '次駅推定中';
    if (previousStation) previousStationName = previousStation.name;
    if (nextStation) nextStationName = nextStation.name;

    let distanceToNextText = '次まで --';
    if (distanceToNextStationMeters !== null && distanceToNextStationMeters >= 0) {
      if (distanceToNextStationMeters >= 1000) {
        const kmVal = (distanceToNextStationMeters / 1000).toFixed(1);
        distanceToNextText = `次まで ${kmVal}km`;
      } else {
        distanceToNextText = `次まで ${distanceToNextStationMeters}m`;
      }
    }

    let progressRatio: number | null = null;
    if (distanceToNextStationMeters !== null && previousStation && nextStation) {
      // Calculate approximate progress ratio for segment progress bar (0.0 ~ 1.0)
      progressRatio = 0.5; // Default fallback ratio
    }

    // 5. FOOTER Region Formulation
    let leftInfo = directionName ?? '走行中';
    if (speedState.isStopped && previousStation) {
      leftInfo = `${previousStation.name} 停車中`;
    }

    // 6. Formulate Raw Formatted Text for G2 Glasses Monospace View
    const rawFormattedText = this.formatG2RawText(
      displaySpeedKmhText,
      isEstimated,
      lineName,
      serviceOrDirection,
      previousStationName,
      nextStationName,
      progressRatio,
      distanceToNextText,
      leftInfo,
      statusRightText,
      statusMode
    );

    return {
      header: {
        lineName,
        serviceOrDirection,
      },
      speed: {
        displaySpeedKmhText,
        unitText: 'km/h',
        isEstimated,
      },
      segment: {
        previousStationName,
        nextStationName,
        progressRatio,
        segmentMaxSpeedText: '区間標準',
        distanceToNextText,
      },
      footer: {
        leftInfo,
        statusRight: statusRightText,
      },
      statusMode,
      rawFormattedText,
      timestampMs: currentTimeMs,
    };
  }

  private formatG2RawText(
    speedText: string,
    isEstimated: boolean,
    lineName: string,
    serviceOrDir: string,
    prevStation: string,
    nextStation: string,
    progressRatio: number | null,
    distText: string,
    footerLeft: string,
    statusRightText: string,
    statusMode: HudStatusMode
  ): string {
    if (statusMode === 'LOST') {
      return `   -- km/h\n\n[ 路線再特定中 ]\nGPS信号を確認中...\n\n${footerLeft}        ${statusRightText}`;
    }

    const estMark = isEstimated ? ' ~' : '';
    
    // Construct progress bar string for text display e.g. "━━━●━━━━━"
    let progressBarStr = '━━━━━━━━━━━━';
    if (progressRatio !== null) {
      const totalChars = 12;
      const dotIdx = Math.max(0, Math.min(totalChars - 1, Math.round(progressRatio * (totalChars - 1))));
      const leftBar = '━'.repeat(dotIdx);
      const rightBar = '━'.repeat(totalChars - 1 - dotIdx);
      progressBarStr = `${leftBar}●${rightBar}`;
    }

    return `${lineName}       ${serviceOrDir}\n\n       ${speedText} km/h${estMark}\n\n${prevStation} ${progressBarStr} ${nextStation}\n${distText}               ${statusRightText}`;
  }
}
