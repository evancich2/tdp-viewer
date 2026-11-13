# Printer bridge (Bambu Lab H2C over the LAN)

`npm run printer -- <command>` is a local command-line bridge between the workflow and the lab's H2C. It reads the printer's status and firmware, uploads a sliced `.gcode.3mf`, starts the print, and follows it to the end. It writes the queue, build-start and build-complete data that `tdp record add` signs into the part's ledger. It's a separate program: the browser viewer still makes no network requests, and nothing under `src/` imports it.

**Status:** tested against a simulated H2C and independent protocol implementations (below), **not yet against the real printer**. The H2-series print command is community-derived. Expect to adjust it after the first real attempt.

## What the printer needs

- **A computer on the printer's network** running the bridge. On a new machine, run the one-command installer from the README; its closing message shows how to start `npm run printer`.
- **The same network for the printer and that computer.** Phones and laptops on a guest Wi-Fi or a network with client isolation can't reach it.
- **LAN Only mode, then Developer Mode** (printer screen: Settings > Network). Since Bambu's 2025 authorization firmware, the printer accepts print and control commands from third-party software only with both on. Status reads work without them. Developer Mode is a Bambu feature they don't support. LAN Only mode disconnects the printer from Bambu's cloud (Bambu Handy stops working).
- **The LAN access code** shown on the same screen. It may change after a firmware update; read it again then.

## First connection

```sh
npm run printer -- discover                       # lists printers heard on this network (listen-only)
npm run printer -- pin --host 192.168.1.50 --resource H2C-LAB-01 --out h2c.printer.json
```

`pin` records the SHA-256 fingerprints of the certificates the printer presents on ports 8883 (MQTT) and 990 (FTPS), and the serial number from the certificate. **Check the serial against the printer's screen** (Settings > Device). Every later connection must present exactly these certificates before the access code is sent. The printer's certificate comes from Bambu's private CA, so it can't be checked against public CAs, and the bridge pins it instead of turning verification off. If port 990 was closed (LAN Only mode off), pin again once it's on. If the printer is reset or replaced, pinning fails until you pin again, deliberately.

The access code comes from `BAMBU_ACCESS_CODE` or a hidden prompt and is never written to disk.

```sh
export BAMBU_ACCESS_CODE=…                          # or let it prompt
npm run printer -- status   --printer h2c.printer.json
npm run printer -- firmware --printer h2c.printer.json --resource-out resource.json
```

`firmware` reads the version from the machine and compares it with the H2C profile (`src/core/printers.ts`, 01.03.00.00). It exits 1 if they differ. `resource.json` is the `resource` block of a suitability record with the firmware read from the machine.

## Printing

Slice in Bambu Studio for the H2C and export the plate with **File > Export > Export plate sliced file** (`.gcode.3mf`). The viewer's own 3MF export is unsliced and is refused.

```sh
npm run printer -- inspect part.gcode.3mf          # offline: plates, G-code MD5, filaments
npm run printer -- print part.gcode.3mf --printer h2c.printer.json --spool left --job J-0001 --records rec/
npm run printer -- print part.gcode.3mf --printer h2c.printer.json --ams 0,4 --plate 2 --records rec/
```

`print`:
1. checks the file has the plate's G-code and that it matches the slicer's recorded MD5;
2. refuses if the printer is already busy;
3. reads the firmware;
4. uploads the file and confirms its size;
5. sends `project_file`;
6. waits until the printer reports the job running.

It asks for `yes` before sending, unless you pass `--yes`.

Filament source is required and deliberate:
- `--spool left|right` uses an external spool (one-filament plates only).
- `--ams` gives one tray per project filament, in order: 0-3 for AMS 1, 4-7 for AMS 2, 128 and up for AMS HT, -1 for unused.

Calibration flags: `--no-bed-leveling`, `--flow-cali`, `--vibration-cali`, `--layer-inspect`, `--timelapse`.

Exit codes: 0 means started. 1 means refused (the message says why; a missing Developer Mode is named). 3 means no confirmation from the printer, so look at its screen.

`--records rec/` writes `queue-entry.json` and `build-start.json`, for example:

```sh
npm run tdp -- record add part.ledger.json --package part.tdp --key keys/oli.key.json --action enter-queue --role operator --outcome queued \
  --reason "Sent to H2C-LAB-01 by the printer bridge" --data rec/queue-entry.json --evidence EV-JOB=build-file=part.gcode.3mf --serial SN-0001 <context>
npm run tdp -- record add part.ledger.json --package part.tdp --key keys/oli.key.json --action dispatch-build --role operator --outcome started \
  --reason "Printer reported the job running" --data rec/build-start.json --serial SN-0001 <context>
```

The workflow gate still decides: a job can't be queued without a current CIP, and dispatch needs fresh authority. The bridge doesn't sign anything; the operator does. The queue entry carries the submitted file's SHA-256, so the build-complete record must name the same file. `complete-build` also needs a `build-log` evidence file.

```sh
npm run printer -- watch --printer h2c.printer.json --until-done --job J-0001 --sha256 <sha256> --started-at <ISO> --records rec/
npm run printer -- pause | resume --printer h2c.printer.json
npm run printer -- stop --printer h2c.printer.json            # asks first
npm run printer -- files --printer h2c.printer.json
npm run printer -- delete part.gcode.3mf --printer h2c.printer.json
```

`watch --until-done` writes `build-complete.json` with the printer's `print_error` and HMS codes as errors. A refused print leaves its file on the printer; `print` tells you the `delete` command.

## Protocol, as implemented

Bambu publishes no LAN API. This follows community documentation and open-source clients:

| | |
|---|---|
| MQTT | MQTT 3.1.1 over TLS, port 8883, user `bblp`, password = access code; subscribe `device/<serial>/report`, publish (QoS 1) to `device/<serial>/request` |
| Status | `{"pushing":{"command":"pushall"}}`, then incremental `push_status` reports merged into one view |
| Firmware | `{"info":{"command":"get_version"}}`; the `ota` module's `sw_ver` |
| Upload | implicit FTPS, port 990, PBSZ 0 / PROT P / binary / PASV; data connections resume the control TLS session; file at the FTP root; never overwrites |
| Print | `project_file` with `url: "ftp:///<name>"`, `param: Metadata/plate_N.gcode`, `md5` of that G-code, 0/1 calibration flags, `ams_mapping` and `ams_mapping2` |
| Refusal | reply with non-zero `err_code` (0x05024007-0x0502400B are authorization) or `result` other than success, or HMS `0500-0500-0001-0007` (command verification failed) |

The MQTT and FTPS clients are small and in this repository (`tools/bambu/`) rather than dependencies. Safety limits:
- a 4 MB cap on MQTT packets;
- a 1 GB cap on sliced files;
- data connections go only to the pinned host, never to the address in a PASV reply;
- only plain file names are allowed on the printer;
- report merging ignores `__proto__`.

## How it was tested

- **Unit tests** (`tests/printer-bridge.test.ts`):
  - MQTT byte vectors from the 3.1.1 spec;
  - packet reassembly and hostile packets;
  - sliced-file inspection, MD5 checks and plate selection;
  - AMS mapping;
  - the `project_file` shape, refusal decoding, discovery parsing and safe file names.
- **A simulated H2C** (`tests/helpers/fake-h2c.ts`): an MQTT broker and implicit-FTPS server over TLS, with a certificate whose CN is the serial. Its MQTT parser is independent of the client's. The tests cover:
  - pinning;
  - status and firmware, including a firmware mismatch;
  - wrong access code, wrong serial, wrong certificate (no credentials sent);
  - TLS 1.2 and 1.3 session reuse, with a check that the simulated printer refuses a non-resumed data connection;
  - a missing 226 reply and a 12 MB upload;
  - print start, the three refusal styles and a busy printer;
  - watch to finish and to failure, and pause/resume/stop;
  - the CLI end to end.
- **Cross-checks, outside the test suite:**
  - this MQTT client against the aedes broker;
  - the mqtt.js client against the simulated broker;
  - the basic-ftp client against the simulated FTPS server (session reuse included).

None of this shows the real H2C answers the same way. The first real run is the test that matters: `status` and `firmware` first, then a small single-filament print watched at the printer.
