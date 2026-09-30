// CIF（Crystallographic Information File）本地解析与校验。
// 全部在浏览器内完成，不上传任何文件内容。

export interface CifCell {
  a: number;
  b: number;
  c: number;
  alpha: number;
  beta: number;
  gamma: number;
}

export interface CifAtomSite {
  label: string;
  element: string;
  /** 归一化到 [0, 1) 的分数坐标 */
  fract: [number, number, number];
}

export interface ParsedCif {
  blockName: string;
  cell: CifCell;
  atoms: CifAtomSite[];
  formula: string | null;
  spaceGroup: string | null;
  /** _cell_formula_units_Z（可选），用于理论密度计算 */
  formulaUnitsZ: number | null;
}

export type CifParseResult = { ok: true; data: ParsedCif } | { ok: false; error: string };

/** 演示场景渲染上限，超出即拒绝，避免浏览器卡死 */
export const MAX_CIF_ATOMS = 2000;

const fail = (error: string): CifParseResult => ({ ok: false, error });

/* ------------------------------------------------------------------ */
/* 分词：处理注释、引号字符串与分号多行文本域                             */
/* ------------------------------------------------------------------ */
function tokenizeCif(text: string): string[] {
  const tokens: string[] = [];
  const lines = text.split(/\r\n|\r|\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // 分号文本域：行首 ';' 开始，到下一个行首 ';' 结束
    if (line.startsWith(';')) {
      const buf: string[] = [line.slice(1)];
      i += 1;
      while (i < lines.length && !lines[i].startsWith(';')) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1; // 跳过结束定界行
      tokens.push(buf.join('\n'));
      continue;
    }
    let j = 0;
    const n = line.length;
    while (j < n) {
      const ch = line[j];
      if (/\s/.test(ch)) {
        j += 1;
        continue;
      }
      if (ch === '#') break; // 注释到行尾
      if (ch === "'" || ch === '"') {
        // 引号字符串：在“引号 + 空白/行尾/#”处结束
        let k = j + 1;
        while (k < n && !(line[k] === ch && (k + 1 === n || /[\s#]/.test(line[k + 1])))) k += 1;
        tokens.push(line.slice(j + 1, k));
        j = k + 1;
        continue;
      }
      let k = j;
      while (k < n && !/\s/.test(line[k])) k += 1;
      tokens.push(line.slice(j, k));
      j = k;
    }
    i += 1;
  }
  return tokens;
}

/* ------------------------------------------------------------------ */
/* 块结构：data_ 块、_tag value 键值对、loop_ 表                        */
/* ------------------------------------------------------------------ */
interface CifLoop {
  tags: string[];
  rows: string[][];
}

interface CifBlock {
  name: string;
  values: Map<string, string>;
  loops: CifLoop[];
}

const isKeyword = (token: string) => {
  const low = token.toLowerCase();
  return low === 'loop_' || low === 'stop_' || low.startsWith('data_') || low.startsWith('save_');
};

function parseFirstBlock(tokens: string[]): CifBlock {
  const block: CifBlock = { name: '', values: new Map(), loops: [] };
  let i = 0;
  while (i < tokens.length && !tokens[i].toLowerCase().startsWith('data_')) i += 1;
  if (i >= tokens.length) throw new Error('未找到 data_ 数据块，不是有效的 CIF 文件');
  block.name = tokens[i].slice(5).trim() || 'unnamed';
  i += 1;
  while (i < tokens.length) {
    const token = tokens[i];
    const low = token.toLowerCase();
    if (low.startsWith('data_')) break; // 只读取第一个数据块
    if (low === 'loop_') {
      i += 1;
      const tags: string[] = [];
      while (i < tokens.length && tokens[i].startsWith('_')) {
        tags.push(tokens[i].toLowerCase());
        i += 1;
      }
      if (tags.length === 0) throw new Error('loop_ 后缺少数据字段名');
      const values: string[] = [];
      while (i < tokens.length && !tokens[i].startsWith('_') && !isKeyword(tokens[i])) {
        values.push(tokens[i]);
        i += 1;
      }
      if (values.length === 0 || values.length % tags.length !== 0) {
        throw new Error(`loop_ 表 ${tags[0]} 的数据列数与字段数不匹配`);
      }
      const rows: string[][] = [];
      for (let r = 0; r < values.length; r += tags.length) rows.push(values.slice(r, r + tags.length));
      block.loops.push({ tags, rows });
      continue;
    }
    if (token.startsWith('_')) {
      const tag = token.toLowerCase();
      if (i + 1 < tokens.length && !tokens[i + 1].startsWith('_') && !isKeyword(tokens[i + 1])) {
        block.values.set(tag, tokens[i + 1]);
        i += 2;
      } else {
        block.values.set(tag, '');
        i += 1;
      }
      continue;
    }
    i += 1; // stop_ 或游离值，忽略
  }
  return block;
}

/* ------------------------------------------------------------------ */
/* 数值与元素                                                           */
/* ------------------------------------------------------------------ */
/** 解析 CIF 数值，兼容标准不确定度写法，如 4.0495(2)；'?'、'.' 视为缺失 */
function parseCifNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  let s = raw.trim();
  if (s === '' || s === '?' || s === '.') return null;
  const paren = s.indexOf('(');
  if (paren >= 0) s = s.slice(0, paren);
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;
  const value = Number(s);
  return Number.isFinite(value) ? value : null;
}

/** 从占位标签（如 Si1、Fe3+、Al_a）提取元素符号 */
function elementFromLabel(label: string): string {
  const match = label.replace(/^[^A-Za-z]+/, '').match(/^[A-Z][a-z]?/);
  return match ? match[0] : 'X';
}

/** 分数坐标归一化到 [0, 1) */
const wrapFraction = (value: number) => ((value % 1) + 1) % 1;

/* ------------------------------------------------------------------ */
/* 晶胞几何                                                             */
/* ------------------------------------------------------------------ */
export type Vec3 = [number, number, number];

export function cellVolume(cell: CifCell): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const ca = Math.cos(toRad(cell.alpha));
  const cb = Math.cos(toRad(cell.beta));
  const cg = Math.cos(toRad(cell.gamma));
  const term = 1 + 2 * ca * cb * cg - ca * ca - cb * cb - cg * cg;
  return cell.a * cell.b * cell.c * Math.sqrt(Math.max(term, 0));
}

/** 晶胞三条边矢量（笛卡尔坐标，Å），a 沿 x 轴、b 在 xy 平面内 */
export function cellVectors(cell: CifCell): [Vec3, Vec3, Vec3] {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const ca = Math.cos(toRad(cell.alpha));
  const cb = Math.cos(toRad(cell.beta));
  const cg = Math.cos(toRad(cell.gamma));
  const sg = Math.sin(toRad(cell.gamma));
  const volume = cellVolume(cell);
  const ax: Vec3 = [cell.a, 0, 0];
  const bx: Vec3 = [cell.b * cg, cell.b * sg, 0];
  const cx: Vec3 = [cell.c * cb, (cell.c * (ca - cb * cg)) / sg, volume / (cell.a * cell.b * sg)];
  return [ax, bx, cx];
}

export function fractionalToCartesian(vectors: [Vec3, Vec3, Vec3], fract: Vec3): Vec3 {
  const [va, vb, vc] = vectors;
  return [
    fract[0] * va[0] + fract[1] * vb[0] + fract[2] * vc[0],
    fract[0] * va[1] + fract[1] * vb[1] + fract[2] * vc[1],
    fract[0] * va[2] + fract[1] * vb[2] + fract[2] * vc[2],
  ];
}

/** 3×3 矩阵求逆（行主序），用于 Cartn → fract 换算 */
function invert3(m: number[][]): number[][] | null {
  const [r0, r1, r2] = m;
  const cross = (u: number[], v: number[]) => [
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  ];
  const det = r0[0] * (r1[1] * r2[2] - r1[2] * r2[1]) - r0[1] * (r1[0] * r2[2] - r1[2] * r2[0]) + r0[2] * (r1[0] * r2[1] - r1[1] * r2[0]);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const c0 = cross(r1, r2).map(v => v / det);
  const c1 = cross(r2, r0).map(v => v / det);
  const c2 = cross(r0, r1).map(v => v / det);
  return [
    [c0[0], c1[0], c2[0]],
    [c0[1], c1[1], c2[1]],
    [c0[2], c1[2], c2[2]],
  ];
}

function cartesianToFractional(vectors: [Vec3, Vec3, Vec3], cart: Vec3): Vec3 | null {
  const [va, vb, vc] = vectors;
  // cart = M · fract，M 的列为 va/vb/vc
  const inv = invert3([
    [va[0], vb[0], vc[0]],
    [va[1], vb[1], vc[1]],
    [va[2], vb[2], vc[2]],
  ]);
  if (!inv) return null;
  return [
    inv[0][0] * cart[0] + inv[0][1] * cart[1] + inv[0][2] * cart[2],
    inv[1][0] * cart[0] + inv[1][1] * cart[1] + inv[1][2] * cart[2],
    inv[2][0] * cart[0] + inv[2][1] * cart[1] + inv[2][2] * cart[2],
  ];
}

/* ------------------------------------------------------------------ */
/* 主入口：解析 + 校验 + 分数坐标归一化                                  */
/* ------------------------------------------------------------------ */
export function parseCif(text: string): CifParseResult {
  try {
    const tokens = tokenizeCif(text);
    if (tokens.length === 0) return fail('文件为空或不包含任何 CIF 内容');
    const block = parseFirstBlock(tokens);

    // ---- 晶胞参数（必需） ----
    const cellTags: [keyof CifCell, string][] = [
      ['a', '_cell_length_a'],
      ['b', '_cell_length_b'],
      ['c', '_cell_length_c'],
      ['alpha', '_cell_angle_alpha'],
      ['beta', '_cell_angle_beta'],
      ['gamma', '_cell_angle_gamma'],
    ];
    const missing = cellTags.filter(([, tag]) => block.values.get(tag) === undefined).map(([, tag]) => tag);
    if (missing.length > 0) return fail(`缺少必需字段：${missing.join('、')}`);
    const cell = {} as CifCell;
    for (const [key, tag] of cellTags) {
      const raw = block.values.get(tag);
      const value = parseCifNumber(raw);
      if (value === null) return fail(`字段 ${tag} 的数值非法：“${raw ?? ''}”`);
      cell[key] = value;
    }
    if (cell.a <= 0 || cell.b <= 0 || cell.c <= 0) return fail(`晶胞边长必须为正数（当前 a=${cell.a}, b=${cell.b}, c=${cell.c}）`);
    for (const [name, angle] of [['alpha', cell.alpha], ['beta', cell.beta], ['gamma', cell.gamma]] as const) {
      if (angle <= 0 || angle >= 180) return fail(`晶胞夹角 ${name} 必须在 (0°, 180°) 区间内（当前 ${angle}°）`);
    }
    const volume = cellVolume(cell);
    if (!Number.isFinite(volume) || volume <= 0) return fail('晶胞参数组合非法，无法构成有效晶胞');

    // ---- 原子坐标 loop（必需，优先分数坐标） ----
    const hasAll = (loop: CifLoop, tags: string[]) => tags.every(tag => loop.tags.includes(tag));
    const fractTags = ['_atom_site_fract_x', '_atom_site_fract_y', '_atom_site_fract_z'];
    const cartnTags = ['_atom_site_cartn_x', '_atom_site_cartn_y', '_atom_site_cartn_z'];
    let loop = block.loops.find(item => hasAll(item, fractTags));
    let useCartesian = false;
    if (!loop) {
      loop = block.loops.find(item => hasAll(item, cartnTags));
      useCartesian = true;
    }
    if (!loop) return fail('缺少原子坐标字段（需要 _atom_site_fract_x/y/z 或 _atom_site_Cartn_x/y/z 的 loop_ 表）');
    if (loop.rows.length === 0) return fail('原子坐标表为空，没有任何原子位');
    if (loop.rows.length > MAX_CIF_ATOMS) return fail(`原子数 ${loop.rows.length} 超出演示渲染上限 ${MAX_CIF_ATOMS}`);

    const coordTags = useCartesian ? cartnTags : fractTags;
    const coordIdx = coordTags.map(tag => loop!.tags.indexOf(tag));
    const labelIdx = loop.tags.indexOf('_atom_site_label');
    const typeIdx = loop.tags.indexOf('_atom_site_type_symbol');
    const vectors = cellVectors(cell);

    const atoms: CifAtomSite[] = [];
    for (let r = 0; r < loop.rows.length; r += 1) {
      const row = loop.rows[r];
      const raw = coordIdx.map(idx => row[idx]);
      const parsed = raw.map(value => parseCifNumber(value));
      if (parsed.some(value => value === null)) {
        return fail(`第 ${r + 1} 个原子坐标非法：“${raw.join(', ')}”`);
      }
      let fract: Vec3;
      if (useCartesian) {
        const converted = cartesianToFractional(vectors, parsed as Vec3);
        if (!converted) return fail('晶胞矩阵奇异，无法将笛卡尔坐标换算为分数坐标');
        fract = converted;
      } else {
        fract = parsed as Vec3;
      }
      const label = (labelIdx >= 0 ? row[labelIdx] : '') || (typeIdx >= 0 ? row[typeIdx] : '') || `site${r + 1}`;
      const element = elementFromLabel(typeIdx >= 0 && row[typeIdx] ? row[typeIdx] : label);
      atoms.push({ label, element, fract: [wrapFraction(fract[0]), wrapFraction(fract[1]), wrapFraction(fract[2])] });
    }

    // ---- 可选摘要字段 ----
    const formulaRaw = block.values.get('_chemical_formula_sum') ?? block.values.get('_chemical_formula_structural');
    const formula = formulaRaw ? formulaRaw.replace(/\s+/g, ' ').trim() : deriveFormula(atoms);
    const spaceGroup =
      block.values.get('_symmetry_space_group_name_h-m') ??
      block.values.get('_space_group_name_h-m_alt') ??
      block.values.get('_symmetry_space_group_name_hall') ??
      null;
    const zRaw = parseCifNumber(block.values.get('_cell_formula_units_z'));
    const formulaUnitsZ = zRaw !== null && zRaw > 0 ? zRaw : null;

    return { ok: true, data: { blockName: block.name, cell, atoms, formula, spaceGroup, formulaUnitsZ } };
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'CIF 解析失败');
  }
}

/** 由所列原子统计元素配比并约简，如 Na4 Cl4 → NaCl */
function deriveFormula(atoms: CifAtomSite[]): string | null {
  if (atoms.length === 0) return null;
  const counts = new Map<string, number>();
  atoms.forEach(atom => counts.set(atom.element, (counts.get(atom.element) ?? 0) + 1));
  const values = [...counts.values()];
  const gcd = values.reduce((acc, value) => {
    let x = acc;
    let y = value;
    while (y) [x, y] = [y, x % y];
    return x;
  });
  return [...counts.entries()]
    .map(([element, count]) => {
      const n = count / gcd;
      return n === 1 ? element : `${element}${n}`;
    })
    .join('');
}

/** 解析化学式（如 'Na Cl'、'Sr Ti O3'）为元素计数；含括号等无法解析时返回 null */
export function parseFormulaCounts(formula: string): Map<string, number> | null {
  const compact = formula.replace(/\s+/g, '');
  if (!compact) return null;
  const counts = new Map<string, number>();
  const pattern = /([A-Z][a-z]?)(\d*\.?\d*)/g;
  let matched = 0;
  for (const match of compact.matchAll(pattern)) {
    matched += match[0].length;
    const count = match[2] ? Number(match[2]) : 1;
    if (!Number.isFinite(count) || count <= 0) return null;
    counts.set(match[1], (counts.get(match[1]) ?? 0) + count);
  }
  return matched === compact.length && counts.size > 0 ? counts : null;
}
