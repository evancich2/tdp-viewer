import { createHash } from "node:crypto";
import { zipSync } from "fflate";
const enc = (s: string) => new TextEncoder().encode(s);
// Independent, minimal vector using the exported Studio slice-info/project-settings schema.
export function explicitSlice(side: "left" | "right" = "right") {
  const g = enc("G28\n");
  return zipSync({
    "Metadata/plate_1.gcode": g,
    "Metadata/plate_1.gcode.md5": enc(createHash("md5").update(g).digest("hex")),
    "Metadata/slice_info.config": enc(`<config><plate><metadata key="index" value="1"/><filament id="1" group_id="0" tray_info_idx="GFA00" type="PLA" color="#FFFFFF"/><nozzle id="0" extruder_id="1" nozzle_diameter="0.4" volume_type="Standard"/></plate></config>`),
    "Metadata/project_settings.config": enc(JSON.stringify({ filament_colour: ["#FFFFFF"], filament_map: ["1"], filament_map_mode: "Manual", physical_extruder_map: side === "left" ? ["1", "0"] : ["0", "1"] })),
  });
}
export const installed = () => ({ device: { extruder: { info: [{ id: 0, snow: 65280 }, { id: 1, snow: 65024 }] }, nozzle: { exist: 3, src_id: 16, tar_id: 16, info: [{ id: 0, diameter: 0.4, sn: "INSTALLED-HOTEND", stat: 0 }, { id: 1, diameter: 0.4, sn: "N/A", stat: 0 }] } }, vir_slot: [{ id: "255", tray_type: "PLA" }, { id: "254", tray_type: "PLA" }] });

