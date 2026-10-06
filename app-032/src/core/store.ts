/**
 * 灯样存储（Vue 自带响应式 + localStorage，无 Pinia/Vuex）
 * 灯型库与工艺参数来自本地打包 src/data/lantern-types.json，断网可用。
 *
 * 老灯样读入：
 *  - 一批老灯样一次读完，逐盏按写明的默认值补齐（见 core/legacy.ts），先给补齐清单；
 *  - 确认前不写回本机存档（界面各页与导出单已按内存里补齐后的同一份数据计算）；
 *  - 确认后一次性写回并读回校验；写一半出错退回读之前的样子；
 *  - 同一批重复确认是幂等空操作，不会写成两版。
 */
import { reactive, watch } from 'vue'
import type { Lantern } from './types'
import { CRAFT, coveringSpec, presetById, PRESETS } from './craft'
import { buildGeometry, effectiveHeight, r1 } from './geometry'
import { migrateBatch, type LanternMigration } from './legacy'

const KEY = 'lantern-frame-lofting.v1'
const STORAGE_VERSION = 2

interface StoreState {
  lanterns: Lantern[]
  ready: boolean
  storageError: string
  /** 待确认的老档补齐清单（确认前不写回本机） */
  pendingMigrations: LanternMigration[]
  /** 已确认写回的补齐记录（按灯样 id，随存档持久化） */
  migrations: Record<string, LanternMigration>
}

export const state = reactive<StoreState>({
  lanterns: [],
  ready: false,
  storageError: '',
  pendingMigrations: [],
  migrations: {}
})

let suspendPersist = false
/** 老档补齐待确认：挂起自动写回，确认了才写进本机存储 */
let holdPersist = false
/** 读入时的存档原文（确认写回失败时退回这份） */
let rawSnapshot: string | null = null
let timer: number | undefined

function makeId(): string {
  return 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

function r1v(v: number): number {
  return Math.round(v * 10) / 10
}

/** 依据灯型库预设新建灯样 */
export function createFromPreset(presetId: string): Lantern {
  const preset = presetById(presetId) || PRESETS[0]
  const p = preset.params
  const count = Math.max(1, Math.round(p.layerCount))
  const each = p.totalHeightMm / count
  const layers = Array.from({ length: count }, () => ({ heightMm: r1v(each), diameterMm: 0 }))
  // 保证分段高度之和 = 总高
  const sum = layers.reduce((s, x) => s + x.heightMm, 0)
  layers[layers.length - 1].heightMm = r1v(layers[layers.length - 1].heightMm + (p.totalHeightMm - sum))

  const now = new Date().toISOString()
  const lantern: Lantern = {
    id: makeId(),
    kind: preset.kind,
    name: preset.name,
    maxDiameterMm: p.maxDiameterMm,
    totalHeightMm: p.totalHeightMm,
    mouthDiameterMm: p.mouthDiameterMm,
    baseDiameterMm: p.baseDiameterMm,
    sides: p.sides,
    layers,
    mouthStyle: p.mouthStyle,
    bottomStyle: p.bottomStyle,
    smoothness: p.smoothness,
    ctrl1: p.ctrl1 ? { ...p.ctrl1 } : { ...CRAFT.legacyDefaults.ctrl1 },
    ctrl2: p.ctrl2 ? { ...p.ctrl2 } : { ...CRAFT.legacyDefaults.ctrl2 },
    divisions: p.divisions ?? CRAFT.defaultDivisions,
    covering: p.covering,
    seamAllowanceMm: CRAFT.defaultSeamAllowanceMm,
    lashAllowanceMm: CRAFT.defaultLashAllowanceMm,
    layerColors: [...p.layerColors],
    color: p.color,
    batchCount: CRAFT.legacyDefaults.batchCount,
    wasteRatio: coveringSpec(p.covering).wasteRatio,
    pageSize: CRAFT.legacyDefaults.pageSize,
    overlapMm: CRAFT.defaultOverlapMm,
    createdAt: now,
    updatedAt: now
  }
  syncLayerDiameters(lantern)
  return lantern
}

/** 把轮廓算出的直径写回分段（数据模型 §7 中 layers[].diameterMm） */
export function syncLayerDiameters(l: Lantern) {
  const g = buildGeometry(l)
  l.layers.forEach((ly, i) => {
    const sec = g.sections[i + 1]
    if (sec) ly.diameterMm = r1(sec.radiusMm * 2)
  })
  l.totalHeightMm = r1(effectiveHeight(l))
}

/** 分段高度均分（改总高/层数时调用） */
export function distributeLayers(l: Lantern) {
  const count = Math.max(1, Math.round(l.layers.length))
  const each = l.totalHeightMm / count
  l.layers = Array.from({ length: count }, () => ({ heightMm: r1v(each), diameterMm: 0 }))
  const sum = l.layers.reduce((s, x) => s + x.heightMm, 0)
  l.layers[count - 1].heightMm = r1v(l.layers[count - 1].heightMm + (l.totalHeightMm - sum))
  while (l.layerColors.length < count) l.layerColors.push(l.color)
  l.layerColors = l.layerColors.slice(0, count)
  syncLayerDiameters(l)
}

export function addLantern(l: Lantern) {
  state.lanterns.unshift(l)
  return l
}

export function getLantern(id: string): Lantern | undefined {
  return state.lanterns.find((l) => l.id === id)
}

export function duplicateLantern(id: string): Lantern | undefined {
  const src = getLantern(id)
  if (!src) return undefined
  const copy: Lantern = JSON.parse(JSON.stringify(src))
  copy.id = makeId()
  copy.name = src.name + ' 副本'
  copy.createdAt = copy.updatedAt = new Date().toISOString()
  state.lanterns.unshift(copy)
  return copy
}

export function removeLantern(id: string) {
  const i = state.lanterns.findIndex((l) => l.id === id)
  if (i >= 0) state.lanterns.splice(i, 1)
  delete state.migrations[id]
  const j = state.pendingMigrations.findIndex((m) => m.id === id)
  if (j >= 0) state.pendingMigrations.splice(j, 1)
  if (state.pendingMigrations.length === 0 && holdPersist) {
    // 待确认的灯样都被删掉了：恢复正常写回
    holdPersist = false
    rawSnapshot = null
  }
}

/** 查某盏灯样的补齐记录（待确认的优先，其次已写回的） */
export function migrationOf(id: string): LanternMigration | undefined {
  return state.pendingMigrations.find((m) => m.id === id) || state.migrations[id]
}

/** 实际写本机存档（抛错版，供确认写回与回滚用） */
function writeStorage() {
  for (const l of state.lanterns) syncLayerDiameters(l)
  localStorage.setItem(
    KEY,
    JSON.stringify({ version: STORAGE_VERSION, lanterns: state.lanterns, migrations: state.migrations })
  )
}

function persistNow() {
  suspendPersist = true
  try {
    writeStorage()
    state.storageError = ''
  } catch (e) {
    state.storageError = e instanceof Error ? e.message : String(e)
  } finally {
    suspendPersist = false
  }
}

function schedulePersist() {
  if (timer !== undefined) window.clearTimeout(timer)
  timer = window.setTimeout(() => {
    timer = undefined
    persistNow()
  }, 180)
}

/**
 * 确认补齐并写回本机存档。
 * 幂等：同一批重复确认是空操作，不会写成两版。
 * 写回后读回校验；写一半出错退回读之前的样子（rawSnapshot），返回 false。
 */
export function confirmMigrations(): boolean {
  if (state.pendingMigrations.length === 0) return true
  const now = new Date().toISOString()
  for (const m of state.pendingMigrations) {
    state.migrations[m.id] = { ...m, confirmedAt: now }
  }
  suspendPersist = true
  try {
    writeStorage()
    const back = localStorage.getItem(KEY)
    if (!back) throw new Error('写回后读不到本机存档')
    const parsed = JSON.parse(back) as { lanterns?: unknown; migrations?: unknown }
    if (JSON.stringify(parsed.lanterns) !== JSON.stringify(state.lanterns)) {
      throw new Error('写回校验失败：存档与内存里的灯样不一致')
    }
    if (JSON.stringify(parsed.migrations ?? {}) !== JSON.stringify(state.migrations)) {
      throw new Error('写回校验失败：补齐记录不一致')
    }
    state.pendingMigrations = []
    state.storageError = ''
    rawSnapshot = null
    holdPersist = false
    return true
  } catch (e) {
    try {
      if (rawSnapshot === null) localStorage.removeItem(KEY)
      else localStorage.setItem(KEY, rawSnapshot)
    } catch {
      // 回滚本身失败：保留报错，由界面提示
    }
    state.storageError = `补齐写回失败，已退回读之前的存档：${e instanceof Error ? e.message : String(e)}`
    return false
  } finally {
    suspendPersist = false
  }
}

/** 本次先不写回：本机存档保持读之前的样子，界面继续用内存里补齐后的同一份数据 */
export function discardMigrations() {
  state.pendingMigrations = []
  rawSnapshot = null
  holdPersist = false
}

/** 载入本地灯样；首次进入预置一个六角宫灯，便于立即放样 */
export function loadStore() {
  if (state.ready) return
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const data = JSON.parse(raw) as { lanterns?: unknown; migrations?: Record<string, LanternMigration> }
      if (Array.isArray(data.lanterns)) {
        const { lanterns, reports, errors } = migrateBatch(data.lanterns)
        state.lanterns = lanterns
        if (data.migrations && typeof data.migrations === 'object') state.migrations = data.migrations
        if (errors.length) state.storageError = errors.join('；')
        if (reports.length > 0) {
          // 一批老灯样一次读完：先给补齐清单，确认了才写进本机存储
          state.pendingMigrations = reports
          rawSnapshot = raw
          holdPersist = true
        }
      }
    }
  } catch {
    state.storageError = '本地灯样数据损坏，已重置'
  }
  if (state.lanterns.length === 0) {
    state.lanterns.push(createFromPreset('hex-palace'))
  }
  state.ready = true
  watch(
    () => state.lanterns,
    () => {
      if (suspendPersist || holdPersist) return
      schedulePersist()
    },
    { deep: true }
  )
  if (!holdPersist) persistNow()
}

export function useLanternStore() {
  return {
    state,
    createFromPreset,
    addLantern,
    getLantern,
    duplicateLantern,
    removeLantern,
    distributeLayers,
    syncLayerDiameters,
    migrationOf,
    confirmMigrations,
    discardMigrations
  }
}
