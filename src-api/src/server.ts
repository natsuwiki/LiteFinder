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
    name: "LiteFinder",
    version: "x1.2",
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

// ANSI 颜色代码
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
};

function printBanner() {
  const banner = `
${colors.cyan}${colors.bright}
 ██╗     ██╗████████╗███████╗███████╗██╗███╗   ██╗██████╗ ███████╗██████╗ 
 ██║     ██║╚══██╔══╝██╔════╝██╔════╝██║████╗  ██║██╔══██╗██╔════╝██╔══██╗
 ██║     ██║   ██║   █████╗  █████╗  ██║██╔██╗ ██║██║  ██║█████╗  ██████╔╝
 ██║     ██║   ██║   ██╔══╝  ██╔══╝  ██║██║╚██╗██║██║  ██║██╔══╝  ██╔══██╗
 ███████╗██║   ██║   ███████╗██║     ██║██║ ╚████║██████╔╝███████╗██║  ██║
 ╚══════╝╚═╝   ╚═╝   ╚══════╝╚═╝     ╚═╝╚═╝  ╚═══╝╚═════╝ ╚══════╝╚═╝  ╚═╝
${colors.reset}
${colors.gray}  Version: ${colors.green}x1.2${colors.gray}  |  Author: ${colors.green}ONEGAME${colors.gray}  |  Based on: ${colors.green}KeleBot Finder Gen2${colors.reset}
${colors.gray}  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}
`;
  console.log(banner);
}

async function start() {
  printBanner();
  
  console.log(`${colors.blue}[配置]${colors.reset} 种子: ${colors.yellow}${CONFIG.seed}${colors.reset}`);
  console.log(`${colors.blue}[配置]${colors.reset} 版本: ${colors.yellow}${CONFIG.mcVersion}${colors.reset}`);
  console.log(`${colors.blue}[配置]${colors.reset} 数据包: ${colors.yellow}${CONFIG.additionalDatapacks.length}${colors.reset} 个`);
  console.log();

  await new Promise<void>((resolve) => {
    app.listen(CONFIG.port, () => {
      console.log(`${colors.green}✓${colors.reset} 服务器启动成功: ${colors.cyan}http://localhost:${CONFIG.port}${colors.reset}`);
      resolve();
    });
  });

  await new Promise((resolve) => setTimeout(resolve, 500));

  console.log(`${colors.magenta}[初始化]${colors.reset} 正在加载数据包并初始化三个维度...`);
  try {
    await initializeCalculator();
    console.log(`${colors.green}✓${colors.reset} 初始化完成，服务就绪`);
    console.log();
    console.log(`${colors.gray}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    console.log(`${colors.bright}  访问 ${colors.cyan}http://localhost:${CONFIG.port}${colors.reset}${colors.bright} 查看 API 文档${colors.reset}`);
    console.log(`${colors.gray}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  } catch (error) {
    console.error(`${colors.red}✗${colors.reset} 初始化失败:`, error);
    process.exit(1);
  }
}

start();
