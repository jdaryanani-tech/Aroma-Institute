import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const proposalPath = new URL(
  "../../docs/security-review/supabase-public-table-grants-proposal.md",
  import.meta.url,
);

test("Supabase public-table grants proposal documents scoped change and exact rollback", async () => {
  const proposal = await readFile(proposalPath, "utf8");

  assert.match(proposal, /review only — NOT APPLIED/);
  assert.match(proposal, /public\.leads/);
  assert.match(proposal, /public\.conversations/);
  assert.match(proposal, /public\.course_knowledge/);
  assert.match(proposal, /REVOKE ALL PRIVILEGES ON TABLE/);
  assert.match(proposal, /GRANT SELECT ON TABLE public\.course_knowledge TO authenticated/);
  assert.match(
    proposal,
    /GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER, TRUNCATE ON TABLE/,
  );
  assert.match(proposal, /is_grantable = false/);
  assert.match(proposal, /published-row RLS policy/);
  assert.match(proposal, /effective privileges, including inherited access/i);
  assert.match(proposal, /does not establish which credentials or roles active n8n/i);
});
