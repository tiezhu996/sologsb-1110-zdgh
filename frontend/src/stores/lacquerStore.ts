import { defineStore } from 'pinia';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import { toPlain } from '../utils/plain';
import { cumulativeThickness, nextSeq, sortLayers } from '../utils/layer';
import type { LacquerLayer, LayerRework } from '../types/lacquer-layer';
import { useStringingStore } from './stringingStore';

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
  /** 返工后的新厚度（mm） */
  layerThickness: number;
  /** 返工日期 ISO */
  reworkedAt: string;
  /** 返工人 */
  reworker: string;
  /** 返工原因（一句话） */
  reason: string;
}

/** 该琴已上弦，须先撤掉上弦记录才能返工 */
export class LayerStrungError extends Error {
  constructor(public guqinNo: string) {
    super(`琴 ${guqinNo} 已上弦，请先在上弦评价页撤掉上弦记录再返工`);
    this.name = 'LayerStrungError';
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
    /** 全坊返工总次数（同一遍每返工一次累计一次） */
    reworkCount(state): number {
      return state.layers.reduce((sum, l) => sum + (l.reworks?.length ?? 0), 0);
    },
  },

  actions: {
    async hydrate() {
      const rows = await db.lacquers.toArray();
      // 兼容 v3 升级前的历史行：reworks 可能缺失
      this.layers = rows.map((row) => ({ ...row, reworks: Array.isArray(row.reworks) ? row.reworks : [] }));
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
      // 厚度不允许在普通编辑里静默改动：改厚度必须走「返工」登记
      const { layerThickness: _ignored, ...safePatch } = patch;
      const next: LacquerLayer = { ...current, ...safePatch };
      const siblings = this.layers.filter((l) => l.guqinNo === next.guqinNo).map((l) => (l.id === id ? next : l));
      const withTotals = siblings.map((item) => ({ ...item, totalThickness: cumulativeThickness(siblings, item.seq) }));
      for (const item of withTotals) {
        await db.lacquers.put(toPlain(item));
      }
      this.layers = this.layers.map((l) => withTotals.find((w) => w.id === l.id) ?? l);
    },

    /**
     * 登记某一遍返工：遍次号不变，追加一条返工记录（同一遍可累计多条）；
     * 本遍按新厚度算，并重算该琴从这一遍往后的累计厚度。
     * 已上弦的琴须先撤掉上弦记录，否则抛 LayerStrungError。
     */
    async reworkLayer(id: string, input: ReworkInput): Promise<LacquerLayer> {
      const current = this.layers.find((l) => l.id === id);
      if (!current) {
        throw new Error('未找到要返工的遍次记录');
      }
      if (useStringingStore().byGuqin(current.guqinNo)) {
        throw new LayerStrungError(current.guqinNo);
      }
      const thickness = Number(input.layerThickness) || 0;
      if (thickness <= 0) {
        throw new Error('返工后的新厚度需大于 0');
      }
      const record: LayerRework = {
        id: uid('rework'),
        reworkedAt: input.reworkedAt,
        reworker: input.reworker.trim(),
        reason: input.reason.trim(),
        layerThickness: thickness,
      };
      // 返工记录按返工时间倒序（最新在前）
      const reworked: LacquerLayer = {
        ...current,
        layerThickness: thickness,
        reworks: [record, ...(current.reworks ?? [])],
      };
      const siblings = this.layers.filter((l) => l.guqinNo === current.guqinNo).map((l) => (l.id === id ? reworked : l));
      const withTotals = siblings.map((item) => ({ ...item, totalThickness: cumulativeThickness(siblings, item.seq) }));
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
