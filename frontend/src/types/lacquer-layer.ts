/** 单遍返工记录：同一遍每返工一次累计一条，遍次号不变 */
export interface ReworkRecord {
  id: string;
  /** 返工日期 ISO */
  reworkedAt: string;
  /** 返工人 */
  operator: string;
  /** 返工原因（一句话） */
  reason: string;
  /** 返工前该遍厚度（mm） */
  thicknessBefore: number;
  /** 返工后该遍厚度（mm），返工后本遍按此厚度计 */
  thicknessAfter: number;
  /** 这是该遍第几次返工（从 1 开始） */
  round: number;
}

/** 灰胎髹漆遍次 */
export interface LacquerLayer {
  id: string;
  /** 琴号 */
  guqinNo: string;
  /** 遍次（从 1 开始，追加时自动 +1） */
  seq: number;
  /** 灰胎配比（鹿角霜:生漆） */
  mixRatio: string;
  /** 荫房温度（℃） */
  curingTemp: number;
  /** 荫房湿度（%） */
  curingHumidity: number;
  /** 打磨目数 */
  polishGrit: number;
  /** 本遍厚度（mm） */
  layerThickness: number;
  /** 累计厚度（mm），由本遍及之前各遍累加 */
  totalThickness: number;
  /** 施工日期 ISO */
  appliedAt: string;
  /** 髹漆人 */
  operator: string;
  /** 备注 */
  remark?: string;
  /** 返工记录（同一遍返工几次就累计几条，遍次号不变） */
  reworks: ReworkRecord[];
}

/** 灰胎阶段常用配比 */
export const MIX_RATIOS: string[] = ['1:1', '1:1.2', '1:1.5', '1:2', '纯生漆'];
