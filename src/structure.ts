// 将解析后的 CIF 结构转换为三维场景模型：坐标归一化、居中缩放、
// 最近邻连接、晶胞边框与摘要指标，全部由真实解析数据推导。

import { cellVectors, cellVolume, fractionalToCartesian, parseFormulaCounts, CifAtomSite, MAX_CIF_ATOMS, ParsedCif, Vec3 } from './cif';

export interface SceneAtom {
  key: string;
  label: string;
  element: string;
  position: Vec3;
  radius: number;
  color: string;
}

export interface ImportedStructure {
  sourceName: string;
  formula: string;
  spaceGroup: string;
  cell: { a: number; b: number; c: number; alpha: number; beta: number; gamma: number; volume: number };
  /** CIF 中列出的原子位数 */
  siteCount: number;
  /** 含晶胞边界周期像的显示原子数 */
  atomCount: number;
  atoms: SceneAtom[];
  bonds: [Vec3, Vec3][];
  cellEdges: [Vec3, Vec3][];
  elements: { symbol: string; color: string }[];
  avgCoordination: string;
  minDistance: number | null;
  density: number | null;
}

/** 场景内结构目标尺寸（最长晶胞边对应的场景单位） */
const SCENE_SIZE = 4.4;
/** 超过该原子数时跳过 O(n²) 键连计算 */
const MAX_BOND_ATOMS = 1200;
/** 键连判定：最短原子间距的倍数 */
const BOND_TOLERANCE = 1.25;

interface ElementInfo {
  color: string;
  radius: number;
  mass: number | null;
}

// 常见元素：CPK 风格配色、共价半径（Å）、摩尔质量（g/mol）
const ELEMENTS: Record<string, { color: string; radius: number; mass: number }> = {
  H: { color: '#e8eef2', radius: 0.31, mass: 1.008 },
  B: { color: '#f5b5a6', radius: 0.85, mass: 10.81 },
  C: { color: '#9aa4ab', radius: 0.76, mass: 12.011 },
  N: { color: '#7d9ff0', radius: 0.71, mass: 14.007 },
  O: { color: '#ef7e83', radius: 0.66, mass: 15.999 },
  F: { color: '#a8e6cf', radius: 0.57, mass: 18.998 },
  Na: { color: '#b39df0', radius: 1.66, mass: 22.99 },
  Mg: { color: '#9fd48a', radius: 1.41, mass: 24.305 },
  Al: { color: '#8fb8c9', radius: 1.21, mass: 26.982 },
  Si: { color: '#e8d29a', radius: 1.11, mass: 28.085 },
  P: { color: '#f0a35e', radius: 1.07, mass: 30.974 },
  S: { color: '#e8e06a', radius: 1.05, mass: 32.06 },
  Cl: { color: '#8fd6a0', radius: 1.02, mass: 35.45 },
  K: { color: '#a48ce0', radius: 2.03, mass: 39.098 },
  Ca: { color: '#9db8a0', radius: 1.76, mass: 40.078 },
  Ti: { color: '#9fb3c8', radius: 1.6, mass: 47.867 },
  V: { color: '#a8a8c8', radius: 1.53, mass: 50.942 },
  Cr: { color: '#8a9bb0', radius: 1.39, mass: 51.996 },
  Mn: { color: '#b08a9b', radius: 1.5, mass: 54.938 },
  Fe: { color: '#d08a5e', radius: 1.42, mass: 55.845 },
  Co: { color: '#e08a9b', radius: 1.38, mass: 58.933 },
  Ni: { color: '#7fbf9f', radius: 1.24, mass: 58.693 },
  Cu: { color: '#e89a6a', radius: 1.32, mass: 63.546 },
  Zn: { color: '#a8a8b8', radius: 1.22, mass: 65.38 },
  Ga: { color: '#c08f8f', radius: 1.22, mass: 69.723 },
  Ge: { color: '#9fbf8f', radius: 1.2, mass: 72.63 },
  As: { color: '#bd80e3', radius: 1.19, mass: 74.922 },
  Se: { color: '#ffa100', radius: 1.2, mass: 78.971 },
  Br: { color: '#a62929', radius: 1.2, mass: 79.904 },
  Sr: { color: '#6fbf6f', radius: 1.95, mass: 87.62 },
  Y: { color: '#94ffff', radius: 1.9, mass: 88.906 },
  Zr: { color: '#94e0e0', radius: 1.75, mass: 91.224 },
  Nb: { color: '#73c2c9', radius: 1.64, mass: 92.906 },
  Mo: { color: '#54b5b5', radius: 1.54, mass: 95.95 },
  Ag: { color: '#c0c0c0', radius: 1.45, mass: 107.87 },
  Cd: { color: '#ffd98f', radius: 1.44, mass: 112.41 },
  In: { color: '#a67573', radius: 1.42, mass: 114.82 },
  Sn: { color: '#9fbfbf', radius: 1.39, mass: 118.71 },
  Sb: { color: '#9e63b5', radius: 1.39, mass: 121.76 },
  Te: { color: '#d47a00', radius: 1.38, mass: 127.6 },
  I: { color: '#940094', radius: 1.39, mass: 126.9 },
  Ba: { color: '#00c900', radius: 2.15, mass: 137.33 },
  La: { color: '#70d4ff', radius: 2.07, mass: 138.91 },
  Ce: { color: '#ffffc7', radius: 2.04, mass: 140.12 },
  Hf: { color: '#4dc2ff', radius: 1.75, mass: 178.49 },
  Ta: { color: '#4da6ff', radius: 1.7, mass: 180.95 },
  W: { color: '#2194d6', radius: 1.62, mass: 183.84 },
  Pt: { color: '#d0d0e0', radius: 1.36, mass: 195.08 },
  Au: { color: '#ffd123', radius: 1.36, mass: 196.97 },
  Hg: { color: '#b8b8d0', radius: 1.32, mass: 200.59 },
  Pb: { color: '#575961', radius: 1.46, mass: 207.2 },
  Bi: { color: '#9e4fb5', radius: 1.48, mass: 208.98 },
};

/** 未知元素按符号哈希给出稳定配色 */
function fallbackColor(symbol: string): string {
  let hash = 0;
  for (let i = 0; i < symbol.length; i += 1) hash = (hash * 31 + symbol.charCodeAt(i)) % 997;
  const hue = (hash * 47) % 360;
  return `hsl(${hue}, 55%, 62%)`;
}

export function elementInfo(symbol: string): ElementInfo {
  const known = ELEMENTS[symbol];
  if (known) return known;
  return { color: fallbackColor(symbol), radius: 0.9, mass: null };
}

const AVOGADRO = 6.02214076e23;
const BOUNDARY_EPS = 1e-4;

/**
 * 晶胞边界周期像：分数坐标为 0 的原子同时出现在对面的边界上，
 * 使角顶/棱/面心原子在相邻晶胞中的共享位置可见（标准晶体学显示方式）。
 */
function expandBoundaryImages(sites: CifAtomSite[]): CifAtomSite[] {
  const expanded: CifAtomSite[] = [];
  for (const site of sites) {
    const axes = site.fract.map(f => (f < BOUNDARY_EPS ? [f, f + 1] : f > 1 - BOUNDARY_EPS ? [f, f - 1] : [f]));
    for (const x of axes[0])
      for (const y of axes[1])
        for (const z of axes[2]) expanded.push({ ...site, fract: [x, y, z] });
  }
  return expanded.length <= MAX_CIF_ATOMS ? expanded : sites;
}

const sub = (u: Vec3, v: Vec3): Vec3 => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
const scaleVec = (u: Vec3, s: number): Vec3 => [u[0] * s, u[1] * s, u[2] * s];
const length = (u: Vec3) => Math.hypot(u[0], u[1], u[2]);

export function buildImportedStructure(cif: ParsedCif, sourceName: string): ImportedStructure {
  const vectors = cellVectors(cif.cell);
  const [va, vb, vc] = vectors;

  // 坐标归一化：分数坐标 → 笛卡尔坐标，并以晶胞中心为原点
  const center = scaleVec([va[0] + vb[0] + vc[0], va[1] + vb[1] + vc[1], va[2] + vb[2] + vc[2]], 0.5);
  const scale = SCENE_SIZE / Math.max(length(va), length(vb), length(vc));
  const toScene = (point: Vec3): Vec3 => scaleVec(sub(point, center), scale);

  const atoms: SceneAtom[] = expandBoundaryImages(cif.atoms).map((site, index) => {
    const info = elementInfo(site.element);
    return {
      key: `${site.label}-${index}`,
      label: site.label,
      element: site.element,
      position: toScene(fractionalToCartesian(vectors, site.fract)),
      radius: Math.max(0.14, Math.min(0.34, info.radius * 0.24)),
      color: info.color,
    };
  });

  // 晶胞边框（12 条边）
  const corners: Vec3[] = ([
    [0, 0, 0], va, vb, vc,
    [va[0] + vb[0], va[1] + vb[1], va[2] + vb[2]],
    [va[0] + vc[0], va[1] + vc[1], va[2] + vc[2]],
    [vb[0] + vc[0], vb[1] + vc[1], vb[2] + vc[2]],
    [va[0] + vb[0] + vc[0], va[1] + vb[1] + vc[1], va[2] + vb[2] + vc[2]],
  ] as Vec3[]).map(toScene);
  const edgePairs: [number, number][] = [
    [0, 1], [0, 2], [0, 3], [1, 4], [1, 5], [2, 4],
    [2, 6], [3, 5], [3, 6], [4, 7], [5, 7], [6, 7],
  ];
  const cellEdges = edgePairs.map(([p, q]) => [corners[p], corners[q]] as [Vec3, Vec3]);

  // 最近邻连接：以真实最小原子间距为基准
  const bonds: [Vec3, Vec3][] = [];
  let minDistance: number | null = null;
  const bondsComputed = atoms.length > 1 && atoms.length <= MAX_BOND_ATOMS;
  if (bondsComputed) {
    let minSq = Infinity;
    for (let i = 0; i < atoms.length; i += 1) {
      for (let j = i + 1; j < atoms.length; j += 1) {
        const d = length(sub(atoms[i].position, atoms[j].position));
        if (d > 1e-6 && d * d < minSq) minSq = d * d;
      }
    }
    if (Number.isFinite(minSq)) {
      const cutoff = Math.sqrt(minSq) * BOND_TOLERANCE;
      for (let i = 0; i < atoms.length; i += 1) {
        for (let j = i + 1; j < atoms.length; j += 1) {
          if (length(sub(atoms[i].position, atoms[j].position)) <= cutoff) {
            bonds.push([atoms[i].position, atoms[j].position]);
          }
        }
      }
      minDistance = Math.sqrt(minSq) / scale; // 换算回 Å
    }
  }

  // 摘要指标
  const avgCoordination = bondsComputed ? ((2 * bonds.length) / atoms.length).toFixed(1) : '—';
  const volume = cellVolume(cif.cell);
  const molarMassOf = (entries: [string, number][]) =>
    entries.every(([symbol]) => elementInfo(symbol).mass !== null)
      ? entries.reduce((sum, [symbol, count]) => sum + count * (elementInfo(symbol).mass as number), 0)
      : null;
  // 优先按 _cell_formula_units_Z × 化学式摩尔质量计算；缺失时退化为所列原子位求和
  let density: number | null = null;
  if (cif.formulaUnitsZ !== null && cif.formula) {
    const counts = parseFormulaCounts(cif.formula);
    const molarMass = counts ? molarMassOf([...counts.entries()]) : null;
    if (molarMass !== null) density = (cif.formulaUnitsZ * molarMass) / (AVOGADRO * volume * 1e-24);
  }
  if (density === null) {
    const listed = cif.atoms.map(site => [site.element, 1] as [string, number]);
    const molarMass = molarMassOf(listed);
    if (molarMass !== null && listed.length > 0) density = molarMass / (AVOGADRO * volume * 1e-24);
  }
  const elementSet = [...new Set(atoms.map(atom => atom.element))];

  return {
    sourceName,
    formula: cif.formula ?? '—',
    spaceGroup: cif.spaceGroup ?? '—',
    cell: { ...cif.cell, volume },
    siteCount: cif.atoms.length,
    atomCount: atoms.length,
    atoms,
    bonds,
    cellEdges,
    elements: elementSet.map(symbol => ({ symbol, color: elementInfo(symbol).color })),
    avgCoordination,
    minDistance,
    density,
  };
}
