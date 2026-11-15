import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { vectorsText } from "./vector-fixtures";

const path = "samples/vectors/canonical-json.json";
const text = await vectorsText();
if (process.argv.includes("--check")) {
  if (readFileSync(path, "utf8") !== text) throw new Error("Shared vectors differ; run npm run vectors and review the changes");
  console.log("Shared canonical JSON vectors match the implementation and committed synthetic record");
} else {
  mkdirSync("samples/vectors", { recursive: true });
  writeFileSync(path, text);
  console.log(`Wrote ${path}`);
}
