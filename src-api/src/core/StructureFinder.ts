import {
  BiomeSource,
  Climate,
  Identifier,
  NoiseGeneratorSettings,
  StructurePlacement,
  StructureSet,
  WorldgenStructure,
} from "deepslate";

/**
 * deepslate 库中未实现 findGenerationPoint 的结构类型
 * 这些结构无法被查找，是库本身的限制
 */
export const UNSUPPORTED_STRUCTURE_TYPES = [
  "MineshaftStructure",
  "NetherFossilStructure",
  "OceanMonumentStructure",
  "RuinedPortalStructure",
] as const;

/**
 * 检查结构是否被 deepslate 库支持
 */
export function isStructureSupported(structure: WorldgenStructure): boolean {
  return !(
    structure instanceof WorldgenStructure.MineshaftStructure ||
    structure instanceof WorldgenStructure.NetherFossilStructure ||
    structure instanceof WorldgenStructure.OceanMonumentStructure ||
    structure instanceof WorldgenStructure.RuinedPortalStructure
  );
}

/**
 * 检查结构集是否包含不支持的结构
 */
export function hasUnsupportedStructures(set: StructureSet): boolean {
  for (const entry of set.structures) {
    const structure = entry.structure.value();
    if (structure && !isStructureSupported(structure)) {
      return true;
    }
  }
  return false;
}

export interface StructureResult {
  structureId: string;
  structureSetId: string;
  x: number;
  z: number;
  chunkX: number;
  chunkZ: number;
  distance?: number;
}

export interface StructureFinderConfig {
  biomeSource: BiomeSource;
  sampler: Climate.Sampler;
  noiseGeneratorSettings: NoiseGeneratorSettings;
  levelHeight: { minY: number; height: number };
  seed: bigint;
  // 可选：注册表快照，用于多维度并行时隔离全局注册表
  structureSetsSnapshot?: Map<string, StructureSet>;
  structuresSnapshot?: Map<string, WorldgenStructure>;
}

/**
 * 优化版缓存生物群系源
 * 使用 LRU 策略 + 更大的缓存窗口
 */
const CACHE_SIZE = 16;
const CACHE_CENTER = 7;

class CachedBiomeSource implements BiomeSource {
  private cache: Map<number, Identifier> = new Map();
  private cache_center_x: number = 0;
  private cache_center_z: number = 0;
  private accessOrder: number[] = [];
  private readonly maxCacheEntries: number;

  constructor(
    private readonly base: BiomeSource,
    maxEntries: number = 20000
  ) {
    this.maxCacheEntries = maxEntries;
  }

  /**
   * 设置缓存中心点 - 关键方法！
   * 在检查每个区块的结构前必须调用
   */
  public setupCache(x: number, z: number): void {
    // 每次中心变化都必须清空缓存（cache_index使用相对坐标，中心移动后同一index对应不同世界坐标）
    this.cache.clear();
    this.accessOrder.length = 0;
    this.cache_center_x = x;
    this.cache_center_z = z;
  }

  public clearCache(): void {
    this.cache.clear();
    this.accessOrder.length = 0;
  }

  getBiome(x: number, y: number, z: number, climateSampler: Climate.Sampler): Identifier {
    // 如果超出缓存范围，直接查询不缓存
    if (
      Math.abs(x - this.cache_center_x) > CACHE_CENTER ||
      Math.abs(z - this.cache_center_z) > CACHE_CENTER
    ) {
      return this.base.getBiome(x, y, z, climateSampler);
    }

    const cache_index =
      (y + 64) * CACHE_SIZE * CACHE_SIZE +
      (x - this.cache_center_x + CACHE_CENTER) * CACHE_SIZE +
      (z - this.cache_center_z + CACHE_CENTER);

    const cached = this.cache.get(cache_index);
    if (cached) {
      return cached;
    }

    // LRU 淘汰
    if (this.cache.size >= this.maxCacheEntries) {
      const evictCount = this.maxCacheEntries >> 2; // 淘汰 25%
      for (let i = 0; i < evictCount && this.accessOrder.length > 0; i++) {
        const key = this.accessOrder.shift()!;
        this.cache.delete(key);
      }
    }

    const biome = this.base.getBiome(x, y, z, climateSampler);
    this.cache.set(cache_index, biome);
    this.accessOrder.push(cache_index);
    return biome;
  }
}

/**
 * 结构查找器 - 用于查找 Minecraft 世界中的结构
 */
export class StructureFinder {
  private config: StructureFinderConfig | null = null;
  private generationContext: WorldgenStructure.GenerationContext | null = null;
  private cachedBiomeSource: CachedBiomeSource | null = null;

  // 本维度的注册表快照（与全局注册表隔离）
  private structureSets: Map<string, StructureSet> = new Map();
  private structures: Map<string, WorldgenStructure> = new Map();

  // 结构 ID → 所属结构集 的快速查找缓存
  private structureToSetMap: Map<string, string[]> = new Map();

  public initialize(config: StructureFinderConfig): void {
    this.config = config;
    this.cachedBiomeSource = new CachedBiomeSource(config.biomeSource);
    this.generationContext = new WorldgenStructure.GenerationContext(
      config.seed,
      this.cachedBiomeSource,
      config.noiseGeneratorSettings,
      config.levelHeight
    );

    // 使用传入的快照，或从当前全局注册表拍快照
    if (config.structureSetsSnapshot) {
      this.structureSets = config.structureSetsSnapshot;
    } else {
      this.structureSets = new Map();
      for (const id of StructureSet.REGISTRY.keys()) {
        const set = StructureSet.REGISTRY.get(id);
        if (set) this.structureSets.set(id.toString(), set);
      }
    }

    if (config.structuresSnapshot) {
      this.structures = config.structuresSnapshot;
    } else {
      this.structures = new Map();
      for (const id of WorldgenStructure.REGISTRY.keys()) {
        const s = WorldgenStructure.REGISTRY.get(id);
        if (s) this.structures.set(id.toString(), s);
      }
    }

    // 构建结构→结构集映射
    this.buildStructureToSetMap();
  }

  private buildStructureToSetMap(): void {
    this.structureToSetMap.clear();
    for (const [setIdStr, set] of this.structureSets) {
      for (const entry of set.structures) {
        const structureKey = entry.structure.key();
        if (structureKey) {
          const key = structureKey.toString();
          let list = this.structureToSetMap.get(key);
          if (!list) {
            list = [];
            this.structureToSetMap.set(key, list);
          }
          list.push(setIdStr);
        }
      }
    }
  }

  public isInitialized(): boolean {
    return this.config !== null && this.generationContext !== null;
  }

  public getStructureSets(): string[] {
    return Array.from(this.structureSets.keys());
  }

  public getStructures(): string[] {
    return Array.from(this.structures.keys());
  }

  public getUnsupportedStructures(): { structureId: string; structureSetId: string; reason: string }[] {
    const unsupported: { structureId: string; structureSetId: string; reason: string }[] = [];
    for (const [setIdStr, set] of this.structureSets) {
      for (const entry of set.structures) {
        const structure = entry.structure.value();
        const structureKey = entry.structure.key();
        if (structure && structureKey && !isStructureSupported(structure)) {
          unsupported.push({
            structureId: structureKey.toString(),
            structureSetId: setIdStr,
            reason: `${structure.constructor.name} - findGenerationPoint not implemented in deepslate`,
          });
        }
      }
    }
    return unsupported;
  }

  public getSupportedStructureSets(): string[] {
    const supported: string[] = [];
    for (const [setIdStr, set] of this.structureSets) {
      if (!hasUnsupportedStructures(set)) {
        supported.push(setIdStr);
      }
    }
    return supported;
  }

  /**
   * 临时抑制 deepslate 的 concentric rings 警告
   */
  private suppressConcentricRingsWarning<T>(fn: () => T): T {
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      const msg = args[0]?.toString() ?? "";
      if (msg.includes("concentric rings") || msg.includes("trying to access")) return;
      originalWarn.apply(console, args);
    };
    try {
      return fn();
    } finally {
      console.warn = originalWarn;
    }
  }

  /**
   * 查找指定坐标所在或附近的结构
   * 会检查周围 3x3 区块范围
   */
  public getStructureAt(x: number, z: number): StructureResult | null {
    if (!this.config || !this.generationContext) {
      throw new Error("StructureFinder not initialized");
    }

    const centerChunkX = x >> 4;
    const centerChunkZ = z >> 4;

    let nearest: StructureResult | null = null;
    let nearestDistance = Infinity;

    // 检查周围 3x3 区块范围
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const chunkX = centerChunkX + dx;
        const chunkZ = centerChunkZ + dz;

        for (const [setIdStr, set] of this.structureSets) {
          try {
            this.suppressConcentricRingsWarning(() => {
              if (set.placement instanceof StructurePlacement.ConcentricRingsStructurePlacement) {
                set.placement.prepare(
                  this.config!.biomeSource,
                  this.config!.sampler,
                  this.config!.seed
                );
              }
            });

            const potentialChunks = this.suppressConcentricRingsWarning(() =>
              set.placement.getPotentialStructureChunks(
                this.config!.seed,
                chunkX,
                chunkZ,
                chunkX,
                chunkZ
              )
            );

            for (const chunk of potentialChunks) {
              if (chunk[0] === chunkX && chunk[1] === chunkZ) {
                try {
                  this.cachedBiomeSource?.setupCache(chunkX << 2, chunkZ << 2);
                  const structure = set.getStructureInChunk(
                    chunkX,
                    chunkZ,
                    this.generationContext
                  );
                  if (structure) {
                    const dist = Math.sqrt(
                      Math.pow(structure.pos[0] - x, 2) +
                        Math.pow(structure.pos[2] - z, 2)
                    );
                    if (dist < nearestDistance) {
                      nearestDistance = dist;
                      nearest = {
                        structureId: structure.id.toString(),
                        structureSetId: setIdStr,
                        x: structure.pos[0],
                        z: structure.pos[2],
                        chunkX,
                        chunkZ,
                        distance: Math.round(dist),
                      };
                    }
                  }
                } catch (_e) {
                  // 忽略错误，继续检查其他结构集
                }
              }
            }
          } catch (_e) {
            // 忽略错误
          }
        }
      }
    }

    return nearest;
  }

  /**
   * 查找指定坐标周围的所有结构
   */
  public getStructuresInArea(
    centerX: number,
    centerZ: number,
    radius: number
  ): StructureResult[] {
    if (!this.config || !this.generationContext) {
      throw new Error("StructureFinder not initialized");
    }

    const results: StructureResult[] = [];
    const minChunkX = (centerX - radius) >> 4;
    const minChunkZ = (centerZ - radius) >> 4;
    const maxChunkX = (centerX + radius) >> 4;
    const maxChunkZ = (centerZ + radius) >> 4;

    for (const [setIdStr, set] of this.structureSets) {
      try {
        this.suppressConcentricRingsWarning(() => {
          if (set.placement instanceof StructurePlacement.ConcentricRingsStructurePlacement) {
            set.placement.prepare(
              this.config!.biomeSource,
              this.config!.sampler,
              this.config!.seed
            );
          }
        });

        const potentialChunks = this.suppressConcentricRingsWarning(() =>
          set.placement.getPotentialStructureChunks(
            this.config!.seed,
            minChunkX,
            minChunkZ,
            maxChunkX,
            maxChunkZ
          )
        );

        for (const chunk of potentialChunks) {
          try {
            this.cachedBiomeSource?.setupCache(chunk[0] << 2, chunk[1] << 2);

            const structure = set.getStructureInChunk(
              chunk[0],
              chunk[1],
              this.generationContext
            );

            if (structure) {
              const dist = Math.sqrt(
                Math.pow(structure.pos[0] - centerX, 2) +
                  Math.pow(structure.pos[2] - centerZ, 2)
              );
              if (dist <= radius) {
                results.push({
                  structureId: structure.id.toString(),
                  structureSetId: setIdStr,
                  x: structure.pos[0],
                  z: structure.pos[2],
                  chunkX: chunk[0],
                  chunkZ: chunk[1],
                  distance: Math.round(dist),
                });
              }
            }
          } catch (_e) {
            // 忽略单个结构的错误
          }
        }
      } catch (_e) {
        // 忽略整个结构集的错误
      }
    }

    // 按距离排序
    results.sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
    return results;
  }

  /**
   * 查找最近的指定结构（优化版）
   * 使用预构建的结构→结构集映射，避免每次遍历全部结构集
   */
  public findNearestStructure(
    structureId: string,
    centerX: number,
    centerZ: number,
    maxRadius: number = 10000,
    excludePositions?: Array<{ x: number; z: number; chunkX?: number; chunkZ?: number }>
  ): StructureResult | null {
    if (!this.config || !this.generationContext) {
      throw new Error("StructureFinder not initialized");
    }

    const targetId = Identifier.parse(structureId);

    // 构建排除集合（用于连锁查找时排除已找到的结构）
    const excludeSet = new Set<string>();
    if (excludePositions) {
      for (const pos of excludePositions) {
        const cx = pos.chunkX ?? (pos.x >> 4);
        const cz = pos.chunkZ ?? (pos.z >> 4);
        excludeSet.add(`${cx},${cz}`);
        // Also exclude surrounding chunks to handle edge cases
        for (let dx = -1; dx <= 1; dx++) {
          for (let dz = -1; dz <= 1; dz++) {
            excludeSet.add(`${cx + dx},${cz + dz}`);
          }
        }
      }
    }

    // 使用预构建的快速查找映射
    const relevantSets = this.structureToSetMap.get(structureId)
      ?? this.structureToSetMap.get(targetId.toString())
      ?? [];

    if (relevantSets.length === 0) {
      // 也尝试带命名空间的匹配
      return null;
    }

    let nearest: StructureResult | null = null;
    let nearestDistance = Infinity;

    // 计算最优步长（基于结构集的 spacing）
    let chunkStep = 1;
    for (const setIdStr of relevantSets) {
      const set = this.structureSets.get(setIdStr);
      if (!set) continue;
      const p = set.placement;
      if (p instanceof StructurePlacement.RandomSpreadStructurePlacement) {
        const spacing = (p as unknown as { spacing: number }).spacing ?? 1;
        chunkStep = Math.max(chunkStep, Math.max(1, spacing));
      }
    }

    // 确保同心环结构使用小步长以不遗漏
    for (const setIdStr of relevantSets) {
      const set = this.structureSets.get(setIdStr);
      if (set?.placement instanceof StructurePlacement.ConcentricRingsStructurePlacement) {
        chunkStep = 1;
        break;
      }
    }

    const maxChunkRadius = maxRadius >> 4;

    // 逐圈向外搜索
    outer: for (let r = 0; r <= maxChunkRadius; r += chunkStep) {
      for (const setIdStr of relevantSets) {
        const set = this.structureSets.get(setIdStr);
        if (!set) continue;

        try {
          this.suppressConcentricRingsWarning(() => {
            if (set.placement instanceof StructurePlacement.ConcentricRingsStructurePlacement) {
              set.placement.prepare(this.config!.biomeSource, this.config!.sampler, this.config!.seed);
            }
          });

          const minCX = (centerX >> 4) - r;
          const minCZ = (centerZ >> 4) - r;
          const maxCX = (centerX >> 4) + r;
          const maxCZ = (centerZ >> 4) + r;

          const potentialChunks = this.suppressConcentricRingsWarning(() =>
            set.placement.getPotentialStructureChunks(
              this.config!.seed, minCX, minCZ, maxCX, maxCZ
            )
          );

          for (const chunk of potentialChunks) {
            const chunkDistSq = Math.pow((chunk[0] << 4) - centerX, 2) + Math.pow((chunk[1] << 4) - centerZ, 2);
            // 只处理新增的外圈区块
            if (r > 0 && Math.sqrt(chunkDistSq) < (r - chunkStep) * 16) continue;

            try {
              this.cachedBiomeSource?.setupCache(chunk[0] << 2, chunk[1] << 2);
              const structure = set.getStructureInChunk(chunk[0], chunk[1], this.generationContext);

              if (structure && structure.id.equals(targetId)) {
                // 跳过已排除的结构（用于连锁查找）
                const chunkKey = `${chunk[0]},${chunk[1]}`;
                if (excludeSet.has(chunkKey)) continue;

                const actualDist = Math.sqrt(
                  Math.pow(structure.pos[0] - centerX, 2) + Math.pow(structure.pos[2] - centerZ, 2)
                );
                if (actualDist < nearestDistance) {
                  nearestDistance = actualDist;
                  nearest = {
                    structureId: structure.id.toString(),
                    structureSetId: setIdStr,
                    x: structure.pos[0],
                    z: structure.pos[2],
                    chunkX: chunk[0],
                    chunkZ: chunk[1],
                    distance: Math.round(actualDist),
                  };
                }
              }
            } catch (_e) {
              // 忽略单个结构的错误
            }
          }
        } catch (_e) {
          // 忽略整个结构集的错误
        }
      }

      // 找到后，确认当前圈之外不可能有更近的，立即返回
      if (nearest && nearestDistance <= r * 16) {
        break outer;
      }
    }

    return nearest;
  }
}