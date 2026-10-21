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

test("a public application edge does not imply a public data service", () => {
  for (const proposal of [
    "RDS Postgres multi-AZ, public ALB",
    "Public ALB, private RDS Postgres multi-AZ",
    "A public load balancer forwards to the application and a private SQL database.",
    "Database is private. The API is internet-facing behind an ALB.",
    "The database is not publicly accessible.",
    "No public database is allowed; use a public ALB for ingress.",
    "Do not deploy a public SQL database.",
    "Block public S3 bucket access.",
    "Public storage access is disabled.",
    "RDS PubliclyAccessible: false",
    "RDS publicly accessible: false",
    "Postgres SQL tuning for a public API."
  ]) {
    assert.equal(deterministicChecks(proposal).some(f => f.id === "public-data"), false, proposal);
  }
});

test("explicit public data access retains a critical veto and the matching evidence", () => {
  for (const proposal of [
    "Deploy an internet-facing SQL database with public access.",
    "Transaction exports are stored in a publicly accessible S3 bucket.",
    "The RDS Postgres is publicly accessible.",
    "The database is open to the internet.",
    "The bucket will be public and contains customer exports.",
    "RDS PubliclyAccessible: true",
    "The database security group allows access from 0.0.0.0/0",
    "No WAF for the public database.",
    "No public database is allowed, but deploy a public S3 bucket for exports.",
    "The SQL database is private; the S3 bucket is public."
  ]) {
    const findings = deterministicChecks(proposal);
    const finding = findings.find(f => f.id === "public-data");
    assert.ok(finding, proposal);
    assert.equal(finding.severity, "critical");
    assert.ok(proposal.includes(finding.evidence), proposal);
    assert.equal(policyVerdict(findings), "REJECT");
  }
});
