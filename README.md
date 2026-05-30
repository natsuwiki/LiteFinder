# LiteFinder v1.3.1

基于 Olelabot Finder Gen2 修改而来的 Minecraft 世界生成分析工具，提供生物群系与结构查找的 HTTP API 服务。

**亮点：**
- 支持主世界、下界、末地三维度同时查找
- 相比原版降低了内存占用
- 基于 [deepslate](https://github.com/misode/deepslate) 实现无需启动游戏的世界生成模拟
- 连锁查找结构/生物群系 + 地图边界限制
- Cluster 多进程 + Worker 线程池 + 流式响应

## 安装

1. **安装 Node.js**（推荐 v20+）
   - 下载：https://nodejs.org/
   - 验证：`node --version`

2. **克隆或下载项目**
   ```bash
   git clone https://github.com/natsuwiki/LiteFinder.git
   cd LiteFinder
   ```

3. **安装依赖**
   ```bash
   cd src-api
   npm install
   ```

4. **添加数据包**
   将 Minecraft 数据包 zip 文件放到 `src-api` 同级目录（项目根目录），启动时会自动扫描加载。

   示例数据包：
   - [Tectonic](https://modrinth.com/datapack/tectonic) — 地形生成
   - [Dungeons and Taverns](https://modrinth.com/datapack/dungeons-and-taverns) — 地牢与酒馆结构

5. **运行**
   ```bash
   cd src-api
   npm run dev
   ```

   Windows 快捷启动：双击项目根目录的 `start.bat`

服务默认运行在 `http://localhost:3000`。

## 环境变量配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SEED` | `877470420230587172` | 世界种子 |
| `MC_VERSION` | `1_21_7` | Minecraft 版本 |
| `PORT` | `3000` | 服务端口 |
| `RATE_LIMIT` | `120` | 每分钟最大请求数 |
| `MAX_AREA_POINTS` | `250000` | 区域查询最大采样点数 |
| `MAX_LOCATE_RADIUS` | `50000` | 查找操作最大半径（方块） |
| `CLUSTER_WORKERS` | `1` | Cluster 工作进程数（1=禁用） |
| `COMPUTE_WORKERS` | `0` | 每进程内 Worker 线程数（0=禁用） |

```bash
# 单进程（默认）
npm run dev

# 4 进程 Cluster 模式
CLUSTER_WORKERS=4 npm run dev

# 2 进程 + 每进程 2 计算线程（需先 build）
npm run build
CLUSTER_WORKERS=2 COMPUTE_WORKERS=2 npm start
```

## 当前已加载的数据包

- `main_tectonic-datapack-3.0.13 (1).zip` — 地形生成
- `Dungeons and Taverns v4.7.3.zip` — 地牢与酒馆结构
- `Amplified_Nether_1.21_v1.2.11.zip` — 放大下界
- `blooming-biosphere-v1.1.11.zip` — 生物群系扩展
- `Cliffs and Coves v1.3.1.zip` — 悬崖与海湾
- `CliffTree 3.0.2 [1.21.5 - 1.21.10].zip` — 悬崖树木
- `Navigable Rivers v1.5.0.zip` — 可航行河流
- `Nullscape_1.21_v1.2.14.zip` — 末地改造
- `William Wythers' Overhauled Overworld v2.6.0.zip` — 主世界全面改造

## 多维度支持

启动时自动初始化主世界、下界、末地三个维度。所有 API 均支持 `dimension` 参数：

- `minecraft:overworld`（默认）
- `minecraft:the_nether`
- `minecraft:the_end`

`/api/locate/structure` 接口会根据结构 ID **自动识别所属维度**。

## API 接口

### 生物群系查询

```http
GET /api/biome?x=0&z=0&y=64&dimension=minecraft:overworld
GET /api/biomes/area?minX=-100&minZ=-100&maxX=100&maxZ=100&y=64&step=16
GET /api/climate?x=0&z=0&y=64
GET /api/find-biome?biome=minecraft:jungle&centerX=0&centerZ=0&maxRadius=6400
GET /api/locate?biome=minecraft:soul_sand_valley&x=0&z=0&dimension=minecraft:the_nether
```

> 区域查询超过 `MAX_AREA_POINTS` 时步长自动增大。支持 `?stream=true` NDJSON 流式输出。

### 结构查询

```http
GET /api/structure?x=0&z=0&dimension=minecraft:overworld
GET /api/structures?dimension=minecraft:the_nether
GET /api/structures/area?x=0&z=0&radius=1000
GET /api/locate/structure?structure=minecraft:village&x=0&z=0
```

### 连锁查找

从起点开始，依次查找最近的指定目标，每次以上一个位置为新起点继续查找：

```http
# 连锁查找结构（连找5个村庄）
GET /api/locate/structure/chain?structure=minecraft:village&x=0&z=0&count=5&maxRadius=20000

# 连锁查找生物群系
GET /api/locate/biome/chain?biome=minecraft:jungle&x=0&z=0&count=3&maxRadius=20000
```

### 地图边界限制

连锁查找接口支持通过 `boundsMinX`, `boundsMinZ`, `boundsMaxX`, `boundsMaxZ` 划定方形边界，超出边界自动停止：

```http
GET /api/locate/structure/chain?structure=minecraft:village&x=0&z=0&count=10
  &boundsMinX=-5000&boundsMinZ=-5000&boundsMaxX=5000&boundsMaxZ=5000
```

### 其他

```http
GET /api/status    # 服务状态（内存、运行时间、请求计数）
GET /health        # 健康检查
```

## 性能特性

- **资源单次注册**：全局注册表只注册一次，三维度共享
- **三维度并行初始化**：`Promise.all` 并行
- **生物群系源缓存**：LRU 缓存策略
- **结构快速查找**：预构建结构→结构集映射
- **两阶段搜索**：粗粒度采样 + 精细定位
- **自适应步长**：查询面积过大时自动增大
- **请求速率限制**：默认 120 req/min
- **Cluster 多进程**：利用多核 CPU
- **Worker 线程池**：计算任务分发到独立线程
- **NDJSON 流式响应**：大区域查询避免内存峰值
- **数据包中间数据释放**：初始化完成后自动释放

## 不支持的结构

以下结构因 deepslate 库限制无法查找：
- 废弃矿井（MineshaftStructure）
- 下界化石（NetherFossilStructure）
- 海底神殿（OceanMonumentStructure）
- 废弃传送门（RuinedPortalStructure）

## 作者

**LiteFinder** — ONEGAME

基于 Olelabot Finder Gen2 修改而来。