import { defineStore } from 'pinia';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import { toPlain } from '../utils/plain';
import { cumulativeThickness, nextSeq, sortLayers } from '../utils/layer';
import type { LacquerLayer, ReworkRecord } from '../types/lacquer-layer';

export interface LacquerInput {
  guqinNo: string;
  mixRatio: string;
  curingTemp: number;
  curingHumidity: number;
  polishGrit: number;
  layerThickness: number;
  appliedAt?: string;
  operator: string;
  remark?: string;
}

export interface ReworkInput {
  /** 返工后该遍厚度（mm） */
  layerThickness: number;
  /** 返工日期 ISO */
  reworkedAt?: string;
  /** 返工人 */
  operator: string;
  /** 返工原因（一句话） */
  reason: string;
}

/** 该琴已上弦，须先撤销上弦记录才能返工 */
export class GuqinStillStrungError extends Error {
  constructor(public guqinNo: string) {
    super(`琴 ${guqinNo} 已上弦，须先撤掉上弦记录再返工`);
    this.name = 'GuqinStillStrungError';
  }
}

interface LacquerState {
  layers: LacquerLayer[];
  hydrated: boolean;
}

/** 髹漆遍次与累计厚度 */
export const useLacquerStore = defineStore('lacquer', {
  state: (): LacquerState => ({ layers: [], hydrated: false }),

  getters: {
    layersOf(state) {
      return (guqinNo: string): LacquerLayer[] => sortLayers(state.layers.filter((l) => l.guqinNo === guqinNo));
    },
    /** 该琴当前累计厚度（mm） */
    totalOf(state) {
      return (guqinNo: string): number => cumulativeThickness(state.layers.filter((l) => l.guqinNo === guqinNo));
    },
    guqinNos(state): string[] {
      return Array.from(new Set(state.layers.map((l) => l.guqinNo))).sort();
    },
    /** 荫房温湿度超窗口的遍次数量 */
    outOfRangeCount(state): number {
      return state.layers.filter((l) => !(l.curingTemp >= 20 && l.curingTemp <= 30 && l.curingHumidity >= 70 && l.curingHumidity <= 85)).length;
    },
    /** 全部返工累计次数（同一遍返工几次计几次） */
    reworkCount(state): number {
      return state.layers.reduce((sum, l) => sum + l.reworks.length, 0);
    },
  },

  actions: {
    async hydrate() {
      const rows = await db.lacquers.toArray();
      // 兼容从旧版备份恢复的记录：无 reworks 字段时按空列表处理
      this.layers = rows.map((l) => ({ ...l, reworks: l.reworks ?? [] }));
      this.hydrated = true;
    },

    /** 追加一遍：遍次自动 +1，并重算该琴累计厚度 */
    async appendLayer(input: LacquerInput): Promise<LacquerLayer> {
      const siblings = this.layers.filter((l) => l.guqinNo === input.guqinNo);
      const layer: LacquerLayer = {
        id: uid('layer'),
        guqinNo: input.guqinNo.trim(),
        seq: nextSeq(siblings),
        mixRatio: input.mixRatio,
        curingTemp: Number(input.curingTemp) || 0,
        curingHumidity: Number(input.curingHumidity) || 0,
        polishGrit: Number(input.polishGrit) || 0,
        layerThickness: Number(input.layerThickness) || 0,
        totalThickness: 0,
        appliedAt: input.appliedAt ?? new Date().toISOString(),
        operator: input.operator.trim(),
        remark: input.remark?.trim() || undefined,
        reworks: [],
      };
      const next = [...siblings, layer];
      const withTotals = next.map((item) => ({
        ...item,
        totalThickness: cumulativeThickness(next, item.seq),
      }));
      for (const item of withTotals) {
        await db.lacquers.put(toPlain(item));
      }
      const others = this.layers.filter((l) => l.guqinNo !== input.guqinNo);
      this.layers = [...others, ...withTotals];
      return withTotals.find((item) => item.id === layer.id)!;
    },

    async updateLayer(id: string, patch: Partial<LacquerInput>) {
      const current = this.layers.find((l) => l.id === id);
      if (!current) return;
      const next: LacquerLayer = { ...current, ...patch };
      const siblings = this.layers.filter((l) => l.guqinNo === next.guqinNo).map((l) => (l.id === id ? next : l));
      const withTotals = siblings.map((item) => ({ ...item, totalThickness: cumulativeThickness(siblings, item.seq) }));
      for (const item of withTotals) {
        await db.lacquers.put(toPlain(item));
      }
      this.layers = this.layers.map((l) => withTotals.find((w) => w.id === l.id) ?? l);
    },

    /**
     * 返工某一遍：只把该遍厚度改成返工后的新值，并追加一条返工记录
     * （同一遍返工几次就累计几条，遍次号不变）。该遍及其后各遍的累计厚度
     * 随之重算，保证琴坯进度页灰胎达标判断准确。
     * 已上弦的琴须先撤掉上弦记录，否则抛 GuqinStillStrungError。
     */
    async reworkLayer(id: string, input: ReworkInput): Promise<LacquerLayer> {
      const current = this.layers.find((l) => l.id === id);
      if (!current) {
        throw new Error('未找到该遍髹漆记录');
      }
      // 直接查库判断上弦状态，避免 lacquerStore 反向依赖 stringingStore
      const strung = await db.stringings.where('guqinNo').equals(current.guqinNo).count();
      if (strung > 0) {
        throw new GuqinStillStrungError(current.guqinNo);
      }
      const thicknessAfter = Number(input.layerThickness) || 0;
      const record: ReworkRecord = {
        id: uid('rework'),
        reworkedAt: input.reworkedAt ?? new Date().toISOString(),
        operator: input.operator.trim(),
        reason: input.reason.trim(),
        thicknessBefore: current.layerThickness,
        thicknessAfter,
        round: current.reworks.length + 1,
      };
      const next: LacquerLayer = {
        ...current,
        layerThickness: thicknessAfter,
        reworks: [...current.reworks, record],
      };
      const siblings = this.layers.filter((l) => l.guqinNo === current.guqinNo).map((l) => (l.id === id ? next : l));
      const withTotals = sortLayers(siblings).map((item) => ({ ...item, totalThickness: cumulativeThickness(siblings, item.seq) }));
      for (const item of withTotals) {
        await db.lacquers.put(toPlain(item));
      }
      this.layers = this.layers.map((l) => withTotals.find((w) => w.id === l.id) ?? l);
      return withTotals.find((item) => item.id === id)!;
    },

    async removeLayer(id: string) {
      const current = this.layers.find((l) => l.id === id);
      await db.lacquers.delete(id);
      const rest = this.layers.filter((l) => l.id !== id);
      if (!current) {
        this.layers = rest;
        return;
      }
      const siblings = rest.filter((l) => l.guqinNo === current.guqinNo);
      const withTotals = siblings.map((item) => ({ ...item, totalThickness: cumulativeThickness(siblings, item.seq) }));
      for (const item of withTotals) {
        await db.lacquers.put(toPlain(item));
      }
      this.layers = rest.map((l) => withTotals.find((w) => w.id === l.id) ?? l);
    },
  },
});
