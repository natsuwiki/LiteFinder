# LiteFinder v1.3.1 — API 服务

基于 Olelabot Finder Gen2 修改而来的 Minecraft 世界生成分析 API 服务，底层使用 [deepslate](https://github.com/misode/deepslate)。

**亮点：**
- 支持主世界、下界、末地三维度同时查找
- 相比原版降低了内存占用
- 连锁查找 + 地图边界限制
- Cluster 多进程 + Worker 线程池

## 固定配置

- 种子: `877470420230587172`
- 版本: `1.21.7`
- 世界类型: 默认（`minecraft:normal`）

## 安装

```bash
npm install
```

## 运行

```bash
# 开发模式
npm run dev

# 或直接运行
npx tsx src/server.ts
```

服务默认运行在 `http://localhost:3000`。

## 多维度支持

启动时自动初始化主世界、下界、末地三个维度。所有接口均支持可选的 `dimension` 参数：

- `minecraft:overworld`（默认）
- `minecraft:the_nether`
- `minecraft:the_end`

## API 接口

### 生物群系

```http
GET /api/biome?x=0&z=0&y=64&dimension=minecraft:overworld
GET /api/biomes/area?minX=-100&minZ=-100&maxX=100&maxZ=100&y=64&step=16
GET /api/climate?x=0&z=0&y=64
GET /api/find-biome?biome=minecraft:jungle&centerX=0&centerZ=0&maxRadius=6400
GET /api/locate?biome=minecraft:plains&x=0&z=0&maxRadius=6400
```

支持 `?stream=true` NDJSON 流式输出。

### 结构

```http
GET /api/structures?dimension=minecraft:the_nether
GET /api/structure?x=0&z=0&dimension=minecraft:overworld
GET /api/structures/area?x=0&z=0&radius=1000
GET /api/locate/structure?structure=minecraft:village&x=0&z=0
```

### 连锁查找

```http
GET /api/locate/structure/chain?structure=minecraft:village&x=0&z=0&count=5
GET /api/locate/biome/chain?biome=minecraft:jungle&x=0&z=0&count=3
```

支持 `boundsMinX`, `boundsMinZ`, `boundsMaxX`, `boundsMaxZ` 参数划定边界。

### 系统状态

```http
GET /api/status
GET /health
```

## 配置

配置文件位于 `src/config.ts`，支持环境变量覆盖。

数据包放入项目根目录（`src-api` 的上级目录）后自动加载，无需修改配置。

当前已加载的数据包：Tectonic、Dungeons and Taverns、Amplified Nether、Blooming Biosphere、Cliffs and Coves、CliffTree、Navigable Rivers、Nullscape、William Wythers' Overhauled Overworld。