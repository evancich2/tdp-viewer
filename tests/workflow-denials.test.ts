// Mutate valid synthetic records one fact at a time. Each control must first pass its gate;
// otherwise a denial could conceal an unrelated invalid fixture.
import { beforeAll, describe, expect, it } from "vitest";
import { evaluateRecord, verifyLedger, type VerifiedRecord, type WorkflowRecord } from "../src/core/records";
import { loadContext, readLedger, type LoadedContext } from "../tools/workflow-commands";
let c: LoadedContext;let records: VerifiedRecord[];
beforeAll(async()=>{
  c=await loadContext({package:"samples/lab/SYN-PH-2000_A.tdp",trust:"samples/lab/trust-store.signed.json",anchors:"samples/lab/anchors.json",authority:"samples/lab/authority.signed.json",process:"samples/lab/processes/printed-part-v1.json",evidenceDir:"samples/lab/evidence",at:"2026-11-12T13:00:00Z"});
  const r=await verifyLedger(readLedger("samples/lab/ledgers/SN-0001.ledger.json"),c.ctx);if(r.verdict!=="verified")throw new Error("synthetic control ledger failed verification");records=r.records;
});
type Mutation=(r:WorkflowRecord)=>void;
const cases:[string,number,Mutation,RegExp][]=[
  ["wrong package",0,r=>{r.baseline.packageId=crypto.randomUUID();},/wrong baseline/],
  ["wrong baseline id",0,r=>{r.baseline.baselineId="MISSING";},/wrong baseline/],
  ["wrong manifest digest",0,r=>{r.baseline.manifestSha256="0".repeat(64);},/wrong baseline/],
  ["unknown item",0,r=>{r.item.itemId="MISSING";},/not in baseline/],
  ["wrong revision",0,r=>{r.item.revision="ZZ";},/wrong revision/],
  ["wrong process",0,r=>{r.policy.processId="missing";},/loaded process/],
  ["wrong process version",0,r=>{r.policy.processVersion+=1;},/loaded process/],
  ["wrong process digest",0,r=>{r.policy.processSha256="0".repeat(64);},/loaded process/],
  ["wrong authority",0,r=>{r.policy.authorityId="MISSING";},/names authority/],
  ["future authority",0,r=>{r.policy.authoritySerial+=100;},/newer than/],
  ["before baseline",0,r=>{r.at="2000-01-01T00:00:00Z";},/before the baseline/],
  ["nonmonotonic time",2,r=>{r.at=records[0]!.record.at;},/before the record/],
  ["untrusted identity",0,r=>{r.actor.keyId="0".repeat(32);},/not.*trust|unknown/i],
  ["unknown transition",0,r=>{r.action="missing";},/not a transition/],
  ["wrong outcome",0,r=>{r.outcome="impossible";},/can't have outcome/],
  ["wrong payload kind",0,r=>{r.data={kind:"closure",summary:"synthetic"};},/records requirements-approval/],
  ["missing requirement",0,r=>{if(r.data.kind==="requirements-approval")r.data.requirements.pop();},/not approved/],
  ["unknown approved requirement",0,r=>{if(r.data.kind==="requirements-approval")r.data.requirements.push({id:"MISSING",version:1});},/isn't a requirement/],
  ["unknown source",1,r=>{if(r.data.kind==="source-release")r.data.source="MISSING";},/not declared/],
  ["wrong source system",1,r=>{if(r.data.kind==="source-release")r.data.system="onshape";},/record says/],
  ["wrong source revision",1,r=>{if(r.data.kind==="source-release")r.data.revision="ZZ";},/source release is for/],
  ["unreleased source",1,r=>{if(r.data.kind==="source-release")r.data.releaseState="Draft";},/not one.*released/],
  ["changed source reference",1,r=>{if(r.data.kind==="source-release")r.data.reference.documentId="MISSING";},/reference differs/],
  ["invalid source attestation",1,r=>{if(r.data.kind==="source-release")r.data.attestation="manual-transcription";},/doesn't fit/],
  ["unjustified suitability outcome",2,r=>{r.outcome="suitable";},/own inputs evaluate/],
  ["stale suitability reference",3,r=>{if(r.data.kind==="suitability-review")r.data.suitabilityRecord=crypto.randomUUID();},/latest suitability/],
  ["unaddressed suitability gap",3,r=>{if(r.data.kind==="suitability-review")r.data.acceptedGaps=[];},/address every gap/],
  ["unknown planned characteristic",4,r=>{if(r.data.kind==="plan")r.data.inspectionPlan[0]!.characteristic="MISSING";},/unknown characteristic/],
  ["missing planned characteristic",4,r=>{if(r.data.kind==="plan")r.data.inspectionPlan.pop();},/needs inspection/],
  ["undefined authorized operation",5,r=>{if(r.data.kind==="authorization")r.data.operations.push("missing");},/not defined/],
  ["wrong CIP policy",5,r=>{if(r.data.kind==="authorization")r.data.policyVersion=999;},/issued for policy/],
  ["empty CIP window",5,r=>{if(r.data.kind==="authorization")r.data.notAfter=r.data.notBefore;},/window is empty/],
  ["unbound CIP units",5,r=>{if(r.data.kind==="authorization")r.data.units={};},/must name.*serials/],
  ["unsubmitted evidence",6,r=>{if(r.data.kind==="queue-entry")r.data.submittedFile.sha256="0".repeat(64);},/submitted file must/],
  ["duplicate evidence id",6,r=>{r.evidence.push(r.evidence[0]!);},/appears twice/],
  ["unverified evidence bytes",6,r=>{r.evidence[0]!.sha256="0".repeat(64);},/not among.*supplied/],
  ["wrong queued job",7,r=>{if(r.data.kind==="build-start")r.data.jobId="MISSING";},/not the queued job/],
  ["wrong completed job",8,r=>{if(r.data.kind==="build-complete")r.data.jobId="MISSING";},/was not started/],
  ["wrong completed file",8,r=>{if(r.data.kind==="build-complete")r.data.submittedFileSha256="0".repeat(64);},/hash differs/],
  ["inverted build time",8,r=>{if(r.data.kind==="build-complete")r.data.completedAt="2000-01-01T00:00:00Z";},/before it started/],
  ["unexplained failed build",8,r=>{if(r.data.kind==="build-complete")r.data.errors=[];},/must record its errors/],
  ["stale disposition reference",14,r=>{if(r.data.kind==="disposition")r.data.inspectionRecord=crypto.randomUUID();},/latest inspection/],
  ["accept with NCR",14,r=>{if(r.data.kind==="disposition")r.data.ncrId="NCR-SYNTHETIC";},/doesn't cite an NCR/],
  ["unknown incorporation",15,r=>{if(r.data.kind==="closure")r.data.incorporation={occurrence:"MISSING",parentUnit:"SYNTHETIC"};},/not in the baseline/],
];
describe("workflow denial paths",()=>{
  it.each(cases)("%s",(_label,index,change,reason)=>{
    const history=records.slice(0,index);const r=structuredClone(records[index]!.record);
    expect(evaluateRecord(history,r,c.ctx,"create").fatal).toBeNull();change(r);
    expect(evaluateRecord(history,r,c.ctx,"create").fatal).toMatch(reason);
  });
  it("holds missing bytes on verification and denies them before signing",()=>{
    const r=records[6]!.record,history=records.slice(0,6);const ctx={...c.ctx,evidence:undefined};
    expect(evaluateRecord(history,r,ctx,"verify")).toMatchObject({fatal:null,held:expect.arrayContaining([expect.stringMatching(/not hash-checked/)])});
    const absent={...c.ctx,evidence:new Map()};
    expect(evaluateRecord(history,r,absent,"create").fatal).toMatch(/not among.*supplied/);
  });
});
