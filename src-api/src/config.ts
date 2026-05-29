import path from "path";
import fs from "fs";

const srcApiRoot = process.cwd();
const projectRoot = path.resolve(srcApiRoot, "..");

// 自动扫描数据包目录，收集所有 zip 文件（排除原版数据包）
function scanDatapacks(dir: string, vanillaFile: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith(".zip") && f !== vanillaFile)
    .map(f => f);
}

const VANILLA_FILE = "vanilla_1_21_7.zip";
const DATAPACK_DIR = projectRoot;
const scannedDatapacks = scanDatapacks(DATAPACK_DIR, VANILLA_FILE);

console.log(`[Config] 扫描到数据包: ${scannedDatapacks.join(", ") || "无"}`);

export const CONFIG = {
  // 世界种子（可通过环境变量 SEED 覆盖）
  seed: process.env.SEED || "877470420230587172",

  // Minecraft 版本（可通过环境变量 MC_VERSION 覆盖）
  mcVersion: process.env.MC_VERSION || "1_21_7",

  // 世界预设
  worldPreset: "minecraft:normal",

  // 原版数据包文件名
  vanillaDatapackFile: VANILLA_FILE,

  // 自动扫描到的额外数据包列表
  additionalDatapacks: scannedDatapacks,

  // 原版数据包目录
  vanillaDatapackDir: path.join(projectRoot, "public", "vanilla_datapacks"),

  // 数据包目录（放置额外数据包的目录）
  datapackDir: DATAPACK_DIR,

  // 服务器端口（可通过环境变量 PORT 覆盖）
  port: parseInt(process.env.PORT || "3000", 10),

  // 请求速率限制（每窗口期最大请求数）
  rateLimit: {
    windowMs: 60_000, // 1 分钟
    max: parseInt(process.env.RATE_LIMIT || "120", 10),
  },

  // 区域查询最大面积限制（防止内存爆炸）
  maxAreaQueryPoints: parseInt(process.env.MAX_AREA_POINTS || "250000", 10),

  // 结构/生物群系查找最大半径限制
  maxLocateRadius: parseInt(process.env.MAX_LOCATE_RADIUS || "50000", 10),

  // Cluster 多进程模式（主进程 fork 子进程数量，1=禁用）
  clusterWorkers: parseInt(process.env.CLUSTER_WORKERS || "1", 10),

  // Worker 线程池大小（每个 cluster worker 内的计算线程数，0=禁用）
  computeWorkers: parseInt(process.env.COMPUTE_WORKERS || "0", 10),
};
