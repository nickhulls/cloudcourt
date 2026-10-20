import test from "node:test";
import assert from "node:assert/strict";
import { deterministicChecks, policyVerdict, aggregateRisk, REVIEWERS, fallbackReview } from "../src/core.js";

test("blocks a public database with wildcard IAM", () => {
  const findings = deterministicChecks("Deploy an internet-facing SQL database with public access and an IAM wildcard policy Action: *.*");
  assert.ok(findings.some((finding) => finding.id === "public-data"));
  assert.ok(findings.some((finding) => finding.id === "wildcard-iam"));
  assert.equal(policyVerdict(findings), "REJECT");
});

test("requires conditions for missing rollback", () => {
  const findings = deterministicChecks("Deploy the private service without rollback and skip monitoring during launch.");
  assert.equal(policyVerdict(findings), "CONDITIONAL");
  assert.ok(findings.some((finding) => finding.id === "no-rollback"));
});

test("risk score respects deterministic policy floor", () => {
  const findings = [{ severity: "critical" }];
  assert.equal(aggregateRisk([{ risk_score: 12 }], findings), 92);
});

test("fallback produces one valid review per council member", () => {
  const findings = deterministicChecks("Store an embedded plaintext API key and deploy with no rollback.");
  for (const reviewer of REVIEWERS) {
    const review = fallbackReview(reviewer, findings);
    assert.ok(["APPROVE", "CONDITIONAL", "REJECT"].includes(review.vote));
    assert.equal(review.reviewer_id, reviewer.id);
  }
});
