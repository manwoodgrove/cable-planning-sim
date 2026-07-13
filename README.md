# Apartment electrical planner

A browser BIM tool for planning conduit/cable runs in an apartment. The 3D
engine is **That Open Engine** end to end; conduits are authored as genuine
**IFC** (`IfcCableCarrierSegment`) so the output round-trips to Revit / MagiCAD /
Solibri, and the cable schedule falls out of the geometry.

## Run

```bash
npm install
npm run dev
```

Then: **Load apartment IFC** → **Start drawing** (click points along a run) →
**Finish conduit** → select it and **Add cable(s)** → **Bake → IFC**.

You need an apartment shell as `.ifc` first. Model it once in **FreeCAD** (BIM
workbench → export IFC — you already have FreeCAD set up) or **Bonsai**
(ex-BlenderBIM). Walls/slabs/spaces as `IfcWall`/`IfcSlab`/`IfcSpace`, and at
least one `IfcBuildingStorey` (the bake needs a storey to contain conduits).

## What's thatOpen, and why it's shaped this way

| Concern | Component |
|---|---|
| Scene / camera / renderer / grid | `@thatopen/components` (`Worlds`, `SimpleScene`, `OrthoPerspectiveCamera`, `SimpleRenderer`, `Grids`) |
| IFC import | `OBC.IfcLoader` → converts to Fragments |
| Model store / render loop | `OBC.FragmentsManager` |
| Length measurement | `@thatopen/components-front` `LengthMeasurement` |
| Conduit IFC authoring | `web-ifc` write API (also thatOpen) |

Two architectural decisions worth knowing:

**1. Fragments-first, not IFC-at-runtime.** That Open never renders IFC
directly — loading IFC at runtime is too slow, so it converts to its
FlatBuffers **Fragments** format once and renders that. The `Export Fragments`
button gives you the `.frag` to cache and load instead of re-converting.

**2. Conduits are live meshes while editing, real IFC on export.** During
drawing, each run is a thatOpen-rendered `TubeGeometry` (instant, no reconvert).
Only on **Bake → IFC** are they written as `IfcCableCarrierSegment` with
`IfcSweptDiskSolid` geometry — the canonical IFC shape for a round section swept
along a path. The bake **injects into the loaded shell IFC** so it reuses the
existing project, units, representation context and storey, instead of
hand-authoring a valid IFC from nothing.

## Version knobs (the two things most likely to bite)

- **web-ifc WASM path.** Pinned to `web-ifc@0.0.77` in `Viewer.tsx` (`WASM`) and
  `authorConduit.ts`. Keep both in sync with the `web-ifc` version npm actually
  installs, or the loader/bake will 404 the WASM.
- **IFC schema + coordinate transform** (`authorConduit.ts`): `S = "IFC4X3"` —
  switch to `"IFC4"` if your shell is IFC4. `defaultSceneToIfc` assumes scene
  Y-up → IFC Z-up; if baked conduits land rotated/offset vs. the walls, derive
  the transform from the loaded model's coordination matrix instead. The
  `LengthMeasurement` wiring is also version-sensitive (3 lines, flagged in code).

## The robust authoring alternative (recommended once you're past the prototype)

"Use thatOpen where possible" has one honest limit: authoring valid IFC is
web-ifc's weakest area (verbose typed writes, sharp edges like the historical
`IfcDirection` serialisation bug). For production authoring, do the bake
**server-side in your existing FastAPI backend with IfcOpenShell** — the mature,
industry-standard IFC engine. The frontend stays 100% thatOpen and just POSTs
the conduit JSON:

```python
# POST /bake  { shell_ifc_id, conduits: [...] }
import ifcopenshell
import ifcopenshell.api.root, ifcopenshell.api.spatial, ifcopenshell.api.pset

model  = ifcopenshell.open(shell_path)
storey = model.by_type("IfcBuildingStorey")[0]
body   = model.by_type("IfcGeometricRepresentationContext")[0]

for c in conduits:
    seg = ifcopenshell.api.root.create_entity(model, ifc_class="IfcCableCarrierSegment")
    # build IfcSweptDiskSolid(directrix=IfcPolyline(points), radius=c.outer_r)
    # → IfcShapeRepresentation(body, "Body", "AdvancedSweptSolid", [solid])
    # → assign representation + placement to seg
    ifcopenshell.api.spatial.assign_container(model, relating_structure=storey, products=[seg])
    pset = ifcopenshell.api.pset.add_pset(model, product=seg, name="ConduitCables")
    ifcopenshell.api.pset.edit_pset(model, pset=pset, properties={
        "Length_m": round(c.length, 3),
        **{f"Cable_{i+1}": f"{x.type} {x.n}G{x.area}" for i, x in enumerate(c.cables)},
    })

model.write(out_path)  # then convert to .frag for the client, or return .ifc
```

IfcOpenShell scaffolds the representation/context/units plumbing that makes the
in-browser web-ifc path tedious, and it slots straight into your Python stack.
`authorConduit.ts` mirrors this exact entity graph, so either path produces the
same model — pick client-side for a zero-backend prototype, server-side for
correctness at scale.
```
