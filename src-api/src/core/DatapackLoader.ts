import {
  Datapack,
  DatapackList,
  AnonymousDatapack,
  ResourceLocation,
} from "mc-datapack-loader";
import {
  DensityFunction,
  Holder,
  HolderSet,
  WorldgenRegistries,
  NoiseParameters,
  Identifier,
  Json,
  StructureSet,
  WorldgenStructure,
  StructureTemplatePool,
  Structure,
  NbtFile,
} from "deepslate";
import { getPreset } from "./BiomePresets";

export interface DimensionData {
  biomeSourceJson: unknown;
  noiseSettingsJson: unknown;
  noiseSettingsId: Identifier;
  densityFunctions: Record<string, unknown>;
  noises: Record<string, unknown>;
  levelHeight: { minY: number; height: number };
  structureSetsSnapshot: Map<string, StructureSet>;
  structuresSnapshot: Map<string, WorldgenStructure>;
}

export const DIMENSIONS = [
  "minecraft:overworld",
  "minecraft:the_nether",
  "minecraft:the_end",
] as const;

export type DimensionId = typeof DIMENSIONS[number];

export class DatapackLoader {
  private datapacks: AnonymousDatapack[] = [];
  private compositeDatapack!: AnonymousDatapack;
  public dimensionData: DimensionData | null = null;

  constructor(private mcVersion: string = "1_21_4") {}

  public async loadVanillaDatapack(url: string): Promise<void> {
    console.log(`Loading vanilla datapack from: ${url}`);
    const response = await fetch(url, { method: "HEAD" });
    if (!response.ok) {
      throw new Error(`Failed to access ${url}: HTTP ${response.status}`);
    }
    const vanillaDatapack = Datapack.fromZipUrl(url, this.getDatapackFormat());
    this.datapacks = [vanillaDatapack];
    this.updateComposite();
    const ids = await this.compositeDatapack.getIds(ResourceLocation.WORLDGEN_WORLD_PRESET);
    if (ids.length === 0) {
      throw new Error(`Failed to load vanilla datapack from ${url}`);
    }
    console.log(`Loaded ${ids.length} world presets`);
  }

  public async addDatapackFromUrl(url: string): Promise<void> {
    console.log(`Loading datapack from: ${url}`);
    const datapack = Datapack.fromZipUrl(url, this.getDatapackFormat());
    this.datapacks.push(datapack);
    this.updateComposite();
  }

  private updateComposite(): void {
    const datapacks = this.datapacks;
    this.compositeDatapack = Datapack.compose(
      new (class implements DatapackList {
        async getDatapacks(): Promise<AnonymousDatapack[]> {
          return datapacks;
        }
      })()
    );
  }

  private getDatapackFormat(): number {
    const formats: Record<string, number> = {
      "1_19": 12, "1_20": 15, "1_20_2": 18, "1_20_4": 26,
      "1_20_6": 41, "1_21_1": 48, "1_21_3": 57, "1_21_4": 61,
      "1_21_5": 71, "1_21_7": 81,
    };
    return formats[this.mcVersion] ?? 61;
  }

  private getStructureResourceLocation(): ResourceLocation {
    const newVersions = ["1_21_1", "1_21_3", "1_21_4", "1_21_5", "1_21_7"];
    return newVersions.includes(this.mcVersion)
      ? ResourceLocation.STRUCTURE
      : ResourceLocation.LEGACY_STRUCTURE;
  }

  public async loadDimension(
    dimensionId: Identifier,
    worldPreset: Identifier = Identifier.create("normal")
  ): Promise<DimensionData> {
    await this.registerResources();

    // 注册完成后立即拍快照，防止后续维度初始化覆盖全局注册表
    const structureSetsSnapshot = new Map<string, StructureSet>();
    for (const id of StructureSet.REGISTRY.keys()) {
      const set = StructureSet.REGISTRY.get(id);
      if (set) structureSetsSnapshot.set(id.toString(), set);
    }
    const structuresSnapshot = new Map<string, WorldgenStructure>();
    for (const id of WorldgenStructure.REGISTRY.keys()) {
      const s = WorldgenStructure.REGISTRY.get(id);
      if (s) structuresSnapshot.set(id.toString(), s);
    }

    let dimensionJson: any;
    if (await this.compositeDatapack.has(ResourceLocation.DIMENSION, dimensionId)) {
      dimensionJson = await this.compositeDatapack.get(ResourceLocation.DIMENSION, dimensionId);
    } else {
      const worldPresetJson = (await this.compositeDatapack.get(
        ResourceLocation.WORLDGEN_WORLD_PRESET,
        worldPreset
      )) as { dimensions: Record<string, any> };
      dimensionJson = worldPresetJson?.dimensions?.[dimensionId.toString()];
      if (!dimensionJson) {
        throw new Error(`Dimension ${dimensionId} not found in world preset ${worldPreset}`);
      }
    }

    const dimensionTypeId = Identifier.parse(dimensionJson.type);
    const dimensionTypeJson = (await this.compositeDatapack.get(
      ResourceLocation.DIMENSION_TYPE,
      dimensionTypeId
    )) as any;

    const levelHeight = { minY: dimensionTypeJson.min_y, height: dimensionTypeJson.height };

    const generator = Json.readObject(dimensionJson.generator) ?? {};
    if (generator?.type !== "minecraft:noise") {
      throw new Error("Dimension without noise generator");
    }

    let noiseSettingsJson: Record<string, unknown>;
    let noiseSettingsId: Identifier;
    if (typeof generator.settings === "object") {
      noiseSettingsJson = Json.readObject(generator.settings) ?? {};
      noiseSettingsId = Identifier.parse("inline:inline");
    } else if (typeof generator.settings === "string") {
      noiseSettingsId = Identifier.parse(Json.readString(generator.settings) ?? "");
      noiseSettingsJson = Json.readObject(
        await this.compositeDatapack.get(ResourceLocation.WORLDGEN_NOISE_SETTINGS, noiseSettingsId)
      ) ?? {};
    } else {
      throw new Error("Malformed generator");
    }

    let biomeSourceJson = Json.readObject(generator.biome_source) ?? {};
    if (biomeSourceJson.type === "minecraft:multi_noise" && "preset" in biomeSourceJson) {
      let preset = Json.readString(biomeSourceJson.preset) ?? "";
      const presetId = Identifier.parse(preset);
      if (await this.compositeDatapack.has(
        ResourceLocation.WORLDGEN_MULTI_NOISE_BIOME_SOURCE_PRARAMETER_LIST, presetId
      )) {
        const parameterList = (await this.compositeDatapack.get(
          ResourceLocation.WORLDGEN_MULTI_NOISE_BIOME_SOURCE_PRARAMETER_LIST, presetId
        )) as { preset: string };
        preset = parameterList.preset;
      }
      biomeSourceJson.biomes = getPreset(preset, this.mcVersion);
    }

    const densityFunctions: Record<string, unknown> = {};
    for (const id of await this.compositeDatapack.getIds(ResourceLocation.WORLDGEN_DENSITY_FUNCTION)) {
      densityFunctions[id.toString()] = await this.compositeDatapack.get(
        ResourceLocation.WORLDGEN_DENSITY_FUNCTION, id
      );
    }

    const noises: Record<string, unknown> = {};
    for (const id of await this.compositeDatapack.getIds(ResourceLocation.WORLDGEN_NOISE)) {
      noises[id.toString()] = await this.compositeDatapack.get(ResourceLocation.WORLDGEN_NOISE, id);
    }

    return { biomeSourceJson, noiseSettingsJson, noiseSettingsId, densityFunctions, noises, levelHeight, structureSetsSnapshot, structuresSnapshot };
  }

  public async loadDimensionAndSave(
    dimensionId: Identifier,
    worldPreset: Identifier = Identifier.create("normal")
  ): Promise<DimensionData> {
    const data = await this.loadDimension(dimensionId, worldPreset);
    this.dimensionData = data;
    return data;
  }

  /**
   * 读取原始维度 JSON（未经处理），用于提取 biomeSource 中的生物群系列表
   */
  public async getRawDimensionBiomes(
    dimensionId: Identifier,
    worldPreset: Identifier
  ): Promise<string[]> {
    const biomeIds: string[] = [];
    try {
      let dimensionJson: any;
      if (await this.compositeDatapack.has(ResourceLocation.DIMENSION, dimensionId)) {
        dimensionJson = await this.compositeDatapack.get(ResourceLocation.DIMENSION, dimensionId);
      } else {
        const worldPresetJson = (await this.compositeDatapack.get(
          ResourceLocation.WORLDGEN_WORLD_PRESET, worldPreset
        )) as { dimensions: Record<string, any> };
        dimensionJson = worldPresetJson?.dimensions?.[dimensionId.toString()];
      }
      if (!dimensionJson) return biomeIds;

      const biomeSource = dimensionJson?.generator?.biome_source;
      if (!biomeSource) return biomeIds;

      // multi_noise 格式：biomes 数组，每项有 biome 字段
      if (biomeSource.biomes && Array.isArray(biomeSource.biomes)) {
        for (const entry of biomeSource.biomes) {
          if (typeof entry?.biome === "string") biomeIds.push(entry.biome);
        }
      }
      // fixed 格式
      if (typeof biomeSource.biome === "string") biomeIds.push(biomeSource.biome);
    } catch (e) {
      // ignore
    }
    return biomeIds;
  }
  public async getRawStructureJsons(): Promise<Map<string, any>> {
    const result = new Map<string, any>();
    for (const id of await this.compositeDatapack.getIds(ResourceLocation.WORLDGEN_STRUCTURE)) {
      try {
        const data = await this.compositeDatapack.get(ResourceLocation.WORLDGEN_STRUCTURE, id);
        result.set(id.toString(), data);
      } catch (e) {
        // ignore
      }
    }
    return result;
  }

  /**
   * 读取所有生物群系标签的原始 JSON
   */
  public async getRawBiomeTagJsons(): Promise<Map<string, any>> {
    const result = new Map<string, any>();
    for (const id of await this.compositeDatapack.getIds(ResourceLocation.WORLDGEN_BIOME_TAG)) {
      try {
        const data = await this.compositeDatapack.get(ResourceLocation.WORLDGEN_BIOME_TAG, id);
        result.set(id.toString(), data);
      } catch (e) {
        // ignore
      }
    }
    return result;
  }

  private async registerResources(): Promise<void> {
    // 注册密度函数
    WorldgenRegistries.DENSITY_FUNCTION.clear();
    for (const id of await this.compositeDatapack.getIds(ResourceLocation.WORLDGEN_DENSITY_FUNCTION)) {
      try {
        const data = await this.compositeDatapack.get(ResourceLocation.WORLDGEN_DENSITY_FUNCTION, id);
        const df = new DensityFunction.HolderHolder(
          Holder.parser(WorldgenRegistries.DENSITY_FUNCTION, DensityFunction.fromJson)(data)
        );
        WorldgenRegistries.DENSITY_FUNCTION.register(id, df);
      } catch (e) {
        console.warn(`Failed to register density function: ${id}`);
      }
    }

    // 注册噪声
    WorldgenRegistries.NOISE.clear();
    for (const id of await this.compositeDatapack.getIds(ResourceLocation.WORLDGEN_NOISE)) {
      try {
        const data = await this.compositeDatapack.get(ResourceLocation.WORLDGEN_NOISE, id);
        WorldgenRegistries.NOISE.register(id, NoiseParameters.fromJson(data));
      } catch (e) {
        console.warn(`Failed to register noise: ${id}`);
      }
    }

    // 注册生物群系
    WorldgenRegistries.BIOME.clear();
    for (const id of await this.compositeDatapack.getIds(ResourceLocation.WORLDGEN_BIOME)) {
      WorldgenRegistries.BIOME.register(id, {});
    }

    // 注册生物群系标签
    const biomeTagRegistry = WorldgenRegistries.BIOME.getTagRegistry();
    biomeTagRegistry.clear();
    for (const id of await this.compositeDatapack.getIds(ResourceLocation.WORLDGEN_BIOME_TAG)) {
      try {
        const data = await this.compositeDatapack.get(ResourceLocation.WORLDGEN_BIOME_TAG, id);
        biomeTagRegistry.register(id, HolderSet.fromJson(WorldgenRegistries.BIOME, data, id));
      } catch (e) {
        console.warn(`Failed to register biome tag: ${id}`);
      }
    }

    // 注册模板池（需要注册内容，Jigsaw结构验证时依赖模板池查找）
    StructureTemplatePool.REGISTRY.clear();
    for (const id of await this.compositeDatapack.getIds(ResourceLocation.WORLDGEN_TEMPLATE_POOL)) {
      try {
        const data = await this.compositeDatapack.get(ResourceLocation.WORLDGEN_TEMPLATE_POOL, id);
        const pool = StructureTemplatePool.fromJson(data);
        StructureTemplatePool.REGISTRY.register(id, pool);
      } catch (e) {
        // 静默忽略
      }
    }

    // 注册结构模板（NBT 文件）
    Structure.REGISTRY.clear();
    const structureLocation = this.getStructureResourceLocation();
    for (const id of await this.compositeDatapack.getIds(structureLocation)) {
      try {
        const data = await this.compositeDatapack.get(structureLocation, id);
        const nbtFile = NbtFile.read(new Uint8Array(data as ArrayBuffer));
        const structure = Structure.fromNbt(nbtFile.root);
        Structure.REGISTRY.register(id, () => structure);
      } catch (e) {
        // 静默忽略
      }
    }
    console.log(`Registered ${Structure.REGISTRY.keys().length} structure templates`);

    // 注册结构（跳过 NBT 模板，节省内存）
    WorldgenStructure.REGISTRY.clear();
    for (const id of await this.compositeDatapack.getIds(ResourceLocation.WORLDGEN_STRUCTURE)) {
      try {
        const data = await this.compositeDatapack.get(ResourceLocation.WORLDGEN_STRUCTURE, id);
        const root = Json.readObject(data) ?? {};
        delete root.dimension_padding;
        WorldgenStructure.REGISTRY.register(id, WorldgenStructure.fromJson(root));
      } catch (e) {
        console.warn(`Failed to register structure: ${id}: ${e}`);
      }
    }

    // 注册结构标签
    const structureTagRegistry = WorldgenStructure.REGISTRY.getTagRegistry();
    structureTagRegistry.clear();
    for (const id of await this.compositeDatapack.getIds(ResourceLocation.WORLDGEN_STRUCTURE_TAG)) {
      try {
        const data = await this.compositeDatapack.get(ResourceLocation.WORLDGEN_STRUCTURE_TAG, id);
        structureTagRegistry.register(id, HolderSet.fromJson(WorldgenStructure.REGISTRY, data, id));
      } catch (e) {
        console.warn(`Failed to register structure tag: ${id}`);
      }
    }

    // 注册结构集
    StructureSet.REGISTRY.clear();
    for (const id of await this.compositeDatapack.getIds(ResourceLocation.WORLDGEN_STRUCTURE_SET)) {
      try {
        const data = await this.compositeDatapack.get(ResourceLocation.WORLDGEN_STRUCTURE_SET, id);
        StructureSet.REGISTRY.register(id, StructureSet.fromJson(data));
      } catch (e) {
        console.warn(`Failed to register structure set: ${id}`);
      }
    }

    console.log(`Registered ${WorldgenStructure.REGISTRY.keys().length} structures, ${StructureSet.REGISTRY.keys().length} structure sets`);
  }

  public getCompositeDatapack(): AnonymousDatapack {
    return this.compositeDatapack;
  }
}
