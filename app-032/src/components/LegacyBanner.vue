<script setup lang="ts">
/**
 * 老灯样补齐状态横幅：
 *  - preset/default 两条路、第几版、不完整层、已作废、旧单子过时；
 *  - 已作废灯样禁止再导出（导出函数自身也会拦截，这里给明确说明：存档/单子/图纸/已裁料如何处理）；
 *  - 编号与创建时间原样展示。
 */
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { isVoided, isReissuedCompletely, latestRevision, pendingReissueKinds, staleExports } from '../core/legacy'
import { mmCmText } from '../core/units'
import type { Lantern } from '../core/types'

const props = defineProps<{ lantern: Lantern; compact?: boolean }>()
const router = useRouter()

const rev = computed(() => latestRevision(props.lantern))
const voided = computed(() => isVoided(props.lantern))
const reissued = computed(() => isReissuedCompletely(props.lantern))
const pendingKinds = computed(() => pendingReissueKinds(props.lantern))
const stale = computed(() => staleExports(props.lantern))
const incomplete = computed(() => rev.value?.incompleteLayers ?? [])

const kindName: Record<string, string> = {
  members: '构件清单', panels: '裁片清单', materials: '备料单', drawing: '1:1 放样图'
}

function goMigrate() {
  router.push('/legacy')
}
</script>

<template>
  <section v-if="rev && rev.revision > 0" class="legacy-banner" :class="{ void: voided && !reissued, partial: !(voided && !reissued) && !rev.complete }">
    <header>
      <span class="route">
        老灯样补齐 · 第 {{ rev.revision }} 版 ·
        <b>{{ rev.route === 'preset' ? '照灯型库预设补' : '按写明的默认值顶' }}</b>
      </span>
      <span class="state">
        <em v-if="voided && !reissued" class="badge bad">换路 · 旧版作废 · 待重出 {{ pendingKinds.length }} 份</em>
        <em v-else-if="voided && reissued" class="badge ok">旧版已作废 · 单子图纸已全部按新版重出</em>
        <em v-else-if="incomplete.length" class="badge warn">{{ incomplete.length }} 个不完整层 · 需人工补</em>
        <em v-else class="badge ok">{{ rev.route === 'preset' ? '各页齐全' : '已顶值' }}</em>
        <em v-if="stale.length" class="badge bad">{{ stale.length }} 份旧单子已过时</em>
      </span>
      <button class="link" @click="goMigrate">补齐/换路</button>
    </header>

    <ul class="warnings">
      <li v-for="(w, i) in rev.warnings" :key="i">{{ w }}</li>
    </ul>

    <div v-if="incomplete.length" class="layers">
      不完整层：
      <span v-for="n in incomplete" :key="n" class="layer-tag">第 {{ n }} 层（少一段轮廓）</span>
    </div>

    <details v-if="!compact">
      <summary>这次补了哪几项（{{ rev.items.length }} 项）· 多出字段 {{ rev.unknownFieldsKept.length }} 个原样保留 · 展开</summary>
      <table class="items">
        <thead>
          <tr><th>缺项</th><th>补成</th><th>取值来源</th><th>人工</th></tr>
      </thead>
        <tbody>
          <tr v-for="(it, i) in rev.items" :key="i" :class="{ manual: it.manual }">
            <td>{{ it.label }} <code>{{ it.path }}</code></td>
            <td class="mono">{{ typeof it.value === 'number' ? mmCmText(it.value) : it.value }}</td>
            <td class="src">{{ it.source }}</td>
            <td>{{ it.manual ? '需人工复核' : '' }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="rev.unknownFieldsKept.length" class="kept">
        旧档多出字段未丢失：<code v-for="k in rev.unknownFieldsKept" :key="k">{{ k }} </code>
      </p>
    </details>

    <p v-if="voided && !reissued" class="void-line">
      {{ rev.voidReason || '旧版已作废。' }} 当前第 {{ rev.revision }} 版还差 <b>{{ pendingKinds.map((k) => kindName[k]).join('、') }}</b> 未按当前数值重出；重出齐全后恢复正常。
    </p>
    <p v-else-if="voided && reissued" class="stale-line">
      三份单子与 1:1 图纸已全部按第 {{ rev.revision }} 版重新导出；旧版补值、旧单子图纸作废、已裁料重裁均已处理，以新版为准。
    </p>
    <p v-if="stale.length" class="stale-line">
      已发出但已过时：<span v-for="(e, i) in stale" :key="i">{{ kindName[e.kind] }}（{{ e.at }}） </span>
      —— 改一处别处要跟着刷新，请用当前数值重新导出这几份单子并重出图纸。
    </p>
    <p class="meta">灯样编号 {{ lantern.id }} · 创建时间 {{ lantern.createdAt }}（原样保留，未重新生成）· 确认于 {{ rev.confirmedAt }}</p>
  </section>
</template>

<style scoped>
.legacy-banner {
  border: 1px solid #cbe3d8;
  background: #f1f8f4;
  border-radius: 10px;
  padding: 10px 14px;
  font-size: 12.5px;
  box-shadow: var(--shadow);
}
.legacy-banner.partial {
  border-color: #e0c78a;
  background: #fdf6e7;
}
.legacy-banner.void {
  border-color: #e08f88;
  background: #fdecea;
}
header {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.route b {
  color: #8f1c19;
}
.state {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.badge {
  font-style: normal;
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid;
}
.badge.ok {
  background: #e3f1ea;
  color: var(--jade);
  border-color: #cbe3d8;
}
.badge.warn {
  background: #f6e3ba;
  color: #8a5a10;
  border-color: #e0c78a;
}
.badge.bad {
  background: #fadbd6;
  color: var(--red);
  border-color: #e8a39c;
}
.link {
  margin-left: auto;
  background: none;
  border: none;
  color: var(--red);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  text-decoration: underline;
}
.warnings {
  margin: 6px 0 0;
  padding-left: 18px;
  color: var(--ink-soft);
}
.layers {
  margin-top: 6px;
  color: #8a5a10;
}
.layer-tag {
  display: inline-block;
  margin: 0 4px;
  padding: 1px 8px;
  border-radius: 6px;
  background: #f6e3ba;
  border: 1px solid #e0c78a;
}
details {
  margin-top: 6px;
}
.items {
  width: 100%;
  border-collapse: collapse;
  margin-top: 6px;
  font-size: 11.5px;
}
.items th,
.items td {
  border: 1px solid var(--line);
  padding: 3px 6px;
  text-align: left;
}
.items tr.manual {
  background: #fdf6e7;
}
.mono {
  font-family: var(--mono);
}
.src {
  color: var(--ink-soft);
}
.kept code,
.items code {
  font-family: var(--mono);
  font-size: 11px;
  background: rgba(0, 0, 0, 0.05);
  padding: 0 4px;
  border-radius: 4px;
}
.void-line {
  color: var(--red);
  font-weight: 600;
  margin: 6px 0 0;
}
.stale-line {
  color: #8a5a10;
  margin: 6px 0 0;
}
.meta {
  margin: 6px 0 0;
  color: var(--ink-soft);
  font-family: var(--mono);
  font-size: 11px;
}
</style>
