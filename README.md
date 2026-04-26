# LiteFinder x1.2

基于 [KeleBot Finder Gen2](https://github.com/kelemiao) 制作的 Minecraft 世界生成分析工具，提供生物群系与结构查找的 HTTP API 服务。

**亮点：**
- 支持主世界、下界、末地三维度同时查找
- 相比原版 Gen2 降低了内存占用
- 基于 [deepslate](https://github.com/misode/deepslate) 实现无需启动游戏的世界生成模拟

## 固定配置

- 种子: `877470420230587172`
- 版本: `1.21.7`
- 世界类型: 默认（`minecraft:normal`）

## 安装

```bash
npm install
```

## 添加数据包

将数据包 zip 文件直接放到项目根目录（与 `src-api` 同级），启动时会自动扫描加载。原版数据包放在 `public/vanilla_datapacks/`。

当前已加载的数据包：

- `main_tectonic-datapack-3.0.13 (1).zip` — 地形生成
- `Dungeons and Taverns v4.7.3.zip` — 地牢与酒馆结构
- `Amplified_Nether_1.21_v1.2.11.zip` — 放大下界
- `blooming-biosphere-v1.1.11.zip` — 生物群系扩展
- `Cliffs and Coves v1.3.1.zip` — 悬崖与海湾
- `CliffTree 3.0.2 [1.21.5 - 1.21.10].zip` — 悬崖树木
- `Navigable Rivers v1.5.0.zip` — 可航行河流
- `Nullscape_1.21_v1.2.14.zip` — 末地改造
- `William Wythers' Overhauled Overworld v2.6.0.zip` — 主世界全面改造

## 运行

```bash
# 在 src-api 目录下运行
cd src-api

# 开发模式
npm run dev

# 或直接运行
npx tsx src/server.ts
```

服务默认运行在 `http://localhost:3000`。

## 多维度支持

启动时会自动初始化主世界、下界、末地三个维度。所有 API 均支持 `dimension` 参数：

- `minecraft:overworld`（默认）
- `minecraft:the_nether`
- `minecraft:the_end`

`/api/locate/structure` 接口会根据结构 ID **自动识别所属维度**，无需手动指定。

## API 接口

所有接口均支持可选的 `dimension` 参数。

### 查询指定坐标的生物群系

```http
GET /api/biome?x=0&z=0&y=64&dimension=minecraft:overworld
```

### 查询区域内的生物群系

```http
GET /api/biomes/area?minX=-100&minZ=-100&maxX=100&maxZ=100&y=64&step=16
```

### 查询气候参数

```http
GET /api/climate?x=0&z=0&y=64
```

### 查找最近的生物群系

```http
GET /api/locate?biome=minecraft:soul_sand_valley&x=0&z=0&dimension=minecraft:the_nether
```

响应：
```json
{
  "found": true,
  "biome": "minecraft:soul_sand_valley",
  "x": 512,
  "z": -256,
  "y": 64,
  "distance": 572,
  "dimension": "minecraft:the_nether"
}
```

### 查找最近的结构（自动识别维度）

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

### 其他接口

```http
GET /api/find-biome?biome=minecraft:jungle&centerX=0&centerZ=0&maxRadius=6400
GET /api/structures?dimension=minecraft:the_nether
GET /api/structure?x=0&z=0&dimension=minecraft:overworld
GET /api/structures/area?x=0&z=0&radius=1000&dimension=minecraft:overworld
GET /api/status
```

## 配置

配置文件位于 `src-api/src/config.ts`，包含：
- 种子
- MC 版本
- 服务器端口

数据包通过放入项目根目录自动加载，无需修改配置。

## 许可证

本项目用于学习和研究目的。by kelemiao [kelemiao](https://github.com/kelemiao)

## 作者

- **LiteFinder** — ONEGAME
- **KeleBot Finder Gen2**（底层基础）— [kelemiao](https://github.com/kelemiao)

## 相关链接

- [deepslate](https://github.com/misode/deepslate) - Minecraft 世界生成库
- [Tectonic](https://modrinth.com/datapack/tectonic) - 世界生成数据包
- [Dungeons and Taverns](https://modrinth.com/datapack/dungeons-and-taverns) - 结构数据包
