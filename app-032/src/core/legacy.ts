/**
 * 老灯样读入补齐引擎（纯函数，不碰 localStorage / DOM）
 *
 * 两条路（取舍必须挑一条并认下代价，见 lantern-types.json 的 legacy.rule）：
 *  - preset：旧档按 legacy.matchKeys 能与当前灯型库某预设逐项对上时，缺项照预设补；
 *    补完各页齐全、可直接放样；代价是补出来的这盏跟当年存下来的未必是一回事，
 *    导出的单子与图纸跟旧档对不上。
 *  - default：对不上（或用户坚持与旧档一致）时，按写明的默认值目录逐项顶值，
 *    逐项写清缺哪一项、顶成什么值、取自哪条预设/工艺默认；与旧档对得上；
 *    代价是连分层高度都缺的层无法造轮廓，构件表/裁片页少这一段、该层显示不全，需人工补。
 *
 * 不变量：
 *  - id 与 createdAt 原样保留，读入/补齐一律不重新生成；updatedAt 也不在确认写回时改动；
 *  - 旧档多出的字段一律原样留下（按原对象浅拷贝 + 就地补键），只登记键名，不删不改；
 *  - 补完的值只落到一份灯样上：存档、骨架构件表、裁片页、1:1 分页、备料、三份导出单子
 *    全部由这同一份灯样重算（各处都直接调用 buildFrame/buildPanels/paginate/computeMaterials）。
 */
import type {
  ExportKind,
  ExportLedgerEntry,
  Lantern,
  LayerSpec,
  LegacyFillItem,
  LegacyMeta,
  LegacyRevision,
  LegacyRoute,
  Point2
} from './types'
import { CRAFT, LEGACY, PRESETS, coveringSpec, type LanternPreset } from './craft'
import { buildGeometry, effectiveHeight, r1 } from './geometry'

/** 灯样上本工具认识的全部顶层字段（其余一律视为旧档多出字段，原样保留） */
const KNOWN_TOP_KEYS = new Set<string>([
  'id', 'kind', 'name', 'maxDiameterMm', 'totalHeightMm', 'mouthDiameterMm', 'baseDiameterMm',
  'sides', 'layers', 'mouthStyle', 'bottomStyle', 'smoothness', 'ctrl1', 'ctrl2', 'divisions',
  'covering', 'seamAllowanceMm', 'lashAllowanceMm', 'layerColors', 'color', 'batchCount',
  'wasteRatio', 'pageSize', 'overlapMm', 'createdAt', 'updatedAt', 'schemaVersion', 'legacy'
])
const KNOWN_LAYER_KEYS = new Set<string>(['heightMm', 'diameterMm'])

const KINDS = ['prism', 'revolution', 'polyhedron', 'box']
const STYLES = ['flat', 'taper', 'gourd']
const COVERINGS = ['xuan', 'silk', 'parchment']

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}
function isPosNum(v: unknown): v is number {
  return isNum(v) && v > 0
}
function asNum(v: unknown): number | undefined {
  return isNum(v) ? v : undefined
}

/** 该分层是否实际成段（高为 0 / 缺失的层不生成轮廓，构件表与裁片页会少这一段） */
export function isLayerActive(ly: LayerSpec | undefined): boolean {
  return !!ly && isPosNum(ly.heightMm)
}

/** 成段层的 0 起始层号（与 panels 的 layerIndex / layerColors 下标一致） */
export function activeLayerIndexes(l: Lantern): number[] {
  return l.layers.map((ly, i) => (isLayerActive(ly) ? i : -1)).filter((i) => i >= 0)
}

// ---------------------------------------------------------------------------
// 「对得上当前灯型库」的判定：legacy.matchKeys 逐项相等（mm 字段四舍五入后比较）
// ---------------------------------------------------------------------------

export interface MatchedPreset {
  preset: LanternPreset
  /** 逐项核对结果（供界面展示） */
  checks: { key: string; old: string; preset: string; equal: boolean }[]
}

export function matchPreset(raw: Record<string, unknown>): MatchedPreset | null {
  for (const preset of PRESETS) {
    const p = preset.params
    const checks = LEGACY.matchKeys.map((key) => {
      let oldv: unknown = raw[key]
      let pv: unknown
      switch (key) {
        case 'kind': pv = preset.kind; break
        case 'sides': pv = p.sides; break
        case 'mouthStyle': pv = p.mouthStyle; break
        case 'bottomStyle': pv = p.bottomStyle; break
        case 'layerCount':
          oldv = Array.isArray(raw.layers) ? raw.layers.length : undefined
          pv = p.layerCount
          break
        case 'maxDiameterMm': pv = p.maxDiameterMm; break
        case 'totalHeightMm': pv = p.totalHeightMm; break
        case 'mouthDiameterMm': pv = p.mouthDiameterMm; break
        default: pv = undefined
      }
      const equal =
        key === 'kind' || key === 'mouthStyle' || key === 'bottomStyle'
          ? oldv === pv
          : isNum(oldv) && isNum(pv) && Math.round(oldv) === Math.round(pv)
      return { key, old: oldv === undefined ? '（旧档缺失）' : String(oldv), preset: String(pv), equal }
    })
    if (checks.every((c) => c.equal)) return { preset, checks }
  }
  return null
}

// ---------------------------------------------------------------------------
// 旧档体检：缺了哪几项（老档的三个典型缺项 + 旋转体等分数 + 其它默认字段）
// ---------------------------------------------------------------------------

export interface LegacyDiagnosis {
  /** 旧档缺少的字段路径 */
  missing: string[]
  /** 旧档里多出/不认识但会原样保留的顶层字段 */
  unknownFields: string[]
  /** 分层逐个体检 */
  layers: { index: number; hasHeight: boolean; hasDiameter: boolean }[]
  parseErrors: string[]
}

export function diagnoseLegacy(raw: Record<string, unknown>): LegacyDiagnosis {
  const missing: string[] = []
  const parseErrors: string[] = []
  const req: [string, (v: unknown) => boolean][] = [
    ['id', (v) => typeof v === 'string' && v.length > 0],
    ['createdAt', (v) => typeof v === 'string' && v.length > 0],
    ['kind', (v) => typeof v === 'string' && KINDS.includes(v)],
    ['maxDiameterMm', isPosNum],
    ['totalHeightMm', isPosNum],
    ['mouthDiameterMm', isPosNum],
    ['sides', isPosNum],
    ['mouthStyle', (v) => typeof v === 'string' && STYLES.includes(v)],
    ['layers', (v) => Array.isArray(v) && v.length > 0]
  ]
  for (const [key, ok] of req) {
    if (!ok(raw[key])) {
      missing.push(key)
      if (key !== 'baseDiameterMm' && ['kind', 'sides', 'maxDiameterMm', 'totalHeightMm', 'mouthDiameterMm', 'mouthStyle', 'layers'].includes(key)) {
        parseErrors.push(`关键字段 ${key} 缺失或无效`)
      }
    }
  }
  // 老档三个典型缺项
  if (!isPosNum(raw.baseDiameterMm)) missing.push('baseDiameterMm')
  if (!Array.isArray(raw.layerColors) || raw.layerColors.length === 0) missing.push('layerColors')
  if (raw.divisions === undefined && raw.kind === 'revolution') missing.push('divisions')

  const layers = Array.isArray(raw.layers) ? (raw.layers as unknown[]) : []
  const layerDiag = layers.map((ly, i) => {
    const o = (ly && typeof ly === 'object' ? ly : {}) as Record<string, unknown>
    const hasHeight = isPosNum(o.heightMm)
    const hasDiameter = isPosNum(o.diameterMm)
    if (!hasHeight) missing.push(`layers[${i}].heightMm`)
    if (!hasDiameter) missing.push(`layers[${i}].diameterMm`)
    if (layers.length > 0 && i < layers.length && !hasHeight) parseErrors.push(`第 ${i + 1} 层缺分层高度`)
    return { index: i, hasHeight, hasDiameter }
  })
  for (const key of ['seamAllowanceMm', 'lashAllowanceMm', 'overlapMm', 'batchCount', 'wasteRatio', 'pageSize', 'smoothness', 'color', 'covering', 'bottomStyle', 'ctrl1', 'ctrl2']) {
    if (raw[key] === undefined) missing.push(key)
  }

  const unknownFields = Object.keys(raw).filter((k) => !KNOWN_TOP_KEYS.has(k))
  return { missing: [...new Set(missing)], unknownFields, layers: layerDiag, parseErrors }
}

// ---------------------------------------------------------------------------
// 补齐：产出一份新灯样 + 逐项补值清单（不修改 raw）
// ---------------------------------------------------------------------------

export interface LegacyFill {
  lantern: Lantern
  route: LegacyRoute
  presetId?: string
  items: LegacyFillItem[]
  unknownFieldsKept: string[]
  complete: boolean
  incompleteLayers: number[]
  warnings: string[]
}

function num(v: unknown, dft: number): number {
  return isNum(v) ? v : dft
}
function str<T extends string>(v: unknown, dft: T, allowed?: readonly string[]): T {
  return typeof v === 'string' && (!allowed || allowed.includes(v)) ? (v as T) : dft
}
function point(v: unknown, dft: Point2): Point2 {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  return { x: num(o.x, dft.x), y: num(o.y, dft.y) }
}

/**
 * 按指定的路补齐一份老灯样。
 * @param rawObject 旧档解析出的对象（不会被修改；多出字段原样带到新灯样上）
 * @param route preset=照预设补（对得上才可走）；default=按默认值目录顶值
 */
export function buildLegacyFill(rawObject: unknown, route: LegacyRoute): LegacyFill {
  const raw = (rawObject && typeof rawObject === 'object' ? rawObject : {}) as Record<string, unknown>
  const diagnosis = diagnoseLegacy(raw)
  const matched = route === 'preset' ? matchPreset(raw) : null
  if (route === 'preset' && !matched) {
    throw new Error('该旧档与当前灯型库对不上，不能走「照预设补」；请改走「按默认值顶」。')
  }
  const presetParams = matched?.preset.params
  const srcPreset = (field: string) => `预设「${matched!.preset.name}」params.${field}`

  // 工作副本：保留旧档全部键（含多出字段），之后只就地补键/规范化数组
  const work: Record<string, unknown> = JSON.parse(JSON.stringify(raw))

  const items: LegacyFillItem[] = []
  const note = (path: string, label: string, value: number | string, source: string, manual = false) =>
    items.push({ path, label, value, source, manual })

  // ---- 基本字段（缺失时：preset 取预设；default 取默认目录/工艺默认） ----
  const maxD = asNum(work.maxDiameterMm) ?? presetParams?.maxDiameterMm ?? 300
  const mouthD = asNum(work.mouthDiameterMm) ?? presetParams?.mouthDiameterMm ?? Math.round(maxD * 0.4)
  const totalH = asNum(work.totalHeightMm) ?? presetParams?.totalHeightMm ?? 300
  const kind = str(work.kind, (presetParams ? matched!.preset.kind : 'revolution') as Lantern['kind'], KINDS)
  const sides = num(work.sides, presetParams?.sides ?? 8)
  const mouthStyle = str(work.mouthStyle, presetParams?.mouthStyle ?? 'taper', STYLES)
  const bottomStyle = str(work.bottomStyle, presetParams?.bottomStyle ?? mouthStyle, STYLES)
  const covering = str(work.covering, presetParams?.covering ?? 'xuan', COVERINGS)
  const color = typeof work.color === 'string' ? work.color : presetParams?.color ?? coveringSpec(covering as Lantern['covering']).color

  if (work.kind === undefined) note('kind', '灯型', kind, matched ? srcPreset('kind') : '默认值目录 kind→revolution', true)
  if (work.maxDiameterMm === undefined) note('maxDiameterMm', '最大直径', `${maxD}mm`, matched ? srcPreset('maxDiameterMm') : '默认值目录 maxDiameterMm→300', true)
  if (work.totalHeightMm === undefined) note('totalHeightMm', '总高', `${totalH}mm`, matched ? srcPreset('totalHeightMm') : '默认值目录 totalHeightMm→300', true)
  if (work.mouthDiameterMm === undefined) note('mouthDiameterMm', '收口直径', `${mouthD}mm`, matched ? srcPreset('mouthDiameterMm') : '默认值目录 mouthDiameterMm→最大直径×0.4', true)
  if (work.sides === undefined) note('sides', '棱数/母线根数', sides, matched ? srcPreset('sides') : '默认值目录 sides→8', true)
  if (work.mouthStyle === undefined) note('mouthStyle', '上收口方式', mouthStyle, matched ? srcPreset('mouthStyle') : '默认值目录 mouthStyle→taper', true)
  if (work.bottomStyle === undefined) note('bottomStyle', '下收口方式', bottomStyle, matched ? srcPreset('bottomStyle') : '默认值目录 bottomStyle→同上收口', true)
  if (work.covering === undefined) note('covering', '蒙面类型', covering, matched ? srcPreset('covering') : '默认值目录 covering→xuan', true)
  if (work.color === undefined) note('color', '主色', color, matched ? srcPreset('color') : `蒙面材料 ${covering} 默认色`)
  if (typeof work.name !== 'string' || !work.name) {
    work.name = matched ? matched.preset.name : '老灯样（待命名）'
    note('name', '名称', String(work.name), matched ? srcPreset('name') : '默认值目录 name→老灯样（待命名）')
  }

  // ---- 底口直径（老档典型缺项 1） ----
  // flat 平口几何上底口 = 最大直径；否则 preset 取预设，default 按写明目录顶成上口直径
  const baseDefault = bottomStyle === 'flat' ? maxD : mouthD
  if (!isPosNum(work.baseDiameterMm)) {
    const baseD = matched && bottomStyle !== 'flat' ? presetParams!.baseDiameterMm : baseDefault
    work.baseDiameterMm = baseD
    const source = bottomStyle === 'flat'
      ? '默认值目录 baseDiameterMm：平口底径=最大直径'
      : matched
        ? srcPreset('baseDiameterMm')
        : '默认值目录 baseDiameterMm→mouthDiameterMm（早期底口与收口同径）'
    note('baseDiameterMm', '底口直径', `${r1(baseD)}mm（${Math.round(baseD / 10)}cm）`, source, route === 'default')
  }

  // ---- 分层（preset 缺高度按预设 layerCount 均摊补齐；default 缺高度不造轮廓） ----
  const rawLayers = Array.isArray(work.layers) && work.layers.length > 0
    ? (work.layers as unknown[])
    : [{ heightMm: totalH, diameterMm: 0 }]
  if (!Array.isArray(work.layers) || work.layers.length === 0) {
    note('layers', '分层', `${rawLayers.length} 层`, matched ? srcPreset('layerCount') : '默认值目录 layers→单层（需人工补分层）', true)
  }
  const presetCount = presetParams?.layerCount
  const layers: LayerSpec[] = rawLayers.map((ly, i) => {
    const o = (ly && typeof ly === 'object' ? { ...(ly as Record<string, unknown>) } : {}) as Record<string, unknown>
    let h = asNum(o.heightMm)
    if (!isPosNum(h)) {
      if (matched && presetCount && rawLayers.length === presetCount) {
        h = i === presetCount - 1
          ? r1(totalH / presetCount + (totalH - r1(totalH / presetCount) * presetCount))
          : r1(totalH / presetCount)
        note(`layers[${i}].heightMm`, `第 ${i + 1} 层分层高`, `${h}mm`, `预设「${matched.preset.name}」按 layerCount=${presetCount} 均摊总高`)
      } else {
        h = 0
        note(`layers[${i}].heightMm`, `第 ${i + 1} 层分层高`, '缺失，留空（不造轮廓）', '默认值目录 layers.heightMm→留空，需人工补该段', true)
      }
    }
    return { heightMm: h, diameterMm: isPosNum(o.diameterMm) ? (o.diameterMm as number) : 0 }
  })
  // 分层上多出的键也不丢
  rawLayers.forEach((ly, i) => {
    const o = (ly && typeof ly === 'object' ? ly : {}) as Record<string, unknown>
    for (const k of Object.keys(o)) {
      if (!KNOWN_LAYER_KEYS.has(k)) (layers[i] as unknown as Record<string, unknown>)[k] = o[k]
    }
  })
  work.layers = layers

  // ---- 逐层配色（老档典型缺项 2：缺失的层回落主色，标为需人工补） ----
  const rawColors = Array.isArray(work.layerColors) ? (work.layerColors as unknown[]) : []
  const layerColors: string[] = layers.map((_, i) => {
    const c = rawColors[i]
    if (typeof c === 'string' && c) return c
    const presetColor = presetParams?.layerColors[i]
    const val = presetColor ?? color
    const source = matched && presetColor
      ? `预设「${matched.preset.name}」layerColors[${i}]`
      : '默认值目录 layerColors→主色 color（蒙面页既有回落规则）'
    note(`layerColors[${i}]`, `第 ${i + 1} 层配色`, val, source, route === 'default' || !presetColor)
    return val
  })
  work.layerColors = layerColors

  // ---- 其余工艺默认（缺失即补，逐项登记） ----
  const smoothness = num(work.smoothness, presetParams?.smoothness ?? Number(LEGACY.defaults.smoothness.fallback))
  if (work.smoothness === undefined) note('smoothness', '收口曲线强度', smoothness, matched ? srcPreset('smoothness') : '默认值目录 smoothness→0.45')
  work.smoothness = smoothness

  const ctrl1 = point(work.ctrl1, presetParams?.ctrl1 ?? (LEGACY.defaults.ctrl1.fallback as Point2))
  const ctrl2 = point(work.ctrl2, presetParams?.ctrl2 ?? (LEGACY.defaults.ctrl2.fallback as Point2))
  if (work.ctrl1 === undefined) note('ctrl1', '葫芦口控制点1', `(${ctrl1.x}, ${ctrl1.y})`, '默认值目录 ctrl1')
  if (work.ctrl2 === undefined) note('ctrl2', '葫芦口控制点2', `(${ctrl2.x}, ${ctrl2.y})`, '默认值目录 ctrl2')
  work.ctrl1 = ctrl1
  work.ctrl2 = ctrl2

  const divisions = Math.max(3, Math.round(num(work.divisions, presetParams?.divisions ?? CRAFT.defaultDivisions)))
  if (work.divisions === undefined && kind === 'revolution') {
    note('divisions', '旋转体母线等分数', `${divisions} 等分`, matched && presetParams?.divisions ? srcPreset('divisions') : '默认值目录 divisions→craft.defaultDivisions(24)')
  }
  work.divisions = divisions

  const seam = num(work.seamAllowanceMm, CRAFT.defaultSeamAllowanceMm)
  const lash = num(work.lashAllowanceMm, CRAFT.defaultLashAllowanceMm)
  const overlap = num(work.overlapMm, CRAFT.defaultOverlapMm)
  const batchCount = Math.max(1, Math.round(num(work.batchCount, Number(LEGACY.defaults.batchCount.fallback))))
  const waste = num(work.wasteRatio, coveringSpec(covering).wasteRatio)
  const pageSize = str(work.pageSize, 'A4', ['A4', 'A3'] as const)
  if (work.seamAllowanceMm === undefined) note('seamAllowanceMm', '缝份（每边）', `${seam}mm`, '默认值目录 seamAllowanceMm→craft.defaultSeamAllowanceMm(10)')
  if (work.lashAllowanceMm === undefined) note('lashAllowanceMm', '绑扎余量（每端）', `${lash}mm`, '默认值目录 lashAllowanceMm→craft.defaultLashAllowanceMm(20)')
  if (work.overlapMm === undefined) note('overlapMm', '跨页搭接量', `${overlap}mm`, '默认值目录 overlapMm→craft.defaultOverlapMm(10)')
  if (work.batchCount === undefined) note('batchCount', '批量数量', `${batchCount} 个`, '默认值目录 batchCount→20')
  if (work.wasteRatio === undefined) note('wasteRatio', '损耗率', `${(waste * 100).toFixed(2)}%`, `默认值目录 wasteRatio→蒙面 ${covering} 默认损耗`)
  if (work.pageSize === undefined) note('pageSize', '放样纸张', pageSize, '默认值目录 pageSize→A4')
  work.seamAllowanceMm = seam
  work.lashAllowanceMm = lash
  work.overlapMm = overlap
  work.batchCount = batchCount
  work.wasteRatio = waste
  work.pageSize = pageSize

  // ---- 规范化标量并组装（id/createdAt/updatedAt 原样，绝不重新生成） ----
  work.kind = kind
  work.maxDiameterMm = maxD
  work.totalHeightMm = totalH
  work.mouthDiameterMm = mouthD
  work.sides = sides
  work.mouthStyle = mouthStyle
  work.bottomStyle = bottomStyle
  work.covering = covering
  work.color = color

  if (typeof work.id !== 'string' || !work.id) {
    throw new Error('旧档没有灯样编号 id：按规则编号必须保持原样、不许重新生成，该档不能自动补齐，请人工补编号。')
  }
  if (typeof work.createdAt !== 'string' || !work.createdAt) {
    throw new Error('旧档没有创建时间 createdAt：按规则创建时间必须保持原样、不许重新生成，该档不能自动补齐。')
  }
  if (typeof work.updatedAt !== 'string' || !work.updatedAt) work.updatedAt = work.createdAt

  // 先组装出灯样，再用同一份轮廓把每层直径（老档典型缺项 3）算回去
  const lantern = work as unknown as Lantern
  const g = buildGeometry(lantern)
  const secByLayer = new Map<number, number>() // 层下标 → 该层上沿直径
  g.sections.forEach((sec, k) => {
    if (k > 0) secByLayer.set(sec.index - 1, r1(sec.radiusMm * 2))
  })
  const heightMissingSet = new Set(diagnosis.layers.filter((x) => !x.hasHeight).map((x) => x.index))
  lantern.layers.forEach((ly, i) => {
    if (!isPosNum(ly.diameterMm)) {
      const d = secByLayer.get(i)
      const heightMissing = heightMissingSet.has(i)
      if (d === undefined || heightMissing) {
        ly.diameterMm = 0
        note(
          `layers[${i}].diameterMm`,
          `第 ${i + 1} 层直径`,
          '留空（该层缺高度）',
          '默认值目录 layers.diameterMm：分层高度缺失时不造该段轮廓',
          true
        )
      } else {
        ly.diameterMm = d
        note(
          `layers[${i}].diameterMm`,
          `第 ${i + 1} 层直径`,
          `${d}mm（${Math.round(d / 10)}cm）`,
          '默认值目录 layers.diameterMm：按该灯已写明的口径/收口曲线沿分层高度重算，r1 取位',
          route === 'default'
        )
      }
    }
  })
  lantern.totalHeightMm = r1(effectiveHeight(lantern))
  if (lantern.totalHeightMm !== totalH) {
    note('totalHeightMm(派生)', '总高（=各分层高之和）', `${lantern.totalHeightMm}mm`, '按分层高度累计回写')
  }
  lantern.schemaVersion = 2

  // ---- 完整性与代价提示 ----
  const incompleteLayers = lantern.layers
    .map((ly, i) => (isLayerActive(ly) ? -1 : i + 1))
    .filter((n) => n >= 1)
  const complete = route === 'preset' && incompleteLayers.length === 0
  const warnings: string[] = []
  if (matched) {
    warnings.push(
      `本盏按「能对得上当前灯型库」照预设「${matched.preset.name}」补值，补完可直接放样、各页齐全；代价是补出来的灯跟当年存下的那一盏未必是一回事，导出的单子与图纸跟旧档对不上。`
    )
  } else {
    warnings.push(
      '本盏按写明的默认值逐项顶值，与旧档对得上；代价是被顶值的层（见下）在构件表与裁片页会少一段轮廓、该层显示不全，需人工补后再放样。'
    )
  }
  if (incompleteLayers.length) {
    warnings.push(`不完整层（缺分层高度，未造轮廓）：第 ${incompleteLayers.join('、')} 层；骨架构件表、蒙面裁片页与 1:1 分页均不含这一段，请人工补高度后重算。`)
  }
  const unknownFieldsKept = diagnosis.unknownFields

  return {
    lantern,
    route,
    presetId: matched?.preset.id,
    items,
    unknownFieldsKept,
    complete,
    incompleteLayers,
    warnings
  }
}

// ---------------------------------------------------------------------------
// 内容签名：改一处别处必须跟着刷新；导出单子按签名判定是否已过时
// （id/createdAt/时间戳/审计字段不参与；只算会改变放样结果的业务字段）
// ---------------------------------------------------------------------------

const SIGNATURE_FIELDS = [
  'kind', 'maxDiameterMm', 'totalHeightMm', 'mouthDiameterMm', 'baseDiameterMm', 'sides',
  'mouthStyle', 'bottomStyle', 'smoothness', 'divisions', 'covering', 'seamAllowanceMm',
  'lashAllowanceMm', 'color', 'batchCount', 'wasteRatio', 'pageSize', 'overlapMm',
  'ctrl1.x', 'ctrl1.y', 'ctrl2.x', 'ctrl2.y'
] as const

/** 稳定字符串哈希（FNV-1a，djb2 变体不引入依赖） */
function hash32(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return ('0000000' + (h >>> 0).toString(16)).slice(-8)
}

export function signatureOf(l: Lantern): string {
  const scalarKeys = SIGNATURE_FIELDS.filter((f) => !f.startsWith('ctrl'))
  const parts: string[] = scalarKeys.map((f) => `${f}=${String((l as unknown as Record<string, unknown>)[f] ?? '')}`)
  parts.push(`ctrl1.x=${l.ctrl1.x}`, `ctrl1.y=${l.ctrl1.y}`, `ctrl2.x=${l.ctrl2.x}`, `ctrl2.y=${l.ctrl2.y}`)
  l.layers.forEach((ly, i) => parts.push(`L${i}.h=${r1(ly.heightMm)}`, `L${i}.d=${r1(ly.diameterMm)}`))
  l.layerColors.forEach((c, i) => parts.push(`C${i}=${c}`))
  return hash32(parts.join('|'))
}

// ---------------------------------------------------------------------------
// 审计 / 台账 / 作废
// ---------------------------------------------------------------------------

export function latestRevision(l: Lantern): LegacyRevision | null {
  const revs = l.legacy?.revisions
  return revs && revs.length ? revs[revs.length - 1] : null
}

/**
 * 灯样是否换过路（审计链上存在已作废版次）。
 * 换路后：旧版存档补值、已发出的单子图纸与已裁的料都作废；允许（且要求）按新版重新导出。
 */
export function hasVoidedHistory(l: Lantern): boolean {
  return !!l.legacy?.revisions.some((r) => r.voidedAt)
}

/** CHK-10/横幅用：是否处于需要醒目提示的作废状态 */
export function isVoided(l: Lantern): boolean {
  return hasVoidedHistory(l)
}

/**
 * 导出前提示：若换过路但新版还没把三份单子 + 1:1 图纸全部重出，先把作废代价讲清楚。
 * 返回 null 表示可直接导出；返回字符串表示需要用户显式确认后才能导。
 */
const REISSUE_KINDS: ExportKind[] = ['members', 'panels', 'materials', 'drawing']
export function pendingReissueKinds(l: Lantern): ExportKind[] {
  if (!hasVoidedHistory(l)) return []
  const done = new Set(latestRevision(l)!.exports.map((e) => e.kind))
  return REISSUE_KINDS.filter((k) => !done.has(k))
}

export function exportBlockedReason(l: Lantern): string | null {
  if (!hasVoidedHistory(l)) return null
  const pending = pendingReissueKinds(l)
  if (pending.length === 0) return null
  const latest = latestRevision(l)!
  const names: Record<ExportKind, string> = {
    members: '构件清单', panels: '裁片清单', materials: '备料单', drawing: '1:1 放样图'
  }
  const oldExports = l.legacy!.revisions.filter((r) => r.voidedAt).reduce((s, r) => s + r.exports.length, 0)
  return `确认按第 ${latest.revision} 版（${latest.route === 'preset' ? '照预设补' : '按默认值顶'}）重新导出？此前 ${oldExports} 份已发出的单子与图纸、以及按旧补值裁好的料都要作废重来。新版还差 ${pending.length} 份未按当前值重出：${pending.map((k) => names[k]).join('、')}。`
}

/** 换路后三份单子 + 图纸是否都已按新版重出（重出齐全即恢复正常） */
export function isReissuedCompletely(l: Lantern): boolean {
  return hasVoidedHistory(l) && pendingReissueKinds(l).length === 0
}

/** 登记一次导出（三份单子之一）；返回登记后的台账条目 */
export function recordExport(l: Lantern, kind: ExportKind, at = new Date().toISOString()): ExportLedgerEntry {
  if (!l.legacy) l.legacy = { revisions: [] }
  let rev = latestRevision(l)
  if (!rev) {
    // 非老档（新建灯样）也记账，便于「改一处，旧单子即过时」提示
    rev = {
      revision: 0,
      route: 'default',
      items: [],
      unknownFieldsKept: [],
      complete: true,
      incompleteLayers: [],
      warnings: [],
      confirmedAt: at,
      exports: []
    }
    l.legacy.revisions.push(rev)
  }
  if (rev.voidedAt) throw new Error('已作废的灯样版本不允许再登记导出。')
  const entry: ExportLedgerEntry = { kind, at, signature: signatureOf(l) }
  rev.exports.push(entry)
  return entry
}

/** 当前灯样相对最近一次导出是否改过（改一处别处必须跟着刷新、旧单子标注过时） */
export function staleExports(l: Lantern): { kind: ExportKind; at: string }[] {
  const rev = latestRevision(l)
  if (!rev) return []
  const sig = signatureOf(l)
  return rev.exports.filter((e) => e.signature !== sig).map((e) => ({ kind: e.kind, at: e.at }))
}

export interface ConfirmResult {
  lantern: Lantern
  revision: LegacyRevision
  /** 与既有版本的关系 */
  outcome: 'new' | 'identical' | 'superseded'
}

/**
 * 把一次补齐确认写进灯样的审计（不碰存储）。
 *  - 同一版（同一路 + 同一内容签名）重复确认 → identical，不产生第二版；
 *  - 换路或内容变化 → superseded：把旧版连同其导出台账作废，升一版。
 */
export function attachConfirmedFill(fill: LegacyFill, existing: Lantern | undefined, at = new Date().toISOString()): ConfirmResult {
  const lantern = fill.lantern
  const sig = signatureOf(lantern)
  const prev = existing ? latestRevision(existing) : null

  // 同一批重复确认 / 与当前版完全一致：不许写成两版
  if (existing && prev && !prev.voidedAt && prev.route === fill.route && signatureOf(existing) === sig) {
    return { lantern: existing, revision: prev, outcome: 'identical' }
  }

  // 换一条路（或内容已变）：把此前未作废的版连同其已导出单子全部作废，再升一版
  if (existing?.legacy?.revisions.length) {
    for (const r of existing.legacy.revisions) {
      if (!r.voidedAt) {
        r.voidedAt = at
        r.voidReason =
          `改用「${fill.route === 'preset' ? '照预设补' : '按默认值顶'}」路重补：本版存档补值、已据其导出的 ${r.exports.length} 份单子与图纸全部作废重来，已按本版数值裁好的料要重裁。`
      }
    }
    lantern.legacy = { revisions: [...existing.legacy.revisions] }
  } else {
    lantern.legacy = { revisions: [] }
  }

  // revision 编号按全部历史版次连续编号（含已作废版），不许断号
  const revision: LegacyRevision = {
    revision: lantern.legacy.revisions.length + 1,
    route: fill.route,
    presetId: fill.presetId,
    items: fill.items,
    unknownFieldsKept: fill.unknownFieldsKept,
    complete: fill.complete,
    incompleteLayers: fill.incompleteLayers,
    warnings: fill.warnings,
    confirmedAt: at,
    exports: []
  }
  lantern.legacy.revisions.push(revision)
  return { lantern, revision, outcome: prev ? 'superseded' : 'new' }
}

/** 便捷：给一个灯样挂上 LegacyMeta（测试/存储迁移用） */
export function emptyMeta(): LegacyMeta {
  return { revisions: [] }
}
