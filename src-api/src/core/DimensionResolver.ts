/**
 * DimensionResolver
 * 通过分析结构 JSON 中的 biomes 字段，判断结构属于哪个维度。
 *
 * 判断逻辑：
 * 1. biomes 字段引用的标签中若包含 #minecraft:is_nether 或 nether 相关标签 → 下界
 * 2. biomes 字段引用的标签中若包含 #minecraft:is_end 或 end 相关标签 → 末地
 * 3. 其余 → 主世界
 */

import { DatapackLoader, DimensionId } from "./DatapackLoader";

// 已知属于下界的标签关键词（精确匹配，避免误判）
const NETHER_KEYWORDS = [
  "is_nether", "nether", "crimson", "warped", "soul_sand", "basalt",
  "bastion", "fortress",
];

// 已知属于末地的标签关键词（精确匹配，避免误判）
const END_KEYWORDS = [
  "is_end", "end_city", "end_highlands", "end_midlands", "end_barrens",
  "small_end", "outer_end", "the_end", "in_the_end",
];

function matchesKeywords(str: string, keywords: string[]): boolean {
  const lower = str.toLowerCase();
  return keywords.some(k => {
    const idx = lower.indexOf(k);
    if (idx === -1) return false;
    const before = idx === 0 ? true : /[:/._]/.test(lower[idx - 1]);
    const after = idx + k.length >= lower.length ? true : /[:/._]/.test(lower[idx + k.length]);
    return before && after;
  });
}

function collectBiomeRefs(biomes: any): string[] {
  if (!biomes) return [];
  if (typeof biomes === "string") return [biomes];
  if (Array.isArray(biomes)) {
    return biomes.flatMap(b => {
      if (typeof b === "string") return [b];
      if (typeof b === "object" && b.id) return [b.id as string];
      return [];
    });
  }
  return [];
}

/**
 * 递归收集标签里所有最终的生物群系 ID（非标签引用）
 */
function collectAllBiomeIds(
  refs: string[],
  biomeTagJsons: Map<string, any>,
  visited: Set<string> = new Set(),
  depth: number = 0
): string[] {
  if (depth > 6) return [];
  const ids: string[] = [];
  for (const ref of refs) {
    if (!ref.startsWith("#")) {
      ids.push(ref);
    } else {
      const tagId = ref.slice(1);
      if (visited.has(tagId)) continue;
      visited.add(tagId);
      const tagJson = biomeTagJsons.get(tagId);
      if (!tagJson) continue;
      const inner = collectBiomeRefs(tagJson.values);
      ids.push(...collectAllBiomeIds(inner, biomeTagJsons, visited, depth + 1));
    }
  }
  return ids;
}

function inferDimensionFromRefs(
  refs: string[],
  biomeTagJsons: Map<string, any>,
  biomeDimensionMap: Map<string, DimensionId>
): DimensionId {
  // 先直接检查引用本身的关键词
  for (const ref of refs) {
    if (matchesKeywords(ref, NETHER_KEYWORDS)) return "minecraft:the_nether";
    if (matchesKeywords(ref, END_KEYWORDS)) return "minecraft:the_end";
  }

  // 递归展开所有生物群系 ID，用关键词 + 生物群系源双重判断
  const allBiomeIds = collectAllBiomeIds(refs, biomeTagJsons);
  for (const id of allBiomeIds) {
    // 关键词匹配
    if (matchesKeywords(id, NETHER_KEYWORDS)) return "minecraft:the_nether";
    if (matchesKeywords(id, END_KEYWORDS)) return "minecraft:the_end";
    // 生物群系源反查
    const dim = biomeDimensionMap.get(id);
    if (dim && dim !== "minecraft:overworld") return dim;
  }

  return "minecraft:overworld";
}

/**
 * 从维度的 biomeSource JSON 中提取所有生物群系 ID
 */
function extractBiomeIdsFromSource(biomeSourceJson: any): string[] {
  const ids: string[] = [];
  if (!biomeSourceJson) return ids;
  // multi_noise 格式
  if (biomeSourceJson.biomes && Array.isArray(biomeSourceJson.biomes)) {
    for (const entry of biomeSourceJson.biomes) {
      const biome = entry?.biome ?? entry?.parameters?.biome;
      if (typeof biome === "string") ids.push(biome);
    }
  }
  // fixed 格式
  if (typeof biomeSourceJson.biome === "string") ids.push(biomeSourceJson.biome);
  // checkerboard 格式
  if (biomeSourceJson.biomes && typeof biomeSourceJson.biomes === "object" && !Array.isArray(biomeSourceJson.biomes)) {
    const b = biomeSourceJson.biomes;
    if (typeof b === "string") ids.push(b);
  }
  return ids;
}

/**
 * 构建 structureId → dimensionId 的映射表
 */
export async function buildStructureDimensionMap(
  loader: DatapackLoader,
  dimensionBiomeSources?: Map<string, any>
): Promise<Map<string, DimensionId>> {
  const structureJsons = await loader.getRawStructureJsons();
  const biomeTagJsons = await loader.getRawBiomeTagJsons();

  // 构建 biomeId → dimension 的反查表
  const biomeDimensionMap = new Map<string, DimensionId>();
  if (dimensionBiomeSources) {
    for (const [dim, biomeSourceJson] of dimensionBiomeSources) {
      const biomeIds = extractBiomeIdsFromSource(biomeSourceJson);
      for (const id of biomeIds) {
        biomeDimensionMap.set(id, dim as DimensionId);
      }
    }
  }

  const result = new Map<string, DimensionId>();
  for (const [structureId, json] of structureJsons) {
    const biomes = json?.biomes;
    const refs = collectBiomeRefs(biomes);
    const dim = inferDimensionFromRefs(refs, biomeTagJsons, biomeDimensionMap);
    result.set(structureId, dim);
  }

  console.log(`[DimensionResolver] 解析完成: ${result.size} 个结构`);
  const netherCount = [...result.values()].filter(d => d === "minecraft:the_nether").length;
  const endCount = [...result.values()].filter(d => d === "minecraft:the_end").length;
  const overworldCount = result.size - netherCount - endCount;
  console.log(`  主世界: ${overworldCount}, 下界: ${netherCount}, 末地: ${endCount}`);

  return result;
}
