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
   │  ├─ paginate.ts                 # 1:1 分页（裁片不跨页、长条搭接）
   │  ├─ checks.ts                   # computeAll + CHK-01~08 断言
   │  ├─ exporter.ts                 # CSV 导出
   │  └─ store.ts                    # localStorage 灯样库
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

## 老灯样读入补齐（`/legacy`）

早期存档缺底口直径、逐层配色、`layers[].diameterMm`（旋转体还可能缺等分数）。读入与写回规则：

- **读进来什么样就什么样**：老档只解析、体检，进「待确认队列」，不自动补、不自动写回；首页有醒目入口。
- **一批一次读完**：`/legacy` 支持文件 / 粘贴导入（单对象、数组、`{lanterns:[]}`），给每盏列出「补了哪几项、顶成什么、取自哪条预设/默认」。
- **两条路必须挑一条并认下代价**：
  - **① 照灯型库预设补**：按 `legacy.matchKeys`（kind/sides/收口方式/层数/各直径）逐项对得上预设才可走；补完各页齐全可直接放样，代价是跟当年那盏未必一致、旧单子图纸对不上。
  - **② 按写明的默认值目录顶**（`lantern-types.json` 的 `legacy.defaults`）：与旧档对得上，逐项写清缺什么/顶什么/取自哪；连分层高度都缺的层不造轮廓（构件表、裁片页、1:1 分页都少这一段并点名），需人工补。
- **确认后才写本机存储**：整批事务——先在副本上补齐、提交后回读校验，任何一条出错整批退回读之前；同一路同一内容重复确认不产生第二版；换路则旧版作废、版次连续升号，并标明存档补值/已发单子图纸作废、已裁料要重裁；三份单子 + 1:1 图纸按新版重出齐全后恢复正常。
- **不变量**：`id`、`createdAt` 读入永不重新生成；旧档多出的字段原样保留（如 `shopNote`）；读出来再存回去内容签名一致。
- **六处同源**：补完的值只落一份灯样，本机存档、骨架件表、蒙面裁片、1:1 分页、备料批量、三份导出单子全部由它重算；CHK-09 指纹断言、CHK-10 补齐状态/作废/旧单子时效、CHK-11 长条编号不断号不重号。
- **取位**：mm 保留 1 位小数；mm→cm 整数取整（`Math.round`）；面积折 m² 保留 3 位；比例百分数保留 2 位；旋转体等分数缺省 24，以直代曲面积容差 ±3.00%。长条分段编号为 `T<构件号>-<段号>/<总段数>`，全局连续、不随分页变化。

可运行验收（Node，无需浏览器）：

```bash
npm run test:legacy    # 16 项：两路补齐 / 不完整层 / 多余字段 / 幂等 / 换路作废 / 事务回滚 / 六处同源 / 编号连续
```
