import { describe, expect, it } from "vitest";
import { inspectSliced } from "../tools/bambu/sliced";
import { prepareNozzleRouting, routingRecordSettings } from "../tools/bambu/routing";
import { RecordData } from "../src/core/records";
import { buildMapping, projectFileCommand } from "../tools/bambu/h2c";

import { explicitSlice, installed } from "./helpers/routing-fixture";

describe("explicit H2C nozzle routing", () => {
  it("retains complete routing within the signed workflow settings limits", () => {
    const routing = prepareNozzleRouting(inspectSliced(explicitSlice("left")), [254], installed(), "left")!;
    const settings = routingRecordSettings(routing);
    expect(Object.values(settings).every(v => v.length <= 200)).toBe(true);
    expect(settings.nozzleRoutingEncoding).toBe("split-fields/1");
    expect({ ...JSON.parse(settings.nozzleRouting!), nozzles_info: JSON.parse(settings.nozzlesInfo!), ams_mapping_info: JSON.parse(settings.amsMappingInfo!) }).toEqual(routing);
    expect(RecordData.safeParse({kind:"queue-entry",jobId:"SYNTHETIC-ROUTING",submittedFile:{name:"synthetic.gcode.3mf",sha256:"0".repeat(64)},settings}).success).toBe(true);
  });
  it("holds metadata too large to retain without truncation", () => {
    const routing = prepareNozzleRouting(inspectSliced(explicitSlice()), [255], installed(), "right")!;
    routing.ams_mapping_info[0]!.filamentId = "x".repeat(201);
    expect(() => routingRecordSettings(routing)).toThrow(/settings limit/);
  });
  it("carries slicer group, logical extruder and physical map through inspection", () => {
    const p = inspectSliced(explicitSlice());
    expect(p).toMatchObject({ filamentMap: [1], physicalExtruderMap: [0, 1], filamentMapMode: "Manual", plate: { nozzles: [{ id: 0, extruderId: 1, diameter: 0.4, volumeType: "Standard" }], filaments: [{ id: 1, groupId: 0, filamentId: "GFA00" }] } });
  });
  it("sends external feed 1 in the new mapping, and preserves the mounted main hotend association", () => {
    const p = inspectSliced(explicitSlice());
    const mapping = buildMapping(p, { kind: "spool", side: "right" });
    const routing = prepareNozzleRouting(p, mapping, installed(), "right");
    const command = projectFileCommand({ remoteName: "part.gcode.3mf", project: p, mapping, routing, useAms: false, taskId: "1", bedLeveling: true, flowCalibration: false, vibrationCalibration: false, layerInspect: false, timelapse: false, bedType: "auto" }, "7");
    expect(command.print).toMatchObject({ use_ams: false, ams_mapping: [-1], ams_mapping2: [{ ams_id: 255, slot_id: 0 }], nozzle_mapping: [16], nozzles_info: [{ id: 0, type: null, flowSize: "standard_flow", diameter: 0.4 }], ams_mapping_info: [{ ams: 255, nozzleId: 1, filamentType: "PLA", filamentId: "GFA00", sourceColor: "FFFFFFFF", targetColor: "FFFFFFFF" }] });
  });
  it("routes the physical left fixed hotend without requesting the right rack hotend", () => {
    const project = inspectSliced(explicitSlice("left"));
    const result = prepareNozzleRouting(project, [254], installed(), "left");
    expect(result).toMatchObject({ physicalSide: "left", protocolExtruderId: 1, nozzle_mapping: [1], ams_mapping_info: [{ ams: 254 }] });
    expect(() => prepareNozzleRouting(project, [255], installed(), "left")).toThrow(/external feed does not match/);
    const state = installed(); state.device.nozzle.exist = 1;
    expect(() => prepareNozzleRouting(project, [254], state, "left")).toThrow(/hotend is absent/);
  });
  it("blocks external-left dispatch while AMS slot 1 remains loaded", () => {
    const state = installed(); state.device.extruder.info[1]!.snow = 0;
    expect(() => prepareNozzleRouting(inspectSliced(explicitSlice("left")), [254], state, "left")).toThrow(/external spool is not reported loaded/);
  });
  it("refuses implicit rack selection and wrong external feed", () => {
    const p = inspectSliced(explicitSlice());
    expect(() => prepareNozzleRouting(p, [255], installed())).toThrow(/explicit --extruder/);
    expect(() => prepareNozzleRouting(p, [254], installed(), "right")).toThrow(/external feed does not match/);
    expect(() => prepareNozzleRouting(p, [255], installed(), "left")).toThrow(/re-slice/);
  });
  it("refuses incomplete, dynamic or conflicting file mappings", () => {
    for (const change of [(p: ReturnType<typeof inspectSliced>) => { p.filamentMapMode = "Auto"; }, (p: ReturnType<typeof inspectSliced>) => { p.physicalExtruderMap = [1, 0]; }, (p: ReturnType<typeof inspectSliced>) => { p.plate.nozzles = []; }, (p: ReturnType<typeof inspectSliced>) => { p.plate.filaments[0]!.groupId = undefined; }]) {
      const p = inspectSliced(explicitSlice()); change(p);
      expect(() => prepareNozzleRouting(p, [255], installed(), "right")).toThrow(/re-slice/);
    }
  });
  it("refuses absent, unidentified, abnormal and wrong-diameter hotends", () => {
    for (const patch of [{ sn: "N/A" }, { stat: 1 }, { stat: 2 }, { diameter: 0.6 }, { diameter: Number.NaN }]) {
      const state = installed(); Object.assign(state.device.nozzle.info[0]!, patch);
      expect(() => prepareNozzleRouting(inspectSliced(explicitSlice()), [255], state, "right")).toThrow(/hotend is absent/);
    }
    const state = installed(); state.device.nozzle.exist = 0;
    expect(() => prepareNozzleRouting(inspectSliced(explicitSlice()), [255], state, "right")).toThrow(/hotend is absent/);
  });
  it("refuses unknown or changing rack association", () => {
    for (const patch of [{ tar_id: 17 }, { tar_id: 0, src_id: 0 }, { tar_id: 65535 }]) {
      const state = installed(); Object.assign(state.device.nozzle, patch);
      expect(() => prepareNozzleRouting(inspectSliced(explicitSlice()), [255], state, "right")).toThrow(/rack association/);
    }
  });
  it("refuses a material mismatch", () => {
    const state = installed(); state.vir_slot[0]!.tray_type = "PETG";
    expect(() => prepareNozzleRouting(inspectSliced(explicitSlice()), [255], state, "right")).toThrow(/material metadata/);
  });
});
