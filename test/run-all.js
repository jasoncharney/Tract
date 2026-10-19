#!/usr/bin/env node
/*
  Run every suite, in series, and sum up.

  In series on purpose: each suite starts its own bridge and its own browser,
  and several of them open four or more player pages with the synth running.
  Run in parallel they stop testing the piece and start testing the machine.

      node test/run-all.js              everything
      node test/run-all.js stage        only the suites whose name matches
*/

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const HERE = __dirname;
const filter = process.argv[2] || "";
const suites = fs
  .readdirSync(HERE)
  .filter((f) => f.endsWith(".test.js"))
  .filter((f) => !filter || f.includes(filter))
  .sort();

if (!suites.length) {
  console.log(filter ? `no suite matches "${filter}"` : "no suites found");
  process.exit(1);
}

const started = Date.now();
const results = [];
for (const file of suites) {
  const run = spawnSync("node", [path.join(HERE, file)], { stdio: "inherit" });
  results.push({ file, code: run.status });
}

const seconds = ((Date.now() - started) / 1000).toFixed(0);
console.log(`\n${"=".repeat(60)}\n`);
results.forEach((r) =>
  console.log(`  ${r.code === 0 ? "pass" : "FAIL"}  ${r.file}${r.code === 2 ? "  (the suite itself fell over)" : ""}`)
);
const bad = results.filter((r) => r.code !== 0).length;
console.log(`\n  ${results.length - bad} of ${results.length} suites passed, in ${seconds}s\n`);
process.exit(bad ? 1 : 0);
