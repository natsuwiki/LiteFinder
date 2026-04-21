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
  // 世界种子
  seed: "877470420230587172",

  // Minecraft 版本
  mcVersion: "1_21_7",

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

  // 服务器端口
  port: process.env.PORT || 3000,
};
