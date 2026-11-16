import { readFileSync } from "node:fs";
import { unzipSync, zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { AuditLog, EngineeringModel, Manifest, PackageSession, buildPackage, defaultPolicy, exportForPrint, generateKeyPair, parsePrintSettings, validateEngineering, type PrintSettings, type StepMesher, type TrustStore } from "../src/core";
import { sha256Hex, utf8 } from "../src/core/bytes";
import { sampleContents } from "../tools/sample-data";
import { LAB_NOW } from "../tools/lab-fixtures";

const now = new Date("2026-06-01T00:00:00Z"), modelPath = "models/SMP-1000_B.stp", settingsPath = "process/print-settings.json";
const contents = sampleContents();
const mesh: StepMesher = async () => [{ name: "synthetic tetrahedron", positions: [0,0,0, 10,0,0, 0,10,0, 0,0,10], indices: [0,2,1, 0,1,3, 0,3,2, 1,2,3] }];
let author: Awaited<ReturnType<typeof generateKeyPair>>, approver: typeof author, store: TrustStore, settings: PrintSettings;
beforeAll(async () => {
  [author, approver] = await Promise.all([generateKeyPair(), generateKeyPair()]);
  store = { schema: "tdp-truststore/0.1", keys: [author,approver].map((k,i) => ({ keyId:k.keyId, name:"synthetic signer", publicKey:k.publicKey, roles:[i===0 ? "author" as const : "approver" as const], notBefore:"2026-01-01T00:00:00Z", notAfter:"2027-01-01T00:00:00Z", revoked:false })) };
  settings = { schema:"tdp-print-settings/0.1", modelPath, modelSha256:await sha256Hex(contents.inputs.find((f) => f.path===modelPath)!.bytes), printerId:"bambu-h2c", parameters:{ layerHeightMm:0.2, infillPercent:20, supports:false, material:"SYNTHETIC PETG <review>" } };
});
async function pack(text = JSON.stringify(settings), extra: { bytes:Uint8Array; role:"model"|"other" } | undefined = undefined) {
  return buildPackage({ id:"8f2d1c3a-6b4e-4f0a-9c1d-2e3f4a5b6c7d", title:"Synthetic settings test", partNumber:"SMP-1000", revision:"B", created:"2026-05-31T00:00:00Z" }, [
    ...contents.inputs, { path:settingsPath, bytes:utf8.encode(text), mediaType:"application/json", role:"other" },
    ...(extra ? [{ path:"process/derived.3mf", bytes:extra.bytes, mediaType:"model/3mf", role:extra.role }] : []),
  ], contents.bom, [{...author,role:"author"},{...approver,role:"approver"}], now);
}
const open = (bytes: Uint8Array) => PackageSession.open("settings.tdp",bytes,store,defaultPolicy,new AuditLog(() => now),now);

describe("signed print settings", () => {
  it("carries hash-verified settings and source identity into escaped 3MF metadata and audit", async () => {
    const session=await open(await pack());
    const out=await exportForPrint(session,modelPath,mesh,{now,settingsPath});
    const xml=utf8.decode(unzipSync(out.bytes)["3D/3dmodel.model"]!);
    expect(out.settings?.value).toEqual(settings);
    expect(xml).toContain('name="tdp:PrintSettings"');
    expect(xml).toContain('&quot;layerHeightMm&quot;:0.2');
    expect(xml).toContain('SYNTHETIC PETG &lt;review&gt;');
    expect(xml).toContain(`<metadata name="tdp:PrintSettingsSha256">${out.settings!.sha256}</metadata>`);
    expect((await session.audit.list()).at(-1)!.detail).toContain(`settings ${settingsPath} sha256`);
  });
  it("holds settings for another model, digest or printer", async () => {
    for(const change of [{modelPath:"models/other.stp"},{modelSha256:"0".repeat(64)},{printerId:"other"}]) {
      await expect(exportForPrint(await open(await pack(JSON.stringify({...settings,...change}))),modelPath,mesh,{now,settingsPath})).rejects.toThrow(/bound to a different/);
    }
  });
  it("refuses missing, malformed, duplicate-key, oversize and unsupported-schema inputs", async () => {
    await expect(exportForPrint(await open(await pack()),modelPath,mesh,{now,settingsPath:"missing.json"})).rejects.toThrow(/invalid print settings/);
    for(const text of ['{"schema":"x","schema":"y"}',JSON.stringify({...settings,schema:"future"}),JSON.stringify({...settings,parameters:{}})]) {
      await expect(exportForPrint(await open(await pack(text)),modelPath,mesh,{now,settingsPath})).rejects.toThrow(/invalid print settings/);
    }
    expect(() => parsePrintSettings(JSON.stringify({...settings,parameters:{x:[]}}))).toThrow();
    expect(() => parsePrintSettings(" ".repeat(32769))).toThrow(/exceed 32768/);
  });
  it("rejects an altered settings file despite otherwise valid package signatures", async () => {
    const files=unzipSync(await pack());files[settingsPath]=utf8.encode(JSON.stringify({...settings,parameters:{infillPercent:99}}));
    const session=await open(zipSync(files));expect(session.trusted).toBe(false);
    await expect(exportForPrint(session,modelPath,mesh,{now,settingsPath})).rejects.toThrow(/not trusted/);
  });
  it("accepts 3MF as an opaque other-role input, and refuses an authoritative model role or non-ZIP bytes", async () => {
    const generated=await exportForPrint(await open(await pack()),modelPath,mesh,{now,settingsPath});
    expect((await open(await pack(undefined,{bytes:generated.bytes,role:"other"}))).trusted).toBe(true);
    expect((await open(await pack(undefined,{bytes:generated.bytes,role:"model"}))).trusted).toBe(false);
    expect((await open(await pack(undefined,{bytes:utf8.encode("not zip"),role:"other"}))).trusted).toBe(false);
  });
  it("requires a 0.2 engineering artifact to classify 3MF as non-authoritative process input", () => {
    const files=unzipSync(readFileSync("samples/lab/SYN-PH-2000_A.tdp"));
    const manifest=Manifest.parse(JSON.parse(utf8.decode(files["tdp-manifest.json"]!)));
    if(manifest.schema!=="tdp-manifest/0.2") throw new Error("expected lab 0.2 package");
    const model=EngineeringModel.parse(JSON.parse(utf8.decode(files[manifest.engineering.path]!)));
    manifest.files.push({path:"process/derived.3mf",sha256:"0".repeat(64),size:1,mediaType:"model/3mf",role:"other"});
    const artifact={id:"PRINT-INPUT",path:"process/derived.3mf",sha256:"0".repeat(64),class:"process-input" as const,authoritative:false};
    expect(validateEngineering(model,manifest).some((x)=>x.message.includes("3MF"))).toBe(true);
    model.artifacts.push(artifact);
    expect(validateEngineering(model,manifest).some((x)=>x.message.includes("3MF"))).toBe(false);
    artifact.authoritative=true;
    expect(validateEngineering(model,manifest).some((x)=>x.message.includes("3MF"))).toBe(true);
  });
  it("exports 0.2 settings only when their verified engineering artifact is a non-authoritative process input", async () => {
    const files=unzipSync(readFileSync("samples/lab/SYN-PH-2000_A.tdp"));
    const manifest=Manifest.parse(JSON.parse(utf8.decode(files["tdp-manifest.json"]!)));
    if(manifest.schema!=="tdp-manifest/0.2") throw new Error("expected lab 0.2 package");
    const selected=manifest.files.find((f)=>f.mediaType==="model/step")!;
    const input=utf8.encode(JSON.stringify({...settings,modelPath:selected.path,modelSha256:selected.sha256}));
    for(const classification of ["process-input","specification"] as const) {
      const model=EngineeringModel.parse(JSON.parse(utf8.decode(files[manifest.engineering.path]!)));
      model.artifacts.push({id:"PRINT-SETTINGS",path:settingsPath,sha256:await sha256Hex(input),class:classification,authoritative:false});
      const inputs=manifest.files.map((f)=>({path:f.path,bytes:f.path===manifest.engineering.path?utf8.encode(JSON.stringify(model)):files[f.path]!,mediaType:f.mediaType,role:f.role,partNumber:f.partNumber,revision:f.revision}));
      inputs.push({path:settingsPath,bytes:input,mediaType:"application/json",role:"other",partNumber:undefined,revision:undefined});
      const bytes=await buildPackage(manifest.package,inputs,manifest.bom,[{...author,role:"author"},{...approver,role:"approver"}],LAB_NOW,{engineering:manifest.engineering.path});
      const session=await PackageSession.open("lab-settings.tdp",bytes,store,defaultPolicy,new AuditLog(),LAB_NOW);
      expect(session.trusted).toBe(true);
      const exported=exportForPrint(session,selected.path,mesh,{now:LAB_NOW,settingsPath});
      if(classification==="process-input") expect((await exported).settings?.path).toBe(settingsPath);
      else await expect(exported).rejects.toThrow(/non-authoritative process-input/);
    }
  });
});
