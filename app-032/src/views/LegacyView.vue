<script setup lang="ts">
/**
 * 老灯样批量补齐页：
 *  - 一批老灯样一次读完，给出每盏「补了哪几项、顶成什么、取自哪条预设/默认」的清单；
 *  - 两条路逐盏挑（能对上灯型库才可走 preset）；代价写明，认下后才确认；
 *  - 确认走存储事务：同一批重复确认不写成两版，写到一半出错整批退回读之前；
 *  - 灯样编号与创建时间原样，不重新生成；旧档多出字段原样保留。
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  confirmPending,
  discardPending,
  importLegacyJson,
  setPendingRoute,
  state,
  type PendingLegacy
} from '../core/store'
import { buildLegacyFill } from '../core/legacy'
import { LEGACY } from '../core/craft'
import { mmCmText, pctText } from '../core/units'

const router = useRouter()
const selectedKeys = ref<Set<string>>(new Set())
const lastReport = ref<ReturnType<typeof confirmPending> | null>(null)
const importMessage = ref('')
const fileInput = ref<HTMLInputElement | null>(null)
const pasteText = ref('')

const pendings = computed(() => state.pendingLegacy)
const allSelected = computed({
  get: () => pendings.value.length > 0 && pendings.value.every((p) => selectedKeys.value.has(p.key)),
  set: (v: boolean) => {
    const s = new Set(selectedKeys.value)
    for (const p of pendings.value) v ? s.add(p.key) : s.delete(p.key)
    selectedKeys.value = s
  }
})

function toggle(key: string) {
  const s = new Set(selectedKeys.value)
  s.has(key) ? s.delete(key) : s.add(key)
  selectedKeys.value = s
}

function chooseRoute(p: PendingLegacy, route: 'preset' | 'default') {
  if (route === 'preset' && !p.match) return
  setPendingRoute(p.key, route)
}

/** 预览某盏在当前所选的路下会补成什么样（不落存储） */
function preview(p: PendingLegacy) {
  try {
    return buildLegacyFill(p.raw, p.chosenRoute)
  } catch {
    return null
  }
}

function doConfirm() {
  const keys = [...selectedKeys.value].filter((k) => pendings.value.some((p) => p.key === k))
  if (keys.length === 0) {
    lastReport.value = { outcomes: [], itemSummary: [], rolledBack: false }
    window.alert('请先勾选要确认写回本机存储的老灯样。')
    return
  }
  const msg =
    `将把 ${keys.length} 盏老灯样按所选路径补齐并写入本机存储。\n\n` +
    `· 照预设补：各页齐全可直接放样，但跟当年旧档未必是同一盏，旧单子/图纸对不上；\n` +
    `· 按默认值顶：与旧档对得上，但被顶值的层可能少一段轮廓、显示不全，要人工补。\n\n` +
    `编号与创建时间保持原样；确认后改走另一条路，旧版存档、已导出的单子图纸与已裁的料都要作废重来。确认继续？`
  if (!window.confirm(msg)) return
  lastReport.value = confirmPending(keys)
  if (!lastReport.value.rolledBack) {
    for (const k of keys) selectedKeys.value.delete(k)
  }
}

function onFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  file.text().then((text) => {
    const r = importLegacyJson(text)
    importMessage.value = r.error || `导入完成：新增 ${r.added} 盏到待确认队列，重复跳过 ${r.skipped} 盏。`
    input.value = ''
  })
}

function onPasteImport() {
  if (!pasteText.value.trim()) return
  const r = importLegacyJson(pasteText.value)
  importMessage.value = r.error || `导入完成：新增 ${r.added} 盏到待确认队列，重复跳过 ${r.skipped} 盏。`
  pasteText.value = ''
}

function openAfter(id: string) {
  router.push(`/design/${id}`)
}

function valText(v: number | string): string {
  return typeof v === 'number' ? mmCmText(v) : v
}
</script>

<template>
  <div class="legacy-view">
    <section class="hero">
      <h1>老灯样读入补齐</h1>
      <p class="rule">{{ LEGACY.rule }}</p>
      <ul class="facts">
        <li>编号与创建时间保持原样，读入绝不重新生成；旧档多出的字段原样留下不丢。</li>
        <li>读出来再存回去两份要对得上：确认时先回读校验，失败整批退回读之前的样子。</li>
        <li>补完的值只落到一份灯样：存档、骨架件表、裁片页、1:1 分页、备料批量、三份导出单子全部按它重算。</li>
        <li>等分数缺省 {{ LEGACY.approximation.divisionsDefault }}；等分近似容差 ±{{ LEGACY.approximation.chordTolerancePct.toFixed(2) }}%；长度 0.1mm；m² 三位；百分数两位；mm→cm 整数取整。</li>
      </ul>
    </section>

    <section class="block">
      <h2>导入老灯样 JSON</h2>
      <p class="sub">支持「单盏对象」「灯样数组」或 <code>{ lanterns: [...] }</code> 包壳；导入只进待确认队列，确认前不写本机存档。</p>
      <div class="import-row">
        <input ref="fileInput" type="file" accept=".json,application/json" @change="onFile" />
        <button @click="fileInput?.click()">选择文件</button>
      </div>
      <details>
        <summary>或直接粘贴 JSON 文本</summary>
        <textarea v-model="pasteText" rows="6" placeholder='[{"id":"OLD-001","kind":"revolution",...}]'></textarea>
        <button @click="onPasteImport">加入待确认队列</button>
      </details>
      <p v-if="importMessage" class="import-msg">{{ importMessage }}</p>
    </section>

    <section class="block">
      <h2>待确认老灯样（{{ pendings.length }} 盏）<em>一批一次读完，确认了才写进本机存储</em></h2>
      <p v-if="pendings.length === 0" class="empty">
        没有待确认的老灯样。本机存档里的老档会在打开应用时自动出现在这里；也可以从上面导入。
      </p>
      <template v-else>
        <div class="batch-bar">
          <label><input type="checkbox" :checked="allSelected" @change="(e) => (allSelected = (e.target as HTMLInputElement).checked)" /> 全选</label>
          <span>已选 {{ selectedKeys.size }} / {{ pendings.length }}</span>
          <button class="primary" @click="doConfirm">按所选路径补齐并确认写回（{{ selectedKeys.size }} 盏）</button>
        </div>

        <article v-for="p in pendings" :key="p.key" class="pend" :class="{ chosen: selectedKeys.has(p.key) }">
          <header>
            <input type="checkbox" :checked="selectedKeys.has(p.key)" @change="() => toggle(p.key)" />
            <div class="id">
              <h3>{{ p.rawName || '（旧档无名）' }}</h3>
              <p class="mono">编号 {{ p.rawId || '（无编号：不可自动补齐）' }} · 创建 {{ p.rawCreatedAt || '（无创建时间：不可自动补齐）' }}</p>
              <p class="src">来源：{{ p.source === 'startup' ? '本机存档读出' : '手工导入' }}</p>
            </div>
            <div class="routes">
              <button
                class="route preset"
                :class="{ on: p.chosenRoute === 'preset' }"
                :disabled="!p.match"
                :title="p.match ? '' : LEGACY.matchRule"
                @click="chooseRoute(p, 'preset')"
              >
                ① 照灯型库预设补
                <small v-if="p.match">对得上「{{ p.match.presetName }}」</small>
                <small v-else>对不上，不可走</small>
              </button>
              <button class="route dft" :class="{ on: p.chosenRoute === 'default' }" @click="chooseRoute(p, 'default')">
                ② 按写明的默认值顶
                <small>与旧档一致 · 可能要人工补</small>
              </button>
            </div>
          </header>

          <div v-if="p.parseErrors.length" class="errors">
            体检问题：{{ p.parseErrors.join('；') }} —— 走②也无法保证轮廓正确，必须人工处理。
          </div>

          <div v-if="p.unknownFields.length" class="kept">
            旧档多出字段（原样保留，不丢）：<code v-for="k in p.unknownFields" :key="k">{{ k }} </code>
          </div>

          <details open>
            <summary>这次补哪几项（{{ preview(p)?.items.length || 0 }} 项）· {{ preview(p)?.complete ? '补完各页齐全' : '存在不完整层 / 需人工补' }}</summary>
            <table v-if="preview(p)" class="items">
              <thead>
                <tr><th>缺项</th><th>补成</th><th>取值来源</th><th>人工</th></tr>
              </thead>
              <tbody>
                <tr v-for="(it, i) in preview(p)!.items" :key="i" :class="{ manual: it.manual }">
                  <td>{{ it.label }} <code>{{ it.path }}</code></td>
                  <td class="mono">{{ valText(it.value) }}</td>
                  <td class="src">{{ it.source }}</td>
                  <td>{{ it.manual ? '需人工复核' : '' }}</td>
                </tr>
              </tbody>
            </table>
            <ul class="warnings">
              <li v-for="(w, i) in preview(p)?.warnings || []" :key="i">{{ w }}</li>
            </ul>
          </details>

          <footer>
            <button class="danger" @click="discardPending(p.key)">丢弃（不写存档）</button>
          </footer>
        </article>
      </template>
    </section>

    <section v-if="lastReport" class="block report">
      <h2>确认结果</h2>
      <p v-if="lastReport.rolledBack" class="error">
        写到一半出错，已整批退回读之前的样子，没有一盏写入本机存储：{{ lastReport.error }}
      </p>
      <template v-else>
        <p class="ok">已写回 {{ lastReport.outcomes.length }} 盏（新建 {{ lastReport.outcomes.filter((o) => o.outcome === 'new').length }} ·
          换路升版 {{ lastReport.outcomes.filter((o) => o.outcome === 'superseded').length }} ·
          同一版重复确认 {{ lastReport.outcomes.filter((o) => o.outcome === 'identical').length }}，未产生第二版）。</p>
        <table>
          <thead><tr><th>名称</th><th>编号</th><th>结果</th><th>版次</th><th>补项数</th><th></th></tr></thead>
          <tbody>
            <tr v-for="o in lastReport.outcomes" :key="o.key">
              <td>{{ o.name }}</td>
              <td class="mono">{{ o.id }}</td>
              <td>{{ o.outcome === 'new' ? '首次确认' : o.outcome === 'identical' ? '同一版（不重复写）' : '旧版作废，升新版' }}</td>
              <td class="mono">第 {{ o.revision }} 版</td>
              <td>{{ o.fill.items.length }}</td>
              <td><button @click="openAfter(o.id)">打开放样</button></td>
            </tr>
          </tbody>
        </table>
        <h3>本批补了什么（汇总）</h3>
        <ul class="summary">
          <li v-for="s in lastReport.itemSummary" :key="s.path"><code>{{ s.path }}</code> × {{ s.count }} 盏</li>
        </ul>
        <p class="tip">比例示例：损耗 {{ pctText(0.12) }}；长度 mm 一位、面积 m² 三位、比例两位、mm→cm 整数。</p>
      </template>
    </section>
  </div>
</template>

<style scoped>
.legacy-view {
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.hero {
  background: linear-gradient(135deg, #fff8ea, #f7e9d2);
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  padding: 18px 22px;
}
.hero h1 {
  margin: 0 0 8px;
  color: #8f1c19;
  font-size: 20px;
}
.rule {
  margin: 0 0 10px;
  color: var(--ink-soft);
  font-size: 13px;
}
.facts {
  margin: 0;
  padding-left: 18px;
  font-size: 12.5px;
  color: var(--ink);
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.block {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 14px 16px;
  box-shadow: var(--shadow);
}
.block h2 {
  font-size: 16px;
  margin: 0 0 10px;
  border-left: 4px solid var(--red);
  padding-left: 10px;
}
.block h2 em {
  font-style: normal;
  font-size: 12px;
  color: var(--ink-soft);
  font-weight: 400;
  margin-left: 8px;
}
.sub {
  font-size: 12.5px;
  color: var(--ink-soft);
}
code {
  font-family: var(--mono);
  font-size: 11px;
  background: rgba(0, 0, 0, 0.05);
  padding: 0 4px;
  border-radius: 4px;
}
.import-row {
  display: flex;
  gap: 10px;
  align-items: center;
  margin: 8px 0;
}
textarea {
  width: 100%;
  font-family: var(--mono);
  font-size: 12px;
  margin: 8px 0;
}
.import-msg {
  color: var(--jade);
  font-size: 12.5px;
}
.batch-bar {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 8px 12px;
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: 8px;
  margin-bottom: 12px;
}
button {
  font: inherit;
  cursor: pointer;
  border-radius: 6px;
  border: 1px solid var(--line-strong);
  background: var(--surface-2);
  padding: 5px 12px;
  font-size: 12.5px;
}
button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
button.primary {
  background: var(--red);
  border-color: var(--red);
  color: #fff;
  font-weight: 600;
}
button.danger {
  color: var(--red);
}
.pend {
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 12px 14px;
  margin-bottom: 12px;
  background: #fffef9;
}
.pend.chosen {
  border-color: var(--red);
  box-shadow: 0 0 0 2px rgba(179, 36, 31, 0.12);
}
.pend header {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.id {
  flex: 1;
}
.id h3 {
  margin: 0;
  font-size: 15px;
}
.id p {
  margin: 2px 0;
  font-size: 11.5px;
  color: var(--ink-soft);
}
.mono {
  font-family: var(--mono);
}
.routes {
  display: flex;
  gap: 8px;
}
.route {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  min-width: 180px;
  text-align: left;
}
.route.preset.on {
  border-color: var(--blue);
  background: #eaf1f8;
  color: var(--blue);
}
.route.dft.on {
  border-color: #b8891f;
  background: #fdf6e7;
  color: #8a5a10;
}
.route small {
  font-size: 10.5px;
  color: var(--ink-soft);
}
.errors {
  margin-top: 8px;
  padding: 6px 10px;
  background: #fdecea;
  border: 1px solid #e8a39c;
  border-radius: 6px;
  color: var(--red);
  font-size: 12px;
}
.kept {
  margin-top: 8px;
  font-size: 12px;
  color: var(--ink-soft);
}
.items {
  width: 100%;
  border-collapse: collapse;
  margin-top: 8px;
  font-size: 12px;
}
.items th,
.items td {
  border: 1px solid var(--line);
  padding: 4px 8px;
  text-align: left;
}
.items tr.manual {
  background: #fdf6e7;
}
.src {
  color: var(--ink-soft);
}
.warnings {
  margin: 8px 0 0;
  padding-left: 18px;
  font-size: 12px;
  color: #8a5a10;
}
.pend footer {
  margin-top: 10px;
  text-align: right;
}
.report .ok {
  color: var(--jade);
}
.report .error {
  color: var(--red);
  font-weight: 600;
}
.report table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
  margin: 8px 0;
}
.report th,
.report td {
  border: 1px solid var(--line);
  padding: 5px 8px;
  text-align: left;
}
.summary {
  columns: 2;
  font-size: 12px;
}
.tip {
  font-size: 11.5px;
  color: var(--ink-soft);
}
.empty {
  color: var(--ink-soft);
}
</style>
