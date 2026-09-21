// Assembles the planner into single-file pages.
//   app/amer-os.html  - page body for publishing as a Claude artifact (the platform adds <html>/<head>)
//   app/preview.html  - full HTML document you can open directly in a browser (local preview mode)
import { readFileSync, writeFileSync, readdirSync, mkdirSync, copyFileSync } from "node:fs";

const shell = readFileSync("src/page.html", "utf8");
if (!shell.includes("/*__JS__*/")) throw new Error("src/page.html is missing the /*__JS__*/ placeholder");

const read = (dir) => readdirSync(dir).filter((f) => f.endsWith(".js")).sort().map((f) => readFileSync(`${dir}/${f}`, "utf8"));
const shared = read("src/shared");           // engine + helpers, shared with the server
const js = [...shared, ...read("src/js")].join("\n");

const body = shell.replace("/*__JS__*/", () => js);
mkdirSync("app", { recursive: true });
writeFileSync("app/amer-os.html", body);
writeFileSync(
  "app/preview.html",
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>[hidden]{display:none!important} body{margin:0}</style>
</head>
<body>
${body}
</body>
</html>
`,
);
// The server imports the same engine, so re-export it as a module.
const EXPORTS = "planWeek, weekStats, weekPosition, dayWindow, windowFor, span, fixedBlocksFor, withDefaults,\n  PILLARS, PKEYS, DAYS, COLLECTIONS, DEFAULT_CONFIG, toMin, hhmm, dur, dkey, pdate, mondayOf, addDays, uid, sortBy, pillarOf";
writeFileSync("app/engine.mjs", shared.join("\n") + `\nexport {\n  ${EXPORTS},\n};\n`);
// Files served as-is: the service worker, the web app manifest and the icons.
const statics = readdirSync("src/static");
for (const f of statics) copyFileSync(`src/static/${f}`, `app/${f}`);

console.log(`Built app/amer-os.html and app/preview.html + app/engine.mjs + ${statics.length} static files (${(body.length / 1024).toFixed(1)} KB)`);
