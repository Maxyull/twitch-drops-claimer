// Integrity checks on .github/workflows/. These freeze the supply-chain rule
// argued in docs/SECURITY-AUDIT.md (actions pinned by SHA, never by tag) and the
// one constraint that broke CI in #73: the CodeQL entry points are two halves of
// a single release and cannot drift apart.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_DIR = path.join(ROOT, ".github", "workflows");

const WORKFLOWS = readdirSync(WORKFLOW_DIR)
  .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
  .map((file) => ({ file, text: readFileSync(path.join(WORKFLOW_DIR, file), "utf8") }));

// `uses: owner/repo[/path]@ref` followed by an optional trailing comment.
const USES = /^\s*(?:-\s+)?uses:\s*(\S+?)@(\S+)(?:\s+#\s*(.*))?$/;

function pins(text) {
  return text
    .split("\n")
    .map((line) => line.match(USES))
    .filter(Boolean)
    .map(([, action, ref, comment]) => ({ action, ref, comment: comment?.trim() ?? null }));
}

const ALL_PINS = WORKFLOWS.flatMap(({ file, text }) => pins(text).map((p) => ({ file, ...p })));

test("there are workflows to check, and they pin something", () => {
  assert.ok(WORKFLOWS.length >= 3, "expected at least ci, codeql and gitleaks");
  assert.ok(ALL_PINS.length > 0, "no `uses:` found — the pin regex has stopped matching");
});

test("every action is pinned by a full commit SHA, never by a tag", () => {
  for (const { file, action, ref } of ALL_PINS) {
    assert.match(
      ref,
      /^[0-9a-f]{40}$/,
      `${file}: ${action} is pinned to "${ref}". A tag is mutable, see docs/SECURITY-AUDIT.md`,
    );
  }
});

// A bare `# v4` cannot be seen to be wrong: it stays plausible while the SHA moves
// under it. #62 bumped actions/checkout from 4.3.1 to 7.0.1 and left `# v4` in
// place across all three workflows, and nothing looked odd. A full version is
// falsifiable at a glance.
test("every pin carries its full version in the trailing comment", () => {
  for (const { file, action, comment } of ALL_PINS) {
    assert.ok(comment, `${file}: ${action} is pinned with no version comment`);
    assert.match(
      comment,
      /^v\d+\.\d+\.\d+$/,
      `${file}: ${action} is commented "${comment}", expected a full version such as v4.37.4`,
    );
  }
});

// The bug in #73. github/codeql-action is a monorepo: `init` writes a configuration
// stamped with its own version and `analyze` refuses to read a configuration from
// another one, with "Loaded a configuration file for version X, but running
// version Y". Dependabot bumps one entry point at a time, so this is the check
// that catches it before CI does.
test("all github/codeql-action entry points share one SHA per workflow", () => {
  for (const { file, text } of WORKFLOWS) {
    const codeql = pins(text).filter((p) => p.action.startsWith("github/codeql-action"));
    if (codeql.length === 0) continue;

    const refs = new Set(codeql.map((p) => p.ref));
    assert.equal(
      refs.size,
      1,
      `${file}: codeql-action entry points are on ${refs.size} different SHAs ` +
        `(${codeql.map((p) => `${p.action}@${p.ref.slice(0, 8)}`).join(", ")}). ` +
        `init and analyze must come from the same release.`,
    );

    const versions = new Set(codeql.map((p) => p.comment));
    assert.equal(versions.size, 1, `${file}: same SHA, disagreeing version comments`);
  }
});
