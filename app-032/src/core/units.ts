/**
 * 单位换算与取位（全项目唯一出口）
 * 规则（写明，来自灯型库 legacy.approximation 节）：
 *  - 长度全 mm，r1 保留 1 位小数；
 *  - 毫米 → 厘米：cm = round(mm / 10)，整数取整（Math.round 四舍五入，不保留小数）；
 *  - 面积折成平方米：r3 保留 3 位小数；
 *  - 比例按百分数：保留 2 位小数（pctText 给字符串；pctRound 给数值）。
 */

/** mm 保留 1 位小数 */
export function r1mm(v: number): number {
  return Math.round(v * 10) / 10
}

/** mm → cm，整数取整（四舍五入到整厘米，不保留小数） */
export function mmToCmInt(mm: number): number {
  return Math.round(mm / 10)
}

/** 「123mm（12cm）」式展示：cm 恒为整数 */
export function mmCmText(mm: number): string {
  return `${r1mm(mm).toFixed(1)}mm（${mmToCmInt(mm)}cm）`
}

/** mm² → m²，保留 3 位小数 */
export function mm2ToM2(mm2: number): number {
  return Math.round((mm2 / 1_000_000) * 1000) / 1000
}

/** 比例（0.1234）→ 百分数数值，保留 2 位小数（12.34） */
export function pctRound(ratio: number): number {
  return Math.round(ratio * 10000) / 100
}

/** 比例 → 百分数文本，固定 2 位小数（"12.34%"） */
export function pctText(ratio: number): string {
  return pctRound(ratio).toFixed(2) + '%'
}
