import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Canvas } from '@react-three/fiber';
import { Grid, Line, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { parseCif, type CifFailureKind, type CifStructure } from './cif';

type DefectType = 'vacancy' | 'substitution' | 'dislocation';
type BaseAtom = { key: string; x: number; y: number; z: number; element: string };
type DisplayAtom = BaseAtom & { defect: 'normal' | 'substitution' };
type StructureMeta = {
  source: 'builtin' | 'cif';
  latticeType: string;
  cellText: string;
  cellTitle: string;
  densityText: string;
  tempText: string;
  formula: string;
  origin: string;
};
type Structure = { atoms: BaseAtom[]; meta: StructureMeta };
type ImportedStructure = { id: number; fileName: string; structure: Structure };

const colors = { host: '#64c9e1', substitution: '#efb863', vacancy: '#ef7e83', bond: '#4b8190' };
/** 超过该原子数时跳过最近邻连线计算，避免 O(n²) 拖垮场景 */
const BOND_MAX_ATOMS = 800;
/** 最近邻判定阈值：最小原子间距 × 1.15 */
const BOND_CUTOFF_RATIO = 1.15;
const MAX_FILE_SIZE = 10 * 1024 * 1024;

const FAILURE_LABEL: Record<CifFailureKind, string> = {
  parse: '解析失败',
  'missing-fields': '字段缺失',
  'invalid-coords': '坐标非法',
};

/* ---------- 内置 FCC 演示结构（保留原有演示行为） ---------- */
function buildBuiltinStructure(cells: number): Structure {
  const atoms: BaseAtom[] = [];
  const offset = ((cells - 1) / 2) * 1.25;
  for (let x = 0; x < cells; x += 1)
    for (let y = 0; y < cells; y += 1)
      for (let z = 0; z < cells; z += 1)
        atoms.push({ key: `b-${x}-${y}-${z}`, x: x * 1.25 - offset, y: y * 1.25 - offset, z: z * 1.25 - offset, element: 'Al' });
  return {
    atoms,
    meta: {
      source: 'builtin',
      latticeType: 'FCC',
      cellText: '4.05 Å',
      cellTitle: 'a = b = c = 4.05 Å，α = β = γ = 90°',
      densityText: '2.70 g/cm³',
      tempText: '298 K',
      formula: 'Al（演示）',
      origin: `内置演示 · ${cells}³ 晶胞`,
    },
  };
}

const fmtCell = (value: number) =>
  value.toFixed(4).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

/** 将解析后的 CIF 结构转换为场景结构；坐标已在解析层完成归一化 */
function structureFromCif(parsed: CifStructure, fileName: string): Structure {
  const meta = parsed.meta;
  const cubicish =
    Math.abs(meta.cellA - meta.cellB) < 1e-6 &&
    Math.abs(meta.cellB - meta.cellC) < 1e-6 &&
    [meta.alpha, meta.beta, meta.gamma].every(angle => Math.abs(angle - 90) < 1e-6);
  const cellText = cubicish
    ? `${fmtCell(meta.cellA)} Å`
    : `${fmtCell(meta.cellA)} / ${fmtCell(meta.cellB)} / ${fmtCell(meta.cellC)} Å`;
  const cellTitle = `a=${fmtCell(meta.cellA)} Å，b=${fmtCell(meta.cellB)} Å，c=${fmtCell(meta.cellC)} Å；α=${meta.alpha}°，β=${meta.beta}°，γ=${meta.gamma}°`;
  const spaceGroup = meta.spaceGroup.replace(/\s+/g, '');
  return {
    atoms: parsed.atoms.map((atom, index) => ({ key: `c-${index}`, x: atom.x, y: atom.y, z: atom.z, element: atom.element })),
    meta: {
      source: 'cif',
      latticeType: spaceGroup ? `${meta.latticeType} · ${spaceGroup}` : meta.latticeType,
      cellText,
      cellTitle,
      densityText: meta.density ? `${meta.density} g/cm³` : '—',
      tempText: meta.temperature ? `${meta.temperature} K` : '—',
      formula: meta.formula || meta.name || fileName,
      origin: `CIF · ${fileName}`,
    },
  };
}

/* ---------- 通用结构工具 ---------- */
function bboxCenter(atoms: BaseAtom[]) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const atom of atoms) {
    minX = Math.min(minX, atom.x); maxX = Math.max(maxX, atom.x);
    minY = Math.min(minY, atom.y); maxY = Math.max(maxY, atom.y);
    minZ = Math.min(minZ, atom.z); maxZ = Math.max(maxZ, atom.z);
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 };
}

function nearestIndex(atoms: BaseAtom[], target: { x: number; y: number; z: number }) {
  let best = 0;
  let bestD = Infinity;
  atoms.forEach((atom, index) => {
    const d = (atom.x - target.x) ** 2 + (atom.y - target.y) ** 2 + (atom.z - target.z) ** 2;
    if (d < bestD - 1e-12) {
      bestD = d;
      best = index;
    }
  });
  return best;
}

/** 内置缺陷模型：对任意当前结构（内置或 CIF 导入）统一施加 */
function applyDefect(atoms: BaseAtom[], defect: DefectType): { atoms: DisplayAtom[]; removed: BaseAtom | null } {
  if (atoms.length === 0) return { atoms: [], removed: null };
  const center = bboxCenter(atoms);
  if (defect === 'substitution') {
    const index = nearestIndex(atoms, center);
    return {
      atoms: atoms.map((atom, i) => ({ ...atom, defect: i === index ? ('substitution' as const) : ('normal' as const) })),
      removed: null,
    };
  }
  if (defect === 'vacancy') {
    const index = nearestIndex(atoms, center);
    return {
      atoms: atoms.filter((_, i) => i !== index).map(atom => ({ ...atom, defect: 'normal' as const })),
      removed: atoms[index],
    };
  }
  // 刃型位错：移除底面中心原子，模拟半原子面边缘
  const minY = Math.min(...atoms.map(atom => atom.y));
  const index = nearestIndex(atoms, { x: center.x, y: minY, z: center.z });
  return {
    atoms: atoms.filter((_, i) => i !== index).map(atom => ({ ...atom, defect: 'normal' as const })),
    removed: atoms[index],
  };
}

/** 最近邻连线：最小间距 × 1.15 内的原子对，内置与导入结构统一算法 */
function computeBonds(atoms: { x: number; y: number; z: number }[]): { pairs: [THREE.Vector3, THREE.Vector3][]; minDist: number } {
  if (atoms.length < 2 || atoms.length > BOND_MAX_ATOMS) return { pairs: [], minDist: 0 };
  const dist2 = (i: number, j: number) =>
    (atoms[i].x - atoms[j].x) ** 2 + (atoms[i].y - atoms[j].y) ** 2 + (atoms[i].z - atoms[j].z) ** 2;
  let minD2 = Infinity;
  for (let i = 0; i < atoms.length; i += 1)
    for (let j = i + 1; j < atoms.length; j += 1) minD2 = Math.min(minD2, dist2(i, j));
  const minDist = Math.sqrt(minD2);
  const cut2 = (minDist * BOND_CUTOFF_RATIO + 1e-9) ** 2;
  const pairs: [THREE.Vector3, THREE.Vector3][] = [];
  for (let i = 0; i < atoms.length; i += 1)
    for (let j = i + 1; j < atoms.length; j += 1)
      if (dist2(i, j) <= cut2)
        pairs.push([
          new THREE.Vector3(atoms[i].x, atoms[i].y, atoms[i].z),
          new THREE.Vector3(atoms[j].x, atoms[j].y, atoms[j].z),
        ]);
  return { pairs, minDist };
}

function structureExtent(atoms: BaseAtom[]): number {
  if (atoms.length === 0) return 3.75;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const atom of atoms) {
    minX = Math.min(minX, atom.x); maxX = Math.max(maxX, atom.x);
    minY = Math.min(minY, atom.y); maxY = Math.max(maxY, atom.y);
    minZ = Math.min(minZ, atom.z); maxZ = Math.max(maxZ, atom.z);
  }
  return Math.max(maxX - minX, maxY - minY, maxZ - minZ);
}

/* ---------- 三维场景 ---------- */
function DefectScene({ structureId, atoms, removed, bonds, minDist, defect, showBonds, planeOpacity, extent }: {
  structureId: string;
  atoms: DisplayAtom[];
  removed: BaseAtom | null;
  bonds: [THREE.Vector3, THREE.Vector3][];
  minDist: number;
  defect: DefectType;
  showBonds: boolean;
  planeOpacity: number;
  extent: number;
}) {
  const atomRadius = minDist > 0 ? Math.min(0.45, Math.max(0.06, minDist * 0.16)) : 0.2;
  const half = Math.max(extent / 2, 0.9);
  const step = half / 3;
  const dislocationLine = useMemo(() => [
    new THREE.Vector3(-half, -half, 0),
    new THREE.Vector3(-step, -half, 0),
    new THREE.Vector3(-step, -step, 0),
    new THREE.Vector3(step, -step, 0),
    new THREE.Vector3(step, step, 0),
    new THREE.Vector3(half, step, 0),
  ], [half, step]);
  const bondPoints = useMemo(() => bonds.flatMap(pair => pair), [bonds]);
  const planeSize = Math.max(3, extent * 1.5);
  return (
    <Canvas shadows camera={{ position: [8, 6, 8], fov: 38 }}>
      <color attach="background" args={['#09151d']} />
      <ambientLight intensity={1.25} />
      <directionalLight position={[5, 8, 5]} intensity={2.3} castShadow />
      <pointLight position={[-4, 2, 3]} color="#5fd4ee" intensity={12} distance={12} />
      <group rotation={[0.15, -0.35, 0]}>
        {showBonds && bondPoints.length > 0 && (
          <Line key={`bonds-${structureId}-${defect}`} segments points={bondPoints} color={colors.bond} lineWidth={1.2} transparent opacity={0.65} />
        )}
        {atoms.map(atom => {
          const isSubstitution = atom.defect === 'substitution';
          return (
            <mesh key={atom.key} position={[atom.x, atom.y, atom.z]} castShadow>
              <sphereGeometry args={[isSubstitution ? atomRadius * 1.5 : atomRadius, 18, 12]} />
              <meshStandardMaterial
                color={isSubstitution ? colors.substitution : colors.host}
                emissive={isSubstitution ? colors.substitution : '#000'}
                emissiveIntensity={isSubstitution ? 0.35 : 0}
              />
            </mesh>
          );
        })}
        {defect === 'vacancy' && removed && (
          <mesh position={[removed.x, removed.y, removed.z]}>
            <sphereGeometry args={[atomRadius * 1.75, 16, 12]} />
            <meshBasicMaterial color={colors.vacancy} transparent opacity={0.26} wireframe />
          </mesh>
        )}
        {defect === 'dislocation' && <Line points={dislocationLine} color="#f08d87" lineWidth={4} />}
      </group>
      <mesh rotation={[0, 0, 0]} position={[0, 0, 0]}>
        <planeGeometry args={[planeSize, planeSize]} />
        <meshBasicMaterial color="#69cde2" transparent opacity={planeOpacity} side={THREE.DoubleSide} />
      </mesh>
      <Grid args={[8, 8]} cellSize={1.25} sectionSize={2.5} cellColor="#326778" sectionColor="#72b9c9" position={[0, -(half + 0.7), 0]} />
      <OrbitControls makeDefault minDistance={5} maxDistance={15} />
    </Canvas>
  );
}

function DefectCard({ type, active, onClick, title, subtitle, color }: { type: DefectType; active: boolean; onClick: () => void; title: string; subtitle: string; color: string }) {
  return (
    <button className={active ? 'defect-card active' : 'defect-card'} onClick={onClick}>
      <span className="defect-symbol" style={{ color }}>{type === 'vacancy' ? '○' : type === 'substitution' ? '◉' : '∿'}</span>
      <span><b>{title}</b><small>{subtitle}</small></span>
      <i>{active ? 'ACTIVE' : 'SELECT'}</i>
    </button>
  );
}

export default function App() {
  const [cells, setCells] = useState(4);
  const [defect, setDefect] = useState<DefectType>('vacancy');
  const [showBonds, setShowBonds] = useState(true);
  const [planeOpacity, setPlaneOpacity] = useState(0.08);
  const [notice, setNotice] = useState<{ text: string; kind: 'info' | 'error' } | null>(null);
  const [imported, setImported] = useState<ImportedStructure | null>(null);
  const [importStatus, setImportStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const builtin = useMemo(() => buildBuiltinStructure(cells), [cells]);
  const structure = imported ? imported.structure : builtin;
  const structureId = imported ? `cif-${imported.id}` : `builtin-${cells}`;

  const display = useMemo(() => applyDefect(structure.atoms, defect), [structure, defect]);
  const { pairs: bonds, minDist } = useMemo(() => computeBonds(display.atoms), [display]);
  const extent = useMemo(() => structureExtent(structure.atoms), [structure]);

  const metrics = useMemo(() => {
    const atomCount = display.atoms.length;
    const coordination = atomCount > 0 && bonds.length > 0 ? ((2 * bonds.length) / atomCount).toFixed(1) : '—';
    const strain = defect === 'dislocation' ? '8.4%' : defect === 'substitution' ? '3.1%' : '1.7%';
    return { atomCount, coordination, strain };
  }, [display, bonds, defect]);

  /**
   * CIF 导入：整批提交。
   * 文件仅在本地读取解析（不上传）；解析、字段校验、坐标校验、归一化全部
   * 通过后，才用一次 setImported 整体替换当前结构；任一失败仅更新提示
   * 状态，imported 保持不变，旧模型原样保留。
   */
  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // 允许重复选择同一文件
    if (!file) return;
    if (file.size > MAX_FILE_SIZE) {
      setImportStatus({ ok: false, text: `导入失败（解析失败）：${file.name} 超过 10 MB，超出本地解析上限，已保留当前结构` });
      setNotice({ kind: 'error', text: 'CIF 导入失败：文件超过 10 MB，已保留当前结构' });
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      setImportStatus({ ok: false, text: `导入失败（解析失败）：无法读取文件 ${file.name}，已保留当前结构` });
      setNotice({ kind: 'error', text: 'CIF 导入失败：文件读取失败，已保留当前结构' });
      return;
    }
    const result = parseCif(text, file.name);
    if (!result.ok) {
      const label = FAILURE_LABEL[result.error.kind];
      setImportStatus({ ok: false, text: `导入失败（${label}）：${result.error.message}，已保留当前结构` });
      setNotice({ kind: 'error', text: `CIF 导入失败（${label}）：${result.error.message}，已保留当前结构` });
      return;
    }
    setImported({ id: Date.now(), fileName: file.name, structure: structureFromCif(result.structure, file.name) });
    setImportStatus({
      ok: true,
      text: `导入成功：${file.name} · ${result.structure.atoms.length} 个原子站点（${result.structure.meta.coordinateMode === 'fractional' ? '分数坐标' : '直角坐标'}，已归一化）`,
    });
    setNotice({ kind: 'info', text: `CIF 导入成功：${file.name}，模型、原子数与晶格参数已更新` });
  };

  const restoreBuiltin = () => {
    setImported(null);
    setImportStatus({ ok: true, text: '已恢复内置 FCC 演示结构' });
  };

  const sampleLabel = imported ? `SAMPLE / CIF-${imported.fileName.slice(0, 24).toUpperCase()}` : 'SAMPLE / FCC-AL-04';

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-icon">◈</div>
          <div>
            <span className="eyebrow">MATERIALS SCIENCE / LATTICE LAB</span>
            <h1>Crystal Defect Lab <span>·</span> 晶格缺陷分析</h1>
          </div>
        </div>
        <div className="header-meta">
          <span className="sample">{sampleLabel}</span>
          <button onClick={() => setNotice({ kind: 'info', text: '结构快照已准备，可接入数据导出' })}>导出快照 ↗</button>
        </div>
      </header>
      <main className="layout">
        <section className="model-card">
          <div className="model-head">
            <div>
              <span className="eyebrow">{imported ? 'CIF STRUCTURE VIEW' : 'UNIT CELL EXPLORER'}</span>
              <h2>{imported ? `CIF 导入结构 · ${imported.fileName}` : '面心立方晶格 · 缺陷结构可视化'}</h2>
            </div>
            <div className="head-stats">
              <span><b>{imported ? 'CIF' : `${cells}³`}</b> {imported ? '外部结构' : '晶胞'}</span>
              <span><b>{metrics.atomCount}</b> 原子</span>
            </div>
          </div>
          <div className="canvas-wrap">
            <DefectScene
              structureId={structureId}
              atoms={display.atoms}
              removed={display.removed}
              bonds={bonds}
              minDist={minDist}
              defect={defect}
              showBonds={showBonds}
              planeOpacity={planeOpacity}
              extent={extent}
            />
            <div className="model-legend">
              <span><i className="dot host" />基体原子</span>
              <span><i className="dot sub" />缺陷原子</span>
              <span><i className="dot line" />滑移/缺陷线</span>
            </div>
            <div className="model-hint">拖拽旋转 · 滚轮缩放 · 三维晶面已叠加</div>
          </div>
        </section>
        <aside className="sidebar">
          <section className="panel summary">
            <span className="eyebrow">STRUCTURE SUMMARY</span>
            <h3>晶格参数</h3>
            <div className="summary-grid">
              <div><span>晶格类型</span><b>{structure.meta.latticeType}</b></div>
              <div><span>晶格常数</span><b title={structure.meta.cellTitle}>{structure.meta.cellText}</b></div>
              <div><span>理论密度</span><b>{structure.meta.densityText}</b></div>
              <div><span>当前温度</span><b>{structure.meta.tempText}</b></div>
              <div><span>化学式</span><b>{structure.meta.formula}</b></div>
              <div><span>数据来源</span><b>{structure.meta.origin}</b></div>
            </div>
          </section>
          <section className="panel import-panel">
            <div className="panel-title">
              <div>
                <span className="eyebrow">CIF IMPORT</span>
                <h3>CIF 结构导入</h3>
              </div>
              <span className="count">本地解析</span>
            </div>
            <p className="import-note">
              文件仅在浏览器本地解析，不会上传。导入策略：整批提交 —— 校验全部通过后一次性替换当前结构；任一字段缺失、坐标非法或解析失败都会保留原模型。
            </p>
            <div className="import-actions">
              <button onClick={() => fileInputRef.current?.click()}>选择 CIF 文件</button>
              {imported && <button className="ghost" onClick={restoreBuiltin}>恢复内置演示</button>}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".cif,.txt"
              style={{ display: 'none' }}
              onChange={handleFile}
            />
            {importStatus && <div className={importStatus.ok ? 'import-status ok' : 'import-status fail'}>{importStatus.text}</div>}
          </section>
          <section className="panel">
            <div className="panel-title">
              <div>
                <span className="eyebrow">DEFECT LIBRARY</span>
                <h3>缺陷类型</h3>
              </div>
              <span className="count">3 MODELS</span>
            </div>
            <div className="defect-list">
              <DefectCard type="vacancy" active={defect === 'vacancy'} onClick={() => setDefect('vacancy')} title="空位缺陷" subtitle="原子位置缺失" color={colors.vacancy} />
              <DefectCard type="substitution" active={defect === 'substitution'} onClick={() => setDefect('substitution')} title="替位缺陷" subtitle="异质原子替换" color={colors.substitution} />
              <DefectCard type="dislocation" active={defect === 'dislocation'} onClick={() => setDefect('dislocation')} title="刃型位错" subtitle="局部滑移面错位" color="#ef8d86" />
            </div>
          </section>
          <section className="panel controls">
            <div className="panel-title">
              <div>
                <span className="eyebrow">ANALYSIS CONTROLS</span>
                <h3>分析参数</h3>
              </div>
            </div>
            <label>
              晶胞数量
              <output>{imported ? '仅内置演示' : `${cells} × ${cells} × ${cells}`}</output>
              <input type="range" min="3" max="5" value={cells} disabled={!!imported} onChange={event => setCells(Number(event.target.value))} />
            </label>
            <label>
              晶面透明度
              <output>{Math.round(planeOpacity * 100)}%</output>
              <input type="range" min="0" max=".3" step=".01" value={planeOpacity} onChange={event => setPlaneOpacity(Number(event.target.value))} />
            </label>
            <button className={showBonds ? 'toggle active' : 'toggle'} onClick={() => setShowBonds(value => !value)}>
              <span className="toggle-dot" />显示最近邻连接
            </button>
          </section>
          <section className="panel metrics-panel">
            <span className="eyebrow">DEFECT METRICS</span>
            <h3>结构指标</h3>
            <div className="metric-row">
              <div><span>原子数</span><b>{metrics.atomCount}</b></div>
              <div><span>平均配位</span><b>{metrics.coordination}</b></div>
              <div><span>局部应变</span><b>{metrics.strain}</b></div>
            </div>
            <p>原子数与平均配位由当前结构实时计算；局部应变为演示估值，后续可接入真实模拟数据。</p>
          </section>
          {notice && (
            <div className={notice.kind === 'error' ? 'toast error' : 'toast'} onClick={() => setNotice(null)}>
              {notice.text}<span>×</span>
            </div>
          )}
        </aside>
      </main>
    </div>
  );
}
