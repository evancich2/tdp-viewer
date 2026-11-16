import { beforeAll, describe, expect, it } from "vitest";
import { validateEngineering, unitInEffectivity, type EngineeringModel } from "../src/core/engineering";
import { loadProcess, validateProcess, type ProcessDefinition } from "../src/core/process";
import { loadContext, type LoadedContext } from "../tools/workflow-commands";
let c: LoadedContext;
beforeAll(async () => { c = await loadContext({package:"samples/lab/SYN-PH-2000_A.tdp",trust:"samples/lab/trust-store.signed.json",anchors:"samples/lab/anchors.json",authority:"samples/lab/authority.signed.json",process:"samples/lab/processes/printed-part-v1.json",at:"2026-11-12T13:00:00Z"}); });
describe("engineering consistency refuses inconsistent controlled definitions", () => {
  const cases: [string, (m: EngineeringModel) => void, RegExp][] = [
    ["wrong package",m=>{m.baseline.packageId=crypto.randomUUID();},/baseline names package/],
    ["wrong root",m=>{m.baseline.item.itemId="MISSING";},/baseline item/],
    ["duplicate source",m=>{m.sources.push(m.sources[0]!);},/duplicate source/],
    ["duplicate item revision",m=>{m.items.push(m.items[0]!);},/duplicate item/],
    ["duplicate occurrence",m=>{m.occurrences.push(m.occurrences[0]!);},/duplicate occurrence/],
    ["duplicate characteristic",m=>{m.characteristics.push(m.characteristics[0]!);},/duplicate characteristic/],
    ["duplicate requirement",m=>{m.requirements.push(m.requirements[0]!);},/duplicate requirement/],
    ["unknown BOM",m=>{m.items[0]!.partNumber="MISSING";},/no BOM entry/],
    ["wrong BOM revision",m=>{m.items[0]!.revision="ZZ";},/in the BOM/],
    ["unknown item source",m=>{m.items[0]!.source="MISSING";},/unknown source/],
    ["source revision mismatch",m=>{m.sources[0]!.declaredRevision="ZZ";},/declares revision/],
    ["unknown occurrence child",m=>{m.occurrences[0]!.child.itemId="MISSING";},/occurrence.*unknown item/],
    ["unknown requirement characteristic",m=>{m.requirements[0]!.characteristics.push("MISSING");},/lists unknown characteristic/],
    ["unknown characteristic requirement",m=>{m.characteristics[0]!.requirement="MISSING";},/names unknown requirement/],
    ["unlisted characteristic",m=>{m.requirements.forEach(r=>{r.characteristics=[];});},/not listed by requirement/],
    ["unknown geometry",m=>{m.characteristics[0]!.geometry=["MISSING"];},/unknown geometry link/],
    ["missing artifact",m=>{m.artifacts[0]!.path="missing.step";},/not in the manifest/],
    ["artifact digest mismatch",m=>{m.artifacts[0]!.sha256="0".repeat(64);},/digest differs/],
    ["unknown artifact source",m=>{m.artifacts[0]!.source="MISSING";},/unknown source/],
    ["unknown link artifact",m=>{m.geometryLinks[0]!.artifact="MISSING";},/unknown artifact/],
    ["unstable geometry claim",m=>{m.geometryLinks[0]!.method="step-solid-index";m.geometryLinks[0]!.stability="revision-stable";},/can't be revision-stable/],
    ["unknown relationship endpoint",m=>{m.relationships.push({type:"describes",from:"MISSING",to:m.baseline.id});},/relationship refers to unknown/],
    ["incomparable effectivity",m=>{m.baseline.effectivity={kind:"serial",from:"SN-01",to:"OTHER-02"};},/share a prefix/],
    ["reversed effectivity",m=>{m.baseline.effectivity={kind:"serial",from:"SN-02",to:"SN-01"};},/reversed/],
  ];
  it.each(cases)("%s",(_label,change,expected)=>{
    const m=structuredClone(c.ctx.baseline.model);
    expect(validateEngineering(m,c.verify.manifest!)).toEqual([]);
    change(m);
    expect(validateEngineering(m,c.verify.manifest!).some(x=>x.severity==="error"&&expected.test(x.message))).toBe(true);
  });
  it("holds stale geometry for review rather than inventing a replacement",()=>{
    const m=structuredClone(c.ctx.baseline.model);m.geometryLinks[0]!.artifactSha256="0".repeat(64);
    expect(validateEngineering(m,c.verify.manifest!)).toContainEqual(expect.objectContaining({severity:"review",message:expect.stringMatching(/stale/)}));
  });
  it("respects serial and lot boundaries",()=>{
    const e={kind:"serial",from:"SN-001",to:"SN-003"} as const;
    for(const serial of ["SN-001","SN-002","SN-003"])expect(unitInEffectivity(e,{serial})).toBe(true);
    for(const serial of ["SN-000","SN-004","SN-02","XX-002"])expect(unitInEffectivity(e,{serial})).toBe(false);
    expect(unitInEffectivity(e,{})).toBe(false);
    expect(unitInEffectivity({kind:"lot",lots:["LOT-A"]},{lot:"LOT-A"})).toBe(true);
    expect(unitInEffectivity({kind:"lot",lots:["LOT-A"]},{lot:"LOT-B"})).toBe(false);
  });
});
describe("process configuration rejects ambiguous or unreachable named dependencies",()=>{
  const cases: [string,(p:ProcessDefinition)=>void,RegExp][]=[
    ["duplicate state",p=>{p.states.push(p.states[0]!);},/duplicate state/],
    ["duplicate role",p=>{p.roles.push(p.roles[0]!);},/duplicate role/],
    ["duplicate operation",p=>{p.operations.push(p.operations[0]!);},/duplicate operation/],
    ["unknown initial",p=>{p.initial="missing";},/initial state/],
    ["unknown terminal",p=>{p.terminal=["missing"];},/terminal state/],
    ["duplicate transition",p=>{p.transitions.push(p.transitions[0]!);},/duplicate transition/],
    ["unknown from-state",p=>{p.transitions[0]!.from=["missing"];},/unknown from-state/],
    ["empty outcomes",p=>{p.transitions[0]!.outcomes={};},/no outcomes/],
    ["invalid outcome",p=>{p.transitions[0]!.outcomes={impossible:p.initial};},/can't have outcome/],
    ["unknown target state",p=>{p.transitions[0]!.outcomes.approved="missing";},/unknown state/],
    ["undeclared role",p=>{p.roles=[];},/undeclared role/],
    ["unknown prerequisite",p=>{p.transitions[0]!.requires.actions=[{id:"missing"}];},/requires unknown transition/],
    ["impossible prerequisite outcome",p=>{p.transitions[1]!.requires.actions=[{id:p.transitions[0]!.id,outcomes:["impossible"]}];},/has no outcome/],
    ["unknown independence",p=>{p.transitions[0]!.distinctOrganizationFrom=["missing"];},/independence from unknown/],
    ["unknown authorization",p=>{p.transitions[0]!.requires.authorization="missing";},/undeclared operation/],
  ];
  it.each(cases)("%s",async(_label,change,expected)=>{
    const p=structuredClone(c.ctx.process.definition);expect(validateProcess(p)).toEqual([]);change(p);
    expect(validateProcess(p).some(x=>expected.test(x))).toBe(true);
    // The public loader must enforce the same guard, not just the validation helper.
    if(p.roles.length)await expect(loadProcess(JSON.stringify(p))).rejects.toThrow(expected);
  });
});
