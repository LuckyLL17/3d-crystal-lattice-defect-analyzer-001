/**
 * CIF（Crystallographic Information Format）本地解析、校验与坐标归一化。
 *
 * 导入策略：整批提交 —— 只有全部必填字段齐备、全部原子坐标合法时才返回
 * ok 结果；任一环节失败都返回带分类的错误，由调用方保留旧模型并提示。
 * 解析完全在本地内存中进行，不涉及任何网络上传。
 */

export type CifFailureKind = 'parse' | 'missing-fields' | 'invalid-coords';

export interface CifError {
  kind: CifFailureKind;
  message: string;
  missing?: string[];
}

export interface CifAtom {
  element: string;
  /** 归一化后的世界坐标（已居中、按统一比例缩放） */
  x: number;
  y: number;
  z: number;
}

export interface CifStructureMeta {
  name: string;
  formula: string;
  spaceGroup: string;
  latticeType: string;
  cellA: number;
  cellB: number;
  cellC: number;
  alpha: number;
  beta: number;
  gamma: number;
  density: string | null;
  temperature: string | null;
  coordinateMode: 'fractional' | 'cartesian';
  /** 1 Å 对应的世界坐标长度 */
  worldScale: number;
}

export interface CifStructure {
  atoms: CifAtom[];
  meta: CifStructureMeta;
}

export type CifParseResult =
  | { ok: true; structure: CifStructure }
  | { ok: false; error: CifError };

/** 归一化后结构最大边长（世界坐标单位），与内置演示结构量级一致 */
export const WORLD_EXTENT = 4.2;
/** 演示渲染上限，避免超大结构拖垮三维场景 */
export const MAX_ATOMS = 3000;

const fail = (kind: CifFailureKind, message: string, missing?: string[]): CifParseResult => ({
  ok: false,
  error: { kind, message, missing },
});

/* ---------------- 词法分析：注释、引号、分号文本块 ---------------- */

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let textBlock: string[] | null = null;
  for (const line of lines) {
    if (textBlock) {
      if (line.startsWith(';')) {
        tokens.push(textBlock.join('\n'));
        textBlock = null;
      } else {
        textBlock.push(line);
      }
      continue;
    }
    if (line.startsWith(';')) {
      textBlock = [line.slice(1)];
      continue;
    }
    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      if (ch === ' ' || ch === '\t') {
        i += 1;
        continue;
      }
      if (ch === '#') break; // 行内注释：# 出现在 token 起始位置
      if (ch === "'" || ch === '"') {
        const end = line.indexOf(ch, i + 1);
        if (end === -1) {
          tokens.push(line.slice(i + 1));
          i = line.length;
        } else {
          tokens.push(line.slice(i + 1, end));
          i = end + 1;
        }
        continue;
      }
      let j = i;
      while (j < line.length && line[j] !== ' ' && line[j] !== '\t') j += 1;
      tokens.push(line.slice(i, j));
      i = j;
    }
  }
  if (textBlock) tokens.push(textBlock.join('\n'));
  return tokens;
}

/* ---------------- 语法分析：data_ 块、键值对、loop_ 表 ---------------- */

interface CifLoop {
  tags: string[];
  rows: string[][];
}

interface CifDocument {
  blockName: string | null;
  singles: Map<string, string>;
  loops: CifLoop[];
}

const LOOP_KEYWORDS = /^(loop_|data_|stop_|save_|global_)/i;

function parseDocument(tokens: string[]): CifDocument | { error: string } {
  const doc: CifDocument = { blockName: null, singles: new Map(), loops: [] };
  let i = 0;
  let blockSeen = false;
  while (i < tokens.length) {
    const token = tokens[i];
    const lower = token.toLowerCase();
    if (lower.startsWith('data_')) {
      if (blockSeen) break; // 多数据块文件仅取第一个结构
      blockSeen = true;
      doc.blockName = token.slice(5) || null;
      i += 1;
      continue;
    }
    if (lower === 'loop_') {
      i += 1;
      const tags: string[] = [];
      while (i < tokens.length && tokens[i].startsWith('_')) {
        tags.push(tokens[i].toLowerCase());
        i += 1;
      }
      if (tags.length === 0) return { error: 'loop_ 之后缺少列标签（_ 开头的字段名）' };
      const values: string[] = [];
      while (i < tokens.length && !tokens[i].startsWith('_') && !LOOP_KEYWORDS.test(tokens[i])) {
        values.push(tokens[i]);
        i += 1;
      }
      if (i < tokens.length && tokens[i].toLowerCase() === 'stop_') i += 1;
      if (values.length === 0) return { error: `loop（${tags[0]} 等 ${tags.length} 列）没有数据行` };
      if (values.length % tags.length !== 0) {
        return { error: `loop 数据列数不匹配：${tags.length} 列标签对应 ${values.length} 个值` };
      }
      const rows: string[][] = [];
      for (let r = 0; r < values.length; r += tags.length) rows.push(values.slice(r, r + tags.length));
      doc.loops.push({ tags, rows });
      continue;
    }
    if (token.startsWith('_')) {
      const value = tokens[i + 1];
      if (value === undefined || value.startsWith('_') || LOOP_KEYWORDS.test(value)) {
        return { error: `标签 ${token} 缺少取值` };
      }
      doc.singles.set(token.toLowerCase(), value);
      i += 2;
      continue;
    }
    // stop_ / save_ / global_ 或孤立 token：宽容跳过
    i += 1;
  }
  return doc;
}

/* ---------------- 数值与符号解析 ---------------- */

/** 解析 CIF 数值，支持标准不确定度后缀，如 4.0495(2)；'.' / '?' 视为未知 */
function parseCifNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '.' || trimmed === '?') return null;
  const match = trimmed.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)(?:\(\d*\))?$/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/** 从 _atom_site_type_symbol 或 _atom_site_label 提取元素符号，如 Al3+ / Al1 → Al */
function normalizeElement(typeSymbol: string | undefined, label: string | undefined): string {
  const candidate = typeSymbol && typeSymbol !== '.' && typeSymbol !== '?' ? typeSymbol : label;
  if (!candidate) return 'X';
  const match = candidate.trim().match(/^([A-Za-z]{1,2})/);
  if (!match) return 'X';
  const raw = match[1];
  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

/** 由空间群 H-M 符号首字母推断点阵心型 */
function deriveLatticeType(spaceGroup: string): string {
  const letter = spaceGroup.trim().charAt(0).toUpperCase();
  switch (letter) {
    case 'F':
      return '面心 F';
    case 'I':
      return '体心 I';
    case 'P':
      return '简单 P';
    case 'R':
      return '菱方 R';
    case 'A':
    case 'B':
    case 'C':
      return `底心 ${letter}`;
    default:
      return '未标注';
  }
}

const FRACT_TAGS: readonly string[] = ['_atom_site_fract_x', '_atom_site_fract_y', '_atom_site_fract_z'];
const CARTN_TAGS: readonly string[] = ['_atom_site_cartn_x', '_atom_site_cartn_y', '_atom_site_cartn_z'];

/* ---------------- 主入口：解析 → 校验 → 坐标归一化 ---------------- */

export function parseCif(text: string, fallbackName = 'CIF 结构'): CifParseResult {
  if (!text || text.trim() === '') return fail('parse', '文件为空，未解析到任何 CIF 内容');

  const tokens = tokenize(text);
  if (!tokens.some(t => t.startsWith('_'))) {
    return fail('parse', '未识别到任何 CIF 标签（如 _cell_length_a、_atom_site_fract_x），文件可能不是 CIF 格式');
  }

  const parsed = parseDocument(tokens);
  if ('error' in parsed) return fail('parse', `CIF 语法错误：${parsed.error}`);

  const getSingle = (names: string[]): string | undefined => {
    for (const name of names) {
      const value = parsed.singles.get(name);
      if (value !== undefined) return value;
    }
    return undefined;
  };

  // —— 必填字段：晶胞棱长 + 原子站点坐标列（分数或直角坐标）——
  const missing: string[] = [];
  const cellA = parseCifNumber(getSingle(['_cell_length_a']));
  const cellB = parseCifNumber(getSingle(['_cell_length_b']));
  const cellC = parseCifNumber(getSingle(['_cell_length_c']));
  if (cellA === null) missing.push('_cell_length_a');
  if (cellB === null) missing.push('_cell_length_b');
  if (cellC === null) missing.push('_cell_length_c');

  const siteLoop = parsed.loops.find(loop =>
    loop.tags.some(tag => FRACT_TAGS.includes(tag) || CARTN_TAGS.includes(tag)),
  );
  let coordTags: readonly string[] | null = null;
  let coordinateMode: 'fractional' | 'cartesian' = 'fractional';
  if (siteLoop) {
    const hasFract = FRACT_TAGS.every(tag => siteLoop.tags.includes(tag));
    const hasCartn = CARTN_TAGS.every(tag => siteLoop.tags.includes(tag));
    if (hasFract) {
      coordTags = FRACT_TAGS;
      coordinateMode = 'fractional';
    } else if (hasCartn) {
      coordTags = CARTN_TAGS;
      coordinateMode = 'cartesian';
    } else {
      // 坐标列不完整：指出具体缺哪一列
      const basis = siteLoop.tags.some(tag => CARTN_TAGS.includes(tag)) && !siteLoop.tags.some(tag => FRACT_TAGS.includes(tag))
        ? CARTN_TAGS
        : FRACT_TAGS;
      for (const tag of basis) if (!siteLoop.tags.includes(tag)) missing.push(tag);
    }
  } else {
    missing.push('_atom_site_fract_x/y/z（或 _atom_site_Cartn_x/y/z）');
  }
  if (missing.length > 0) {
    return fail('missing-fields', `必填字段缺失：${missing.join('、')}`, missing);
  }

  // —— 晶胞夹角：缺省 90°（立方晶系常见写法），存在则必须是合法数值 ——
  const angleOrDefault = (names: string[]): number | null => {
    const raw = getSingle(names);
    if (raw === undefined) return 90;
    return parseCifNumber(raw);
  };
  const alpha = angleOrDefault(['_cell_angle_alpha']);
  const beta = angleOrDefault(['_cell_angle_beta']);
  const gamma = angleOrDefault(['_cell_angle_gamma']);
  if (alpha === null || beta === null || gamma === null) {
    return fail('invalid-coords', '晶胞夹角 _cell_angle_alpha/beta/gamma 不是合法数值');
  }
  if (!(cellA! > 0) || !(cellB! > 0) || !(cellC! > 0)) {
    return fail('invalid-coords', `晶胞棱长必须为正数（a=${cellA}, b=${cellB}, c=${cellC}）`);
  }
  if (alpha <= 0 || alpha >= 180 || beta <= 0 || beta >= 180 || gamma <= 0 || gamma >= 180) {
    return fail('invalid-coords', `晶胞夹角必须在 (0°, 180°) 之间（α=${alpha}°, β=${beta}°, γ=${gamma}°）`);
  }

  // —— 晶胞几何：分数坐标 → 直角坐标的转换矩阵 ——
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const cosA = Math.cos(toRad(alpha));
  const cosB = Math.cos(toRad(beta));
  const cosG = Math.cos(toRad(gamma));
  const sinG = Math.sin(toRad(gamma));
  if (Math.abs(sinG) < 1e-9) {
    return fail('invalid-coords', `晶胞夹角 γ=${gamma}° 导致晶胞退化（sinγ≈0）`);
  }
  const ax = cellA!;
  const bx = cellB! * cosG;
  const by = cellB! * sinG;
  const cx = cellC! * cosB;
  const cy = (cellC! * (cosA - cosB * cosG)) / sinG;
  const cz2 = cellC! * cellC! - cx * cx - cy * cy;
  if (cz2 <= 1e-12) {
    return fail('invalid-coords', '晶胞参数组合无法构成有效三维晶胞（体积 ≤ 0）');
  }
  const cz = Math.sqrt(cz2);

  // —— 原子站点：逐行校验坐标 ——
  const loop = siteLoop!;
  const tags = coordTags!;
  const ix = loop.tags.indexOf(tags[0]);
  const iy = loop.tags.indexOf(tags[1]);
  const iz = loop.tags.indexOf(tags[2]);
  const iLabel = loop.tags.indexOf('_atom_site_label');
  const iType = loop.tags.indexOf('_atom_site_type_symbol');
  if (loop.rows.length === 0) return fail('invalid-coords', '原子站点表为空，没有可导入的原子');
  if (loop.rows.length > MAX_ATOMS) {
    return fail('parse', `原子站点数 ${loop.rows.length} 超出演示渲染上限 ${MAX_ATOMS}`);
  }

  const rawAtoms: { element: string; u: number; v: number; w: number }[] = [];
  for (let r = 0; r < loop.rows.length; r += 1) {
    const row = loop.rows[r];
    const label = (iLabel >= 0 ? row[iLabel] : undefined) ?? `站点${r + 1}`;
    const u = parseCifNumber(row[ix]);
    const v = parseCifNumber(row[iy]);
    const w = parseCifNumber(row[iz]);
    if (u === null || v === null || w === null) {
      return fail(
        'invalid-coords',
        `第 ${r + 1} 行原子（${label}）坐标非法：'${row[ix]}', '${row[iy]}', '${row[iz]}'`,
      );
    }
    const limit = coordinateMode === 'fractional' ? 100 : 1e5;
    if (Math.abs(u) > limit || Math.abs(v) > limit || Math.abs(w) > limit) {
      return fail('invalid-coords', `第 ${r + 1} 行原子（${label}）坐标超出合理范围`);
    }
    rawAtoms.push({
      element: normalizeElement(iType >= 0 ? row[iType] : undefined, iLabel >= 0 ? row[iLabel] : undefined),
      u,
      v,
      w,
    });
  }

  // —— 坐标归一化：分数坐标回卷 [0,1) → 直角坐标（Å）→ 居中 → 等比缩放 ——
  const wrap = (value: number) => ((value % 1) + 1) % 1;
  const cartesian = rawAtoms.map(atom => {
    if (coordinateMode === 'cartesian') return { x: atom.u, y: atom.v, z: atom.w };
    const fu = wrap(atom.u);
    const fv = wrap(atom.v);
    const fw = wrap(atom.w);
    return {
      x: fu * ax + fv * bx + fw * cx,
      y: fv * by + fw * cy,
      z: fw * cz,
    };
  });

  const xs = cartesian.map(p => p.x);
  const ys = cartesian.map(p => p.y);
  const zs = cartesian.map(p => p.z);
  const centerX = (Math.min(...xs) + Math.max(...xs)) / 2;
  const centerY = (Math.min(...ys) + Math.max(...ys)) / 2;
  const centerZ = (Math.min(...zs) + Math.max(...zs)) / 2;
  const extent = Math.max(
    Math.max(...xs) - Math.min(...xs),
    Math.max(...ys) - Math.min(...ys),
    Math.max(...zs) - Math.min(...zs),
  );
  const scale = extent > 1e-9 ? WORLD_EXTENT / extent : 1;
  const atoms: CifAtom[] = cartesian.map((p, index) => ({
    element: rawAtoms[index].element,
    x: (p.x - centerX) * scale,
    y: (p.y - centerY) * scale,
    z: (p.z - centerZ) * scale,
  }));

  // —— 摘要元数据 ——
  const spaceGroup = (
    getSingle(['_symmetry_space_group_name_h-m', '_space_group_name_h-m_alt', '_symmetry_space_group_name_hall']) ?? ''
  )
    .replace(/\s+/g, ' ')
    .trim();
  const formula =
    getSingle(['_chemical_formula_sum', '_chemical_formula_structural', '_chemical_formula_iupac']) ?? '';
  const density = getSingle(['_exptl_crystal_density_diffrn', '_exptl_crystal_density_meas']) ?? null;
  const temperature = getSingle(['_diffrn_ambient_temperature', '_cell_measurement_temperature']) ?? null;

  return {
    ok: true,
    structure: {
      atoms,
      meta: {
        name: parsed.blockName ?? fallbackName,
        formula,
        spaceGroup,
        latticeType: deriveLatticeType(spaceGroup),
        cellA: cellA!,
        cellB: cellB!,
        cellC: cellC!,
        alpha,
        beta,
        gamma,
        density,
        temperature,
        coordinateMode,
        worldScale: scale,
      },
    },
  };
}
