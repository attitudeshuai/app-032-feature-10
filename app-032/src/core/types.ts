/** 花灯放样数据模型（对齐规格书 §7，并补充放样所需的展开参数） */

export type LanternKind = 'prism' | 'revolution' | 'polyhedron' | 'box'
export type MouthStyle = 'flat' | 'taper' | 'gourd'
export type Covering = 'xuan' | 'silk' | 'parchment'
export type PageSize = 'A4' | 'A3'
export type PanelShape = 'trapezoid' | 'rectangle' | 'sector' | 'circle' | 'triangle'
export type MemberKind = 'vertical' | 'ring' | 'mouth_ring' | 'base_ring' | 'rib' | 'spoke'

export interface Point2 {
  x: number
  y: number
}

/** 分段（层）：高度为准，直径为轮廓派生结果 */
export interface LayerSpec {
  heightMm: number
  diameterMm: number
}

/** 老灯样补齐的两条路（取舍必须挑一条并认下代价） */
export type LegacyRoute = 'preset' | 'default'

/** 导出台账上的单子/图纸种类（三份导出单子 + 1:1 图纸） */
export type ExportKind = 'members' | 'panels' | 'materials' | 'drawing'

/** 一次写进存档的导出记录（已发出去的单子/图纸据此作废判定） */
export interface ExportLedgerEntry {
  kind: ExportKind
  at: string
  /** 导出时灯样的内容签名（改一处再导出即与旧单子对不上） */
  signature: string
}

/** 一次补齐的审计记录（写在灯样上，列清这次补了哪几项） */
export interface LegacyRevision {
  /** 第几版补齐（同一批重复确认不许写成两版；换一条路重补即升一版） */
  revision: number
  route: LegacyRoute
  /** 对得上的预设 id（route=preset 时有值） */
  presetId?: string
  /** 逐项补值清单 */
  items: LegacyFillItem[]
  /** 补值来源里多出的/不认识的字段原样留下，仅登记键名 */
  unknownFieldsKept: string[]
  complete: boolean
  /** 不完整层（按 1 起始的层号）：default 路顶值后仍可能少一段轮廓的层 */
  incompleteLayers: number[]
  warnings: string[]
  confirmedAt: string
  /** 该版确认后已据其导出过的单子（换路即作废） */
  exports: ExportLedgerEntry[]
  /** 该版是否已被换路重补作废 */
  voidedAt?: string
  /** 作废原因（写明已发出的单子/图纸与已裁料如何处理） */
  voidReason?: string
}

/** 单个补值项：缺哪一项、顶成什么值、取自哪条预设/默认 */
export interface LegacyFillItem {
  /** 字段路径，如 baseDiameterMm / layerColors[2] / layers[1].diameterMm / divisions */
  path: string
  /** 人类可读字段名 */
  label: string
  /** 补后的值（展示用，必要时同时给 mm 与整数 cm） */
  value: number | string
  /** 取值来源，如「预设 六角宫灯 params.baseDiameterMm」「默认值目录 baseDiameterMm→mouthDiameterMm」 */
  source: string
  /** 该补值是否让构件表/裁片页可能少一段轮廓、需人工复核 */
  manual?: boolean
}

/** 老灯样补齐元数据（挂在灯样上；id/createdAt 永不在读入时重生成） */
export interface LegacyMeta {
  revisions: LegacyRevision[]
}

export interface Lantern {
  id: string
  kind: LanternKind
  name: string
  /** 最大直径（灯体最粗处） */
  maxDiameterMm: number
  /** 总高（= 各分段高度之和） */
  totalHeightMm: number
  /** 收口直径（上口） */
  mouthDiameterMm: number
  /** 底口直径（下口） */
  baseDiameterMm: number
  /** 棱数（prism/box）；旋转体时作为竖篾（母线篾）根数 */
  sides: number
  /** 分段高度与直径 */
  layers: LayerSpec[]
  /** 上收口方式 */
  mouthStyle: MouthStyle
  /** 下收口方式 */
  bottomStyle: MouthStyle
  /** 收口曲线强度 0~1 */
  smoothness: number
  /** 葫芦/花瓶形贝塞尔控制点（归一化：x 为半径插值比例，y 为肩部区间比例） */
  ctrl1: Point2
  ctrl2: Point2
  /** 旋转体母线等分数（默认 24，可调；老档缺了按默认值补） */
  divisions: number
  /** 蒙面类型 */
  covering: Covering
  /** 缝份（mm，四边各加） */
  seamAllowanceMm: number
  /** 绑扎余量（mm，每端） */
  lashAllowanceMm: number
  /** 每层配色（长度 = layers.length，可短于层数则回落到主色） */
  layerColors: string[]
  /** 主色 */
  color: string
  /** 批量制灯数量 */
  batchCount: number
  /** 损耗率 0~0.2 */
  wasteRatio: number
  /** 1:1 打印纸张 */
  pageSize: PageSize
  /** 长条图跨页搭接量（mm） */
  overlapMm: number
  createdAt: string
  updatedAt: string
  /** 数据模型版本（老档没有，读入时不补写、确认写回时才带 v2） */
  schemaVersion?: number
  /** 老灯样补齐审计（只有被补齐过的灯样才有） */
  legacy?: LegacyMeta
  /** 允许保留任何多出的旧字段，读出来再存回去不丢 */
  [extra: string]: unknown
}

export interface FrameMember {
  id: string
  kind: MemberKind
  /** 名称，如「竖篾」「第 3 层横篾」「收口圈」 */
  label: string
  /** 截取长度（已含绑扎余量） */
  lengthMm: number
  /** 净长（不含余量） */
  rawLengthMm: number
  /** 建议弯曲半径（圆形圈 / 收口段） */
  bendRadiusMm?: number
  /** 折角（多边形圈的转角，度） */
  bendAngleDeg?: number
  /** 数量 */
  qty: number
  /** 分组：所属层或类别 */
  group: string
  /** 每根含几处绑扎余量 */
  lashJoints: number
  note?: string
}

export interface PanelMark {
  x: number
  y: number
  label: string
}

export interface Panel {
  id: string
  label: string
  shape: PanelShape
  /** 裁片下宽（已含缝份） */
  widthBottomMm: number
  /** 裁片上宽（已含缝份） */
  widthTopMm: number
  /** 裁片高（已含缝份） */
  heightMm: number
  seamAllowanceMm: number
  marksMm: PanelMark[]
  qty: number
  /** 展开净尺寸（不含缝份） */
  rawWidthTopMm: number
  rawWidthBottomMm: number
  rawHeightMm: number
  /** 圆形/正多边形裁片半径（净，不含缝份） */
  radiusMm?: number
  /** 正多边形边数（顶/底盖为多边形时） */
  polySides?: number
  /** 对应灯体层的索引（-1 表示顶/底盖） */
  layerIndex: number
  color: string
  note?: string
}

export interface MaterialTally {
  /** 备料竹篾/铁丝总长（m，含绑扎余量与损耗） */
  frameM: number
  /** 蒙面面积（m²，含缝份与损耗） */
  coveringM2: number
  /** 损耗率 */
  wasteRatio: number
  /** 扎线（m） */
  lashM: number
  /** 胶（g） */
  glueG: number
  /** LED 灯珠建议数量 */
  ledCount?: number
}

/** 构件与裁片的自检结果（对应规格书 §10） */
export interface CheckResult {
  id: string
  title: string
  pass: boolean
  detail: string
  /** 相关数值，便于界面展示 */
  value?: string
}
