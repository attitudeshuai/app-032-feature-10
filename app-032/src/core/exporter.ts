/** 导出：构件清单 / 裁片清单 / 备料单（CSV，本地生成，无外部请求） */
import type { FrameMember, Lantern, Panel, ExportKind } from './types'
import type { BatchMaterials, SingleLightMaterials } from './materials'
import { coveringSpec } from './craft'
import { hasVoidedHistory, latestRevision, recordExport, staleExports } from './legacy'
import { pctText } from './units'

function csvCell(v: string | number): string {
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(rows: (string | number)[][]): string {
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n')
}

export function downloadText(filename: string, content: string, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 单子公共头部：灯样编号/创建时间原样、补齐版次与来源、过时提示；并登记导出台账 */
function exportHeader(l: Lantern, docTitle: string, kind: ExportKind): string[] {
  const rev = latestRevision(l)
  const voidedBefore = hasVoidedHistory(l)
  const lines = [
    `${docTitle} · ${l.name}`,
    `灯样编号 ${l.id} / 创建时间 ${l.createdAt}（编号与创建时间按存档原样，不重新生成）`
  ]
  if (rev && rev.revision > 0) {
    lines.push(
      `老灯样补齐 第 ${rev.revision} 版 · 路径：${
        rev.route === 'preset'
          ? `照灯型库预设补（${rev.presetId || '预设'}，各页齐全，与旧档未必一致）`
          : '按默认值目录顶值（与旧档对得上，被顶值层可能需人工补）'
      } · 确认于 ${rev.confirmedAt}${voidedBefore ? ' · 本版为换路重补版，此前版次的存档补值与已发单子图纸均已作废、已裁料要重裁' : ''}`
    )
    lines.push(`本单每一行均按补完后的同一份灯样计算；补值明细共 ${rev.items.length} 项，见本机存档审计。`)
    if (rev.incompleteLayers.length) {
      lines.push(`注意：第 ${rev.incompleteLayers.join('、')} 层为不完整层，本单不含这一段，需人工补后重新放样。`)
    }
  }
  recordExport(l, kind)
  const stale = staleExports(l).filter((e) => e.kind === kind)
  if (stale.length) {
    lines.push(`警告：此前于 ${stale.map((e) => e.at).join('、')} 导出的同名单子已因灯样改动而过时，请以本单为准。`)
  }
  return lines
}

export function membersCsv(l: Lantern, members: FrameMember[]): string {
  const header = exportHeader(l, '花灯构件清单', 'members')
  const rows: (string | number)[][] = [
    [header[0]],
    [header[1]],
    ...header.slice(2).map((x) => [x]),
    [`最大直径 ${l.maxDiameterMm}mm / 总高 ${l.totalHeightMm}mm / 绑扎余量 每端 ${l.lashAllowanceMm}mm / 生成 ${new Date().toLocaleString()}`],
    [],
    ['构件名称', '类别', '分组', '净长(mm)', '截取长度(mm,含余量)', '余量处数', '数量', '总截取长度(mm)', '弯曲半径(mm)', '折角(°)', '备注']
  ]
  for (const m of members) {
    rows.push([
      m.label,
      kindName(m.kind),
      m.group,
      m.rawLengthMm.toFixed(1),
      m.lengthMm.toFixed(1),
      m.lashJoints,
      m.qty,
      (m.lengthMm * m.qty).toFixed(1),
      m.bendRadiusMm ? m.bendRadiusMm.toFixed(1) : '—',
      m.bendAngleDeg ? m.bendAngleDeg.toFixed(1) : '—',
      m.note || ''
    ])
  }
  const stock = members.reduce((s, m) => s + m.lengthMm * m.qty, 0)
  const raw = members.reduce((s, m) => s + m.rawLengthMm * m.qty, 0)
  rows.push([])
  rows.push(['合计', '', '', raw.toFixed(1), '', '', members.reduce((s, m) => s + m.qty, 0), stock.toFixed(1), '', '', `备料 ${(stock / 1000).toFixed(3)}m`])
  return toCsv(rows)
}

export function panelsCsv(l: Lantern, panels: Panel[]): string {
  const header = exportHeader(l, '蒙面裁片清单', 'panels')
  const rows: (string | number)[][] = [
    [header[0]],
    [header[1]],
    ...header.slice(2).map((x) => [x]),
    [`蒙面 ${coveringSpec(l.covering).name} / 缝份 每边 ${l.seamAllowanceMm}mm（已含在裁片尺寸内）/ 生成 ${new Date().toLocaleString()}`],
    [],
    ['裁片编号', '名称', '形状', '对应层', '净上宽(mm)', '净下宽(mm)', '净高(mm)', '裁切上宽(mm)', '裁切下宽(mm)', '裁切高(mm)', '半径/对边(mm)', '数量', '配色', '对位标记数']
  ]
  for (const p of panels) {
    rows.push([
      p.id,
      p.label,
      shapeName(p.shape),
      p.layerIndex >= 0 ? `第 ${p.layerIndex + 1} 层` : '顶/底盖',
      p.rawWidthTopMm.toFixed(1),
      p.rawWidthBottomMm.toFixed(1),
      p.rawHeightMm.toFixed(1),
      p.widthTopMm.toFixed(1),
      p.widthBottomMm.toFixed(1),
      p.heightMm.toFixed(1),
      p.radiusMm ? p.radiusMm.toFixed(1) : '—',
      p.qty,
      p.color,
      p.marksMm.length
    ])
  }
  return toCsv(rows)
}

export function materialsCsv(
  l: Lantern,
  single: SingleLightMaterials,
  batch: BatchMaterials
): string {
  const cov = coveringSpec(l.covering)
  const header = exportHeader(l, '备料单', 'materials')
  const rows: (string | number)[][] = [
    [header[0]],
    [header[1]],
    ...header.slice(2).map((x) => [x]),
    [`生成 ${new Date().toLocaleString()} / 单位 mm·m²·m·g（比例按百分数保留 2 位小数）`],
    [],
    ['项目', '单灯用量', '单位', `批量 ${batch.count} 个（含损耗 ${pctText(batch.wasteRatio)}）`],
    ['竹篾/铁丝（含绑扎余量）', single.frameM.toFixed(3), 'm', batch.frameM.toFixed(3)],
    ['竹篾构件净长', single.frameRawM.toFixed(3), 'm', batch.frameRawM.toFixed(3)],
    [`蒙面（${cov.name}，含缝份）`, single.coveringM2.toFixed(3), 'm²', batch.coveringM2.toFixed(3)],
    ['蒙面净面积（不含缝份）', single.coveringNetM2.toFixed(3), 'm²', batch.coveringNetM2.toFixed(3)],
    ['扎线', single.lashM.toFixed(3), 'm', batch.lashM.toFixed(3)],
    ['胶', single.glueG.toFixed(1), 'g', batch.glueG.toFixed(1)],
    ['LED 灯珠建议', single.ledCount, '颗', batch.ledCount],
    [],
    ['灯体体积', single.volumeL.toFixed(3), 'L', batch.volumeL.toFixed(3)],
    ['灯体表面积', single.surfaceM2.toFixed(3), 'm²', batch.surfaceM2.toFixed(3)]
  ]
  return toCsv(rows)
}

export function kindName(k: FrameMember['kind']): string {
  const map: Record<FrameMember['kind'], string> = {
    vertical: '竖篾',
    ring: '横篾',
    mouth_ring: '收口圈',
    base_ring: '底盘圈',
    rib: '母线篾',
    spoke: '辐条/中轴'
  }
  return map[k]
}

export function shapeName(s: Panel['shape']): string {
  const map: Record<Panel['shape'], string> = {
    trapezoid: '梯形',
    rectangle: '矩形',
    sector: '扇形',
    circle: '圆形/正多边形',
    triangle: '三角形'
  }
  return map[s]
}
