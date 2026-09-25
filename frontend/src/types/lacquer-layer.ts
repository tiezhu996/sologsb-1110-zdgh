/** 单遍返工记录：返工不改遍次号，同一遍返工几次就累计几条 */
export interface LayerRework {
  id: string;
  /** 返工日期 ISO */
  reworkedAt: string;
  /** 返工人 */
  reworker: string;
  /** 返工原因（一句话） */
  reason: string;
  /** 返工后的新厚度（mm） */
  layerThickness: number;
}

/** 灰胎髹漆遍次 */
export interface LacquerLayer {
  id: string;
  /** 琴号 */
  guqinNo: string;
  /** 遍次（从 1 开始，追加时自动 +1；返工不改变遍次号） */
  seq: number;
  /** 灰胎配比（鹿角霜:生漆） */
  mixRatio: string;
  /** 荫房温度（℃） */
  curingTemp: number;
  /** 荫房湿度（%） */
  curingHumidity: number;
  /** 打磨目数 */
  polishGrit: number;
  /** 本遍厚度（mm）；返工后按新厚度算 */
  layerThickness: number;
  /** 累计厚度（mm），由本遍及之前各遍累加；返工后从该遍往后重算 */
  totalThickness: number;
  /** 施工日期 ISO */
  appliedAt: string;
  /** 髹漆人 */
  operator: string;
  /** 备注 */
  remark?: string;
  /** 返工记录（同一遍可累计多条，按返工时间倒序） */
  reworks: LayerRework[];
}

/** 灰胎阶段常用配比 */
export const MIX_RATIOS: string[] = ['1:1', '1:1.2', '1:1.5', '1:2', '纯生漆'];
