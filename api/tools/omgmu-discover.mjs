import { discoverOmgmuSources, OMG_MU_SOURCE } from "../src/adapters/omgmu/discover.mjs";

function readArg(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

const sourceUrl = readArg("source", OMG_MU_SOURCE);
const output = readArg("output", "data/imports/omgmu-source-manifest.json");
const manifest = await discoverOmgmuSources({ sourceUrl, output });

console.log(`Discovered ${manifest.sourceCount} ОмГМУ schedule files`);
console.log(`Manifest: ${output}`);
if (manifest.validation.errors.length) {
  console.error(manifest.validation.errors.join("\n"));
  process.exitCode = 2;
}
