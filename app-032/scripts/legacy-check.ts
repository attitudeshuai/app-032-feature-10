/**
 * 老灯样补齐规则的可执行验收（node 运行，esbuild 打包核心模块，无需浏览器）
 * 覆盖：默认值目录逐项补齐、两路取舍、不完整层、多余字段不丢、编号/创建时间不动、
 *      读出再存回对得上、六处同源、分页长条不断号不重号、幂等/换路作废/旧单子过时、
 *      批量事务与回滚、单位取位（mm→cm 整数 / m² 三位 / 百分数两位）。
 */
import assert from 'node:assert'
import { buildLegacyFill, attachConfirmedFill, signatureOf, recordExport, staleExports, isVoided, exportBlockedReason, diagnoseLegacy, matchPreset } from '../src/core/legacy'
import { buildFrame } from '../src/core/frame'
import { buildPanels } from '../src/core/panels'
import { computeMaterials, computeBatch } from '../src/core/materials'
import { computeAll } from '../src/core/checks'
import { DEFAULT_LOFT_OPTIONS, paginate, assertStripNumbering } from '../src/core/paginate'
import { membersCsv, panelsCsv, materialsCsv } from '../src/core/exporter'
import { mmToCmInt, pctText, mm2ToM2 } from '../src/core/units'
import { state, importLegacyJson, confirmPending, loadStore } from '../src/core/store'
import type { Lantern } from '../src/core/types'

let passed = 0
function test(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

// 一个典型老档：无底口直径、无逐层配色、分层里无直径、无 divisions（且带旧档多出字段）
function oldRoundLantern(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'OLD-ROUND-01',
    kind: 'revolution',
    name: '甲辰年旧圆灯',
    maxDiameterMm: 300,
    totalHeightMm: 300,
    mouthDiameterMm: 90,
    sides: 8,
    layers: [{ heightMm: 100 }, { heightMm: 100 }, { heightMm: 100 }],
    mouthStyle: 'taper',
    bottomStyle: 'taper',
    smoothness: 0.5,
    covering: 'xuan',
    color: '#d94a2a',
    createdAt: '2019-05-01T08:00:00.000Z',
    updatedAt: '2019-05-02T08:00:00.000Z',
    shopNote: '老师傅手写备注：收口要紧一点', // 旧档多出字段
    ...over
  }
}

console.log('单位与取位')
test('mm→cm 整数取整（四舍五入，不留小数）', () => {
  assert.equal(mmToCmInt(134), 13)
  assert.equal(mmToCmInt(135), 14)
  assert.equal(pctText(0.12346), '12.35%')
  assert.equal(pctText(0.12), '12.00%')
  assert.equal(mm2ToM2(1_234_567), 1.235)
})

console.log('体检与「对得上灯型库」')
test('旧档体检出三个典型缺项 + divisions，且能对得上圆形灯笼预设', () => {
  const raw = oldRoundLantern()
  const d = diagnoseLegacy(raw)
  for (const k of ['baseDiameterMm', 'layerColors', 'divisions']) assert.ok(d.missing.includes(k), k)
  assert.ok(d.missing.some((m) => m.startsWith('layers[0].diameterMm')))
  assert.deepEqual(d.unknownFields, ['shopNote'])
  const m = matchPreset(raw)
  assert.ok(m)
  assert.equal(m!.preset.id, 'round-lantern')
})

let presetFill = buildLegacyFill(oldRoundLantern(), 'preset')
let defaultFill = buildLegacyFill(oldRoundLantern(), 'default')

console.log('两条补齐路')
test('① 照预设补：底口/逐层配色/等分数取预设，补完完整、可直接放样', () => {
  const l = presetFill.lantern
  assert.equal(l.baseDiameterMm, 90)
  assert.deepEqual(l.layerColors, ['#d94a2a', '#e0703a', '#d94a2a'])
  assert.equal(l.divisions, 24)
  assert.equal(presetFill.complete, true)
  assert.equal(presetFill.incompleteLayers.length, 0)
  assert.ok(presetFill.items.some((i) => i.path === 'baseDiameterMm'))
  assert.ok(presetFill.warnings.join('').includes('跟当年存下的那一盏未必是一回事'))
})

test('② 按默认值顶：底口顶上口、配色全回落主色，并逐项写明来源', () => {
  const l = defaultFill.lantern
  assert.equal(l.baseDiameterMm, 90) // 早期底口与收口同径
  assert.deepEqual(l.layerColors, ['#d94a2a', '#d94a2a', '#d94a2a'])
  assert.equal(l.divisions, 24)
  assert.equal(defaultFill.complete, false)
  const paths = defaultFill.items.map((i) => i.path)
  assert.ok(paths.includes('baseDiameterMm'))
  assert.ok(paths.includes('layerColors[1]'))
  assert.ok(paths.some((p) => p.startsWith('layers[2].diameterMm')))
  for (const it of defaultFill.items) assert.ok(it.source.length > 0, `${it.path} 必须写清来源`)
  assert.ok(defaultFill.warnings.join('').includes('与旧档对得上'))
})

test('对不上预设时强走 preset 会被拒绝', () => {
  assert.throws(() => buildLegacyFill(oldRoundLantern({ maxDiameterMm: 301 }), 'preset'))
})

console.log('不变量：编号/创建时间/多余字段/读出再存回')
test('id 与 createdAt 原样保留，updatedAt 不重生成', () => {
  for (const f of [presetFill, defaultFill]) {
    assert.equal(f.lantern.id, 'OLD-ROUND-01')
    assert.equal(f.lantern.createdAt, '2019-05-01T08:00:00.000Z')
    assert.equal(f.lantern.updatedAt, '2019-05-02T08:00:00.000Z')
  }
})
test('旧档多出字段原样留下（shopNote 不丢），并登记键名', () => {
  assert.equal((defaultFill.lantern as unknown as Record<string, unknown>).shopNote, '老师傅手写备注：收口要紧一点')
  assert.deepEqual(defaultFill.unknownFieldsKept, ['shopNote'])
})
test('读出来再存回去（JSON 往返）内容签名一致', () => {
  const a = defaultFill.lantern
  const b = JSON.parse(JSON.stringify(a)) as Lantern
  assert.equal(signatureOf(a), signatureOf(b))
})

console.log('六处同源：骨架/裁片/分页/备料/导出都按补完后的同一份灯样')
test('同一盏 default 补完灯样：各页齐全且数字互相咬合', () => {
  const l = defaultFill.lantern
  const frame = buildFrame(l)
  const panels = buildPanels(l)
  const mat = computeMaterials(l)
  const batch = computeBatch(mat, 20, l.wasteRatio)
  const sheets = paginate(l, { ...DEFAULT_LOFT_OPTIONS, paper: l.pageSize, overlapMm: l.overlapMm })

  // 每层都有侧面展开片 + 顶/底盖
  assert.equal(panels.panels.filter((p) => p.layerIndex >= 0).length, 3)
  // 分页里每块裁片都出现，且每页取色用的就是补完的逐层配色
  const onPages = sheets.flatMap((s) => s.items).filter((i) => i.type === 'panel').length
  assert.equal(onPages, panels.panels.length)
  // 备料竹篾 = 构件表合计
  assert.ok(Math.abs(frame.stockLengthMm / 1000 - mat.frameM) < 0.002)
  // 批量 = 单灯 × 20 × (1+损耗)
  assert.ok(Math.abs(batch.frameM - mat.frameM * 20 * 1.12) < 0.002)
  // 三份导出单子逐行可出，且表头带同一编号与补齐版次
  const mcsv = membersCsv({ ...l } as Lantern, frame.members)
  const pcsv = panelsCsv({ ...l } as Lantern, panels.panels)
  // materialsCsv 会登记一次导出台账（用副本避免污染 l）
  const matcsv = materialsCsv({ ...l } as Lantern, mat, batch)
  for (const txt of [mcsv, pcsv, matcsv]) {
    assert.ok(txt.includes('OLD-ROUND-01'))
    assert.ok(txt.includes('2019-05-01T08:00:00.000Z'))
  }
  assert.ok(matcsv.includes('12.00%'))
  // CHK-09/11 在计算总览里通过
  const all = computeAll(l, { ...DEFAULT_LOFT_OPTIONS, paper: l.pageSize, overlapMm: l.overlapMm })
  assert.ok(all.checks.find((c) => c.id === 'CHK-09')!.pass)
  assert.ok(all.checks.find((c) => c.id === 'CHK-11')!.pass)
})

test('长条分段编号 T<构件号>-<段号>/<总数> 全局唯一、连续（不断号/不重号）', () => {
  const l = buildLegacyFill(oldRoundLantern(), 'default').lantern
  const sheets = paginate(l, { ...DEFAULT_LOFT_OPTIONS, paper: 'A4', overlapMm: 10 })
  const r = assertStripNumbering(sheets)
  assert.ok(r.pass, r.detail)
})

console.log('default 路的代价：缺分层高度 → 少一段轮廓、显示不全，需人工补')
test('第 2 层连高度都缺：不完整层在构件表/裁片页/分页里都少这一段，并被点名', () => {
  const raw = oldRoundLantern({ maxDiameterMm: 303, layers: [{ heightMm: 100 }, { /* 缺高度 */ }, { heightMm: 100 }] })
  const f = buildLegacyFill(raw, 'default')
  assert.deepEqual(f.incompleteLayers, [2])
  const l = attachConfirmedFill(f, undefined).lantern
  const frame = buildFrame(l)
  assert.deepEqual(frame.geometry.activeLayers, [0, 2])
  const panels = buildPanels(l)
  assert.deepEqual(panels.panels.filter((p) => p.layerIndex >= 0).map((p) => p.layerIndex), [0, 2])
  const all = computeAll(l, { ...DEFAULT_LOFT_OPTIONS, paper: 'A4', overlapMm: 10 })
  const chk10 = all.checks.find((c) => c.id === 'CHK-10')!
  assert.ok(!chk10.pass)
  assert.ok(chk10.detail.includes('第 2 层不完整'))
  // 对得上的原始档走 preset（均摊补高度）就齐全
  const rawMatched = oldRoundLantern({ layers: [{ heightMm: 100 }, { /* 缺高度 */ }, { heightMm: 100 }] })
  assert.ok(matchPreset(rawMatched))
  const fp = buildLegacyFill(rawMatched, 'preset')
  assert.equal(fp.complete, true)
  assert.deepEqual(fp.lantern.layers.map((x) => x.heightMm), [100, 100, 100])
})

console.log('版本/作废/旧单子时效')
test('同版重复确认不产生第二版；换路作废旧版，已导出单子被点名且禁止再导出', () => {
  const f1 = buildLegacyFill(oldRoundLantern(), 'default')
  const r1 = attachConfirmedFill(f1, undefined, '2026-10-01T00:00:00.000Z')
  assert.equal(r1.outcome, 'new')
  assert.equal(r1.revision.revision, 1)
  // 再确认一次同一路同一内容
  const f2 = buildLegacyFill(oldRoundLantern(), 'default')
  const r2 = attachConfirmedFill(f2, r1.lantern, '2026-10-01T00:01:00.000Z')
  assert.equal(r2.outcome, 'identical')
  assert.equal(r2.lantern.legacy!.revisions.length, 1)
  // 据第 1 版导出一份构件单
  recordExport(r2.lantern, 'members', '2026-10-02T00:00:00.000Z')
  // 改一处 → 旧单子过时
  r2.lantern.maxDiameterMm = 305
  assert.equal(staleExports(r2.lantern).length, 1)
  // 换走 preset 路 → 旧版作废、编号连续升到第 2 版
  r2.lantern.maxDiameterMm = 300
  const f3 = buildLegacyFill(oldRoundLantern(), 'preset')
  const r3 = attachConfirmedFill(f3, r2.lantern, '2026-10-03T00:00:00.000Z')
  assert.equal(r3.outcome, 'superseded')
  assert.equal(r3.revision.revision, 2)
  assert.ok(isVoided(r3.lantern))
  // 新版尚未重新导出：导出前必须先显式确认（旧单子图纸作废、料重裁）
  const warn = exportBlockedReason(r3.lantern)
  assert.ok(warn && warn.includes('作废重来'))
  // 确认后按新版把三份单子 + 图纸全部重出：表头声明旧版作废，重出齐全后不再拦截
  const csv = membersCsv(r3.lantern, buildFrame(r3.lantern).members)
  assert.ok(csv.includes('换路重补版'))
  panelsCsv(r3.lantern, buildPanels(r3.lantern).panels)
  const mat = computeMaterials(r3.lantern)
  materialsCsv(r3.lantern, mat, computeBatch(mat, r3.lantern.batchCount, r3.lantern.wasteRatio))
  recordExport(r3.lantern, 'drawing', '2026-10-04T00:00:00.000Z')
  assert.equal(exportBlockedReason(r3.lantern), null)
  const allNew = computeAll(r3.lantern, { ...DEFAULT_LOFT_OPTIONS, paper: 'A4', overlapMm: 10 })
  assert.ok(allNew.checks.find((c) => c.id === 'CHK-10')!.pass)
  assert.ok(r3.lantern.legacy!.revisions[0].voidReason!.includes('重裁'))
})

// ---------------------------------------------------------------------------
// 存储事务（需 localStorage / window 占位）
// ---------------------------------------------------------------------------
console.log('批量读入、确认事务、幂等与回滚')

function installShims() {
  const map = new Map<string, string>()
  ;(globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0
  } as Storage
  ;(globalThis as unknown as { window: { setTimeout: typeof setTimeout } }).window = { setTimeout: (() => 0) as unknown as typeof setTimeout }
  return map
}

installShims()

test('一批老灯样读进待确认队列（不自动补、不写盘），确认后才写入且字段齐全', () => {
  const text = JSON.stringify([
    oldRoundLantern(),
    oldRoundLantern({ id: 'OLD-ROUND-02', name: '第二盏旧灯', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' })
  ])
  const imp = importLegacyJson(text)
  assert.equal(imp.added, 2)
  assert.equal(state.lanterns.length, 0)
  assert.equal(state.pendingLegacy.length, 2)
  const rep = confirmPending(state.pendingLegacy.map((p) => p.key))
  assert.equal(rep.rolledBack, false)
  assert.equal(state.lanterns.length, 2)
  assert.equal(state.pendingLegacy.length, 0)
  // 落盘内容：多余字段不丢、编号/创建时间不动
  const saved = JSON.parse(localStorage.getItem('lantern-frame-lofting.v1')!)
  const l1 = saved.lanterns.find((x: Lantern) => x.id === 'OLD-ROUND-01')
  assert.equal(l1.shopNote, '老师傅手写备注：收口要紧一点')
  assert.equal(l1.createdAt, '2019-05-01T08:00:00.000Z')
  assert.equal(l1.baseDiameterMm, 90)
  assert.ok(l1.legacy.revisions.length >= 1)
  // 本批补了什么的清单
  assert.ok(rep.itemSummary.some((s) => s.path === 'baseDiameterMm' && s.count === 2))
})

test('同一批重复确认同一版不写成两版', () => {
  importLegacyJson(JSON.stringify([oldRoundLantern()]))
  assert.equal(state.pendingLegacy.length, 1)
  const rep = confirmPending(state.pendingLegacy.map((p) => p.key))
  assert.equal(rep.outcomes[0].outcome, 'identical')
  const l = state.lanterns.find((x) => x.id === 'OLD-ROUND-01')!
  assert.equal(l.legacy!.revisions.filter((r) => !r.voidedAt).length, 1)
})

test('写到一半出错整批退回：坏灯样（无 id）连累整批，一盏都不写入', () => {
  const before = state.lanterns.length
  const storageBefore = localStorage.getItem('lantern-frame-lofting.v1')
  importLegacyJson(JSON.stringify([oldRoundLantern({ id: 'OLD-OK-9', name: '本来要成功的' }), { kind: 'revolution' /* 无 id：不可自动补 */ }]))
  assert.equal(state.pendingLegacy.length, 2)
  const rep = confirmPending(state.pendingLegacy.map((p) => p.key))
  assert.equal(rep.rolledBack, true)
  assert.ok(rep.error!.includes('编号'))
  assert.equal(state.lanterns.length, before)
  assert.equal(localStorage.getItem('lantern-frame-lofting.v1'), storageBefore)
  // 待确认队列原样保留，可改选/丢弃后重试
  assert.equal(state.pendingLegacy.length, 2)
})

test('启动时把本机 v1 老档自动放进待确认队列，不静默改写', () => {
  localStorage.clear()
  state.lanterns.splice(0, state.lanterns.length)
  state.pendingLegacy.splice(0, state.pendingLegacy.length)
  localStorage.setItem(
    'lantern-frame-lofting.v1',
    JSON.stringify({ version: 1, lanterns: [oldRoundLantern(), { ...oldRoundLantern(), id: 'NEW-1', baseDiameterMm: 90, layerColors: ['#fff', '#eee', '#ddd'], layers: [{ heightMm: 100, diameterMm: 200 }, { heightMm: 100, diameterMm: 280 }, { heightMm: 100, diameterMm: 90 }], divisions: 24 }] })
  )
  loadStore()
  assert.equal(state.pendingLegacy.length, 1)
  assert.equal(state.lanterns.length, 1)
  assert.equal(state.lanterns[0].id, 'NEW-1')
})

console.log(`\n全部通过：${passed} 项`)
