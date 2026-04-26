import { Router, Request, Response } from "express";
import { BiomeSource, Identifier, NoiseGeneratorSettings, Climate, RandomState } from "deepslate";
import {
  BiomeCalculator,
  DatapackLoader,
  StructureFinder,
  parseSeed,
  buildStructureDimensionMap,
  DIMENSIONS,
  type DimensionId,
} from "../core/index";
import { CONFIG } from "../config";

const router = Router();

// 每个维度各自的计算器实例
const biomeCalculators = new Map<DimensionId, BiomeCalculator>();
const structureFinders = new Map<DimensionId, StructureFinder>();

// 结构 ID → 所属维度 的映射
let structureDimensionMap = new Map<string, DimensionId>();

let datapackLoader: DatapackLoader | null = null;

export async function initializeCalculator(): Promise<void> {
  datapackLoader = new DatapackLoader(CONFIG.mcVersion);

  // 加载原版数据包
  const vanillaUrl = `http://localhost:${CONFIG.port}/vanilla/${CONFIG.vanillaDatapackFile}`;
  console.log(`Loading vanilla datapack from: ${vanillaUrl}`);
  await datapackLoader.loadVanillaDatapack(vanillaUrl);

  // 加载所有额外数据包（自动扫描）
  for (const file of CONFIG.additionalDatapacks) {
    const url = `http://localhost:${CONFIG.port}/datapacks/${encodeURIComponent(file)}`;
    console.log(`Loading datapack: ${file}`);
    try {
      await datapackLoader.addDatapackFromUrl(url);
    } catch (error) {
      console.warn(`Failed to load datapack ${file}: ${error instanceof Error ? error.message : error}`);
    }
  }

  // 先预加载三个维度的原始生物群系列表，用于结构维度反查
  const dimensionBiomeSources = new Map<string, any>();
  const worldPresetId = Identifier.parse(CONFIG.worldPreset);
  for (const dim of DIMENSIONS) {
    try {
      const dimId = Identifier.parse(dim);
      const biomeIds = await datapackLoader.getRawDimensionBiomes(dimId, worldPresetId);
      // 构造简单的 biomeIds 数组格式供 DimensionResolver 使用
      dimensionBiomeSources.set(dim, { biomes: biomeIds.map(b => ({ biome: b })) });
    } catch (e) {
      console.warn(`Failed to preload biomes for ${dim}: ${e}`);
    }
  }

  // 构建结构→维度映射
  console.log("Analyzing structure dimensions...");
  structureDimensionMap = await buildStructureDimensionMap(datapackLoader, dimensionBiomeSources);

  // 初始化三个维度
  const seedBigInt = parseSeed(CONFIG.seed);

  for (const dim of DIMENSIONS) {
    console.log(`Initializing dimension: ${dim}`);
    try {
      const dimensionId = Identifier.parse(dim);
      const dimensionData = await datapackLoader.loadDimensionAndSave(dimensionId, worldPresetId);

      // 生物群系计算器（仅用于结构查找的 sampler，不加载地形密度函数）
      const calculator = new BiomeCalculator();
      calculator.initialize({
        biomeSourceJson: dimensionData.biomeSourceJson,
        noiseGeneratorSettingsJson: dimensionData.noiseSettingsJson,
        densityFunctions: dimensionData.densityFunctions,
        noises: dimensionData.noises,
        surfaceDensityFunctionId: undefined,
        terrainDensityFunctionId: undefined,
        seed: seedBigInt,
      });
      biomeCalculators.set(dim, calculator);

      // 结构查找器（传入本维度的注册表快照，与其他维度隔离）
      const finder = new StructureFinder();
      const biomeSource = BiomeSource.fromJson(dimensionData.biomeSourceJson);
      const noiseGeneratorSettings = NoiseGeneratorSettings.fromJson(dimensionData.noiseSettingsJson);
      const randomState = new RandomState(noiseGeneratorSettings, seedBigInt);
      const sampler = Climate.Sampler.fromRouter(randomState.router);
      finder.initialize({
        biomeSource,
        sampler,
        noiseGeneratorSettings,
        levelHeight: dimensionData.levelHeight,
        seed: seedBigInt,
        structureSetsSnapshot: dimensionData.structureSetsSnapshot,
        structuresSnapshot: dimensionData.structuresSnapshot,
      });
      structureFinders.set(dim, finder);

      console.log(`  ${dim}: ${finder.getStructures().length} structures, ${finder.getStructureSets().length} structure sets`);
    } catch (error) {
      console.warn(`Failed to initialize dimension ${dim}: ${error instanceof Error ? error.message : error}`);
    }
  }

  console.log("All dimensions initialized.");
}

function isReady(): boolean {
  return biomeCalculators.size > 0 && structureFinders.size > 0;
}

/**
 * GET /api/biome
 */
router.get("/biome", (req: Request, res: Response) => {
  try {
    const dim = (req.query.dimension as DimensionId) || "minecraft:overworld";
    const calculator = biomeCalculators.get(dim);
    if (!calculator?.isInitialized()) {
      return res.status(503).json({ error: `Dimension '${dim}' not initialized` });
    }
    const x = parseInt(req.query.x as string) || 0;
    const z = parseInt(req.query.z as string) || 0;
    const y = parseInt(req.query.y as string) || 64;
    res.json(calculator.getBiomeAt(x, z, y));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

/**
 * GET /api/biomes/area
 */
router.get("/biomes/area", (req: Request, res: Response) => {
  try {
    const dim = (req.query.dimension as DimensionId) || "minecraft:overworld";
    const calculator = biomeCalculators.get(dim);
    if (!calculator?.isInitialized()) {
      return res.status(503).json({ error: `Dimension '${dim}' not initialized` });
    }
    const minX = parseInt(req.query.minX as string) || 0;
    const minZ = parseInt(req.query.minZ as string) || 0;
    const maxX = parseInt(req.query.maxX as string) || 256;
    const maxZ = parseInt(req.query.maxZ as string) || 256;
    const y = parseInt(req.query.y as string) || 64;
    const step = parseInt(req.query.step as string) || 16;
    const results = calculator.getBiomesInArea(minX, minZ, maxX, maxZ, y, step);
    res.json({ count: results.length, biomes: results });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

/**
 * GET /api/climate
 */
router.get("/climate", (req: Request, res: Response) => {
  try {
    const dim = (req.query.dimension as DimensionId) || "minecraft:overworld";
    const calculator = biomeCalculators.get(dim);
    if (!calculator?.isInitialized()) {
      return res.status(503).json({ error: `Dimension '${dim}' not initialized` });
    }
    const x = parseInt(req.query.x as string) || 0;
    const z = parseInt(req.query.z as string) || 0;
    const y = parseInt(req.query.y as string) || 64;
    const climate = calculator.getClimateAt(x, z, y);
    if (!climate) return res.status(500).json({ error: "Failed to get climate" });
    res.json({ x, z, y, ...climate });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

/**
 * GET /api/find-biome
 */
router.get("/find-biome", (req: Request, res: Response) => {
  try {
    const dim = (req.query.dimension as DimensionId) || "minecraft:overworld";
    const calculator = biomeCalculators.get(dim);
    if (!calculator?.isInitialized()) {
      return res.status(503).json({ error: `Dimension '${dim}' not initialized` });
    }
    const biome = req.query.biome as string;
    if (!biome) return res.status(400).json({ error: "biome parameter required" });
    const centerX = parseInt(req.query.centerX as string) || 0;
    const centerZ = parseInt(req.query.centerZ as string) || 0;
    const y = parseInt(req.query.y as string) || 64;
    const maxRadius = parseInt(req.query.maxRadius as string) || 6400;
    const step = parseInt(req.query.step as string) || 64;
    const result = calculator.findBiome(biome, centerX, centerZ, y, maxRadius, step);
    res.json(result ? { found: true, ...result } : { found: false, message: "Biome not found within radius" });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

/**
 * GET /api/locate
 * 支持 dimension 参数，默认主世界
 */
router.get("/locate", (req: Request, res: Response) => {
  try {
    const dim = (req.query.dimension as DimensionId) || "minecraft:overworld";
    const calculator = biomeCalculators.get(dim);
    if (!calculator?.isInitialized()) {
      return res.status(503).json({ error: `Dimension '${dim}' not initialized` });
    }
    const biome = req.query.biome as string;
    if (!biome) return res.status(400).json({ error: "biome parameter required" });
    const x = parseInt(req.query.x as string) || 0;
    const z = parseInt(req.query.z as string) || 0;
    const y = parseInt(req.query.y as string) || 64;
    const maxRadius = parseInt(req.query.maxRadius as string) || 6400;
    const step = parseInt(req.query.step as string) || 32;

    const result = findNearestBiome(calculator, biome, x, z, y, maxRadius, step);
    if (result) {
      const distance = Math.round(Math.sqrt(Math.pow(result.x - x, 2) + Math.pow(result.z - z, 2)));
      res.json({ found: true, biome: result.biome, x: result.x, z: result.z, y: result.y, distance, surface: result.surface, dimension: dim });
    } else {
      res.json({ found: false, message: `Biome '${biome}' not found within ${maxRadius} blocks` });
    }
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

/**
 * GET /api/status
 */
router.get("/status", (req: Request, res: Response) => {
  const dims: Record<string, any> = {};
  for (const dim of DIMENSIONS) {
    const calc = biomeCalculators.get(dim);
    const finder = structureFinders.get(dim);
    dims[dim] = {
      biomeCalculator: calc?.isInitialized() ?? false,
      structureFinder: finder?.isInitialized() ?? false,
      structures: finder?.getStructures().length ?? 0,
    };
  }
  res.json({
    ready: isReady(),
    seed: CONFIG.seed,
    mcVersion: CONFIG.mcVersion,
    datapacks: CONFIG.additionalDatapacks,
    dimensions: dims,
    structureDimensionMapSize: structureDimensionMap.size,
  });
});

/**
 * GET /api/structures
 * 返回所有结构及其所属维度
 */
router.get("/structures", (req: Request, res: Response) => {
  try {
    const dim = req.query.dimension as DimensionId | undefined;
    const finder = structureFinders.get(dim || "minecraft:overworld");
    if (!finder?.isInitialized()) {
      return res.status(503).json({ error: "Structure finder not initialized" });
    }

    const allStructures = finder.getStructures().map(id => ({
      id,
      dimension: structureDimensionMap.get(id) ?? "minecraft:overworld",
    }));

    const filtered = dim ? allStructures.filter(s => s.dimension === dim) : allStructures;
    const unsupported = finder.getUnsupportedStructures();

    res.json({
      structures: filtered,
      structureSets: finder.getStructureSets(),
      supportedStructureSets: finder.getSupportedStructureSets(),
      unsupportedStructures: unsupported,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

/**
 * GET /api/structure
 */
router.get("/structure", (req: Request, res: Response) => {
  try {
    const dim = (req.query.dimension as DimensionId) || "minecraft:overworld";
    const finder = structureFinders.get(dim);
    if (!finder?.isInitialized()) {
      return res.status(503).json({ error: `Dimension '${dim}' not initialized` });
    }
    const x = parseInt(req.query.x as string) || 0;
    const z = parseInt(req.query.z as string) || 0;
    const result = finder.getStructureAt(x, z);
    res.json(result ? { found: true, dimension: dim, ...result } : { found: false, message: "No structure at this location" });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

/**
 * GET /api/structures/area
 */
router.get("/structures/area", (req: Request, res: Response) => {
  try {
    const dim = (req.query.dimension as DimensionId) || "minecraft:overworld";
    const finder = structureFinders.get(dim);
    if (!finder?.isInitialized()) {
      return res.status(503).json({ error: `Dimension '${dim}' not initialized` });
    }
    const x = parseInt(req.query.x as string) || 0;
    const z = parseInt(req.query.z as string) || 0;
    const radius = parseInt(req.query.radius as string) || 1000;
    const results = finder.getStructuresInArea(x, z, radius);
    res.json({ count: results.length, centerX: x, centerZ: z, radius, dimension: dim, structures: results });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

/**
 * GET /api/locate/structure
 * 自动根据结构 ID 路由到正确维度，也可手动指定 dimension 参数覆盖
 */
router.get("/locate/structure", (req: Request, res: Response) => {
  try {
    if (!isReady()) {
      return res.status(503).json({ error: "Not initialized" });
    }

    const structure = req.query.structure as string;
    if (!structure) return res.status(400).json({ error: "structure parameter required" });

    const x = parseInt(req.query.x as string) || 0;
    const z = parseInt(req.query.z as string) || 0;
    const maxRadius = parseInt(req.query.maxRadius as string) || 10000;

    // 自动判断维度，可被 dimension 参数覆盖
    const autoDim = structureDimensionMap.get(structure) ?? "minecraft:overworld";
    const dim = (req.query.dimension as DimensionId) || autoDim;

    const finder = structureFinders.get(dim);
    if (!finder?.isInitialized()) {
      return res.status(503).json({ error: `Dimension '${dim}' not initialized` });
    }

    const result = finder.findNearestStructure(structure, x, z, maxRadius);
    if (result) {
      res.json({ found: true, dimension: dim, autoDimension: autoDim, ...result });
    } else {
      res.json({ found: false, dimension: dim, message: `Structure '${structure}' not found within ${maxRadius} blocks` });
    }
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

function findNearestBiome(
  calculator: BiomeCalculator,
  targetBiome: string,
  centerX: number,
  centerZ: number,
  y: number,
  maxRadius: number,
  step: number
): ReturnType<BiomeCalculator["getBiomeAt"]> | null {
  const center = calculator.getBiomeAt(centerX, centerZ, y);
  if (center.biome === targetBiome) return center;

  for (let radius = step; radius <= maxRadius; radius += step) {
    for (let dx = -radius; dx <= radius; dx += step) {
      const top = calculator.getBiomeAt(centerX + dx, centerZ - radius, y);
      if (top.biome === targetBiome) return top;
      const bot = calculator.getBiomeAt(centerX + dx, centerZ + radius, y);
      if (bot.biome === targetBiome) return bot;
    }
    for (let dz = -radius + step; dz < radius; dz += step) {
      const left = calculator.getBiomeAt(centerX - radius, centerZ + dz, y);
      if (left.biome === targetBiome) return left;
      const right = calculator.getBiomeAt(centerX + radius, centerZ + dz, y);
      if (right.biome === targetBiome) return right;
    }
  }
  return null;
}

export default router;
