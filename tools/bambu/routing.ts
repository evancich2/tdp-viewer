// Explicit, conservative H2C routing for one filament through an already installed hotend.
// ID conventions follow Bambu Studio v02.09.01.70 DevDefs.h, SelectMachine.cpp,
// and DevMappingNozzle.cpp. No hotend replacement or extrusion commands are issued here.
import type { SlicedProject } from "./sliced";

export type ExtruderSide = "left" | "right";
export interface NozzleRouting {
  physicalSide: ExtruderSide;
  protocolExtruderId: number;
  nozzle_mapping: number[];
  nozzles_info: { id: number; type: null; flowSize: string; diameter: number }[];
  ams_mapping_info: { ams: number; sourceColor: string; targetColor: string; filamentId: string; filamentType: string; nozzleId: number }[];
}

type State = Record<string, any>;

/** Keep all routing detail within tdp-record/0.1's 200-character settings values. */
export function routingRecordSettings(routing: NozzleRouting): Record<string, string> {
  const { nozzles_info, ams_mapping_info, ...identity } = routing;
  const settings = { nozzleRoutingEncoding: "split-fields/1", nozzleRouting: JSON.stringify(identity), nozzlesInfo: JSON.stringify(nozzles_info), amsMappingInfo: JSON.stringify(ams_mapping_info) };
  if (Object.values(settings).some(value => value.length > 200)) throw new Error("routing metadata exceeds workflow settings limit; dispatch held");
  return settings;
}

export function prepareNozzleRouting(project: SlicedProject, mapping: number[], state: State, extruder?: ExtruderSide): NozzleRouting | undefined {
  const system = state.device?.nozzle;
  const rack = system?.tar_id !== undefined;
  if (extruder === undefined) {
    if (rack) throw new Error("H2C hotend rack requires an explicit --extruder left or right; refusing automatic nozzle selection");
    return undefined; // Preserve support for older printers without hotend-rack telemetry.
  }
  if (extruder !== "left" && extruder !== "right") throw new Error("--extruder must be left or right");
  const physical = extruder === "right" ? 0 : 1;
  const filament = project.plate.filaments[0], nozzle = project.plate.nozzles[0];
  if (project.projectFilaments !== 1 || project.plate.filaments.length !== 1 || filament?.id !== 1 ||
      project.plate.nozzles.length !== 1 || nozzle?.id !== 0 || filament.groupId !== 0 ||
      project.filamentMapMode !== "Manual" || !project.filamentMap || project.filamentMap.length !== 1 ||
      !project.physicalExtruderMap || project.physicalExtruderMap.length !== 2 ||
      ![0, 1].every((id) => project.physicalExtruderMap!.includes(id)) ||
      ![1, 2].includes(nozzle.extruderId) || project.filamentMap[0] !== nozzle.extruderId ||
      project.physicalExtruderMap[nozzle.extruderId - 1] !== physical) {
    throw new Error("explicit nozzle routing requires one filament, one nozzle group 0, and matching Manual slicer/physical extruder maps; re-slice for the requested extruder");
  }
  if (nozzle.volumeType !== "Standard" || !Number.isFinite(nozzle.diameter) || nozzle.diameter <= 0) {
    throw new Error("only an explicit Standard-flow nozzle is supported by this routing fix");
  }
  const tray = mapping[0];
  if (tray === 254 || tray === 255) {
    // Bambu's main physical extruder 0 uses external ID 255; deputy 1 uses 254.
    if (tray !== (physical === 0 ? 255 : 254)) throw new Error("external feed does not match requested physical extruder (right = 255, left = 254)");
    const external = state.vir_slot?.find((s: State) => Number(s.id) === tray);
    if (!external || external.tray_type !== filament.type) throw new Error("external-feed material metadata is missing or differs from the sliced filament");
    // snow: high byte = AMS ID, low byte = slot. Require external already loaded,
    // so dispatch cannot implicitly retract a previous AMS source.
    const loaded = state.device?.extruder?.info?.find((e: State) => e.id === physical);
    if (loaded?.snow !== (tray << 8)) throw new Error("external spool is not reported loaded in the selected extruder; use printer Unload/Load controls before dispatch");
  }
  // The fixed left hotend can report SN N/A; use existence/status/diameter for it.
  // Retain serial identification for the replaceable right hotend.
  const live = system?.info?.find((n: State) => n.id === physical);
  if (!live || !Number.isInteger(system.exist) || !(system.exist & (1 << physical)) ||
      !Number.isInteger(live.stat) || (live.stat & 7) !== 0 || (physical === 0 && (!live.sn || live.sn === "N/A")) ||
      Math.abs(Number(live.diameter) - nozzle.diameter) > 0.000001 || !Number.isFinite(Number(live.diameter))) {
    throw new Error("requested installed hotend is absent, abnormal, unidentified, or has a different diameter; dispatch held");
  }
  let target = physical;
  if (physical === 0 && rack) {
    // Studio substitutes tar_id for the main hotend, preserving its current rack association.
    // Never select a different rack hotend or allow a replacement already in progress.
    if (!Number.isInteger(system.tar_id) || system.tar_id < 16 || system.tar_id > 31 || system.src_id !== system.tar_id) {
      throw new Error("main hotend rack association is missing or changing; dispatch held");
    }
    target = system.tar_id;
  }
  if (!filament.filamentId || !filament.type || !/^#[0-9a-f]{6}$/i.test(filament.color ?? "")) {
    throw new Error("sliced filament identity/type/color metadata is incomplete");
  }
  const color = filament.color!.slice(1).toUpperCase() + "FF";
  return {
    physicalSide: extruder,
    protocolExtruderId: physical,
    nozzle_mapping: [target],
    nozzles_info: [{ id: nozzle.id, type: null, flowSize: "standard_flow", diameter: nozzle.diameter }],
    ams_mapping_info: [{ ams: tray!, sourceColor: color, targetColor: color, filamentId: filament.filamentId,
      filamentType: filament.type, nozzleId: nozzle.extruderId === 1 ? 1 : 0 }],
  };
}
