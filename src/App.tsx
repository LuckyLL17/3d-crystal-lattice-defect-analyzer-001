import { useMemo, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { Grid, Line, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { parseCif } from './cif';
import { buildImportedStructure, ImportedStructure } from './structure';

type DefectType = 'vacancy' | 'substitution' | 'dislocation';
type ViewMode = 'builtin' | 'imported';
type Notice = { kind: 'info' | 'error'; text: string };
type AtomPoint = { key: string; x: number; y: number; z: number; defect?: 'vacancy' | 'substitution' | 'normal' };

const colors = { host: '#64c9e1', substitution: '#efb863', vacancy: '#ef7e83', bond: '#4b8190', cell: '#7fd8be' };
const MAX_FILE_BYTES = 8 * 1024 * 1024;

function buildAtoms(cells: number, defect: DefectType): AtomPoint[] {
  const atoms: AtomPoint[] = [];
  for (let x = 0; x < cells; x += 1)
    for (let y = 0; y < cells; y += 1)
      for (let z = 0; z < cells; z += 1) {
        const key = `${x}-${y}-${z}`;
        if (defect === 'vacancy' && x === 1 && y === 1 && z === 1) continue;
        if (defect === 'substitution' && x === 1 && y === 1 && z === 1) atoms.push({ key, x, y, z, defect: 'substitution' });
        else atoms.push({ key, x, y, z, defect: 'normal' });
      }
  if (defect === 'dislocation') return atoms.filter(atom => !(atom.x === 2 && atom.y === 0 && atom.z === 2));
  return atoms;
}

const gridPosition = (atom: AtomPoint, cells: number): [number, number, number] => [
  (atom.x - (cells - 1) / 2) * 1.25,
  (atom.y - (cells - 1) / 2) * 1.25,
  (atom.z - (cells - 1) / 2) * 1.25,
];

/** 内置 FCC 演示晶格（含缺陷模型） */
function BuiltinModel({ cells, defect, showBonds }: { cells: number; defect: DefectType; showBonds: boolean }) {
  const atoms = useMemo(() => buildAtoms(cells, defect), [cells, defect]);
  const bonds = useMemo(() => {
    const list: [THREE.Vector3, THREE.Vector3][] = [];
    atoms.forEach(atom => {
      const origin = new THREE.Vector3(...gridPosition(atom, cells));
      const neighbor = atoms.find(item => item.x === atom.x + 1 && item.y === atom.y && item.z === atom.z);
      if (neighbor) list.push([origin, new THREE.Vector3(...gridPosition(neighbor, cells))]);
      const zNeighbor = atoms.find(item => item.x === atom.x && item.y === atom.y && item.z === atom.z + 1);
      if (zNeighbor) list.push([origin, new THREE.Vector3(...gridPosition(zNeighbor, cells))]);
    });
    return list;
  }, [atoms, cells]);
  return (
    <group rotation={[0.15, -0.35, 0]}>
      {showBonds && bonds.map((bond, index) => <Line key={index} points={bond} color={colors.bond} lineWidth={1.2} transparent opacity={0.65} />)}
      {atoms.map(atom => {
        const color = atom.defect === 'substitution' ? colors.substitution : colors.host;
        return (
          <mesh key={atom.key} position={gridPosition(atom, cells)} castShadow>
            <sphereGeometry args={[atom.defect === 'substitution' ? 0.3 : 0.2, 18, 12]} />
            <meshStandardMaterial color={color} emissive={atom.defect === 'substitution' ? colors.substitution : '#000'} emissiveIntensity={atom.defect === 'substitution' ? 0.35 : 0} />
          </mesh>
        );
      })}
      {defect === 'vacancy' && (
        <mesh position={gridPosition({ key: 'v', x: 1, y: 1, z: 1 }, cells)}>
          <sphereGeometry args={[0.35, 16, 12]} />
          <meshBasicMaterial color={colors.vacancy} transparent opacity={0.26} wireframe />
        </mesh>
      )}
      {defect === 'dislocation' && (
        <Line
          points={[new THREE.Vector3(-1.9, -1.9, 0), new THREE.Vector3(-0.65, -1.9, 0), new THREE.Vector3(-0.65, -0.65, 0), new THREE.Vector3(0.65, -0.65, 0), new THREE.Vector3(0.65, 0.65, 0), new THREE.Vector3(1.9, 0.65, 0)]}
          color="#f08d87"
          lineWidth={4}
        />
      )}
    </group>
  );
}

/** 导入的 CIF 结构：原子球、最近邻连接与晶胞边框 */
function ImportedModel({ structure, showBonds }: { structure: ImportedStructure; showBonds: boolean }) {
  return (
    <group rotation={[0.15, -0.35, 0]}>
      {structure.cellEdges.map((edge, index) => (
        <Line key={`edge-${index}`} points={edge} color={colors.cell} lineWidth={1} transparent opacity={0.5} dashed dashSize={0.12} gapSize={0.07} />
      ))}
      {showBonds && structure.bonds.map((bond, index) => <Line key={`bond-${index}`} points={bond} color={colors.bond} lineWidth={1.2} transparent opacity={0.65} />)}
      {structure.atoms.map(atom => (
        <mesh key={atom.key} position={atom.position} castShadow>
          <sphereGeometry args={[atom.radius, 18, 12]} />
          <meshStandardMaterial color={atom.color} />
        </mesh>
      ))}
    </group>
  );
}

function DefectScene({ cells, defect, imported, view, showBonds, planeOpacity }: { cells: number; defect: DefectType; imported: ImportedStructure | null; view: ViewMode; showBonds: boolean; planeOpacity: number }) {
  return (
    <Canvas shadows camera={{ position: [8, 6, 8], fov: 38 }}>
      <color attach="background" args={['#09151d']} />
      <ambientLight intensity={1.25} />
      <directionalLight position={[5, 8, 5]} intensity={2.3} castShadow />
      <pointLight position={[-4, 2, 3]} color="#5fd4ee" intensity={12} distance={12} />
      {view === 'imported' && imported ? <ImportedModel structure={imported} showBonds={showBonds} /> : <BuiltinModel cells={cells} defect={defect} showBonds={showBonds} />}
      <mesh rotation={[0, 0, 0]} position={[0, 0, 0]}>
        <planeGeometry args={[5.6, 5.6]} />
        <meshBasicMaterial color="#69cde2" transparent opacity={planeOpacity} side={THREE.DoubleSide} />
      </mesh>
      <Grid args={[8, 8]} cellSize={1.25} sectionSize={2.5} cellColor="#326778" sectionColor="#72b9c9" position={[0, -2.55, 0]} />
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
  const [notice, setNotice] = useState<Notice | null>(null);
  const [imported, setImported] = useState<ImportedStructure | null>(null);
  const [view, setView] = useState<ViewMode>('builtin');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const viewingImported = view === 'imported' && imported !== null;

  /** 整批提交：解析、校验、归一化全部通过后才一次性切换模型状态；任何失败只提示，保留旧模型 */
  const importCifFile = async (file: File) => {
    if (file.size > MAX_FILE_BYTES) {
      setNotice({ kind: 'error', text: `导入失败：文件 ${(file.size / 1024 / 1024).toFixed(1)} MB 超过 8 MB 上限，已保留当前模型` });
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      setNotice({ kind: 'error', text: '导入失败：无法读取文件，已保留当前模型' });
      return;
    }
    const result = parseCif(text);
    if (!result.ok) {
      setNotice({ kind: 'error', text: `导入失败：${result.error}，已保留当前模型` });
      return;
    }
    const structure = buildImportedStructure(result.data, file.name);
    setImported(structure);
    setView('imported');
    setNotice({ kind: 'info', text: `已导入 ${file.name}：${structure.atomCount} 个原子 · ${structure.formula}` });
  };

  const onFilePicked = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void importCifFile(file);
    event.target.value = ''; // 允许重复选择同一文件
  };

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (file) void importCifFile(file);
  };

  const selectBuiltinDefect = (type: DefectType) => {
    setDefect(type);
    setView('builtin');
  };

  const metrics = useMemo(() => {
    if (viewingImported && imported) {
      return {
        atoms: imported.atomCount,
        neighbors: imported.avgCoordination,
        thirdLabel: '最近邻距',
        thirdValue: imported.minDistance !== null ? `${imported.minDistance.toFixed(2)} Å` : '—',
        footnote: '指标由导入的 CIF 实时计算，显示含晶胞边界周期像。',
      };
    }
    return {
      atoms: defect === 'vacancy' ? cells ** 3 - 1 : cells ** 3,
      neighbors: defect === 'dislocation' ? '5 / 6' : defect === 'vacancy' ? '5 / 6' : '6 / 6',
      thirdLabel: '局部应变',
      thirdValue: defect === 'dislocation' ? '8.4%' : defect === 'substitution' ? '3.1%' : '1.7%',
      footnote: '指标为演示计算结果，后续可接入真实晶体结构文件与模拟数据。',
    };
  }, [viewingImported, imported, cells, defect]);

  const summary = useMemo(() => {
    if (viewingImported && imported) {
      const { cell } = imported;
      const fmt = (value: number) => value.toFixed(3);
      return [
        { label: '化学式', value: imported.formula },
        { label: '空间群', value: imported.spaceGroup },
        { label: '晶胞边长 (Å)', value: `${fmt(cell.a)} · ${fmt(cell.b)} · ${fmt(cell.c)}` },
        { label: '晶胞夹角 (°)', value: `${fmt(cell.alpha)} · ${fmt(cell.beta)} · ${fmt(cell.gamma)}` },
        { label: '晶胞体积', value: `${cell.volume.toFixed(2)} Å³` },
        { label: '理论密度', value: imported.density !== null ? `${imported.density.toFixed(2)} g/cm³` : '—' },
        { label: '列出原子位', value: `${imported.siteCount}` },
      ];
    }
    return [
      { label: '晶格类型', value: 'FCC' },
      { label: '晶格常数', value: '4.05 Å' },
      { label: '理论密度', value: '2.70 g/cm³' },
      { label: '当前温度', value: '298 K' },
    ];
  }, [viewingImported, imported]);

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
          <span className="sample">SAMPLE / {viewingImported && imported ? imported.sourceName : 'FCC-AL-04 演示'}</span>
          <button onClick={() => setNotice({ kind: 'info', text: '结构快照已准备，可接入数据导出' })}>导出快照 ↗</button>
        </div>
      </header>
      <main className="layout">
        <section className="model-card">
          <div className="model-head">
            <div>
              <span className="eyebrow">UNIT CELL EXPLORER</span>
              <h2>{viewingImported && imported ? `CIF 结构 · ${imported.formula}` : '面心立方晶格 · 缺陷结构可视化'}</h2>
            </div>
            <div className="head-stats">
              {viewingImported && imported ? (
                <>
                  <span><b>CIF</b> 已导入</span>
                  <span><b>{imported.atomCount}</b> 原子</span>
                </>
              ) : (
                <>
                  <span><b>{cells}³</b> 晶胞</span>
                  <span><b>{metrics.atoms}</b> 原子</span>
                </>
              )}
            </div>
          </div>
          <div className="canvas-wrap" onDragOver={event => event.preventDefault()} onDrop={onDrop}>
            <DefectScene cells={cells} defect={defect} imported={imported} view={view} showBonds={showBonds} planeOpacity={planeOpacity} />
            <div className="model-legend">
              {viewingImported && imported ? (
                <>
                  {imported.elements.slice(0, 5).map(item => (
                    <span key={item.symbol}><i className="dot" style={{ background: item.color }} />{item.symbol}</span>
                  ))}
                  <span><i className="dot cell" />晶胞边框</span>
                </>
              ) : (
                <>
                  <span><i className="dot host" />基体原子</span>
                  <span><i className="dot sub" />缺陷原子</span>
                  <span><i className="dot line" />滑移/缺陷线</span>
                </>
              )}
            </div>
            <div className="model-hint">拖拽旋转 · 滚轮缩放 · 可拖入 CIF 文件</div>
          </div>
        </section>
        <aside className="sidebar">
          <section className="panel import-panel">
            <div className="panel-title">
              <div>
                <span className="eyebrow">CIF IMPORT</span>
                <h3>本地结构对照</h3>
              </div>
              <span className="count">LOCAL ONLY</span>
            </div>
            <p className="import-desc">选择本地 CIF 文件，浏览器内完成解析、校验与坐标归一化，文件不会上传。导入成功即整批切换模型，失败则保留当前结构。</p>
            <div className="import-actions">
              <button className="import-btn" onClick={() => fileInputRef.current?.click()}>选择 CIF 文件…</button>
              {viewingImported && (
                <button className="import-btn ghost" onClick={() => setView('builtin')}>返回内置演示</button>
              )}
            </div>
            <div className="import-status">
              <span>当前模型</span>
              <b>{viewingImported && imported ? imported.sourceName : '内置 FCC 演示结构'}</b>
            </div>
            <input ref={fileInputRef} type="file" accept=".cif,.txt,.cifcore" hidden onChange={onFilePicked} />
          </section>
          <section className="panel summary">
            <span className="eyebrow">STRUCTURE SUMMARY</span>
            <h3>{viewingImported ? 'CIF 晶格参数' : '晶格参数'}</h3>
            <div className="summary-grid">
              {summary.map(item => (
                <div key={item.label}><span>{item.label}</span><b>{item.value}</b></div>
              ))}
            </div>
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
              <DefectCard type="vacancy" active={!viewingImported && defect === 'vacancy'} onClick={() => selectBuiltinDefect('vacancy')} title="空位缺陷" subtitle="原子位置缺失" color={colors.vacancy} />
              <DefectCard type="substitution" active={!viewingImported && defect === 'substitution'} onClick={() => selectBuiltinDefect('substitution')} title="替位缺陷" subtitle="异质原子替换" color={colors.substitution} />
              <DefectCard type="dislocation" active={!viewingImported && defect === 'dislocation'} onClick={() => selectBuiltinDefect('dislocation')} title="刃型位错" subtitle="局部滑移面错位" color="#ef8d86" />
            </div>
          </section>
          <section className="panel controls">
            <div className="panel-title">
              <div>
                <span className="eyebrow">ANALYSIS CONTROLS</span>
                <h3>分析参数</h3>
              </div>
            </div>
            <label className={viewingImported ? 'disabled' : ''}>
              晶胞数量 <output>{cells} × {cells} × {cells}</output>
              <input type="range" min="3" max="5" value={cells} disabled={viewingImported} onChange={event => setCells(Number(event.target.value))} />
            </label>
            {viewingImported && <p className="control-hint">晶胞数量仅适用于内置演示模型</p>}
            <label>
              晶面透明度 <output>{Math.round(planeOpacity * 100)}%</output>
              <input type="range" min="0" max="0.3" step="0.01" value={planeOpacity} onChange={event => setPlaneOpacity(Number(event.target.value))} />
            </label>
            <button className={showBonds ? 'toggle active' : 'toggle'} onClick={() => setShowBonds(value => !value)}>
              <span className="toggle-dot" />显示最近邻连接
            </button>
          </section>
          <section className="panel metrics-panel">
            <span className="eyebrow">DEFECT METRICS</span>
            <h3>结构指标</h3>
            <div className="metric-row">
              <div><span>原子数</span><b>{metrics.atoms}</b></div>
              <div><span>平均配位</span><b>{metrics.neighbors}</b></div>
              <div><span>{metrics.thirdLabel}</span><b>{metrics.thirdValue}</b></div>
            </div>
            <p>{metrics.footnote}</p>
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
