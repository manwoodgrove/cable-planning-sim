import * as WebIFC from "web-ifc";
import * as THREE from "three";
import { Conduit, conduitLength } from "./model";

/*
 * ────────────────────────────────────────────────────────────────────────
 *  IFC-NATIVE BAKE — validate this module against YOUR installed web-ifc.
 * ────────────────────────────────────────────────────────────────────────
 *  Strategy: rather than construct a valid IFC from scratch (which means
 *  hand-authoring IfcProject + units + IfcGeometricRepresentationContext +
 *  spatial tree — tedious and error-prone), we OPEN the apartment IFC the
 *  user already loaded and INJECT conduits into it, reusing its context,
 *  storey and owner history. Each conduit becomes:
 *
 *    IfcCableCarrierSegment
 *      └─ Representation → IfcShapeRepresentation ('AdvancedSweptSolid')
 *           └─ IfcSweptDiskSolid (Radius = outer radius)
 *                └─ Directrix → IfcPolyline (the drawn path)
 *      └─ IfcRelDefinesByProperties → IfcPropertySet (cable schedule)
 *      └─ IfcRelContainedInSpatialStructure → IfcBuildingStorey
 *
 *  The two things most likely to need tuning for your data:
 *    1. sceneToIfc — the axis/units transform (see note below).
 *    2. context / storey / ownerHistory discovery — depends on how your
 *       authoring tool (FreeCAD / Bonsai) wrote the shell.
 */

const S = "IFC4X3"; // schema namespace used below; swap to IFC4 if your shell is IFC4.

/** Standard IFC GlobalId compression alphabet. */
const B64 =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";
function ifcGuid(): string {
  // 22-char compressed GUID from 128 random bits.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  // 128 bits → pad to 132 (22 * 6) with 4 leading zeros.
  bits = "0000" + bits;
  let out = "";
  for (let i = 0; i < 132; i += 6) out += B64[parseInt(bits.slice(i, i + 6), 2)];
  return out;
}

/**
 * Scene (Y-up, as rendered by thatOpen) → IFC model space.
 * DEFAULT assumes the shell was loaded with a Y-up coordination and its IFC
 * space is Z-up: (x, y, z)_scene → (x, -z, y)_ifc. If your conduits land
 * rotated or offset relative to the walls, this is the first knob to turn —
 * ideally derive it from the loaded model's coordination matrix instead.
 */
export function defaultSceneToIfc(p: THREE.Vector3): [number, number, number] {
  return [p.x, -p.z, p.y];
}

interface Anchors {
  contextID: number;
  storeyID: number;
  ownerHistoryID: number | null;
}

/** Find an existing geometric context, a storey to contain elements, and owner history. */
function findAnchors(api: WebIFC.IfcAPI, modelID: number): Anchors {
  const first = (type: number): number | null => {
    const ids = api.GetLineIDsWithType(modelID, type);
    return ids.size() > 0 ? ids.get(0) : null;
  };
  const contextID = first(WebIFC.IFCGEOMETRICREPRESENTATIONCONTEXT);
  const storeyID = first(WebIFC.IFCBUILDINGSTOREY);
  const ownerHistoryID = first(WebIFC.IFCOWNERHISTORY);
  if (contextID === null) throw new Error("No IfcGeometricRepresentationContext in the loaded model.");
  if (storeyID === null) throw new Error("No IfcBuildingStorey in the loaded model — nowhere to contain conduits.");
  return { contextID, storeyID, ownerHistoryID };
}

/**
 * Author every conduit into a fresh copy of the shell IFC and return the new
 * IFC bytes. Feed the result back through the IfcLoader to see the conduits
 * as real BIM elements, or hand the .ifc to Revit/MagiCAD/Solibri.
 */
export async function bakeConduitsToIfc(
  shellIfc: Uint8Array,
  conduits: Conduit[],
  sceneToIfc: (p: THREE.Vector3) => [number, number, number] = defaultSceneToIfc,
): Promise<Uint8Array> {
  const api = new WebIFC.IfcAPI();
  api.SetWasmPath("/wasm/", true);
  await api.Init();

  const modelID = api.OpenModel(shellIfc);
  const { contextID, storeyID, ownerHistoryID } = findAnchors(api, modelID);

  let nextId = api.GetMaxExpressID(modelID) + 1;
  const ref = (expressID: number) => new WebIFC.Handle(expressID);
  const owner = ownerHistoryID ? ref(ownerHistoryID) : null;

  // Typed-value helpers — the web-ifc write API wants schema-typed wrappers,
  // not bare numbers/strings, or attributes serialise as '*'.
  const IFC = (WebIFC as any)[S];
  const len = (v: number) => new IFC.IfcLengthMeasure(v);
  const plen = (v: number) => new IFC.IfcPositiveLengthMeasure(v);
  const label = (v: string) => new IFC.IfcLabel(v);
  const ident = (v: string) => new IFC.IfcIdentifier(v);
  const text = (v: string) => new IFC.IfcText(v);
  const guid = () => new IFC.IfcGloballyUniqueId(ifcGuid());

  // Constructors take ONLY the IFC attributes — the express ID is a separate
  // property. Passing it as the first argument shifts every attribute by one.
  const write = (entity: any): number => {
    entity.expressID = nextId++;
    api.WriteLine(modelID, entity);
    return entity.expressID as number;
  };

  for (const conduit of conduits) {
    if (conduit.points.length < 2) continue;

    // 1. Directrix: cartesian points → polyline (in IFC coordinates).
    const pointRefs = conduit.points.map((p) => {
      const [x, y, z] = sceneToIfc(p);
      return ref(write(new IFC.IfcCartesianPoint([len(x), len(y), len(z)])));
    });
    const polylineID = write(new IFC.IfcPolyline(pointRefs));

    // 2. Swept disk solid = circular section swept along the directrix.
    //    (Directrix, Radius, InnerRadius, StartParam, EndParam)
    const solidID = write(
      new IFC.IfcSweptDiskSolid(
        ref(polylineID),
        plen(conduit.outerRadius_m),
        null,
        null,
        null,
      ),
    );

    // 3. Shape representation + product definition shape.
    const shapeRepID = write(
      new IFC.IfcShapeRepresentation(
        ref(contextID),
        label("Body"),
        label("AdvancedSweptSolid"),
        [ref(solidID)],
      ),
    );
    const productShapeID = write(
      new IFC.IfcProductDefinitionShape(null, null, [ref(shapeRepID)]),
    );

    // 4. Placement at the origin (points are already absolute in IFC space).
    const originID = write(new IFC.IfcCartesianPoint([len(0), len(0), len(0)]));
    const axisID = write(new IFC.IfcAxis2Placement3D(ref(originID), null, null));
    const placementID = write(new IFC.IfcLocalPlacement(null, ref(axisID)));

    // 5. The element itself.
    const segmentID = write(
      new IFC.IfcCableCarrierSegment(
        guid(),
        owner,
        label(conduit.name),
        text(`${conduit.diameter} conduit`),
        null, // ObjectType
        ref(placementID),
        ref(productShapeID),
        ident(conduit.id),
        null, // PredefinedType (IfcCableCarrierSegmentTypeEnum) — set e.g. .CONDUITSEGMENT when validated
      ),
    );

    // 6. Cable schedule as a property set on the segment.
    const props: WebIFC.Handle<any>[] = [];
    const addProp = (name: string, value: any) => {
      props.push(ref(write(new IFC.IfcPropertySingleValue(ident(name), null, value, null))));
    };
    addProp("Length_m", new IFC.IfcReal(Number(conduitLength(conduit).toFixed(3))));
    addProp("Diameter", label(conduit.diameter));
    conduit.cables.forEach((c, i) => {
      const n = i + 1;
      addProp(`Cable_${n}`, label(`${c.type} ${c.n_conductors}G${c.area_mm2}`));
      if (c.note) addProp(`Cable_${n}_note`, label(c.note));
    });
    const psetID = write(
      new IFC.IfcPropertySet(
        guid(),
        owner,
        label("Pset_TowerSpotting_Cables"),
        null,
        props,
      ),
    );
    write(
      new IFC.IfcRelDefinesByProperties(
        guid(),
        owner,
        null,
        null,
        [ref(segmentID)],
        ref(psetID),
      ),
    );

    // 7. Contain the segment in the storey.
    write(
      new IFC.IfcRelContainedInSpatialStructure(
        guid(),
        owner,
        null,
        null,
        [ref(segmentID)],
        ref(storeyID),
      ),
    );
  }

  const out = api.SaveModel(modelID);
  api.CloseModel(modelID);
  return out;
}
