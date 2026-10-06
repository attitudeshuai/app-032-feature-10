/**
 * 老灯样补齐（读入迁移）
 *
 * 背景：早先存下的那批灯样没有底口直径、没有逐层配色，分层里也没有直径这一项，
 * 直接打开不是缺一段轮廓就是图上少一块，存回去又把缺的带回去。
 *
 * 本模块在读入时把缺的项按「写明的默认值」补齐，并逐项给出清单（缺哪项、按什么值顶、值来自哪）。
 * 缺的那几项怎么补只有两条路，按灯样逐盏挑定并认下代价：
 *  - 能跟当前灯型库对上的 → 照预设补：补完可直接放样、各页齐全；
 *    代价是补出来的这盏跟当年存下的那盏未必是一回事，导出的单子与图纸跟旧档对不上。
 *  - 对不上的 → 按写明的默认值兜底：跟旧档对得上；
 *    代价是构件表与裁片页会少一段轮廓、有的层显示不全（逐层配色按主色），需人工补。
 *
 * 约定：
 *  - 只补缺失项，已有值一律不动；多出来的未知字段原样保留，不删不丢；
 *  - 灯样编号 id 与创建时间 createdAt 保持原样；缺了只生成一次，确认写回后固定，
 *    不许每次读进来都重新生成；
 *  - 迁移幂等：补过的灯样再读一遍不再产生清单，同一批重复确认不会写成两版；
 *  - 取位：厘米→毫米 ×10 按整数取整；长度 mm 保留 1 位小数；面积折 m² 保留 3 位小数；
 *    比例按百分数保留 2 位小数；旋转体母线等分数缺省按工艺默认（24），
 *    等分近似展开的面积核对容差 [0.97, 1.03]（±3%）。
 */
import {
  COVERINGS,
  CRAFT,
  PRESETS,
  coveringLabel,
  coveringSpec,
  kindLabel,
  presetById,
  styleLabel,
  type LanternPreset
} from './craft'
import { buildGeometry, effectiveHeight, r1 } from './geometry'
import type { Lantern, LanternKind, LayerSpec, MouthStyle } from './types'

/** 补齐清单中的一项：缺哪一项、按什么值顶、这个值来自哪 */
export interface PatchItem {
  /** 字段路径，如 baseDiameterMm、layers[].diameterMm */
  field: string
  /** 中文名 */
  label: string
  /** 顶上的值（展示用） */
  value: string
  /** 这个值来自哪一项预设 / 工艺默认 / 几何推算 */
  source: string
}

export interface LanternMigration {
  /** 灯样编号（补齐后保持稳定） */
  id: string
  name: string
  /** 走的哪条路：preset = 照预设补；defaults = 按写明的默认值兜底 */
  path: 'preset' | 'defaults'
  presetId?: string
  presetName?: string
  items: PatchItem[]
  /** 这条路的代价（确认前必须认下） */
  costNote: string
  /** 确认写回时间（未确认时无） */
  confirmedAt?: string
}

export interface MigrateOneResult {
  lantern: Lantern
  /** null 表示这项不缺，无需补齐 */
  report: LanternMigration | null
}

export interface MigrateBatchResult {
  lanterns: Lantern[]
  reports: LanternMigration[]
  errors: string[]
}

export const PRESET_COST_NOTE =
  '照预设补齐：补完可直接放样、各页齐全；代价——补出来的这盏跟当年存下的那盏未必是一回事，据它导出的单子与图纸跟旧档对不上。'
export const DEFAULTS_COST_NOTE =
  '按默认值兜底：跟旧档对得上；代价——构件表与裁片页会少一段轮廓、有的层显示不全（逐层配色按主色），需人工核对补正。'

/** 取位与容差说明（界面与清单里写明） */
export const LEGACY_ROUNDING_NOTE =
  '取位与容差：厘米→毫米 ×10 后按整数取整；长度 mm 保留 1 位小数；面积折 m² 保留 3 位小数；' +
  `比例按百分数保留 2 位小数；旋转体母线等分数缺省 ${CRAFT.defaultDivisions} 等分，` +
  '等分近似展开的面积核对容差 [0.97, 1.03]（±3%），超差时提示提高等分数。'

const KINDS: LanternKind[] = ['prism', 'revolution', 'polyhedron', 'box']
const STYLES: MouthStyle[] = ['flat', 'taper', 'gourd']
const SRC_CRAFT = '工艺默认值（lantern-types.json · craft）'

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
function pos(v: unknown): number | null {
  const n = num(v)
  return n !== null && n > 0 ? n : null
}
function txt(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null
}
function makeId(): string {
  return 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

/** 能跟当前灯型库对上的判定：已有的每一项都要与预设参数一致（缺的项不参与判定） */
function matchPreset(l: Lantern): LanternPreset | undefined {
  const tol = 0.05
  const eq = (a: unknown, b: number) => {
    const n = num(a)
    return n === null || Math.abs(n - b) <= tol
  }
  return PRESETS.find((p) => {
    const pp = p.params
    if (p.kind !== l.kind) return false
    if (!eq(l.maxDiameterMm, pp.maxDiameterMm)) return false
    if (!eq(l.totalHeightMm, pp.totalHeightMm)) return false
    if (!eq(l.mouthDiameterMm, pp.mouthDiameterMm)) return false
    const sd = num(l.sides)
    if (sd !== null && Math.round(sd) !== pp.sides) return false
    if (Array.isArray(l.layers) && l.layers.length > 0 && l.layers.length !== pp.layerCount) return false
    const ms = txt(l.mouthStyle)
    if (ms && ms !== pp.mouthStyle) return false
    return true
  })
}

/** 均分总高为 count 层（末层吸收取整差，保证各层之和 = 总高） */
function evenLayers(totalMm: number, count: number): LayerSpec[] {
  const each = r1(totalMm / count)
  const arr = Array.from({ length: count }, () => ({ heightMm: each, diameterMm: 0 }))
  const sum = arr.reduce((s, x) => s + x.heightMm, 0)
  arr[arr.length - 1].heightMm = r1(arr[arr.length - 1].heightMm + (totalMm - sum))
  return arr
}

/**
 * 补齐一盏老灯样。直接在读入的原对象上就地补（多出来的字段原样留下），
 * 返回补齐后的灯样与本次补了哪几项的清单。
 */
export function migrateLanternRecord(raw: Record<string, unknown>): MigrateOneResult {
  const l = raw as unknown as Lantern
  const items: PatchItem[] = []
  const LD = CRAFT.legacyDefaults
  const fallback = presetById(LD.fallbackPresetId) || PRESETS[0]
  const srcPreset = (p: LanternPreset) => `灯型库预设「${p.name}」`
  const srcFallback = `兜底预设「${fallback.name}」`
  const push = (field: string, label: string, value: string, source: string) => {
    items.push({ field, label, value, source })
  }

  // ---- 0. 厘米 → 毫米：×10 按整数取整（老档的 *Cm 字段本身原样保留）----
  const cmFields: { mm: 'maxDiameterMm' | 'totalHeightMm' | 'mouthDiameterMm' | 'baseDiameterMm'; cm: string; label: string }[] = [
    { mm: 'maxDiameterMm', cm: 'maxDiameterCm', label: '最大直径' },
    { mm: 'totalHeightMm', cm: 'totalHeightCm', label: '总高' },
    { mm: 'mouthDiameterMm', cm: 'mouthDiameterCm', label: '收口直径' },
    { mm: 'baseDiameterMm', cm: 'baseDiameterCm', label: '底口直径' }
  ]
  for (const f of cmFields) {
    if (pos(l[f.mm]) === null) {
      const cm = pos(raw[f.cm])
      if (cm !== null) {
        const mm = Math.round(cm * 10)
        l[f.mm] = mm
        push(f.mm, f.label, `${mm}mm`, `老档厘米字段 ${f.cm}=${cm} ×10 整数取整`)
      }
    }
  }

  // ---- 1. 灯型（匹配预设前要先有）----
  if (!KINDS.includes(l.kind)) {
    l.kind = 'prism'
    push('kind', '灯型', kindLabel('prism'), '写明默认：缺省按正多棱柱')
  }

  // ---- 2. 能跟当前灯型库对上的就照预设补 ----
  const preset = matchPreset(l)
  const P = preset?.params

  // ---- 3. 逐项补齐（只补缺的，已有值一律不动）----
  if (!txt(l.name)) {
    l.name = preset?.name ?? '未命名老灯样'
    push('name', '灯样名称', l.name, preset ? srcPreset(preset) : '写明默认：未命名老灯样')
  }
  if (pos(l.maxDiameterMm) === null) {
    const v = P?.maxDiameterMm ?? fallback.params.maxDiameterMm
    l.maxDiameterMm = v
    push('maxDiameterMm', '最大直径', `${v}mm`, preset ? srcPreset(preset) : srcFallback)
  }
  if (pos(l.totalHeightMm) === null) {
    const layerSum = Array.isArray(l.layers)
      ? l.layers.reduce((s, ly) => s + (isRec(ly) ? pos((ly as LayerSpec).heightMm) ?? 0 : 0), 0)
      : 0
    if (layerSum > 0) {
      l.totalHeightMm = r1(layerSum)
      push('totalHeightMm', '总高', `${l.totalHeightMm}mm`, '各层分段高累计')
    } else {
      const v = P?.totalHeightMm ?? fallback.params.totalHeightMm
      l.totalHeightMm = v
      push('totalHeightMm', '总高', `${v}mm`, preset ? srcPreset(preset) : srcFallback)
    }
  }
  if (!STYLES.includes(l.mouthStyle)) {
    const v = P?.mouthStyle ?? LD.mouthStyle
    l.mouthStyle = v
    push('mouthStyle', '上收口方式', styleLabel(v), preset ? srcPreset(preset) : `${SRC_CRAFT} legacyDefaults.mouthStyle`)
  }
  if (!STYLES.includes(l.bottomStyle)) {
    const v = P?.bottomStyle ?? l.mouthStyle
    l.bottomStyle = v
    push('bottomStyle', '下收口方式', styleLabel(v), preset ? srcPreset(preset) : '写明默认：与上收口同法')
  }
  if (pos(l.mouthDiameterMm) === null) {
    const v = P?.mouthDiameterMm ?? l.maxDiameterMm
    l.mouthDiameterMm = v
    push('mouthDiameterMm', '收口直径', `${v}mm`, preset ? srcPreset(preset) : '写明默认：与最大直径相同（不收口）')
  }
  if (pos(l.baseDiameterMm) === null) {
    const v = P?.baseDiameterMm ?? l.mouthDiameterMm
    l.baseDiameterMm = v
    push('baseDiameterMm', '底口直径', `${v}mm`, preset ? srcPreset(preset) : '写明默认：与上口同径（上下同径）')
  }
  if (pos(l.sides) === null) {
    const v = P?.sides ?? LD.sides[l.kind] ?? 6
    l.sides = v
    push('sides', l.kind === 'revolution' ? '母线根数' : '棱数', `${v}`, preset ? srcPreset(preset) : `${SRC_CRAFT} legacyDefaults.sides`)
  }
  const sm = num(l.smoothness)
  if (sm === null) {
    const v = P?.smoothness ?? LD.smoothness
    l.smoothness = v
    push('smoothness', '收口曲线强度', `${v}`, preset ? srcPreset(preset) : `${SRC_CRAFT} legacyDefaults.smoothness`)
  } else if (sm < 0 || sm > 1) {
    l.smoothness = Math.min(1, Math.max(0, sm))
    push('smoothness', '收口曲线强度', `${l.smoothness}`, '写明默认：夹到 0~1 区间')
  }
  const ctrlOk = (c: unknown): c is { x: number; y: number } => isRec(c) && num(c.x) !== null && num(c.y) !== null
  if (!ctrlOk(l.ctrl1)) {
    const v = P?.ctrl1 ?? LD.ctrl1
    l.ctrl1 = { ...v }
    push('ctrl1', '葫芦口控制点 1', `(${v.x}, ${v.y})`, P?.ctrl1 ? srcPreset(preset!) : `${SRC_CRAFT} legacyDefaults.ctrl1`)
  }
  if (!ctrlOk(l.ctrl2)) {
    const v = P?.ctrl2 ?? LD.ctrl2
    l.ctrl2 = { ...v }
    push('ctrl2', '葫芦口控制点 2', `(${v.x}, ${v.y})`, P?.ctrl2 ? srcPreset(preset!) : `${SRC_CRAFT} legacyDefaults.ctrl2`)
  }
  if (pos(l.divisions) === null) {
    const v = P?.divisions ?? CRAFT.defaultDivisions
    l.divisions = v
    push(
      'divisions',
      '母线等分数',
      `${v} 等分`,
      (P?.divisions ? srcPreset(preset!) : `${SRC_CRAFT} defaultDivisions`) + '；等分近似容差 [0.97, 1.03]'
    )
  } else {
    const c = Math.max(CRAFT.divMin, Math.min(CRAFT.divMax, Math.round(l.divisions)))
    if (c !== l.divisions) {
      push('divisions', '母线等分数', `${c} 等分`, `写明默认：取整并夹到 [${CRAFT.divMin}, ${CRAFT.divMax}]`)
      l.divisions = c
    }
  }
  if (!COVERINGS.some((c) => c.id === l.covering)) {
    const v = P?.covering ?? COVERINGS[0].id
    l.covering = v
    push('covering', '蒙面类型', coveringLabel(v), preset ? srcPreset(preset) : `写明默认：${coveringLabel(COVERINGS[0].id)}`)
  }
  if (num(l.seamAllowanceMm) === null || l.seamAllowanceMm < 0) {
    l.seamAllowanceMm = CRAFT.defaultSeamAllowanceMm
    push('seamAllowanceMm', '缝份（每边）', `${l.seamAllowanceMm}mm`, `${SRC_CRAFT} defaultSeamAllowanceMm`)
  }
  if (num(l.lashAllowanceMm) === null || l.lashAllowanceMm < 0) {
    l.lashAllowanceMm = CRAFT.defaultLashAllowanceMm
    push('lashAllowanceMm', '绑扎余量（每端）', `${l.lashAllowanceMm}mm`, `${SRC_CRAFT} defaultLashAllowanceMm`)
  }
  if (!txt(l.color)) {
    const v = P?.color ?? fallback.params.color
    l.color = v
    push('color', '主色', v, preset ? srcPreset(preset) : srcFallback)
  }

  // ---- 4. 分层：层缺失则均分；层高缺则顶均分值；分层直径缺则按补齐后的轮廓重算 ----
  if (!Array.isArray(l.layers) || l.layers.length === 0) {
    const count = Math.max(1, Math.round(P?.layerCount ?? LD.layerCount))
    l.layers = evenLayers(l.totalHeightMm, count)
    push('layers', '分段（层）', `${count} 层均分（每层 ${r1(l.totalHeightMm / count)}mm）`, preset ? srcPreset(preset) : `${srcFallback}层数`)
  } else {
    let fixedH = 0
    l.layers = l.layers.map((ly0) => {
      const ly = (isRec(ly0) ? ly0 : {}) as LayerSpec & Record<string, unknown>
      if (pos(ly.heightMm) === null) {
        const cm = pos(ly.heightCm)
        if (cm !== null) {
          ly.heightMm = Math.round(cm * 10)
          push('layers[].heightMm', '分层高（厘米换算）', `${ly.heightMm}mm`, `老档厘米字段 heightCm=${cm} ×10 整数取整`)
        } else {
          ly.heightMm = r1(l.totalHeightMm / l.layers.length)
          fixedH++
        }
      }
      return ly
    })
    if (fixedH > 0) {
      push('layers[].heightMm', '分层高', `${fixedH} 层按均分 ${r1(l.totalHeightMm / l.layers.length)}mm 顶`, '写明默认：总高 ÷ 层数均分')
    }
  }
  if (l.layers.some((ly) => pos(ly.diameterMm) === null)) {
    const g = buildGeometry(l)
    l.layers.forEach((ly, i) => {
      const sec = g.sections[i + 1]
      if (sec) ly.diameterMm = r1(sec.radiusMm * 2)
    })
    push('layers[].diameterMm', '分层直径', `${l.layers.length} 层全部按轮廓重算`, '几何推算（按补齐后的收口曲线）')
  }
  const sumH = r1(effectiveHeight(l))
  if (Math.abs(sumH - l.totalHeightMm) > 0.05) {
    push('totalHeightMm', '总高', `${sumH}mm`, '几何重算：= 各层分段高累计')
    l.totalHeightMm = sumH
  }

  // ---- 5. 逐层配色（层数定了再对齐）----
  {
    const count = l.layers.length
    const rawColors = Array.isArray(l.layerColors) ? l.layerColors : []
    const aligned = Array.from({ length: count }, (_, i) => txt(rawColors[i]) ?? P?.layerColors?.[i] ?? l.color)
    const changed = rawColors.length !== count || aligned.some((c, i) => c !== rawColors[i])
    if (changed) {
      l.layerColors = aligned
      const how = rawColors.length === 0 ? (preset ? `照预设 ${count} 层配色` : `逐层取主色 ${l.color}`) : `由 ${rawColors.length} 项对齐到 ${count} 层（缺的取主色）`
      push('layerColors', '逐层配色', how, preset ? srcPreset(preset) : '写明默认：逐层取主色')
    }
  }

  // ---- 6. 批量 / 损耗 / 打印参数 ----
  if (pos(l.batchCount) === null) {
    l.batchCount = LD.batchCount
    push('batchCount', '批量数量', `${LD.batchCount} 个`, `${SRC_CRAFT} legacyDefaults.batchCount`)
  }
  if (num(l.wasteRatio) === null || l.wasteRatio < 0 || l.wasteRatio > 0.2) {
    const v = coveringSpec(l.covering).wasteRatio
    l.wasteRatio = v
    push('wasteRatio', '损耗率', `${(v * 100).toFixed(0)}%`, `蒙面「${coveringLabel(l.covering)}」默认损耗率`)
  }
  if (l.pageSize !== 'A4' && l.pageSize !== 'A3') {
    l.pageSize = LD.pageSize
    push('pageSize', '打印纸张', LD.pageSize, `${SRC_CRAFT} legacyDefaults.pageSize`)
  }
  if (num(l.overlapMm) === null || l.overlapMm < 0) {
    l.overlapMm = CRAFT.defaultOverlapMm
    push('overlapMm', '长条搭接量', `${l.overlapMm}mm`, `${SRC_CRAFT} defaultOverlapMm`)
  }

  // ---- 7. 编号与时间：保持原样；缺了只补一次，确认写回后固定 ----
  if (!txt(l.id)) {
    l.id = makeId()
    push('id', '灯样编号', l.id, '老档缺编号：本次生成一次，确认写回后固定（不再每次读入重新生成）')
  }
  if (!txt(l.createdAt)) {
    const v = txt(l.updatedAt) ?? new Date().toISOString()
    l.createdAt = v
    push('createdAt', '创建时间', v, '老档缺创建时间：补一次并固定（不再每次读入重新生成）')
  }
  if (!txt(l.updatedAt)) {
    l.updatedAt = l.createdAt
    push('updatedAt', '修改时间', l.updatedAt, '写明默认：与创建时间相同')
  }

  if (items.length === 0) return { lantern: l, report: null }
  const path = preset ? 'preset' : 'defaults'
  return {
    lantern: l,
    report: {
      id: l.id,
      name: l.name,
      path,
      presetId: preset?.id,
      presetName: preset?.name,
      items,
      costNote: preset ? PRESET_COST_NOTE : DEFAULTS_COST_NOTE
    }
  }
}

/** 一批老灯样一次读完：逐盏补齐并汇总清单（读入的原对象就地补，未知字段原样保留） */
export function migrateBatch(records: unknown[]): MigrateBatchResult {
  const lanterns: Lantern[] = []
  const reports: LanternMigration[] = []
  const errors: string[] = []
  records.forEach((rec, i) => {
    if (!isRec(rec)) {
      errors.push(`第 ${i + 1} 条老灯样不是有效记录，已跳过`)
      return
    }
    const { lantern, report } = migrateLanternRecord(rec)
    lanterns.push(lantern)
    if (report) reports.push(report)
  })
  return { lanterns, reports, errors }
}

/** 一句话清单（导出单表头、灯样列表角标用） */
export function migrationSummary(m: LanternMigration): string {
  const head = m.path === 'preset' ? `照预设「${m.presetName}」补齐` : '按写明的默认值兜底补齐'
  return `老档${head} ${m.items.length} 项：${m.items.map((i) => `${i.label}=${i.value}`).join('；')}`
}
