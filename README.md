# Kelebot Gen2 Finder
## 固定配置

- 种子: `877470420230587172`
- 版本: `1.21.7`
- 数据包: `Tectonic 3.0.13`
- 世界类型: 默认

## 安装

```bash
npm install
```

## 添加数据包

将数据包 zip 文件直接放到项目根目录（与 `src-api` 同级），启动时会自动扫描加载。原版数据包放在 `public/vanilla_datapacks/`。

## 运行

```bash
# 开发模式
npm run dev

# 或直接运行
npx tsx src/server.ts
```

## 多维度支持

启动时会自动初始化主世界、下界、末地三个维度。所有 API 均支持 `dimension` 参数：

- `minecraft:overworld`（默认）
- `minecraft:the_nether`
- `minecraft:the_end`

`/api/locate/structure` 接口会根据结构 ID **自动识别所属维度**，无需手动指定。

## API 接口

所有接口均支持可选的 `dimension` 参数。

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
GET /api/biome?x=0&z=0&y=64&dimension=minecraft:overworld
GET /api/biomes/area?minX=-100&minZ=-100&maxX=100&maxZ=100&y=64&step=16
GET /api/climate?x=0&z=0&y=64
GET /api/find-biome?biome=minecraft:jungle&centerX=0&centerZ=0&maxRadius=6400
GET /api/structures?dimension=minecraft:the_nether
GET /api/structure?x=0&z=0&dimension=minecraft:overworld
GET /api/structures/area?x=0&z=0&radius=1000&dimension=minecraft:overworld
GET /api/status
```

## 配置

配置文件位于 `src/config.ts`，包含：
- 种子
- MC 版本
- 服务器端口

数据包通过放入项目根目录自动加载，无需修改配置。

olela啊
olela
## 许可证

本项目用于学习和研究目的。 by kelemiao [kelemiao](https://github.com/kelemiao)

## 相关链接

- [deepslate](https://github.com/misode/deepslate) - Minecraft 世界生成库
- [Tectonic](https://modrinth.com/datapack/tectonic) - 世界生成数据包
- [Dungeons and Taverns](https://modrinth.com/datapack/dungeons-and-taverns) - 结构数据包