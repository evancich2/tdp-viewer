# Phase II assembly and inspection scope

Status: proposed bounded demonstration for STDP-011. The current laboratory evidence covers a
single-part workflow with synthetic fixtures. Nothing beyond that single-part scope is validated
by this note. A future assembly demonstration is distinct from the completed entry PoC baseline.

## Bounded scenario

Use one parent assembly with two child part occurrences and explicitly serialized built units.
Approve the assembly BOM, reference design, characteristics and decision rules before testing.
Bind each occurrence to the correct child item revision, exact package baseline and built serial.
The existing closure `incorporation` field is a starting point; it does not by itself implement
assembly state, parent hold propagation or assembly-level inspection.

1. Release the parent/child baselines and establish authorized operations under signed policy.
2. Build and inspect the two serialized child units; preserve their individual histories.
3. Record incorporation into named parent occurrences, refusing a wrong revision or reused serial.
4. Perform a separate assembly-level inspection against approved functional and dimensional criteria.
5. Raise an NCR against one installed child. The parent must be held with a reason and affected
   occurrence, even if its previous inspection passed. Do not silently disposition either unit.
6. Record authorized replacement/rework, re-inspection and engineering disposition separately.
   Preserve the original child NCR and the parent hold history; demonstrate release only when an
   authorized disposition and applicable policy explicitly permit it.

## Features and required evidence

| Feature | Required evidence / expected outcome |
|---|---|
| Occurrence-to-unit identity | Signed serial/occurrence/baseline binding; wrong revision, duplicate incorporation and missing child refused |
| Assembly inspection | Approved criteria, raw measurements, equipment qualification, uncertainty, decision rule and inspector identity |
| Child NCR → parent hold | Signed child NCR and propagation record; dependent parent operation denied until authorized resolution |
| Revision/change | Original and revised configurations, explicit effectivity/CIP and physical incorporation history |
| Recovery and replay | Rebuild identical as-built associations from retained records; no duplicate incorporation on retry |

Khaled supplies the controlled design/BOM, fixtures, safe physical procedure, approved limits,
instrument evidence, actual measurements and engineering decisions. Software fixtures remain labeled
synthetic. Do not invent tolerances, approvals, build outcomes, calibration or dispositions.

## Limits and follow-on work

This does not qualify a production process, SPC capability, arbitrary assembly depth, enterprise
PLM integration or autonomous release. Two governed contexts and actual participant roles need
separate evidence. Live Onshape/Windchill access and data permissions are open dependencies.
Selecting a part in 3D ↔ BOM requires verified STEP assembly/occurrence mapping; positional solid
indices are not persistent item identity. A measure tool also needs a stated geometric accuracy
and tessellation limitation. Neither feature is validated by the existing single-part viewer.

Exit: reviewed expected/actual test logs, hash-bound raw evidence, a defect register, and explicit
engineering hold/disposition for each unit and parent. Quantitative targets must precede execution.
