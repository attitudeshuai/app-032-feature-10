# 花灯骨架放样与蒙面裁片 · Lantern Frame Lofting

纯前端工具：选灯型 → 填直径/高度/收口 → 出「每根竹篾截多长、弯什么角度」的骨架件表、带缝份的蒙面裁片、以及可 100% 打印的 1:1 放样图与备料单。无后端、无网络请求，断网可用。

## 技术栈

- Vue 3（`<script setup>` 单文件组件）+ TypeScript + Vite 6
- 状态：Vue 自带 `ref / reactive / computed / watch`（无 Pinia / Vuex）
- 额外依赖仅 `vue-router` 4（规格书要求的 6 个路由）
- 手写 CSS；无 UI 组件库、无图表库、无游戏引擎/物理库
- 字体、灯型数据包（`src/data/lantern-types.json`）全部本地打包，无外网 CDN

## 目录结构

```
.
├─ index.html
├─ package.json / tsconfig.json / vite.config.ts
├─ Dockerfile / docker-compose.yml / nginx.conf
├─ .dockerignore / .gitignore
├─ lantern-frame-lofting.md          # 规格书（只读，未改动）
└─ src/
   ├─ main.ts / App.vue / env.d.ts
   ├─ router/index.ts                # 6 个路由
   ├─ components/
   │  ├─ LanternPreview.vue          # 正视 / 俯视 / 等轴测 + 可拖动贝塞尔控制点
   │  ├─ PanelDiagram.vue            # 裁片尺寸箭头 + 缝份虚线 + 对位十字
   │  └─ ChecksPanel.vue             # 断言结果面板（CHK-01 ~ CHK-08）
   ├─ core/
   │  ├─ types.ts                    # 数据模型（规格书 §7）
   │  ├─ geometry.ts                 # 轮廓 / 分段 / 周长 / 面积 / 体积
   │  ├─ frame.ts                    # 骨架构件表（净长 + 绑扎余量）
   │  ├─ panels.ts                   # 展开裁片（含缝份与对位标记）
   │  ├─ materials.ts                # 备料统计与批量汇总
   │  ├─ craft.ts                    # 工艺参数、蒙面类型
   │  ├─ paginate.ts                 # 1:1 分页（裁片不跨页、长条搭接、分段连号）
   │  ├─ checks.ts                   # computeAll + CHK-01~08 断言
   │  ├─ exporter.ts                 # CSV 导出
   │  ├─ legacy.ts                   # 老灯样读入补齐（迁移与清单）
   │  └─ store.ts                    # localStorage 灯样库（确认写回 / 失败回滚）
   └─ views/                         # / · /design · /frame · /panels · /print · /materials
```

## 启动

```bash
npm install
npm run dev        # http://127.0.0.1:5173
npm run build      # vue-tsc --noEmit && vite build
npm run preview
```

## Docker 构建

```bash
docker compose build
docker compose up -d            # http://localhost:8112
curl http://localhost:8112/healthz
docker compose down
```

多阶段：`node:20-alpine` 构建 → `nginx:1.27-alpine` 只托管 `dist/` 与 `nginx.conf`（SPA 回退、哈希资源 immutable、index.html no-cache、gzip、SVG MIME、`/healthz` 健康检查）。

## 老灯样读入补齐（迁移）

早先存下的那批灯样没有底口直径、没有逐层配色，分层里也没有直径这一项。读入时按「写明的默认值」（`lantern-types.json · craft.legacyDefaults`）补齐，规则：

- **一批一次读完**：逐盏出「缺哪一项 / 按什么值顶 / 值来自哪」清单，**确认了才写回本机存档**；同一批重复确认是幂等空操作，不会写成两版；写回后读回校验，写一半出错**退回读之前的样子**。
- **两条路（逐盏挑定并认下代价）**：能跟当前灯型库对上的照预设补（补完可直接放样、各页齐全；代价是与当年那盏未必是一回事，导出单子与旧档对不上）；对不上的按默认值兜底（与旧档对得上；代价是构件表与裁片页可能少一段轮廓、有的层显示不全，需人工补）。
- **只补不丢**：已有值一律不动，多出来的未知字段原样保留；灯样编号与创建时间保持原样，缺了只补一次、写回后固定，不再每次读入重新生成；迁移幂等，读出来再存回去两份对得上。
- **同一份数**：补齐后参数预览、骨架件表、蒙面裁片、1:1 放样图与分页、备料与批量、三份导出单全部按同一份灯样计算，改一处各处跟着刷新；确认前唯独**本机存档**还拿补之前的老数，页面横幅会点明。
- **取位与容差**：厘米→毫米 ×10 按整数取整；长度 mm 1 位小数；面积 m² 3 位小数；比例百分数 2 位小数；旋转体等分数缺省 24，等分近似展开面积核对容差 [0.97, 1.03]。
- **分页连号**：补完重排分页时，骨架长条分段编号全图 S1…Sn 顺序连号（CHK-06 断言：无断号、无重号）。

## 验收结果（规格书 §10）

| 用例 | 结果 | 关键证据 |
| --- | --- | --- |
| 几何手算核对 | 通过 | 正六棱柱底边(D200) 100.000 / 手算 100.000（Δ0.000）；正八棱柱 76.537 / 76.537；圆形周长 628.319 / 628.319；六边形周长 600.000 / 600.000 |
| 竖篾 = 分段高累计 | 通过 | 六角宫灯：竖篾净长 306.8mm，分段高累计 300.0，母线折线长累计 306.8（收口段横向偏移 6.8mm），Δ折线 0.0mm |
| 缝份 = 净尺寸 + 缝份×边数 | 通过 | 6/6 种裁片三向均 = 净尺寸 + 10.0×2mm；图上实线=裁切线、绿色虚线=净样 |
| 备料守恒 | 通过 | 六角宫灯 Σ备料 5.209m / Σ净长 4.369m，差值 840.0mm = 余量总和；莲花灯 Σ备料 8.524m / Σ净长 8.004m，差 520.0mm |
| 面积核对 | 通过 | 六角宫灯 裁片净面积 0.186m² / 灯体表面积 0.186m² = 100.02%；莲花灯 0.311 / 0.309 = 100.67%（∈[0.97,1.03]） |
| 分页 | 通过 | 6 种裁片每块只出现在一页且完整，超区整块输出 0 块；跨页仅骨架长条，带对位十字与搭接 10.0mm |
| 批量守恒 | 通过 | 20 个 × 1.10 损耗：竹篾 5.209 → 114.598m（= 5.209×20×1.10）；蒙面 0.284 → 6.248m² |
| 1:1 打印 | 通过 | `@page { size: 210mm 297mm; margin: 0 }`，图纸宽 793.6875px = 210.0mm；100mm 校验尺实测 377.946px = 99.9991mm（误差 0.0009mm ≤ 1mm） |
| 性能 | 通过 | 计算耗时 0.7 ~ 2.1ms（< 100ms） |

自检面板（每页底部）显示 **8 / 8 通过**，浏览器控制台无报错、无警告。
