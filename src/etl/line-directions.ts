import { RailwayLine, Station } from '../domain/models/railway';

/**
 * 路線の「上り」側終端駅(起点)を人手で指定するための補正エントリ。
 *
 * ランタイムの方向ラベルは「駅 sequence が増える向きに走行 → directionAName、
 * 減る向き → directionBName」という契約で決まる。一方、MLIT 由来路線の sequence は
 * 端点駅IDのハッシュ順で機械的に振られ、どちらの端が起点かはデータ上保証されない。
 * そのため MLIT 路線に「上り」「下り」を出すには、起点駅がどちらの端に来たかを
 * 見て directionAName / directionBName を決める必要がある。
 */
export type LineDirectionCorrection = {
  /** 一致させる路線名。チェーン分割後の「路線名（A〜B）」は括弧を除いた部分で照合する。 */
  lineNames: string[];
  /** 指定時は operatorName または operatorId のいずれかが一致する路線のみ対象にする(京急本線 / 京成本線の区別用)。 */
  operators?: string[];
  /** 上り方向の終端駅(=起点)の駅名。この駅へ向かう走行が「上り」になる。 */
  upTerminalStation: string;
  /** 上り側のラベル。省略時は「上り」。 */
  upLabel?: string;
  /** 下り側のラベル。省略時は「下り」。 */
  downLabel?: string;
};

export type LineDirectionNames = {
  directionAName: string;
  directionBName: string;
};

export const DEFAULT_UP_LABEL = '上り';
export const DEFAULT_DOWN_LABEL = '下り';

/** 「横浜線（東神奈川〜八王子）」→「横浜線」のようにチェーン分割の括弧サフィックスを除く。 */
export function baseLineName(name: string): string {
  const index = name.indexOf('（');
  return index >= 0 ? name.slice(0, index) : name;
}

export function matchesLineDirection(entry: LineDirectionCorrection, line: RailwayLine): boolean {
  const nameMatches = entry.lineNames.includes(line.name) || entry.lineNames.includes(baseLineName(line.name));
  if (!nameMatches) return false;
  if (!entry.operators || entry.operators.length === 0) return true;
  return entry.operators.some((operator) => operator === line.operatorName || operator === line.operatorId);
}

/**
 * 起点駅が路線の駅列のどちらの端にあるかで方向名を決める。
 *
 * - 起点駅が最大 sequence → sequence 増加方向が上り → A=上り, B=下り
 * - 起点駅が最小 sequence → sequence 増加方向が下り → A=下り, B=上り
 * - 起点駅が見つからない / 途中駅にある(チェーン分割で端に来なかった等) → null。
 *   この場合は名前を付けず、ランタイムの「○○方面」フォールバックに委ねる。
 */
export function resolveLineDirectionNames(
  entry: LineDirectionCorrection,
  lineStations: Station[]
): LineDirectionNames | null {
  if (lineStations.length < 2) return null;
  const upTerminal = lineStations.find((station) => station.name === entry.upTerminalStation);
  if (!upTerminal) return null;

  const sequences = lineStations.map((station) => station.sequence);
  const maxSequence = Math.max(...sequences);
  const minSequence = Math.min(...sequences);
  if (maxSequence === minSequence) return null;

  const upLabel = entry.upLabel ?? DEFAULT_UP_LABEL;
  const downLabel = entry.downLabel ?? DEFAULT_DOWN_LABEL;
  if (upTerminal.sequence === maxSequence) {
    return { directionAName: upLabel, directionBName: downLabel };
  }
  if (upTerminal.sequence === minSequence) {
    return { directionAName: downLabel, directionBName: upLabel };
  }
  return null;
}
