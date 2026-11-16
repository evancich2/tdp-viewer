# Signed print settings and 3MF process inputs

Print settings can be supplied as a manifest-listed JSON file with role `other`, signed with the
rest of the package. For a `tdp-manifest/0.2` package, also list the settings file as an engineering
artifact with class `process-input`, `authoritative: false`, and its actual raw-byte SHA-256.
The STEP geometry remains the authoritative model; a settings file is not engineering release.

## Settings file

The schema is `tdp-print-settings/0.1`. It requires `modelPath`, the exact STEP `modelSha256`,
`printerId` (for example the existing `bambu-h2c` profile), and `parameters`. Parameter names are
1–64 characters matching `[A-Za-z][A-Za-z0-9._-]*`; values are strings up to 200 characters, finite
numbers or booleans. Supply 1–50 entries; the complete JSON text is limited to 32,768 characters.
Unknown top-level fields, duplicate names, malformed Unicode and excessive nesting are rejected.
Declare units in names, such as `layerHeightMm`, and retain the approved planning basis. The
schema validates structure, not material suitability, machine limits or engineering acceptance.
No actual BasePlate settings are prescribed by this document.

Use the real model path and digest, selected printer profile and approved parameters when
building the package; `buildPackage` hashes/signs these files as ordinary inputs. In the viewer,
select **Signed print settings** in the print panel before exporting. A file bound to another
model path, model digest or printer profile is refused. The CLI/core interface accepts
`exportForPrint(..., { settingsPath })`. Export without settings remains available as before and
the selector explicitly shows **No settings attached**; that means no process settings were supplied.

## What the exported 3MF records

The 3MF includes `tdp:PrintSettings` (canonical JSON, XML-escaped), `tdp:PrintSettingsPath` and
`tdp:PrintSettingsSha256`, alongside the package/manifest/model digests. Settings are re-read
through `PackageSession.openFile` immediately before export, and their source digest appears in
the audit entry. Package signatures cover the original settings bytes; the derived 3MF itself is
an export with a recorded digest, not a newly approved or signed manufacturing baseline.

These are provenance metadata, **not vendor-specific Bambu Studio project settings**. A slicer
may ignore custom metadata. The operator must compare/apply the approved values in the slicer,
then retain the actual sliced job bytes/hash and settings in the build record. This does not
start a printer, grant CIP authority, guarantee slicer compatibility or prove a live printer run.

## Carrying an existing 3MF in a package

Use media type `model/3mf` and manifest role `other`. In a 0.2 engineering model it must have a
non-authoritative `process-input` artifact; missing/wrong classification is rejected. The viewer
checks the outer package signatures, listed raw-byte digest/size and a ZIP prefix. It treats the
3MF as opaque: it does not recursively extract it, validate all 3MF semantics, execute scripts,
render its geometry, follow embedded links or submit embedded machine instructions. **Save process
input** re-verifies the bytes and records an export audit entry. Review the file in the approved
slicer under the local operating procedure before any manufacturing action.

Tests in `tests/printsettings.test.ts` cover signed settings export, XML escaping, source/printer
mismatches, tampering, malformed/duplicate/oversize/schema inputs and 3MF classification. Existing
manifest 0.1/0.2 packages without these artifacts remain unchanged.
