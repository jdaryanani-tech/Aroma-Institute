import { runSupabaseLegacyImport, safeImportErrorCategory } from "../server/db/supabase-legacy-import-runner";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const apply = process.argv.includes("--apply");
const allowed = new Set(["--apply", "--manifest"]);
  for (let index = 2; index < process.argv.length; index++) {
    const arg = process.argv[index];
    if (!arg.startsWith("--")) continue;
    if (!allowed.has(arg)) throw new Error("unsupported_argument");
    if (arg !== "--apply") index++;
  }
  const result = await runSupabaseLegacyImport({
    apply,
    manifestPath: argument("--manifest"),
  });
  // The runner's report is aggregate-only. Never print query errors or records.
  console.log(JSON.stringify(result));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, category: safeImportErrorCategory(error) }));
  process.exitCode = 1;
});
