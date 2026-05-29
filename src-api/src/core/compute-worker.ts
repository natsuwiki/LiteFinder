/**
 * Compute Worker Script
 * 
 * 运行在独立 Worker 线程中，接收计算任务并返回结果。
 * 每个 Worker 独立初始化 deepslate 注册表和计算器实例。
 * 
 * 注意：由于 deepslate 使用全局注册表，Worker 线程有自己独立的模块实例，
 * 因此不会与主线程冲突。
 */

import { parentPort, workerData } from "node:worker_threads";
import {
  BiomeSource,
  Identifier,
  NoiseGeneratorSettings,
  Climate,
  RandomState,
  DensityFunction,
  Holder,
  NoiseParameters,
  WorldgenRegistries,
  StructureSet,
  WorldgenStructure,
  StructureTemplatePool,
  HolderSet,
} from "deepslate";
import type { BiomeResult } from "./BiomeCalculator";
import type { StructureResult } from "./StructureFinder";
import { BiomeCalculator } from "./BiomeCalculator";
import { StructureFinder } from "./StructureFinder";
import { parseSeed } from "./utils";

// Worker 初始化数据
interface WorkerInitData {
  seed: string;
  dimensions: Array<{
    dim: string;
    biomeSourceJson: unknown;
    noiseSettingsJson: unknown;
    densityFunctions: Record<string, unknown>;
    noises: Record<string, unknown>;
    levelHeight: { minY: number; height: number };
    structuresJson: [string, unknown][];
    structureSetsJson: [string, unknown][];
    biomeTagsJson?: [string, unknown][];
  }>;
}

// 任务类型
interface BiomeAreaTask {
  type: "biomeArea";
  id: number;
  dim: string;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  y: number;
  step: number;
  maxPoints: number;
}

interface LocateBiomeTask {
  type: "locateBiome";
  id: number;
  dim: string;
  biome: string;
  centerX: number;
  centerZ: number;
  y: number;
  maxRadius: number;
  step: number;
}

interface StructuresAreaTask {
  type: "structuresArea";
  id: number;
  dim: string;
  centerX: number;
  centerZ: number;
  radius: number;
}

type Task = BiomeAreaTask | LocateBiomeTask | StructuresAreaTask;

// Worker 状态
const biomeCalculators = new Map<string, BiomeCalculator>();
const structureFinders = new Map<string, StructureFinder>();
let initialized = false;

function initializeWorker(data: WorkerInitData): void {
  const seedBigInt = parseSeed(data.seed);

  for (const dimData of data.dimensions) {
    const dim = dimData.dim;

    // 注册密度函数和噪声（首次注册后后续共享）
    if (!initialized) {
      WorldgenRegistries.DENSITY_FUNCTION.clear();
      for (const id in dimData.densityFunctions) {
        try {
          const df = new DensityFunction.HolderHolder(
            Holder.parser(WorldgenRegistries.DENSITY_FUNCTION, DensityFunction.fromJson)(dimData.densityFunctions[id])
          );
          WorldgenRegistries.DENSITY_FUNCTION.register(Identifier.parse(id), df);
        } catch (_e) { /* skip */ }
      }

      WorldgenRegistries.NOISE.clear();
      for (const id in dimData.noises) {
        try {
          const noise = NoiseParameters.fromJson(dimData.noises[id]);
          WorldgenRegistries.NOISE.register(Identifier.parse(id), noise);
        } catch (_e) { /* skip */ }
      }

      // 注册生物群系标签（如果提供）
      if (dimData.biomeTagsJson) {
        for (const [idStr, data] of dimData.biomeTagsJson) {
          try {
            const id = Identifier.parse(idStr);
            HolderSet.fromJson(WorldgenRegistries.BIOME, data, id);
          } catch (_e) { /* skip */ }
        }
      }
    }

    // 初始化生物群系计算器
    const calculator = new BiomeCalculator();
    calculator.initialize({
      biomeSourceJson: dimData.biomeSourceJson,
      noiseGeneratorSettingsJson: dimData.noiseSettingsJson,
      densityFunctions: undefined, // 已注册
      noises: undefined,
      seed: seedBigInt,
    });
    biomeCalculators.set(dim, calculator);

    // 初始化结构查找器
    // 从 JSON 重建结构注册表快照
    WorldgenStructure.REGISTRY.clear();
    for (const [idStr, jsonData] of dimData.structuresJson) {
      try {
        const id = Identifier.parse(idStr);
        const root = jsonData as Record<string, unknown>;
        delete root.dimension_padding;
        delete root.start_jigsaw_name;
        WorldgenStructure.REGISTRY.register(id, WorldgenStructure.fromJson(root));
      } catch (_e) { /* skip */ }
    }

    StructureSet.REGISTRY.clear();
    for (const [idStr, jsonData] of dimData.structureSetsJson) {
      try {
        const id = Identifier.parse(idStr);
        StructureSet.REGISTRY.register(id, StructureSet.fromJson(jsonData));
      } catch (_e) { /* skip */ }
    }

    const structuresSnapshot = new Map<string, WorldgenStructure>();
    for (const id of WorldgenStructure.REGISTRY.keys()) {
      const s = WorldgenStructure.REGISTRY.get(id);
      if (s) structuresSnapshot.set(id.toString(), s);
    }
    const structureSetsSnapshot = new Map<string, StructureSet>();
    for (const id of StructureSet.REGISTRY.keys()) {
      const set = StructureSet.REGISTRY.get(id);
      if (set) structureSetsSnapshot.set(id.toString(), set);
    }

    const biomeSource = BiomeSource.fromJson(dimData.biomeSourceJson);
    const noiseGeneratorSettings = NoiseGeneratorSettings.fromJson(dimData.noiseSettingsJson);
    const randomState = new RandomState(noiseGeneratorSettings, seedBigInt);
    const sampler = Climate.Sampler.fromRouter(randomState.router);

    const finder = new StructureFinder();
    finder.initialize({
      biomeSource,
      sampler,
      noiseGeneratorSettings,
      levelHeight: dimData.levelHeight,
      seed: seedBigInt,
      structureSetsSnapshot,
      structuresSnapshot,
    });
    structureFinders.set(dim, finder);
  }

  initialized = true;
}

function handleTask(task: Task): unknown {
  switch (task.type) {
    case "biomeArea": {
      const calculator = biomeCalculators.get(task.dim);
      if (!calculator?.isInitialized()) {
        throw new Error(`Dimension ${task.dim} not initialized`);
      }
      const results: BiomeResult[] = [];
      let actualStep = task.step;
      const rangeX = task.maxX - task.minX;
      const rangeZ = task.maxZ - task.minZ;
      if (rangeX > 0 && rangeZ > 0) {
        const estimatedPoints = (Math.floor(rangeX / actualStep) + 1) * (Math.floor(rangeZ / actualStep) + 1);
        if (estimatedPoints > task.maxPoints) {
          actualStep = Math.ceil(Math.sqrt((rangeX * rangeZ) / task.maxPoints));
          actualStep = Math.max(actualStep, task.step);
        }
      }
      for (let x = task.minX; x <= task.maxX; x += actualStep) {
        for (let z = task.minZ; z <= task.maxZ; z += actualStep) {
          results.push(calculator.getBiomeAt(x, z, task.y));
        }
      }
      return { count: results.length, biomes: results, step: actualStep };
    }

    case "locateBiome": {
      const calculator = biomeCalculators.get(task.dim);
      if (!calculator?.isInitialized()) {
        throw new Error(`Dimension ${task.dim} not initialized`);
      }
      // 两阶段搜索
      const center = calculator.getBiomeAt(task.centerX, task.centerZ, task.y);
      if (center.biome === task.biome) {
        return { found: true, ...center };
      }
      const coarseStep = task.step * 8;
      for (let radius = coarseStep; radius <= task.maxRadius; radius += coarseStep) {
        for (let dx = -radius; dx <= radius; dx += coarseStep) {
          const top = calculator.getBiomeAt(task.centerX + dx, task.centerZ - radius, task.y);
          if (top.biome === task.biome) return { found: true, ...top };
          const bot = calculator.getBiomeAt(task.centerX + dx, task.centerZ + radius, task.y);
          if (bot.biome === task.biome) return { found: true, ...bot };
        }
        for (let dz = -radius + coarseStep; dz < radius; dz += coarseStep) {
          const left = calculator.getBiomeAt(task.centerX - radius, task.centerZ + dz, task.y);
          if (left.biome === task.biome) return { found: true, ...left };
          const right = calculator.getBiomeAt(task.centerX + radius, task.centerZ + dz, task.y);
          if (right.biome === task.biome) return { found: true, ...right };
        }
      }
      // 精细搜索
      for (let radius = task.step; radius <= task.maxRadius; radius += task.step) {
        for (let dx = -radius; dx <= radius; dx += task.step) {
          const top = calculator.getBiomeAt(task.centerX + dx, task.centerZ - radius, task.y);
          if (top.biome === task.biome) return { found: true, ...top };
          const bot = calculator.getBiomeAt(task.centerX + dx, task.centerZ + radius, task.y);
          if (bot.biome === task.biome) return { found: true, ...bot };
        }
        for (let dz = -radius + task.step; dz < radius; dz += task.step) {
          const left = calculator.getBiomeAt(task.centerX - radius, task.centerZ + dz, task.y);
          if (left.biome === task.biome) return { found: true, ...left };
          const right = calculator.getBiomeAt(task.centerX + radius, task.centerZ + dz, task.y);
          if (right.biome === task.biome) return { found: true, ...right };
        }
      }
      return { found: false };
    }

    case "structuresArea": {
      const finder = structureFinders.get(task.dim);
      if (!finder?.isInitialized()) {
        throw new Error(`Dimension ${task.dim} not initialized`);
      }
      const results: StructureResult[] = finder.getStructuresInArea(task.centerX, task.centerZ, task.radius);
      return { count: results.length, structures: results };
    }

    default:
      throw new Error(`Unknown task type: ${(task as Task).type}`);
  }
}

// 监听主线程消息
if (workerData) {
  try {
    initializeWorker(workerData as WorkerInitData);
    parentPort?.postMessage({ type: "ready" });
  } catch (err) {
    parentPort?.postMessage({ type: "error", error: (err as Error).message });
  }
}

parentPort?.on("message", (task: Task) => {
  try {
    const data = handleTask(task);
    parentPort?.postMessage({ id: task.id, data });
  } catch (err) {
    parentPort?.postMessage({ id: task.id, error: (err as Error).message });
  }
});