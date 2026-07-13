import * as THREE from "three";

/**
 * A cable pulled through a conduit. Keep this close to what an electrician /
 * a TR15-style schedule actually needs, and to the IFC electrical domain so
 * baking to IfcCableSegment later is a straight mapping.
 */
export interface Cable {
  id: string;
  /** e.g. "FK", "EKK", "EQLQ" — Swedish installation cable designations */
  type: string;
  /** conductor cross-section in mm² (1.5, 2.5, 4, 6, 10, 16, ...) */
  area_mm2: number;
  /** number of conductors (incl. protective earth), e.g. 3 for 3G1.5 */
  n_conductors: number;
  /** free-text: circuit id, phase, breaker, colour... */
  note?: string;
}

/**
 * A conduit / cable-carrier run. Geometrically a polyline (the directrix)
 * with a circular cross-section — the canonical IfcSweptDiskSolid shape.
 * `points` are stored in SCENE space (Y-up, as rendered). The IFC bake step
 * transforms them back to the model's IFC space (usually Z-up).
 */
export interface Conduit {
  id: string;
  name: string;
  /** outer diameter designation, e.g. "VP16", "VP20", "VP25" */
  diameter: string;
  /** outer radius in metres, used for the swept disk + the preview tube */
  outerRadius_m: number;
  /** ordered polyline vertices in scene space */
  points: THREE.Vector3[];
  cables: Cable[];
}

/** Common Swedish plastic conduit (VP/rör) nominal → outer radius in metres. */
export const CONDUIT_PRESETS: Record<string, number> = {
  VP16: 0.016 / 2,
  VP20: 0.020 / 2,
  VP25: 0.025 / 2,
  VP32: 0.032 / 2,
  VP40: 0.040 / 2,
};

/** Polyline length in metres — trivial once geometry is in real units. */
export function conduitLength(conduit: Conduit): number {
  let total = 0;
  for (let i = 1; i < conduit.points.length; i++) {
    total += conduit.points[i].distanceTo(conduit.points[i - 1]);
  }
  return total;
}

export interface BomRow {
  cableType: string;
  area_mm2: number;
  n_conductors: number;
  /** total metres of this exact cable spec across all conduits */
  meters: number;
  /** how many distinct conduits carry it */
  runs: number;
}

/**
 * The cable schedule / bill of materials — grouped by exact cable spec.
 * This is the shopping list and the electrician handoff, derived entirely
 * from geometry + the cable lists. No separate source of truth.
 */
export function computeBom(conduits: Conduit[]): BomRow[] {
  const rows = new Map<string, BomRow>();
  for (const conduit of conduits) {
    const len = conduitLength(conduit);
    for (const cable of conduit.cables) {
      const key = `${cable.type}|${cable.area_mm2}|${cable.n_conductors}`;
      const row =
        rows.get(key) ??
        {
          cableType: cable.type,
          area_mm2: cable.area_mm2,
          n_conductors: cable.n_conductors,
          meters: 0,
          runs: 0,
        };
      row.meters += len;
      row.runs += 1;
      rows.set(key, row);
    }
  }
  return [...rows.values()].sort(
    (a, b) => a.cableType.localeCompare(b.cableType) || a.area_mm2 - b.area_mm2,
  );
}

let counter = 0;
export function uid(prefix = "id"): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}
