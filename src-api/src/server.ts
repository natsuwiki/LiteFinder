import express from "express";
import cors from "cors";
import apiRoutes, { initializeCalculator } from "./api/routes";
import { CONFIG } from "./config";

const app = express();

app.use(cors());
app.use(express.json());

// 静态文件服务
app.use("/vanilla", express.static(CONFIG.vanillaDatapackDir));
app.use("/datapacks", express.static(CONFIG.datapackDir));

app.use("/api", apiRoutes);

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/", (req, res) => {
  res.json({
    name: "olela",
    version: "2.0.0",
    config: {
      seed: CONFIG.seed,
      mcVersion: CONFIG.mcVersion,
      datapacks: CONFIG.additionalDatapacks,
    },
    endpoints: {
      "GET /api/biome?x=&z=&y=&dimension=": "获取指定坐标的生物群系",
      "GET /api/biomes/area?minX=&minZ=&maxX=&maxZ=&y=&step=&dimension=": "获取区域内的生物群系",
      "GET /api/climate?x=&z=&y=&dimension=": "获取气候参数",
      "GET /api/find-biome?biome=&centerX=&centerZ=&y=&maxRadius=&step=&dimension=": "搜索特定生物群系",
      "GET /api/locate?biome=&x=&z=&y=&maxRadius=&step=&dimension=": "查找最近的生物群系",
      "GET /api/status": "获取服务状态",
      "GET /api/structures?dimension=": "获取结构列表（可按维度过滤）",
      "GET /api/structure?x=&z=&dimension=": "获取指定坐标的结构",
      "GET /api/structures/area?x=&z=&radius=&dimension=": "获取区域内所有结构",
      "GET /api/locate/structure?structure=&x=&z=&maxRadius=&dimension=": "查找最近的结构（自动识别维度）",
    },
    note: "dimension 参数可选值: minecraft:overworld | minecraft:the_nether | minecraft:the_end。locate/structure 接口会根据结构 ID 自动选择正确维度。",
  });
});

async function start() {
  console.log("olela 正在启动...");
  console.log(`  种子: ${CONFIG.seed}`);
  console.log(`  版本: ${CONFIG.mcVersion}`);
  console.log(`  数据包: ${CONFIG.additionalDatapacks.join(", ") || "仅原版"}`);

  await new Promise<void>((resolve) => {
    app.listen(CONFIG.port, () => {
      console.log(`服务器运行在 http://localhost:${CONFIG.port}`);
      resolve();
    });
  });

  await new Promise((resolve) => setTimeout(resolve, 500));

  console.log("正在加载数据包并初始化三个维度...");
  try {
    await initializeCalculator();
    console.log("初始化完成，服务就绪。");
  } catch (error) {
    console.error("初始化失败:", error);
    process.exit(1);
  }
}

start();
