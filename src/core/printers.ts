/** A 3D printer the viewer can check parts against before export. Sizes in millimetres. */
export interface PrinterProfile {
  id: string;
  name: string;
  /** Usable build volume, X × Y × Z. */
  buildVolume: [number, number, number];
  /** Firmware the lab's printer runs, as the printer reports it (Bambu Lab: XX.XX.XX.XX). */
  firmware?: string;
  note?: string;
}

export const PRINTERS: PrinterProfile[] = [
  {
    id: "bambu-h2c",
    name: "Bambu Lab H2C",
    // Published figures vary with nozzle mode (the Vortek hotend rack takes space on one side):
    // about 300 × 320 × 325 mm using both nozzles, up to 325 × 320 × 325 mm single-nozzle.
    // Use the smallest envelope reported so a "fits" answer holds in every mode.
    buildVolume: [300, 320, 320],
    // Read from the lab's H2C on 2026-11-13. Update it here when the printer is updated.
    firmware: "01.03.00.00",
    note: "Conservative envelope valid for both nozzles; single-nozzle printing allows a little more width.",
  },
  { id: "generic", name: "Other printer (no size check)", buildVolume: [Infinity, Infinity, Infinity] },
];

export interface FitResult {
  fits: boolean;
  /** The part's overall size, X × Y × Z, as modelled. */
  size: [number, number, number];
}

/**
 * Whether a part of this size fits the printer's build volume in some axis-aligned orientation.
 * The slicer can rotate the part, so dimensions are compared largest to largest.
 */
export function checkFit(size: [number, number, number], printer: PrinterProfile): FitResult {
  const part = [...size].sort((a, b) => b - a);
  const volume = [...printer.buildVolume].sort((a, b) => b - a);
  return { fits: part.every((d, i) => d <= volume[i]!), size };
}
