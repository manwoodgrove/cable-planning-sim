import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import * as OBC from "@thatopen/components";
import * as OBCF from "@thatopen/components-front";
import {
  Conduit,
  Cable,
  CONDUIT_PRESETS,
  computeBom,
  conduitLength,
  uid,
} from "./conduits/model";
import { bakeConduitsToIfc } from "./conduits/authorConduit";

const WASM = "https://unpkg.com/web-ifc@0.0.77/";

export function Viewer() {
  const containerRef = useRef<HTMLDivElement>(null);

  // thatOpen handles kept across renders.
  const refs = useRef<{
    components?: OBC.Components;
    world?: any;
    fragments?: OBC.FragmentsManager;
    ifcLoader?: OBC.IfcLoader;
    dims?: any;
    raycaster: THREE.Raycaster;
    pointer: THREE.Vector2;
    ground?: THREE.Mesh;
    previewGroup?: THREE.Group;
    rawIfc?: Uint8Array; // original shell bytes, kept for the IFC bake
  }>({ raycaster: new THREE.Raycaster(), pointer: new THREE.Vector2() });

  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("Load an apartment IFC to begin.");
  const [drawMode, setDrawMode] = useState(false);
  const [diameter, setDiameter] = useState<keyof typeof CONDUIT_PRESETS>("VP20");
  const [conduits, setConduits] = useState<Conduit[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Draft polyline being drawn (kept in a ref for the pointer handlers,
  // mirrored to state only for the vertex count in the UI).
  const draftRef = useRef<THREE.Vector3[]>([]);
  const [draftCount, setDraftCount] = useState(0);
  const drawModeRef = useRef(false);
  const diameterRef = useRef(diameter);
  const conduitsRef = useRef<Conduit[]>([]);
  useEffect(() => void (drawModeRef.current = drawMode), [drawMode]);
  useEffect(() => void (diameterRef.current = diameter), [diameter]);
  useEffect(() => void (conduitsRef.current = conduits), [conduits]);

  // ── thatOpen world setup ────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current!;
    let disposed = false;

    (async () => {
      const components = new OBC.Components();
      const worlds = components.get(OBC.Worlds);
      const world = worlds.create<
        OBC.SimpleScene,
        OBC.OrthoPerspectiveCamera,
        OBC.SimpleRenderer
      >();

      world.scene = new OBC.SimpleScene(components);
      world.scene.setup();
      world.scene.three.background = null;

      world.renderer = new OBC.SimpleRenderer(components, container);
      world.camera = new OBC.OrthoPerspectiveCamera(components);
      await world.camera.controls.setLookAt(12, 10, 12, 0, 0, 0);

      components.init();
      components.get(OBC.Grids).create(world);

      // Invisible floor plane so clicks land somewhere even with no geometry.
      const ground = new THREE.Mesh(
        new THREE.PlaneGeometry(200, 200),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
      );
      ground.rotation.x = -Math.PI / 2;
      world.scene.three.add(ground);

      const previewGroup = new THREE.Group();
      world.scene.three.add(previewGroup);

      // IFC loader → Fragments pipeline (per thatOpen's current IfcLoader tutorial).
      const ifcLoader = components.get(OBC.IfcLoader);
      await ifcLoader.setup({ autoSetWasm: false, wasm: { path: WASM, absolute: true } });

      const workerUrl = await OBC.FragmentsManager.getWorker();
      const fragments = components.get(OBC.FragmentsManager);
      fragments.init(workerUrl);
      world.camera.controls.addEventListener("update", () => fragments.core.update());
      fragments.list.onItemSet.add(({ value: model }: any) => {
        model.useCamera(world.camera.three);
        world.scene.three.add(model.object);
        fragments.core.update(true);
      });

      // Length measurement for the shell (thatOpen front). Version-sensitive —
      // if the API differs on your installed version, adjust these three lines.
      let dims: any;
      try {
        dims = components.get(OBCF.LengthMeasurement);
        dims.world = world;
        dims.enabled = false;
        dims.snapDistance = 0.25;
      } catch (e) {
        console.warn("LengthMeasurement unavailable on this version:", e);
      }

      Object.assign(refs.current, {
        components, world, fragments, ifcLoader, dims, ground, previewGroup,
      });
      if (!disposed) setReady(true);
    })();

    return () => {
      disposed = true;
      refs.current.components?.dispose();
    };
  }, []);

  // ── Pointer interaction: draw conduit vertices / select conduits ─────────
  useEffect(() => {
    const container = containerRef.current!;
    let downAt: { x: number; y: number } | null = null;

    const ndc = (e: PointerEvent) => {
      const r = container.getBoundingClientRect();
      refs.current.pointer.set(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1,
      );
    };

    const pick = (): THREE.Vector3 | { conduitId: string } | null => {
      const { world, raycaster, pointer, ground, previewGroup } = refs.current;
      if (!world) return null;
      raycaster.setFromCamera(pointer, world.camera.three);

      // Selection: hit a conduit tube first (userData.conduitId).
      if (previewGroup) {
        const hitsC = raycaster.intersectObjects(previewGroup.children, true);
        const withId = hitsC.find((h) => (h.object as any).userData?.conduitId);
        if (withId) return { conduitId: (withId.object as any).userData.conduitId };
      }
      // Otherwise a 3D point: shell geometry, else the ground plane.
      const targets = world.scene.three.children.filter(
        (c: THREE.Object3D) => c !== previewGroup,
      );
      const hits = raycaster.intersectObjects(targets, true);
      const hit = hits.find((h) => h.object !== ground) ?? hits.find((h) => h.object === ground);
      return hit ? hit.point.clone() : null;
    };

    const onDown = (e: PointerEvent) => (downAt = { x: e.clientX, y: e.clientY });
    const onUp = (e: PointerEvent) => {
      if (!downAt) return;
      const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
      downAt = null;
      if (moved > 4) return; // it was a camera drag, not a click
      ndc(e);
      const result = pick();
      if (!result) return;

      if (!drawModeRef.current) {
        if ((result as any).conduitId) setSelectedId((result as any).conduitId);
        return;
      }
      // Drawing: append a vertex.
      draftRef.current.push(result as THREE.Vector3);
      setDraftCount(draftRef.current.length);
      redrawPreview();
    };

    container.addEventListener("pointerdown", onDown);
    container.addEventListener("pointerup", onUp);
    return () => {
      container.removeEventListener("pointerdown", onDown);
      container.removeEventListener("pointerup", onUp);
    };
  }, []);

  // ── Preview / committed tube rendering ───────────────────────────────────
  const tubeMesh = (points: THREE.Vector3[], radius: number, color: number, conduitId?: string) => {
    if (points.length < 2) return null;
    const curve = new THREE.CurvePath<THREE.Vector3>();
    for (let i = 1; i < points.length; i++) {
      curve.add(new THREE.LineCurve3(points[i - 1], points[i]));
    }
    const geom = new THREE.TubeGeometry(curve as any, points.length * 8, radius, 12, false);
    const mesh = new THREE.Mesh(
      geom,
      new THREE.MeshStandardMaterial({ color, metalness: 0.1, roughness: 0.8 }),
    );
    if (conduitId) mesh.userData.conduitId = conduitId;
    return mesh;
  };

  const redrawPreview = () => {
    const g = refs.current.previewGroup;
    if (!g) return;
    for (const child of [...g.children]) {
      g.remove(child);
      (child as THREE.Mesh).geometry?.dispose();
    }
    // committed conduits
    for (const c of conduitsRef.current) {
      const m = tubeMesh(c.points, c.outerRadius_m, c.id === selectedId ? 0xff8800 : 0x2e78d2, c.id);
      if (m) g.add(m);
    }
    // draft in progress
    const draft = draftRef.current;
    if (draft.length >= 2) {
      const m = tubeMesh(draft, CONDUIT_PRESETS[diameterRef.current], 0x39c26f);
      if (m) g.add(m);
    }
    refs.current.fragments?.core.update(true);
  };
  useEffect(redrawPreview, [conduits, selectedId]);

  // ── Actions ──────────────────────────────────────────────────────────────
  const loadIfc = async (file: File) => {
    const { ifcLoader } = refs.current;
    if (!ifcLoader) return;
    setStatus(`Converting ${file.name} → Fragments…`);
    const buffer = new Uint8Array(await file.arrayBuffer());
    refs.current.rawIfc = buffer; // keep for the bake
    await ifcLoader.load(buffer, false, file.name, {
      processData: { progressCallback: (p: number) => setStatus(`Converting… ${Math.round(p * 100)}%`) },
    });
    setStatus(`Loaded ${file.name}. Draw conduits or measure.`);
  };

  const finishConduit = () => {
    const pts = draftRef.current;
    if (pts.length < 2) { setStatus("Need at least two points."); return; }
    const conduit: Conduit = {
      id: uid("cond"),
      name: `Conduit ${conduits.length + 1}`,
      diameter,
      outerRadius_m: CONDUIT_PRESETS[diameter],
      points: pts.map((p) => p.clone()),
      cables: [],
    };
    draftRef.current = [];
    setDraftCount(0);
    setConduits((cs) => [...cs, conduit]);
    setSelectedId(conduit.id);
    setDrawMode(false);
    setStatus(`Added ${conduit.name} (${conduitLength(conduit).toFixed(2)} m). Add its cables →`);
  };

  const cancelDraft = () => { draftRef.current = []; setDraftCount(0); redrawPreview(); };

  const toggleMeasure = () => {
    const dims = refs.current.dims;
    if (!dims) { setStatus("Measurement not available on this version."); return; }
    dims.enabled = !dims.enabled;
    setStatus(dims.enabled ? "Measure: double-click two points. Delete to remove." : "Measurement off.");
  };
  useEffect(() => {
    const container = containerRef.current!;
    const onDbl = () => refs.current.dims?.enabled && refs.current.dims.create();
    const onKey = (e: KeyboardEvent) =>
      (e.key === "Delete" || e.key === "Backspace") && refs.current.dims?.enabled && refs.current.dims.delete();
    container.addEventListener("dblclick", onDbl);
    window.addEventListener("keydown", onKey);
    return () => { container.removeEventListener("dblclick", onDbl); window.removeEventListener("keydown", onKey); };
  }, []);

  const addCable = (c: Cable) =>
    setConduits((cs) => cs.map((x) => (x.id === selectedId ? { ...x, cables: [...x.cables, c] } : x)));
  const removeCable = (cid: string) =>
    setConduits((cs) => cs.map((x) => (x.id === selectedId ? { ...x, cables: x.cables.filter((c) => c.id !== cid) } : x)));

  const exportIfc = async () => {
    if (!refs.current.rawIfc) { setStatus("Load an IFC shell first."); return; }
    setStatus("Baking conduits into IFC…");
    try {
      const out = await bakeConduitsToIfc(refs.current.rawIfc, conduits);
      download(new Blob([out]), "apartment-with-conduits.ifc");
      setStatus("Exported IFC with IfcCableCarrierSegments.");
    } catch (e: any) {
      console.error(e);
      setStatus(`Bake failed: ${e.message}`);
    }
  };
  const exportFragments = async () => {
    const fragments = refs.current.fragments;
    const [model] = fragments?.list.values() ?? [];
    if (!model) return;
    download(new Blob([await model.getBuffer(false)]), "apartment.frag");
  };

  const bom = computeBom(conduits);
  const selected = conduits.find((c) => c.id === selectedId) ?? null;
  const totalMeters = bom.reduce((s, r) => s + r.meters, 0);

  return (
    <div style={{ position: "relative", height: "100%", width: "100%" }}>
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />
      <Panel
        ready={ready} status={status} drawMode={drawMode} draftCount={draftCount}
        diameter={diameter} setDiameter={setDiameter}
        onLoad={loadIfc} onToggleDraw={() => { setDrawMode((d) => !d); cancelDraft(); }}
        onFinish={finishConduit} onCancel={cancelDraft} onMeasure={toggleMeasure}
        onExportIfc={exportIfc} onExportFrag={exportFragments}
        conduits={conduits} selected={selected} selectId={setSelectedId}
        addCable={addCable} removeCable={removeCable}
        bom={bom} totalMeters={totalMeters}
      />
    </div>
  );
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

// ── Control panel (plain React; the 3D engine is 100% thatOpen) ────────────
function Panel(p: any) {
  const box: React.CSSProperties = {
    position: "absolute", top: 12, left: 12, width: 300, maxHeight: "calc(100% - 24px)",
    overflowY: "auto", background: "rgba(20,22,26,0.92)", color: "#e8eaed",
    borderRadius: 10, padding: 14, fontSize: 13, lineHeight: 1.4,
    boxShadow: "0 6px 24px rgba(0,0,0,0.4)", backdropFilter: "blur(6px)",
  };
  const btn: React.CSSProperties = {
    width: "100%", padding: "8px 10px", margin: "3px 0", borderRadius: 6,
    border: "1px solid #3a3f47", background: "#2a2e35", color: "#e8eaed", cursor: "pointer",
  };
  const h: React.CSSProperties = { margin: "12px 0 4px", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, color: "#9aa0a6" };

  const [ct, setCt] = useState("FK");
  const [area, setArea] = useState(2.5);
  const [nc, setNc] = useState(3);

  return (
    <div style={box}>
      <div style={{ fontWeight: 600, fontSize: 15 }}>TowerSpotting Twin</div>
      <div style={{ color: "#9aa0a6", minHeight: 32 }}>{p.status}</div>

      <div style={h}>Model</div>
      <label style={{ ...btn, display: "block", textAlign: "center" }}>
        Load apartment IFC
        <input type="file" accept=".ifc" style={{ display: "none" }}
          onChange={(e) => e.target.files?.[0] && p.onLoad(e.target.files[0])} />
      </label>
      <button style={btn} onClick={p.onMeasure} disabled={!p.ready}>Toggle length measurement</button>

      <div style={h}>Draw conduit</div>
      <select value={p.diameter} onChange={(e) => p.setDiameter(e.target.value)}
        style={{ ...btn, appearance: "auto" }}>
        {Object.keys(CONDUIT_PRESETS).map((d) => <option key={d} value={d}>{d}</option>)}
      </select>
      <button style={{ ...btn, background: p.drawMode ? "#39c26f" : "#2a2e35" }} onClick={p.onToggleDraw} disabled={!p.ready}>
        {p.drawMode ? `Drawing… (${p.draftCount} pts) — click to add` : "Start drawing"}
      </button>
      {p.drawMode && (
        <>
          <button style={btn} onClick={p.onFinish}>Finish conduit</button>
          <button style={btn} onClick={p.onCancel}>Cancel</button>
        </>
      )}

      <div style={h}>Conduits ({p.conduits.length})</div>
      {p.conduits.map((c: Conduit) => (
        <div key={c.id} onClick={() => p.selectId(c.id)}
          style={{ ...btn, textAlign: "left", background: c.id === p.selected?.id ? "#3a4658" : "#2a2e35" }}>
          {c.name} · {c.diameter} · {conduitLength(c).toFixed(2)} m · {c.cables.length} cable(s)
        </div>
      ))}

      {p.selected && (
        <>
          <div style={h}>Cables in {p.selected.name}</div>
          {p.selected.cables.map((c: Cable) => (
            <div key={c.id} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0" }}>
              <span>{c.type} {c.n_conductors}G{c.area_mm2}</span>
              <span onClick={() => p.removeCable(c.id)} style={{ cursor: "pointer", color: "#e06c75" }}>✕</span>
            </div>
          ))}
          <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
            <input value={ct} onChange={(e) => setCt(e.target.value)} style={{ ...btn, width: 60 }} />
            <input type="number" value={area} step={0.5} onChange={(e) => setArea(+e.target.value)} style={{ ...btn, width: 60 }} />
            <input type="number" value={nc} onChange={(e) => setNc(+e.target.value)} style={{ ...btn, width: 46 }} />
          </div>
          <button style={btn} onClick={() => p.addCable({ id: uid("cab"), type: ct, area_mm2: area, n_conductors: nc })}>
            Add cable
          </button>
        </>
      )}

      <div style={h}>Cable schedule</div>
      {p.bom.length === 0 ? <div style={{ color: "#9aa0a6" }}>No cables yet.</div> :
        p.bom.map((r: any) => (
          <div key={r.cableType + r.area_mm2 + r.n_conductors} style={{ display: "flex", justifyContent: "space-between" }}>
            <span>{r.cableType} {r.n_conductors}G{r.area_mm2}</span>
            <span>{r.meters.toFixed(1)} m · {r.runs}×</span>
          </div>
        ))}
      <div style={{ borderTop: "1px solid #3a3f47", marginTop: 6, paddingTop: 6, display: "flex", justifyContent: "space-between", fontWeight: 600 }}>
        <span>Total cable</span><span>{p.totalMeters.toFixed(1)} m</span>
      </div>

      <div style={h}>Export</div>
      <button style={btn} onClick={p.onExportIfc}>Bake → IFC (conduits)</button>
      <button style={btn} onClick={p.onExportFrag}>Export Fragments (.frag)</button>
    </div>
  );
}
