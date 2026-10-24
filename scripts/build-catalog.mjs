// Writes site/catalog.json from the compiled recipes. Run by `npm run build`, after tsc.
import { writeFileSync } from "node:fs";
import { URL } from "node:url";
import { siteCatalog } from "../dist/site-catalog.js";

const out = new URL("../site/catalog.json", import.meta.url);
writeFileSync(out, JSON.stringify(siteCatalog(), null, 2) + "\n");
