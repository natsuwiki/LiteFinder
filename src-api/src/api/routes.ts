import { Router, Request, Response, NextFunction } from "express";
import { BiomeSource, Identifier, NoiseGeneratorSettings, Climate, RandomState } from "deepslate";
import {
  BiomeCalculator,
  DatapackLoader,
  StructureFinder,
  WorkerPool,
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

// Worker 线程池（可选，由 COMPUTE_WORKERS 环境变量控制）
let workerPool: WorkerPool | null = null;

// 请求计数器
let requestCount = 0;
const serverStartTime = Date.now();

// ==================== 输入校验工具 ====================

function parseParamInt(value: string | undefined, defaultValue: number, min?: number, max?: number): number {
  if (value === undefined || value === "") return defaultValue;
  const num = Number(value);
  if (!Number.isFinite(num)) return defaultValue;
  const rounded = Math.trunc(num);
  if (min !== undefined && rounded < min) return min;
  if (max !== undefined && rounded > max) return max;
  return rounded;
}

function parseDimension(value: string | undefined): DimensionId {
  const dim = value || "minecraft:overworld";
  if ((DIMENSIONS as readonly string[]).includes(dim)) {
    return dim as DimensionId;
  }
  return "minecraft:overworld";
}

function clampRadius(radius: number, max: number): number {
  return Math.min(Math.max(radius, 1), max);
}

// ==================== 地图边界 ====================

interface MapBounds {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

function parseBounds(req: Request): MapBounds | null {
  const bMinX = req.query.boundsMinX as string | undefined;
  const bMinZ = req.query.boundsMinZ as string | undefined;
  const bMaxX = req.query.boundsMaxX as string | undefined;
  const bMaxZ = req.query.boundsMaxZ as string | undefined;

  if (bMinX === undefined || bMinZ === undefined || bMaxX === undefined || bMaxZ === undefined) {
    return null;
  }

  const minX = parseParamInt(bMinX, 0);
  const minZ = parseParamInt(bMinZ, 0);
  const maxX = parseParamInt(bMaxX, 0);
  const maxZ = parseParamInt(bMaxZ, 0);

  return {
    minX: Math.min(minX, maxX),
    minZ: Math.min(minZ, maxZ),
    maxX: Math.max(minX, maxX),
    maxZ: Math.max(minZ, maxZ),
  };
}

function clampRadiusToBounds(centerX: number, centerZ: number, radius: number, bounds: MapBounds | null): number {
  if (!bounds) return radius;
  const maxDistX = Math.max(Math.abs(bounds.maxX - centerX), Math.abs(bounds.minX - centerX));
  const maxDistZ = Math.max(Math.abs(bounds.maxZ - centerZ), Math.abs(bounds.minZ - centerZ));
  return Math.min(radius, Math.max(maxDistX, maxDistZ));
}

function isInBounds(x: number, z: number, bounds: MapBounds | null): boolean {
  if (!bounds) return true;
  return x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ;
}

// ==================== 初始化 ====================

export async function initializeCalculator(): Promise<void> {
  datapackLoader = new DatapackLoader(CONFIG.mcVersion);

  const vanillaUrl = `http://localhost:${CONFIG.port}/vanilla/${CONFIG.vanillaDatapackFile}`;
  console.log(`Loading vanilla datapack from: ${vanillaUrl}`);
  await datapackLoader.loadVanillaDatapack(vanillaUrl);

  for (const file of CONFIG.additionalDatapacks) {
    const url = `http://localhost:${CONFIG.port}/datapacks/${encodeURIComponent(file)}`;
    console.log(`Loading datapack: ${file}`);
    try {
      await datapackLoader.addDatapackFromUrl(url);
    } catch (error) {
      console.warn(`Failed to load datapack ${file}: ${error instanceof Error ? error.message : error}`);
    }
  }

  const dimensionBiomeSources = new Map<string, any>();
  const worldPresetId = Identifier.parse(CONFIG.worldPreset);
  for (const dim of DIMENSIONS) {
    try {
      const dimId = Identifier.parse(dim);
      const biomeIds = await datapackLoader.getRawDimensionBiomes(dimId, worldPresetId);
      dimensionBiomeSources.set(dim, { biomes: biomeIds.map(b => ({ biome: b })) });
    } catch (e) {
      console.warn(`Failed to preload biomes for ${dim}: ${e}`);
    }
  }

  console.log("Analyzing structure dimensions...");
  structureDimensionMap = await buildStructureDimensionMap(datapackLoader, dimensionBiomeSources);
  dimensionBiomeSources.clear();

  const seedBigInt = parseSeed(CONFIG.seed);
  const initStart = Date.now();

  // 阶段1：顺序加载维度数据（避免 registerResources 竞态）
  const dimensionDataList: Array<{ dim: DimensionId; data: Awaited<ReturnType<NonNullable<typeof datapackLoader>["loadDimensionAndSave"]>> }> = [];
  for (const dim of DIMENSIONS) {
    try {
      const dimensionId = Identifier.parse(dim);
      const data = await datapackLoader!.loadDimensionAndSave(dimensionId, worldPresetId);
      dimensionDataList.push({ dim, data });
    } catch (error) {
      console.warn(`Failed to load dimension data for ${dim}: ${error instanceof Error ? error.message : error}`);
    }
  }

  // 阶段2：并行初始化计算器
  const initResults = await Promise.allSettled(
    dimensionDataList.map(async ({ dim, data: dimensionData }) => {
      const calculator = new BiomeCalculator();
      calculator.initialize({
        biomeSourceJson: dimensionData.biomeSourceJson,
        noiseGeneratorSettingsJson: dimensionData.noiseSettingsJson,
        densityFunctions: undefined,
        noises: undefined,
        surfaceDensityFunctionId: undefined,
        terrainDensityFunctionId: undefined,
        seed: seedBigInt,
      });

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

      return { dim, calculator, finder };
    })
  );

  for (const result of initResults) {
    if (result.status === "fulfilled") {
      const { dim, calculator, finder } = result.value;
      biomeCalculators.set(dim, calculator);
      structureFinders.set(dim, finder);
      console.log(`  ${dim}: ${finder.getStructures().length} structures, ${finder.getStructureSets().length} structure sets`);
    } else {
      console.warn(`Failed to initialize dimension: ${result.reason}`);
    }
  }

  const initElapsed = Date.now() - initStart;
  console.log(`All dimensions initialized in ${initElapsed}ms.`);

  if (datapackLoader) {
    datapackLoader.cleanup();
    datapackLoader = null;
  }

  if (global.gc) {
    global.gc();
    console.log("[Memory] 已触发垃圾回收");
  }

  if (CONFIG.computeWorkers > 0) {
    try {
      workerPool = new WorkerPool(CONFIG.computeWorkers, "compute-worker.js");
      await workerPool.initialize();
      console.log(`[WorkerPool] ${CONFIG.computeWorkers} compute workers initialized`);
    } catch (error) {
      console.warn(`[WorkerPool] Failed to initialize: ${error instanceof Error ? error.message : error}`);
      workerPool = null;
    }
  }
}

function isReady(): boolean {
  return biomeCalculators.size > 0 && structureFinders.size > 0;
}

// ==================== 限流中间件 ====================

const requestTimestamps: number[] = [];

function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  const now = Date.now();
  const windowStart = now - CONFIG.rateLimit.windowMs;

  while (requestTimestamps.length > 0 && requestTimestamps[0] <= windowStart) {
    requestTimestamps.shift();
  }

  if (requestTimestamps.length >= CONFIG.rateLimit.max) {
    res.status(429).json({
      error: "Too many requests",
      retryAfter: Math.ceil((requestTimestamps[0] + CONFIG.rateLimit.windowMs - now) / 1000),
    });
    return;
  }

  requestTimestamps.push(now);
  requestCount++;
  next();
}

router.use(rateLimitMiddleware);

// ==================== API 路由 ====================

router.get("/biome", (req: Request, res: Response) => {
  try {
    const dim = parseDimension(req.query.dimension as string);
    const calculator = biomeCalculators.get(dim);
    if (!calculator?.isInitialized()) {
      return res.status(503).json({ error: `Dimension '${dim}' not initialized` });
    }
    const x = parseParamInt(req.query.x as string, 0);
    const z = parseParamInt(req.query.z as string, 0);
    const y = parseParamInt(req.query.y as string, 64, -64, 319);
    res.json(calculator.getBiomeAt(x, z, y));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

router.get("/biomes/area", (req: Request, res: Response) => {
  try {
    const dim = parseDimension(req.query.dimension as string);
    const calculator = biomeCalculators.get(dim);
    if (!calculator?.isInitialized()) {
      return res.status(503).json({ error: `Dimension '${dim}' not initialized` });
    }
    const minX = parseParamInt(req.query.minX as string, 0);
    const minZ = parseParamInt(req.query.minZ as string, 0);
    const maxX = parseParamInt(req.query.maxX as string, 256);
    const maxZ = parseParamInt(req.query.maxZ as string, 256);
    const y = parseParamInt(req.query.y as string, 64, -64, 319);
    const step = parseParamInt(req.query.step as string, 16, 1);
    const useStream = req.query.stream === "true";

    const rangeX = Math.abs(maxX - minX);
    const rangeZ = Math.abs(maxZ - minZ);
    if (rangeX > 100000 || rangeZ > 100000) {
      return res.status(400).json({ error: "Query range too large (max 100000 blocks per axis)" });
    }

    let actualStep = step;
    const estimatedPoints = (Math.floor(rangeX / actualStep) + 1) * (Math.floor(rangeZ / actualStep) + 1);
    if (estimatedPoints > CONFIG.maxAreaQueryPoints) {
      actualStep = Math.ceil(Math.sqrt((rangeX * rangeZ) / CONFIG.maxAreaQueryPoints));
      actualStep = Math.max(actualStep, step);
    }

    if (useStream) {
      res.setHeader("Content-Type", "application/x-ndjson");
      res.setHeader("Transfer-Encoding", "chunked");
      res.setHeader("Cache-Control", "no-cache");

      let count = 0;
      res.write(JSON.stringify({ _meta: true, minX, minZ, maxX, maxZ, y, step: actualStep, dimension: dim }) + "\n");

      for (let x = minX; x <= maxX; x += actualStep) {
        for (let z = minZ; z <= maxZ; z += actualStep) {
          const result = calculator.getBiomeAt(x, z, y);
          res.write(JSON.stringify(result) + "\n");
          count++;
        }
      }

      res.write(JSON.stringify({ _done: true, count }) + "\n");
      res.end();
    } else {
      const results = calculator.getBiomesInArea(minX, minZ, maxX, maxZ, y, step, CONFIG.maxAreaQueryPoints);
      res.json({ count: results.length, biomes: results, step: actualStep });
    }
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

router.get("/climate", (req: Request, res: Response) => {
  try {
    const dim = parseDimension(req.query.dimension as string);
    const calculator = biomeCalculators.get(dim);
    if (!calculator?.isInitialized()) {
      return res.status(503).json({ error: `Dimension '${dim}' not initialized` });
    }
    const x = parseParamInt(req.query.x as string, 0);
    const z = parseParamInt(req.query.z as string, 0);
    const y = parseParamInt(req.query.y as string, 64, -64, 319);
    const climate = calculator.getClimateAt(x, z, y);
    if (!climate) return res.status(500).json({ error: "Failed to get climate" });
    res.json({ x, z, y, ...climate });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

router.get("/find-biome", (req: Request, res: Response) => {
  try {
    const dim = parseDimension(req.query.dimension as string);
    const calculator = biomeCalculators.get(dim);
    if (!calculator?.isInitialized()) {
      return res.status(503).json({ error: `Dimension '${dim}' not initialized` });
    }
    const biome = req.query.biome as string;
    if (!biome) return res.status(400).json({ error: "biome parameter required" });
    const centerX = parseParamInt(req.query.centerX as string, 0);
    const centerZ = parseParamInt(req.query.centerZ as string, 0);
    const y = parseParamInt(req.query.y as string, 64, -64, 319);
    const maxRadius = clampRadius(parseParamInt(req.query.maxRadius as string, 6400), CONFIG.maxLocateRadius);
    const step = parseParamInt(req.query.step as string, 64, 1);
    const result = calculator.findBiome(biome, centerX, centerZ, y, maxRadius, step);
    res.json(result ? { found: true, ...result } : { found: false, message: "Biome not found within radius" });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

router.get("/locate", (req: Request, res: Response) => {
  try {
    const dim = parseDimension(req.query.dimension as string);
    const calculator = biomeCalculators.get(dim);
    if (!calculator?.isInitialized()) {
      return res.status(503).json({ error: `Dimension '${dim}' not initialized` });
    }
    const biome = req.query.biome as string;
    if (!biome) return res.status(400).json({ error: "biome parameter required" });
    const x = parseParamInt(req.query.x as string, 0);
    const z = parseParamInt(req.query.z as string, 0);
    const y = parseParamInt(req.query.y as string, 64, -64, 319);
    const maxRadius = clampRadius(parseParamInt(req.query.maxRadius as string, 6400), CONFIG.maxLocateRadius);
    const step = parseParamInt(req.query.step as string, 32, 1);

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

router.get("/status", (_req: Request, res: Response) => {
  const memUsage = process.memoryUsage();
  const dims: Record<string, any> = {};
  for (const dim of DIMENSIONS) {
    const calc = biomeCalculators.get(dim);
    const finder = structureFinders.get(dim);
    dims[dim] = {
      biomeCalculator: calc?.isInitialized() ?? false,
      structureFinder: finder?.isInitialized() ?? false,
      structures: finder?.getStructures().length ?? 0,
      unsupportedStructures: finder?.getUnsupportedStructures().length ?? 0,
    };
  }

  res.json({
    ready: isReady(),
    seed: CONFIG.seed,
    mcVersion: CONFIG.mcVersion,
    datapacks: CONFIG.additionalDatapacks,
    dimensions: dims,
    structureDimensionMapSize: structureDimensionMap.size,
    memory: {
      rss: `${(memUsage.rss / 1024 / 1024).toFixed(1)}MB`,
      heapUsed: `${(memUsage.heapUsed / 1024 / 1024).toFixed(1)}MB`,
      heapTotal: `${(memUsage.heapTotal / 1024 / 1024).toFixed(1)}MB`,
    },
    uptime: `${((Date.now() - serverStartTime) / 1000).toFixed(0)}s`,
    requestCount,
    gcEnabled: !!global.gc,
  });
});

router.get("/structures", (req: Request, res: Response) => {
  try {
    const dim = parseDimension(req.query.dimension as string);
    const finder = structureFinders.get(dim);
    if (!finder?.isInitialized()) {
      return res.status(503).json({ error: "Structure finder not initialized" });
    }

    const allStructures = finder.getStructures().map(id => ({
      id,
      dimension: structureDimensionMap.get(id) ?? "minecraft:overworld",
    }));

    const filtered = allStructures.filter(s => s.dimension === dim);
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

router.get("/structure", (req: Request, res: Response) => {
  try {
    const dim = parseDimension(req.query.dimension as string);
    const finder = structureFinders.get(dim);
    if (!finder?.isInitialized()) {
      return res.status(503).json({ error: `Dimension '${dim}' not initialized` });
    }
    const x = parseParamInt(req.query.x as string, 0);
    const z = parseParamInt(req.query.z as string, 0);
    const result = finder.getStructureAt(x, z);
    res.json(result ? { found: true, dimension: dim, ...result } : { found: false, message: "No structure at this location" });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

router.get("/structures/area", (req: Request, res: Response) => {
  try {
    const dim = parseDimension(req.query.dimension as string);
    const finder = structureFinders.get(dim);
    if (!finder?.isInitialized()) {
      return res.status(503).json({ error: `Dimension '${dim}' not initialized` });
    }
    const x = parseParamInt(req.query.x as string, 0);
    const z = parseParamInt(req.query.z as string, 0);
    const radius = clampRadius(parseParamInt(req.query.radius as string, 1000), CONFIG.maxLocateRadius);
    const results = finder.getStructuresInArea(x, z, radius);
    res.json({ count: results.length, centerX: x, centerZ: z, radius, dimension: dim, structures: results });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

router.get("/locate/structure", (req: Request, res: Response) => {
  try {
    if (!isReady()) {
      return res.status(503).json({ error: "Not initialized" });
    }

    const structure = req.query.structure as string;
    if (!structure) return res.status(400).json({ error: "structure parameter required" });

    const x = parseParamInt(req.query.x as string, 0);
    const z = parseParamInt(req.query.z as string, 0);
    const maxRadius = clampRadius(parseParamInt(req.query.maxRadius as string, 10000), CONFIG.maxLocateRadius);

    const autoDim = structureDimensionMap.get(structure) ?? "minecraft:overworld";
    const dim = (req.query.dimension as DimensionId) || autoDim;

    const finder = structureFinders.get(dim);
    if (!finder?.isInitialized()) {
      return res.status(503).json({ error: `Dimension '${dim}' not initialized` });
    }

    const bounds = parseBounds(req);
    const effectiveRadius = clampRadiusToBounds(x, z, maxRadius, bounds);
    const result = finder.findNearestStructure(structure, x, z, effectiveRadius);
    if (result && isInBounds(result.x, result.z, bounds)) {
      res.json({ found: true, dimension: dim, autoDimension: autoDim, bounds: bounds ?? undefined, ...result });
    } else {
      res.json({ found: false, dimension: dim, bounds: bounds ?? undefined, message: `Structure '${structure}' not found within ${maxRadius} blocks` });
    }
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

// ==================== 连锁查找结构 ====================

router.get("/locate/structure/chain", (req: Request, res: Response) => {
  try {
    if (!isReady()) {
      return res.status(503).json({ error: "Not initialized" });
    }

    const structure = req.query.structure as string;
    if (!structure) return res.status(400).json({ error: "structure parameter required" });

    const startX = parseParamInt(req.query.x as string, 0);
    const startZ = parseParamInt(req.query.z as string, 0);
    const count = Math.min(Math.max(parseParamInt(req.query.count as string, 3, 1), 1), 20);
    const maxRadius = clampRadius(parseParamInt(req.query.maxRadius as string, 20000), CONFIG.maxLocateRadius);
    const bounds = parseBounds(req);

    const autoDim = structureDimensionMap.get(structure) ?? "minecraft:overworld";
    const dim = (req.query.dimension as DimensionId) || autoDim;

    const finder = structureFinders.get(dim);
    if (!finder?.isInitialized()) {
      return res.status(503).json({ error: `Dimension '${dim}' not initialized` });
    }

    const chain: Array<{
      index: number;
      x: number;
      z: number;
      distance: number;
      chunkX: number;
      chunkZ: number;
      structureId: string;
      inBounds: boolean;
    }> = [];

    let currentX = startX;
    let currentZ = startZ;
    let totalDistance = 0;
    const foundPositions: Array<{ x: number; z: number }> = [];

    for (let i = 0; i < count; i++) {


      const effectiveRadius = clampRadiusToBounds(currentX, currentZ, maxRadius, bounds);
      const result = finder.findNearestStructure(structure, currentX, currentZ, effectiveRadius, foundPositions);
      if (!result) break;
      if (!isInBounds(result.x, result.z, bounds)) {
        currentX = Math.max(bounds?.minX ?? -Infinity, Math.min(result.x, bounds?.maxX ?? Infinity));
        currentZ = Math.max(bounds?.minZ ?? -Infinity, Math.min(result.z, bounds?.maxZ ?? Infinity));
        continue;
      }

      // 通过距离为0判断是否找到的是同一个结构（双重保护）
      if (result.distance === 0 && chain.length > 0) break;

      totalDistance += result.distance ?? 0;
      chain.push({
        index: chain.length + 1,
        x: result.x,
        z: result.z,
        distance: result.distance ?? 0,
        chunkX: result.chunkX,
        chunkZ: result.chunkZ,
        structureId: result.structureId,
        inBounds: true,
      });

      foundPositions.push({ x: result.x, z: result.z, chunkX: result.chunkX, chunkZ: result.chunkZ });
      currentX = result.x;
      currentZ = result.z;
    }

    if (chain.length === 0) {
      res.json({
        found: false,
        message: `Structure '${structure}' not found within ${maxRadius} blocks of (${startX}, ${startZ})`,
        dimension: dim,
        bounds: bounds ?? undefined,
      });
    } else {
      res.json({
        found: true,
        structure,
        dimension: dim,
        autoDimension: autoDim,
        start: { x: startX, z: startZ },
        count: chain.length,
        requestedCount: count,
        totalDistance,
        maxRadius,
        bounds: bounds ?? undefined,
        chain,
      });
    }
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

// ==================== 连锁查找生物群系 ====================

router.get("/locate/biome/chain", (req: Request, res: Response) => {
  try {
    const dim = parseDimension(req.query.dimension as string);
    const calculator = biomeCalculators.get(dim);
    if (!calculator?.isInitialized()) {
      return res.status(503).json({ error: `Dimension '${dim}' not initialized` });
    }

    const biome = req.query.biome as string;
    if (!biome) return res.status(400).json({ error: "biome parameter required" });

    const startX = parseParamInt(req.query.x as string, 0);
    const startZ = parseParamInt(req.query.z as string, 0);
    const y = parseParamInt(req.query.y as string, 64, -64, 319);
    const count = Math.min(Math.max(parseParamInt(req.query.count as string, 3, 1), 1), 20);
    const maxRadius = clampRadius(parseParamInt(req.query.maxRadius as string, 20000), CONFIG.maxLocateRadius);
    const step = parseParamInt(req.query.step as string, 32, 1);
    const bounds = parseBounds(req);

    const chain: Array<{
      index: number;
      x: number;
      z: number;
      y: number;
      distance: number;
      biome: string;
      inBounds: boolean;
    }> = [];

    let currentX = startX;
    let currentZ = startZ;
    let totalDistance = 0;

    for (let i = 0; i < count; i++) {
      

      const effectiveRadius = clampRadiusToBounds(currentX, currentZ, maxRadius, bounds);
      const result = findNearestBiome(calculator, biome, currentX, currentZ, y, effectiveRadius, step, chain.length > 0);
      if (!result) break;

      const distance = Math.round(Math.sqrt(Math.pow(result.x - currentX, 2) + Math.pow(result.z - currentZ, 2)));
      if (distance === 0 && chain.length > 0) break;
            if (!isInBounds(result.x, result.z, bounds)) {
        currentX = Math.max(bounds?.minX ?? -Infinity, Math.min(result.x, bounds?.maxX ?? Infinity));
        currentZ = Math.max(bounds?.minZ ?? -Infinity, Math.min(result.z, bounds?.maxZ ?? Infinity));
        continue;
      }

      totalDistance += distance;
      chain.push({
        index: chain.length + 1,
        x: result.x,
        z: result.z,
        y: result.y,
        distance,
        biome: result.biome,
        inBounds: true,
      });

      currentX = result.x;
      currentZ = result.z;
    }

    if (chain.length === 0) {
      res.json({
        found: false,
        message: `Biome '${biome}' not found within ${maxRadius} blocks of (${startX}, ${startZ})`,
        dimension: dim,
        bounds: bounds ?? undefined,
      });
    } else {
      res.json({
        found: true,
        biome,
        dimension: dim,
        start: { x: startX, z: startZ, y },
        count: chain.length,
        requestedCount: count,
        totalDistance,
        maxRadius,
        bounds: bounds ?? undefined,
        chain,
      });
    }
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

// ==================== 内部辅助函数 ====================

function findNearestBiome(
  calculator: BiomeCalculator,
  targetBiome: string,
  centerX: number,
  centerZ: number,
  y: number,
  maxRadius: number,
  step: number,
  skipCenter: boolean = false
): ReturnType<BiomeCalculator["getBiomeAt"]> | null {
  if (!skipCenter) {
    const center = calculator.getBiomeAt(centerX, centerZ, y);
    if (center.biome === targetBiome) return center;
  }

  // 两阶段搜索：粗粒度
  const coarseStep = step * 8;
  for (let radius = coarseStep; radius <= maxRadius; radius += coarseStep) {
    for (let dx = -radius; dx <= radius; dx += coarseStep) {
      const top = calculator.getBiomeAt(centerX + dx, centerZ - radius, y);
      if (top.biome === targetBiome) {
        return refineSearch(calculator, targetBiome, centerX + dx, centerZ - radius, y, coarseStep, step);
      }
      const bot = calculator.getBiomeAt(centerX + dx, centerZ + radius, y);
      if (bot.biome === targetBiome) {
        return refineSearch(calculator, targetBiome, centerX + dx, centerZ + radius, y, coarseStep, step);
      }
    }
    for (let dz = -radius + coarseStep; dz < radius; dz += coarseStep) {
      const left = calculator.getBiomeAt(centerX - radius, centerZ + dz, y);
      if (left.biome === targetBiome) {
        return refineSearch(calculator, targetBiome, centerX - radius, centerZ + dz, y, coarseStep, step);
      }
      const right = calculator.getBiomeAt(centerX + radius, centerZ + dz, y);
      if (right.biome === targetBiome) {
        return refineSearch(calculator, targetBiome, centerX + radius, centerZ + dz, y, coarseStep, step);
      }
    }
  }

  // 精细搜索
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

function refineSearch(
  calculator: BiomeCalculator,
  targetBiome: string,
  hitX: number,
  hitZ: number,
  y: number,
  coarseStep: number,
  fineStep: number
): ReturnType<BiomeCalculator["getBiomeAt"]> {
  let best: ReturnType<BiomeCalculator["getBiomeAt"]> | null = null;
  let bestDistSq = Infinity;

  for (let dx = -coarseStep; dx <= coarseStep; dx += fineStep) {
    for (let dz = -coarseStep; dz <= coarseStep; dz += fineStep) {
      const result = calculator.getBiomeAt(hitX + dx, hitZ + dz, y);
      if (result.biome === targetBiome) {
        const distSq = dx * dx + dz * dz;
        if (distSq < bestDistSq) {
          bestDistSq = distSq;
          best = result;
        }
      }
    }
  }

  return best ?? calculator.getBiomeAt(hitX, hitZ, y);
}

export default router;