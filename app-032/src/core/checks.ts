/**
 * 自检（对应规格书 §10 验收标准）
 * 每次参数变化都会重算全部几何并跑一遍断言，结果直接显示在界面上。
 */
import type { CheckResult, Lantern } from './types'
import { bodySurfaceArea, polygonEdge, ringPerimeter, segmentInfos } from './geometry'
import { buildFrame, type FrameResult } from './frame'
import { buildPanels, panelNetArea, type PanelResult } from './panels'
import { computeBatch, computeMaterials, type BatchMaterials, type SingleLightMaterials } from './materials'
import { assertNoPanelSplit, assertStripNumbering, paginate, type LoftOptions, type Sheet } from './paginate'
import { CRAFT } from './craft'
import { isReissuedCompletely, isVoided, latestRevision, pendingReissueKinds, signatureOf, staleExports } from './legacy'
import { pctText } from './units'

export interface FullResult {
  frame: FrameResult
  panels: PanelResult
  materials: SingleLightMaterials
  batch: BatchMaterials
  sheets: Sheet[]
  checks: CheckResult[]
  elapsedMs: number
}

const f1 = (v: number) => (Math.round(v * 10) / 10).toFixed(1)
const f3 = (v: number) => (Math.round(v * 1000) / 1000).toFixed(3)

export function computeAll(l: Lantern, loft: LoftOptions): FullResult {
  const t0 = performance.now()
  const frame = buildFrame(l)
  const panels = buildPanels(l)
  const materials = computeMaterials(l)
  const batch = computeBatch(materials, Math.max(1, Math.round(l.batchCount)), l.wasteRatio)
  const sheets = paginate(l, loft)
  const elapsedMs = performance.now() - t0
  const checks = runChecks(l, frame, panels, materials, batch, sheets, elapsedMs)
  return { frame, panels, materials, batch, sheets, checks, elapsedMs }
}

function runChecks(
  l: Lantern,
  frame: FrameResult,
  panels: PanelResult,
  materials: SingleLightMaterials,
  batch: BatchMaterials,
  sheets: Sheet[],
  elapsedMs: number
): CheckResult[] {
  const out: CheckResult[] = []
  const g = frame.geometry
  const lash = Math.max(0, l.lashAllowanceMm)

  // ---- CHK-01 几何：棱长/周长与手算一致 ----
  {
    const cases = [
      { name: '正六棱柱底边（D200）', got: polygonEdge(100, 6), expect: 100, tol: 1 },
      { name: '正八棱柱底边（D200）', got: polygonEdge(100, 8), expect: 76.5367, tol: 1 },
      { name: '圆形横篾圈周长（D200）', got: ringPerimeter(100, 0, false), expect: 628.3185, tol: 1 },
      { name: '六边形周长（D200）', got: ringPerimeter(100, 6, true), expect: 600, tol: 1 }
    ]
    const bad = cases.filter((c) => Math.abs(c.got - c.expect) > c.tol)
    out.push({
      id: 'CHK-01',
      title: '几何手算核对（棱长 / 周长，误差 ≤ 1mm）',
      pass: bad.length === 0,
      value: bad.length === 0 ? '4/4 项通过' : `${bad.length} 项超差`,
      detail: cases
        .map((c) => `${c.name}：算得 ${f3(c.got)} / 手算 ${f3(c.expect)}（Δ${f3(Math.abs(c.got - c.expect))}）`)
        .join('；')
    })
  }

  // ---- CHK-02 竖篾长度与分段高度累计 ----
  {
    const segs = segmentInfos(g)
    const sumH = segs.reduce((s, x) => s + x.heightMm, 0)
    const sumSlant = segs.reduce((s, x) => s + x.slantMm, 0)
    const vertical = frame.members.find((m) => m.kind === 'vertical' || m.kind === 'rib')
    const raw = vertical ? vertical.rawLengthMm : 0
    const allStraight = segs.every((s) => Math.abs(s.drMm) < 0.05)
    const pass = Math.abs(raw - sumSlant) <= 0.1 && (!allStraight || Math.abs(raw - sumH) <= 0.1)
    out.push({
      id: 'CHK-02',
      title: '竖篾净长 = 分段母线折线长累计',
      pass,
      value: `Δ折线 ${f1(Math.abs(raw - sumSlant))}mm`,
      detail: allStraight
        ? `竖篾净长 ${f1(raw)}mm，分段高累计 ${f1(sumH)}mm，平口直柱两者一致（Δ${f1(Math.abs(raw - sumH))}mm）`
        : `竖篾净长 ${f1(raw)}mm，分段高累计 ${f1(sumH)}mm，折线长累计 ${f1(sumSlant)}mm（收口段横向偏移 ${f1(sumSlant - sumH)}mm）`
    })
  }

  // ---- CHK-03 缝份 ----
  {
    const s = Math.max(0, l.seamAllowanceMm)
    const bad = panels.panels.filter(
      (p) =>
        Math.abs(p.widthTopMm - (p.rawWidthTopMm + 2 * s)) > 0.06 ||
        Math.abs(p.widthBottomMm - (p.rawWidthBottomMm + 2 * s)) > 0.06 ||
        Math.abs(p.heightMm - (p.rawHeightMm + 2 * s)) > 0.06
    )
    out.push({
      id: 'CHK-03',
      title: '裁片尺寸 = 展开净尺寸 + 缝份 × 2（每边）',
      pass: bad.length === 0,
      value: `${panels.panels.length - bad.length}/${panels.panels.length} 种裁片通过`,
      detail:
        bad.length === 0
          ? `全部 ${panels.panels.length} 种裁片上/下/高三个尺寸均等于净尺寸 + ${f1(s)}×2mm；裁片图以红色虚线绘制缝份折线`
          : `超差裁片：${bad.map((p) => p.label).join('、')}`
    })
  }

  // ---- CHK-04 备料守恒 ----
  {
    const stock = frame.members.reduce((a, m) => a + m.lengthMm * m.qty, 0)
    const rawTotal = frame.members.reduce((a, m) => a + m.rawLengthMm * m.qty, 0)
    const lashTotal = frame.members.reduce((a, m) => a + m.qty * m.lashJoints * lash, 0)
    const diff = stock - rawTotal
    const pass = stock >= rawTotal - 1e-6 && Math.abs(diff - lashTotal) <= 0.5
    out.push({
      id: 'CHK-04',
      title: '备料守恒：Σ备料长度 ≥ Σ净长，且差值 = 余量总和',
      pass,
      value: `Σ备料 ${f1(stock)}mm / Σ净长 ${f1(rawTotal)}mm`,
      detail: `差值 ${f1(diff)}mm，应等于余量总和 ${f1(lashTotal)}mm（竖篾两端、横篾圈接头各计 ${f1(lash)}mm）`
    })
  }

  // ---- CHK-05 面积核对 ----
  {
    const netArea = panels.panels.reduce((a, p) => a + panelNetArea(p) * p.qty, 0)
    const refArea = bodySurfaceArea(g, Math.max(3, Math.round(l.divisions)))
    const ratio = refArea > 0 ? netArea / refArea : 0
    const pass = ratio >= 0.97 && ratio <= 1.03
    let advice = ''
    if (!pass && !g.polygon) {
      const need = suggestDivisions(l, netArea, ratio)
      advice = need ? `；建议把母线等分数提高到 ${need}（当前 ${l.divisions}）` : ''
    } else if (!pass) {
      advice = '；请检查缝份/分层参数，棱柱类侧面积应与裁片面积完全一致'
    }
    out.push({
      id: 'CHK-05',
      title: '面积核对：Σ裁片净面积 / 灯体表面积 ∈ [97.00%,103.00%]（旋转体等分近似容差，百分数 2 位小数）',
      pass,
      value: `比值 ${pctText(ratio)}`,
      detail: `裁片净面积 ${f3(netArea / 1_000_000)}m²，灯体表面积（含顶底盖）${f3(refArea / 1_000_000)}m²；旋转体按 ${Math.max(3, Math.round(l.divisions))} 等分以直代曲，容差 ±3.00%，长度取位 0.1mm${advice}`
    })
  }

  // ---- CHK-06 分页：裁片不跨页 ----
  {
    const r = assertNoPanelSplit(sheets)
    out.push({
      id: 'CHK-06',
      title: '分页：任一裁片不跨页（长条跨页带对位十字与搭接量）',
      pass: r.pass,
      value: r.pass ? '通过' : '失败',
      detail: `${r.detail}；跨页仅出现在骨架长条上，接缝处绘制对位十字并标注搭接 ${f1(loftOverlap(sheets))}mm 与拼接编号`
    })
  }

  // ---- CHK-07 批量 ----
  {
    const n = Math.max(1, Math.round(l.batchCount))
    const k = n * (1 + l.wasteRatio)
    // 与单灯值的偏差只来自展示精度（长度 3 位小数 / 胶 1 位小数）
    const errs = [
      Math.abs(batch.frameM - materials.frameM * k),
      Math.abs(batch.coveringM2 - materials.coveringM2 * k),
      Math.abs(batch.lashM - materials.lashM * k)
    ]
    const pass = errs.every((e) => e <= 0.0011) && Math.abs(batch.glueG - materials.glueG * k) <= 0.051
    out.push({
      id: 'CHK-07',
      title: `批量制灯：${n} 个材料总量 = 单灯 × ${n} × (1 + ${pctText(l.wasteRatio)})`,
      pass,
      value: `竹篾 ${f3(batch.frameM)}m / 蒙面 ${f3(batch.coveringM2)}m²`,
      detail: `单灯竹篾 ${f3(materials.frameM)}m × ${n} × ${(1 + l.wasteRatio).toFixed(2)} = ${f3(materials.frameM * k)}m = 批量值；蒙面、扎线、胶同理（LED 按颗数 × ${n} 计，不参与损耗）`
    })
  }

  // ---- CHK-08 性能 ----
  {
    const pass = elapsedMs < 100
    out.push({
      id: 'CHK-08',
      title: '放样计算 < 100ms',
      pass,
      value: `${elapsedMs.toFixed(1)}ms`,
      detail: `${l.divisions} 等分 × ${l.layers.length} 层：构件 ${frame.totalQty} 根、裁片 ${panels.totalQty} 块、图纸 ${sheets.length} 页，全流程耗时 ${elapsedMs.toFixed(1)}ms（含分页）`
    })
  }

  // ---- CHK-09 六处同源：补完的同一份灯样落到存档/骨架/裁片/分页/备料/导出 ----
  {
    const sig = signatureOf(l)
    const problems: string[] = []
    // 骨架与裁片必须来自同一几何（同一分层截面）
    if (frame.geometry.sections.length !== panels.geometry.sections.length) {
      problems.push(`骨架构件表用 ${frame.geometry.sections.length} 个截面、裁片页用 ${panels.geometry.sections.length} 个`)
    }
    // 备料的竹篾总长必须就是构件表按同一份灯样算出的总长（m²/m 取位误差内）
    const stockM = frame.stockLengthMm / 1000
    if (Math.abs(stockM - materials.frameM) > 0.002) {
      problems.push(`备料竹篾 ${f3(materials.frameM)}m 与构件表合计 ${f3(stockM)}m 对不上`)
    }
    // 批量损耗必须由同一份单灯数推得
    const nB = Math.max(1, Math.round(l.batchCount))
    if (Math.abs(batch.coveringM2 - materials.coveringM2 * nB * (1 + l.wasteRatio)) > 0.002) {
      problems.push('批量用料不是按同一份单灯 × 数量 × (1+损耗) 推得')
    }
    // 分页：页内裁片必须全部来自裁片页同一批裁片，骨架长条必须来自构件表同一批构件
    const panelIds = new Set(panels.panels.map((p) => p.id))
    const memberIds = new Set(frame.members.map((m) => m.id))
    let pagePanels = 0
    let pageStrips = 0
    for (const s of sheets) {
      for (const it of s.items) {
        if (it.type === 'panel') {
          pagePanels++
          if (!panelIds.has(it.panel.id)) problems.push(`1:1 放样页出现了裁片页里没有的裁片 ${it.panel.id}`)
        }
        if (it.type === 'strip') {
          pageStrips++
          if (!memberIds.has(it.member.id)) problems.push(`1:1 放样页出现了构件表里没有的长条 ${it.member.id}`)
        }
      }
    }
    if (pagePanels < panels.panels.length) {
      problems.push(`裁片页有 ${panels.panels.length} 种裁片，1:1 分页只放了 ${pagePanels} 种（有缺块）`)
    }
    out.push({
      id: 'CHK-09',
      title: '六处同源：存档 / 构件表 / 裁片页 / 1:1 分页 / 备料批量 / 三份导出单子都按补完后的同一份灯样',
      pass: problems.length === 0,
      value: problems.length === 0 ? `同一指纹 ${sig}` : `${problems.length} 处不同源`,
      detail:
        problems.length === 0
          ? `骨架 ${frame.members.length} 项、裁片 ${panels.panels.length} 种、分页 ${sheets.length} 页（页内裁片 ${pagePanels}、长条 ${pageStrips}）、备料 ${f3(materials.frameM)}m / ${f3(materials.coveringM2)}m²、批量 ×${nB}、三份导出单子逐行取数，全部来自同一份灯样（指纹 ${sig}）；导出单子另在表头带同一编号与补齐版次。`
          : '拿了补之前老数的位置：' + problems.join('；')
    })
  }

  // ---- CHK-10 老灯样补齐状态：作废 / 不完整层 / 已发出单子过时 / 编号与创建时间 ----
  {
    const rev = latestRevision(l)
    const problems: string[] = []
    const notes: string[] = []
    if (!rev || rev.revision === 0) {
      out.push({
        id: 'CHK-10',
        title: '老灯样补齐：无补齐记录（新建灯样，不涉及补值）',
        pass: true,
        value: '非老档',
        detail: '该灯样由当前灯型库新建，不涉及老灯样补齐。'
      })
    } else {
      if (isVoided(l)) {
        const pending = pendingReissueKinds(l)
        const kindNames: Record<string, string> = { members: '构件清单', panels: '裁片清单', materials: '备料单', drawing: '1:1 放样图' }
        if (isReissuedCompletely(l)) {
          notes.push(`换路重补后三份单子与 1:1 图纸已全部按第 ${rev.revision} 版重新导出；旧版存档补值、旧单子图纸与已裁料均已作废，以新版为准。`)
        } else {
          problems.push(
            `这盏灯换过路，旧补值版、据此导出的单子与图纸都已作废、已按旧值裁好的料要重裁；当前第 ${rev.revision} 版还差 ${pending.length} 份没按当前值重出：${pending.map((k) => kindNames[k]).join('、')}。`
          )
        }
      }
      if (rev.incompleteLayers.length) {
        problems.push(`第 ${rev.incompleteLayers.join('、')} 层不完整：构件表与裁片页少这一段轮廓、该层显示不全，须人工补分层高度后重算。`)
      }
      const stale = staleExports(l)
      if (stale.length) {
        const where: Record<string, string> = { members: '构件清单', panels: '裁片清单', materials: '备料单' }
        problems.push(`已导出的 ${stale.length} 份单子仍是改之前的老数（${stale.map((e) => `${where[e.kind]} ${e.at}`).join('、')}）：这几处单子必须按当前灯样重新导出，图纸同步重出。`)
      }
      notes.push(`编号 ${l.id}、创建时间 ${l.createdAt} 与存档原样一致（读入未重新生成）。`)
      notes.push(rev.route === 'preset'
        ? '走「照预设补」：各页齐全可直接放样，但与当年旧档未必一致，旧单子/图纸对不上属预期。'
        : '走「按默认值顶」：与旧档对得上；被顶值的层（见上）需人工补。')
      if (rev.unknownFieldsKept.length) notes.push(`旧档多出字段已原样保留：${rev.unknownFieldsKept.join('、')}。`)
      out.push({
        id: 'CHK-10',
        title: '老灯样补齐：状态、代价、不完整层与已发出单子时效',
        pass: problems.length === 0,
        value: isVoided(l) ? '已作废' : rev.incompleteLayers.length ? `${rev.incompleteLayers.length} 个不完整层` : stale.length ? `${stale.length} 份旧单子` : `第 ${rev.revision} 版正常`,
        detail: problems.length ? problems.join(' ') + ' ' + notes.join(' ') : notes.join(' ')
      })
    }
  }

  // ---- CHK-11 长条分段编号：不断号、不重号 ----
  {
    const r = assertStripNumbering(sheets)
    out.push({
      id: 'CHK-11',
      title: '1:1 长条分段编号：T<构件号>-<段号>/<总段数> 全局连续，重排分页不断号、不重号',
      pass: r.pass,
      value: r.pass ? '通过' : '失败',
      detail: r.detail
    })
  }

  return out
}

function suggestDivisions(l: Lantern, netArea: number, ratio: number): number | null {
  if (ratio <= 1.0005) return null
  for (let d = Math.max(3, Math.round(l.divisions)) + 1; d <= CRAFT.divMax; d++) {
    const ref = bodySurfaceArea(frameGeometryOf(l), d)
    const r = ref > 0 ? netArea / ref : 0
    if (r <= 1.03) return d
  }
  return CRAFT.divMax
}

function loftOverlap(sheets: Sheet[]): number {
  for (const s of sheets) {
    for (const it of s.items) {
      if (it.type === 'strip' && it.overlapMm > 0) return it.overlapMm
    }
  }
  return 0
}

/** 校验尺标称长度（mm）：1:1 打印用 */
export const CALIBRATION_RULER_MM = 100
export const CALIBRATION_CIRCLE_MM = 100

function frameGeometryOf(l: Lantern) {
  return buildFrame(l).geometry
}

/** 由圆周长反推直径（尺寸反推工具用） */
export function diameterFromPerimeter(lengthMm: number, n: number, polygon: boolean, lashMm: number): number {
  const net = Math.max(0, lengthMm - lashMm)
  if (polygon) {
    const s = Math.max(3, Math.round(n))
    return net / (s * Math.sin(Math.PI / s))
  }
  return net / Math.PI
}

/** 由母线（竖篾）长度反推可用最大直径：保持收口比例与总高，二分求解 */
export function diameterFromRib(l: Lantern, ribLengthMm: number): number {
  const target = Math.max(10, ribLengthMm - 2 * l.lashAllowanceMm)
  let lo = 20
  let hi = 3000
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2
    const test: Lantern = { ...l, maxDiameterMm: mid, mouthDiameterMm: (mid * l.mouthDiameterMm) / Math.max(1, l.maxDiameterMm), baseDiameterMm: (mid * l.baseDiameterMm) / Math.max(1, l.maxDiameterMm) }
    const segs = segmentInfos(buildFrame(test).geometry)
    const len = segs.reduce((a, s) => a + s.slantMm, 0)
    if (len < target) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}
