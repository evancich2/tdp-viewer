import { z } from "zod";
import { canonicalJson } from "./canonical";
import { parseJson } from "./json";

/** Recorded process parameters, not slicer commands or manufacturing authority. Units belong in keys. */
export const PrintSettings = z.object({
  schema: z.literal("tdp-print-settings/0.1"),
  modelPath: z.string().min(1).max(255),
  modelSha256: z.string().regex(/^[0-9a-f]{64}$/),
  printerId: z.string().min(1).max(64),
  parameters: z.record(z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9._-]*$/), z.union([z.string().max(200), z.number(), z.boolean()]))
    .refine((p) => Object.keys(p).length > 0 && Object.keys(p).length <= 50, "1 to 50 print parameters required"),
}).strict();
export type PrintSettings = z.infer<typeof PrintSettings>;

export function parsePrintSettings(text: string): PrintSettings {
  if (text.length > 32_768) throw new Error("print settings exceed 32768 characters");
  return PrintSettings.parse(parseJson(text));
}
export const printSettingsMetadata = (settings: PrintSettings) => canonicalJson(PrintSettings.parse(settings));
