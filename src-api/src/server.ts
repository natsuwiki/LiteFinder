import cluster from "node:cluster";
import os from "node:os";
import express from "express";
import cors from "cors";
import apiRoutes, { initializeCalculator } from "./api/routes";
import { CONFIG } from "./config";

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
  red: "\x1b[31m",
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
${colors.gray}  Version: ${colors.green}v1.3.1${colors.gray}  |  Author: ${colors.green}ONEGAME${colors.gray}  |  Based on: ${colors.green}Olelabot Finder Gen2${colors.reset}
${colors.gray}  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}
`;
  console.log(banner);
}

function getMemoryMB(): string {
  const used = process.memoryUsage();
  return `RSS: ${(used.rss / 1024 / 1024).toFixed(1)}MB, Heap: ${(used.heapUsed / 1024 / 1024).toFixed(1)}/${(used.heapTotal / 1024 / 1024).toFixed(1)}MB`;
}

// ==================== Cluster 模式 ====================

const numWorkers = Math.max(1, CONFIG.clusterWorkers);

async function startMaster() {
  printBanner();
  console.log(`${colors.magenta}[Cluster]${colors.reset} 主进程 PID: ${process.pid}`);
  console.log(`${colors.magenta}[Cluster]${colors.reset} 启动 ${numWorkers} 个工作进程...`);
  console.log(`${colors.blue}[配置]${colors.reset} 种子: ${colors.yellow}${CONFIG.seed}${colors.reset}`);
  console.log(`${colors.blue}[配置]${colors.reset} 版本: ${colors.yellow}${CONFIG.mcVersion}${colors.reset}`);
  console.log(`${colors.blue}[配置]${colors.reset} 数据包: ${colors.yellow}${CONFIG.additionalDatapacks.length}${colors.reset} 个`);
  console.log(`${colors.blue}[配置]${colors.reset} Worker线程: ${colors.yellow}${CONFIG.computeWorkers}${colors.reset}`);
  console.log();

  // Fork 工作进程
  for (let i = 0; i < numWorkers; i++) {
    const worker = cluster.fork();
    console.log(`${colors.green}✓${colors.reset} 工作进程 #${i + 1} 已启动 (PID: ${worker.process.pid})`);
  }

  // 监听工作进程退出，自动重启
  cluster.on("exit", (worker, code, signal) => {
    console.warn(`${colors.red}✗${colors.reset} 工作进程 PID:${worker.process.pid} 退出 (code: ${code}, signal: ${signal})，正在重启...`);
    const newWorker = cluster.fork();
    console.log(`${colors.green}✓${colors.reset} 新工作进程 PID:${newWorker.process.pid} 已启动`);
  });

  console.log(`${colors.gray}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log(`${colors.bright}  所有工作进程已启动，服务运行在 ${colors.cyan}http://localhost:${CONFIG.port}${colors.reset}`);
  console.log(`${colors.gray}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
}

async function startWorker() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // 静态文件服务（仅数据包目录）
  app.use("/vanilla", express.static(CONFIG.vanillaDatapackDir));
  app.use("/datapacks", express.static(CONFIG.datapackDir));

  app.use("/api", apiRoutes);

  app.get("/health", (_req, res) => {
    const mem = process.memoryUsage();
    res.json({
      status: "ok",
      pid: process.pid,
      timestamp: new Date().toISOString(),
      memory: `${(mem.rss / 1024 / 1024).toFixed(1)}MB`,
    });
  });

  app.get("/", (_req, res) => {
    res.json({
      name: "LiteFinder",
      version: "v1.3.1",
      pid: process.pid,
      config: {
        seed: CONFIG.seed,
        mcVersion: CONFIG.mcVersion,
        datapacks: CONFIG.additionalDatapacks,
      },
      endpoints: {
        "GET /api/biome?x=&z=&y=&dimension=": "获取指定坐标的生物群系",
        "GET /api/biomes/area?minX=&minZ=&maxX=&maxZ=&y=&step=&dimension=&stream=": "获取区域内的生物群系",
        "GET /api/climate?x=&z=&y=&dimension=": "获取气候参数",
        "GET /api/find-biome?biome=&centerX=&centerZ=&y=&maxRadius=&step=&dimension=": "搜索特定生物群系",
        "GET /api/locate?biome=&x=&z=&y=&maxRadius=&step=&dimension=": "查找最近的生物群系",
        "GET /api/status": "获取服务状态",
        "GET /api/structures?dimension=": "获取结构列表",
        "GET /api/structure?x=&z=&dimension=": "获取指定坐标的结构",
        "GET /api/structures/area?x=&z=&radius=&dimension=": "获取区域内所有结构",
        "GET /api/locate/structure?structure=&x=&z=&maxRadius=&dimension=": "查找最近的结构",
        "GET /api/locate/structure/chain?structure=&x=&z=&count=&maxRadius=&dimension=": "连锁查找结构",
        "GET /api/locate/biome/chain?biome=&x=&z=&count=&maxRadius=&step=&dimension=": "连锁查找生物群系",
        "GET /health": "健康检查",
      },
      notes: [
        "dimension: minecraft:overworld | minecraft:the_nether | minecraft:the_end",
        "连锁查找支持 boundsMinX/boundsMinZ/boundsMaxX/boundsMaxZ 边界限制",
        "环境变量: SEED, MC_VERSION, PORT, RATE_LIMIT, MAX_AREA_POINTS, MAX_LOCATE_RADIUS, CLUSTER_WORKERS, COMPUTE_WORKERS",
      ],
    });
  });

  const isPrimaryWorker = !cluster.worker || cluster.worker.id === 1;

  if (isPrimaryWorker) {
    printBanner();
  }

  console.log(`${colors.blue}[Worker PID:${process.pid}]${colors.reset} 种子: ${colors.yellow}${CONFIG.seed}${colors.reset}`);
  console.log(`${colors.blue}[Worker PID:${process.pid}]${colors.reset} 数据包: ${colors.yellow}${CONFIG.additionalDatapacks.length}${colors.reset} 个`);
  console.log(`${colors.blue}[Worker PID:${process.pid}]${colors.reset} 计算Worker线程: ${colors.yellow}${CONFIG.computeWorkers}${colors.reset}`);
  console.log(`${colors.blue}[内存]${colors.reset} 启动: ${colors.yellow}${getMemoryMB()}${colors.reset}`);

  await new Promise<void>((resolve) => {
    app.listen(CONFIG.port, () => {
      console.log(`${colors.green}✓${colors.reset} [PID:${process.pid}] 服务器启动成功: ${colors.cyan}http://localhost:${CONFIG.port}${colors.reset}`);
      resolve();
    });
  });

  console.log(`${colors.magenta}[初始化]${colors.reset} [PID:${process.pid}] 正在加载数据包并初始化三个维度...`);
  const initStart = Date.now();
  try {
    await initializeCalculator();
    const initElapsed = Date.now() - initStart;
    console.log(`${colors.green}✓${colors.reset} [PID:${process.pid}] 初始化完成 (${initElapsed}ms)，服务就绪`);
    console.log(`${colors.blue}[内存]${colors.reset} [PID:${process.pid}] 就绪: ${colors.yellow}${getMemoryMB()}${colors.reset}`);

    if (isPrimaryWorker) {
      console.log();
      console.log(`${colors.gray}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
      console.log(`${colors.bright}  访问 ${colors.cyan}http://localhost:${CONFIG.port}${colors.reset}${colors.bright} 查看 API 文档${colors.reset}`);
      console.log(`${colors.gray}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
      console.log(`${colors.gray}  V8 GC: ${global.gc ? 'enabled (--expose-gc)' : 'disabled (add --expose-gc for auto GC)'}${colors.reset}`);
    }
  } catch (error) {
    console.error(`${colors.red}✗${colors.reset} [PID:${process.pid}] 初始化失败:`, error);
    process.exit(1);
  }
}

async function main() {
  if (numWorkers > 1 && cluster.isPrimary) {
    await startMaster();
  } else {
    await startWorker();
  }
}

main().catch((err) => {
  console.error(`${colors.red}Fatal error:${colors.reset}`, err);
  process.exit(1);
});