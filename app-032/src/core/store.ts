/**
 * 灯样存储（Vue 自带响应式 + localStorage，无 Pinia/Vuex）
 * 灯型库与工艺参数来自本地打包 src/data/lantern-types.json，断网可用。
 *
 * 老灯样（早期存档：缺底口直径/逐层配色/分层直径等）读入规则：
 *  - 读进来只解析、体检，放进 pendingLegacy 待确认队列；**绝不自动补、自动写回**；
 *  - 一批在 MigrateView 里一次读完，给出「这次补了哪几项」的清单，用户确认后才写入本机存储；
 *  - 同一批重复确认同一版不产生第二版（内容签名判定，见 legacy.ts）；
 *  - 写到一半出错：整批回滚到确认（读）之前的存档样子；
 *  - id 与 createdAt 原样保留，任何时候都不重新生成；旧档多出的字段原样留下。
 */
import { reactive, watch } from 'vue'
import type { Lantern, LegacyRoute } from './types'
import { CRAFT, coveringSpec, presetById, PRESETS } from './craft'
import { buildGeometry, effectiveHeight, r1 } from './geometry'
import {
  attachConfirmedFill,
  buildLegacyFill,
  diagnoseLegacy,
  matchPreset,
  type LegacyFill
} from './legacy'

const KEY = 'lantern-frame-lofting.v1'

/** 待确认的老灯样（raw 是原样解析对象，确认前不做任何改动） */
export interface PendingLegacy {
  /** 队列内稳定标识：有 id 用 id，否则用解析序号（不重新生成灯样编号） */
  key: string
  raw: Record<string, unknown>
  rawId?: string
  rawName?: string
  rawCreatedAt?: string
  missing: string[]
  unknownFields: string[]
  parseErrors: string[]
  /** 是否能对得上当前灯型库（决定能不能走 preset 路） */
  match:
    | { presetId: string; presetName: string }
    | null
  /** 界面预选的路：对得上默认 preset，否则 default */
  chosenRoute: LegacyRoute
  /** 导入来源：startup=本机老档读出；import=手工导入 */
  source: 'startup' | 'import'
}

interface StoreState {
  lanterns: Lantern[]
  pendingLegacy: PendingLegacy[]
  ready: boolean
  storageError: string
}

export const state = reactive<StoreState>({ lanterns: [], pendingLegacy: [], ready: false, storageError: '' })

let suspendPersist = false
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
    ctrl1: p.ctrl1 ? { ...p.ctrl1 } : { x: 0.12, y: 0.3 },
    ctrl2: p.ctrl2 ? { ...p.ctrl2 } : { x: 0.85, y: 0.78 },
    divisions: p.divisions ?? CRAFT.defaultDivisions,
    covering: p.covering,
    seamAllowanceMm: CRAFT.defaultSeamAllowanceMm,
    lashAllowanceMm: CRAFT.defaultLashAllowanceMm,
    layerColors: [...p.layerColors],
    color: p.color,
    batchCount: 20,
    wasteRatio: coveringSpec(p.covering).wasteRatio,
    pageSize: 'A4',
    overlapMm: CRAFT.defaultOverlapMm,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 2
  }
  syncLayerDiameters(lantern)
  return lantern
}

/** 把轮廓算出的直径写回分段（数据模型 §7 中 layers[].diameterMm）；缺高度的不完整层不造轮廓 */
export function syncLayerDiameters(l: Lantern) {
  const g = buildGeometry(l)
  g.sections.forEach((sec, k) => {
    if (k === 0) return
    const layerIdx = sec.index - 1
    const ly = l.layers[layerIdx]
    if (ly) ly.diameterMm = r1(sec.radiusMm * 2)
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
  delete copy.legacy
  copy.schemaVersion = 2
  state.lanterns.unshift(copy)
  return copy
}

export function removeLantern(id: string) {
  const i = state.lanterns.findIndex((l) => l.id === id)
  if (i >= 0) state.lanterns.splice(i, 1)
}

// ---------------------------------------------------------------------------
// 老灯样：待确认队列 / 批量确认事务 / 回滚
// ---------------------------------------------------------------------------

function toPending(raw: Record<string, unknown>, source: PendingLegacy['source'], seq: number): PendingLegacy {
  const diag = diagnoseLegacy(raw)
  const m = matchPreset(raw)
  const rawId = typeof raw.id === 'string' ? raw.id : undefined
  return {
    key: rawId || `legacy-${source}-${seq}`,
    raw,
    rawId,
    rawName: typeof raw.name === 'string' ? raw.name : undefined,
    rawCreatedAt: typeof raw.createdAt === 'string' ? raw.createdAt : undefined,
    missing: diag.missing,
    unknownFields: diag.unknownFields,
    parseErrors: diag.parseErrors,
    match: m ? { presetId: m.preset.id, presetName: m.preset.name } : null,
    chosenRoute: m ? 'preset' : 'default',
    source
  }
}

/** 把一批旧档 JSON（数组或单对象，或 {lanterns:[...]} 包壳）读进待确认队列；返回新增条数 */
export function importLegacyJson(text: string): { added: number; skipped: number; error?: string } {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (e) {
    return { added: 0, skipped: 0, error: 'JSON 解析失败：' + (e instanceof Error ? e.message : String(e)) }
  }
  const list: unknown[] = Array.isArray(data)
    ? data
    : Array.isArray((data as { lanterns?: unknown[] })?.lanterns)
      ? (data as { lanterns: unknown[] }).lanterns
      : [data]
  let added = 0
  let skipped = 0
  list.forEach((item, i) => {
    if (!item || typeof item !== 'object') {
      skipped++
      return
    }
    const raw = item as Record<string, unknown>
    const pend = toPending(raw, 'import', state.pendingLegacy.length + i + 1)
    // 同一份旧档重复导入不重复进队列（按 id 去重；无 id 按内容）
    const dupKey = state.pendingLegacy.some((p) => p.key === pend.key)
    const dupSig = !pend.rawId && state.pendingLegacy.some((p) => JSON.stringify(p.raw) === JSON.stringify(raw))
    if (dupKey || dupSig) {
      skipped++
      return
    }
    state.pendingLegacy.push(pend)
    added++
  })
  return { added, skipped }
}

/** 切换某条待确认老灯样的补齐路（对不上的不许强走 preset） */
export function setPendingRoute(key: string, route: LegacyRoute): boolean {
  const p = state.pendingLegacy.find((x) => x.key === key)
  if (!p) return false
  if (route === 'preset' && !p.match) return false
  p.chosenRoute = route
  return true
}

export interface ConfirmOutcome {
  key: string
  outcome: 'new' | 'identical' | 'superseded'
  id: string
  name: string
  revision: number
  fill: LegacyFill
}

export interface ConfirmReport {
  outcomes: ConfirmOutcome[]
  /** 整批补了哪几项的汇总（去重后字段路径 → 出现次数） */
  itemSummary: { path: string; count: number }[]
  error?: string
  rolledBack: boolean
}

/**
 * 一次读完并确认整批：
 *  - 全部补值先在副本上算完，任何一条出错都不写存储；
 *  - 提交前快照 localStorage，提交后立即回读校验（读出来再存回去要对得上），失败整批回滚；
 *  - 与当前存档里同 id 且同版的，按 identical 处理，不写成两版。
 */
export function confirmPending(keys: string[]): ConfirmReport {
  const selected = state.pendingLegacy.filter((p) => keys.includes(p.key))
  if (selected.length === 0) return { outcomes: [], itemSummary: [], rolledBack: false }

  // 1) 在「下一版状态」的副本上完成全部补齐，任何一条抛错都不动现有状态
  const snapshot = state.lanterns.map((l) => JSON.parse(JSON.stringify(l)) as Lantern)
  const next: Lantern[] = snapshot.map((l) => JSON.parse(JSON.stringify(l)))
  const outcomes: ConfirmOutcome[] = []

  try {
    for (const pend of selected) {
      const fill = buildLegacyFill(pend.raw, pend.chosenRoute)
      const existing = next.find((l) => l.id === fill.lantern.id)
      const result = attachConfirmedFill(fill, existing)
      if (existing) {
        if (result.outcome !== 'identical') {
          // result.lantern.legacy 已含 existing 的审计链（同引用）并追加新版，直接替换
          next[next.indexOf(existing)] = result.lantern
        }
      } else {
        next.unshift(result.lantern)
      }
      outcomes.push({
        key: pend.key,
        outcome: result.outcome,
        id: result.lantern.id,
        name: result.lantern.name,
        revision: result.revision.revision,
        fill
      })
    }
  } catch (e) {
    state.storageError = '补齐失败，已整批退回读之前的样子：' + (e instanceof Error ? e.message : String(e))
    return {
      outcomes: [],
      itemSummary: [],
      rolledBack: true,
      error: e instanceof Error ? e.message : String(e)
    }
  }

  // 2) 事务提交：写内存 → 立即落盘 → 回读校验（读出来再存回去要对得上；id/createdAt 不变）
  const storageSnapshot = readRawStorage()
  try {
    state.lanterns.splice(0, state.lanterns.length, ...next)
    for (const l of state.lanterns) syncLayerDiameters(l)
    persistNow()
    const rereadRaw = readRawStorage()
    const reread = rereadRaw ? (JSON.parse(rereadRaw) as { lanterns?: Lantern[] }) : null
    if (!reread || !Array.isArray(reread.lanterns) || reread.lanterns.length !== state.lanterns.length) {
      throw new Error('回读灯样条数与提交不一致')
    }
    for (const l of state.lanterns) {
      const saved = reread.lanterns.find((x) => x.id === l.id)
      if (!saved) throw new Error(`回读缺少灯样 ${l.id}`)
      if (saved.createdAt !== l.createdAt) throw new Error(`回读后创建时间变化：${l.id}`)
    }
    // 已确认的移出待确认队列；identical 的也移出（同一批不重复处理）
    const keySet = new Set(keys)
    for (let i = state.pendingLegacy.length - 1; i >= 0; i--) {
      if (keySet.has(state.pendingLegacy[i].key)) state.pendingLegacy.splice(i, 1)
    }
  } catch (e) {
    // 整批回滚：内存与 localStorage 都退回确认之前
    state.lanterns.splice(0, state.lanterns.length, ...snapshot)
    if (storageSnapshot === null) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, storageSnapshot)
    state.storageError = '写回本机存储失败，已整批退回读之前的样子：' + (e instanceof Error ? e.message : String(e))
    return {
      outcomes: [],
      itemSummary: [],
      rolledBack: true,
      error: e instanceof Error ? e.message : String(e)
    }
  }

  const counter = new Map<string, number>()
  for (const o of outcomes) {
    for (const it of o.fill.items) counter.set(it.path, (counter.get(it.path) || 0) + 1)
  }
  return {
    outcomes,
    itemSummary: [...counter.entries()].map(([path, count]) => ({ path, count })),
    rolledBack: false
  }
}

function readRawStorage(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

/** 丢弃一条待确认老灯样（不写存档） */
export function discardPending(key: string) {
  const i = state.pendingLegacy.findIndex((p) => p.key === key)
  if (i >= 0) state.pendingLegacy.splice(i, 1)
}

function persistNow() {
  suspendPersist = true
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        version: 2,
        lanterns: state.lanterns,
        pendingLegacy: state.pendingLegacy.map((p) => ({
          key: p.key,
          raw: p.raw,
          source: p.source,
          chosenRoute: p.chosenRoute
        }))
      })
    )
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

/** 一份解析后的存档是否已是合格灯样（关键字段齐全） */
function isWellFormed(o: Record<string, unknown>): boolean {
  return (
    typeof o.id === 'string' &&
    typeof o.createdAt === 'string' &&
    typeof o.kind === 'string' &&
    (typeof o.baseDiameterMm === 'number' || o.mouthStyle === 'flat') &&
    Array.isArray(o.layerColors) &&
    Array.isArray(o.layers) &&
    o.layers.every((ly) => {
      const x = ly as Record<string, unknown>
      return x && typeof x === 'object' && typeof x.heightMm === 'number' && typeof x.diameterMm === 'number'
    })
  )
}

/** 载入本地灯样；老档进待确认队列；首次进入预置一个六角宫灯，便于立即放样 */
export function loadStore() {
  if (state.ready) return
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const data = JSON.parse(raw) as {
        version?: number
        lanterns?: unknown[]
        pendingLegacy?: {
          key?: string
          raw?: unknown
          source?: PendingLegacy['source']
          chosenRoute?: PendingLegacy['chosenRoute']
        }[]
      }
      const list = Array.isArray(data.lanterns) ? data.lanterns : []
      let seq = 0
      for (const item of list) {
        const o = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
        if (isWellFormed(o)) {
          state.lanterns.push(o as Lantern)
        } else {
          // 老档：读进来什么样就什么样，只体检、不补值，等用户确认
          state.pendingLegacy.push(toPending(o, 'startup', ++seq))
        }
      }
      // v2 起待确认队列也持久化（raw 原样存）
      if (Array.isArray(data.pendingLegacy)) {
        for (const pe of data.pendingLegacy) {
          if (pe.raw && typeof pe.raw === 'object' && !state.pendingLegacy.some((p) => p.key === pe.key)) {
            const pend = toPending(pe.raw as Record<string, unknown>, pe.source || 'startup', ++seq)
            if (pe.chosenRoute === 'preset' || pe.chosenRoute === 'default') pend.chosenRoute = pe.chosenRoute
            state.pendingLegacy.push(pend)
          }
        }
      }
    }
  } catch {
    state.storageError = '本地灯样数据损坏，已重置'
  }
  if (state.lanterns.length === 0 && state.pendingLegacy.length === 0) {
    state.lanterns.push(createFromPreset('hex-palace'))
  }
  state.ready = true
  watch(
    () => [state.lanterns, state.pendingLegacy],
    () => {
      if (suspendPersist) return
      schedulePersist()
    },
    { deep: true }
  )
  persistNow()
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
    importLegacyJson,
    setPendingRoute,
    confirmPending,
    discardPending
  }
}
