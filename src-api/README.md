# LiteFinder x1.2 — API 服务

基于 [KeleBot Finder Gen2](https://github.com/kelemiao) 制作的 Minecraft 世界生成分析 API 服务，底层使用 [deepslate](https://github.com/misode/deepslate)。

**亮点：**
- 支持主世界、下界、末地三维度同时查找
- 相比原版 Gen2 降低了内存占用

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

#### 查询指定坐标的生物群系

```http
GET /api/biome?x=0&z=0&y=64&dimension=minecraft:overworld
```

响应：
```json
{
  "x": 0,
  "z": 0,
  "y": 64,
  "biome": "minecraft:deep_ocean",
  "surface": 71.69
}
```

#### 查询区域内的生物群系

```http
GET /api/biomes/area?minX=-100&minZ=-100&maxX=100&maxZ=100&y=64&step=16&dimension=minecraft:overworld
```

#### 查询气候参数

```http
GET /api/climate?x=0&z=0&y=64&dimension=minecraft:overworld
```

响应：
```json
{
  "x": 0,
  "z": 0,
  "y": 64,
  "temperature": 0.5,
  "humidity": 0.3,
  "continentalness": -0.8,
  "erosion": 0.1,
  "depth": 0,
  "weirdness": 0.4
}
```

#### 搜索特定生物群系

```http
GET /api/find-biome?biome=minecraft:jungle&centerX=0&centerZ=0&y=64&maxRadius=6400&step=64
```

#### 查找最近的生物群系

```http
GET /api/locate?biome=minecraft:plains&x=0&z=0&y=64&maxRadius=6400&step=32&dimension=minecraft:overworld
```

响应：
```json
{
  "found": true,
  "biome": "minecraft:plains",
  "x": 1214,
  "z": 54,
  "y": 64,
  "distance": 1215,
  "surface": 72.5,
  "dimension": "minecraft:overworld"
}
```

### 结构

#### 获取结构列表

```http
GET /api/structures?dimension=minecraft:the_nether
```

#### 查询指定坐标的结构

```http
GET /api/structure?x=0&z=0&dimension=minecraft:overworld
```

#### 查询区域内的所有结构

```http
GET /api/structures/area?x=0&z=0&radius=1000&dimension=minecraft:overworld
```

#### 查找最近的指定结构（自动识别维度）

```http
GET /api/locate/structure?structure=nova_structures:nether_keep&x=0&z=0
```

响应：
```json
{
  "found": true,
  "structureId": "nova_structures:nether_keep",
  "x": 1024,
  "z": 768,
  "distance": 1267,
  "dimension": "minecraft:the_nether",
  "autoDimension": "minecraft:the_nether"
}
```

### 系统状态

```http
GET /api/status
```

## 配置

配置文件位于 `src/config.ts`，包含：
- 种子
- MC 版本
- 服务器端口

数据包放入项目根目录（`src-api` 的上级目录）后自动加载，无需修改配置。

当前已加载的数据包：Tectonic (`main_tectonic-datapack-3.0.13 (1).zip`)、Dungeons and Taverns v4.7.3、Amplified Nether v1.2.11、Blooming Biosphere v1.1.11、Cliffs and Coves v1.3.1、CliffTree 3.0.2、Navigable Rivers v1.5.0、Nullscape v1.2.14、William Wythers' Overhauled Overworld v2.6.0。
