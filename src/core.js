export const REVIEWERS = [
  { id: "security", name: "Security", initials: "SE", color: "#ff6b6b", focus: "attack paths, exposed services, secrets and encryption" },
  { id: "iam", name: "Identity & Access", initials: "IA", color: "#ffd166", focus: "least privilege, authentication, authorization and credential lifecycle" },
  { id: "network", name: "Network", initials: "NW", color: "#4cc9f0", focus: "segmentation, ingress, egress, private connectivity and trust boundaries" },
  { id: "sre", name: "Reliability", initials: "SR", color: "#7ae582", focus: "availability, failure modes, recovery, rollback and observability" },
  { id: "finops", name: "FinOps", initials: "FO", color: "#c77dff", focus: "unit economics, scaling exposure, quotas and waste" },
  { id: "compliance", name: "Compliance", initials: "CO", color: "#f4a261", focus: "auditability, retention, sensitive data and control evidence" },
  { id: "platform", name: "Platform Architecture", initials: "PA", color: "#90a4ff", focus: "operability, standards, portability and long-term maintainability" }
];

export function deterministicChecks(text) {
  const source = text.toLowerCase();
  const checks = [
    {
      id: "public-data",
      severity: "critical",
      title: "Potentially public data plane",
      hit: /(public|0\.0\.0\.0\/0|internet.?facing).{0,80}(bucket|database|storage|rds|sql)|(?:bucket|database|storage|rds|sql).{0,80}(public|0\.0\.0\.0\/0|internet.?facing)/s.test(source),
      fix: "Move the data service behind private connectivity and explicitly deny public access."
    },
    {
      id: "wildcard-iam",
      severity: "critical",
      title: "Wildcard privilege detected",
      hit: /(action|permission|role|policy).{0,60}(\*:\*|\"\*\"|administrator|owner)|iam.{0,40}wildcard/s.test(source),
      fix: "Replace wildcard permissions with task-scoped actions and resources."
    },
    {
      id: "embedded-secret",
      severity: "critical",
      title: "Static or embedded credential",
      hit: /(hard.?coded|embedded|plaintext|static).{0,50}(secret|password|api.?key|credential)|(?:secret|password|api.?key|credential).{0,50}(hard.?coded|embedded|plaintext|static)/s.test(source),
      fix: "Use a managed secret store and short-lived workload identity."
    },
    {
      id: "no-rollback",
      severity: "high",
      title: "Rollback plan missing",
      hit: /(no|without|skip).{0,35}(rollback|backout)|rollback.{0,30}(none|missing|not required)/s.test(source),
      fix: "Define automated rollback criteria, ownership and a tested restoration path."
    },
    {
      id: "unencrypted",
      severity: "high",
      title: "Encryption gap",
      hit: /(unencrypted|without encryption|disable encryption|http only|plaintext traffic)/s.test(source),
      fix: "Require encryption in transit and at rest using managed keys where appropriate."
    },
    {
      id: "missing-observability",
      severity: "medium",
      title: "Insufficient operational evidence",
      hit: /(no|without|skip).{0,35}(logs|logging|metrics|monitoring|tracing|alerts)/s.test(source),
      fix: "Add structured logs, service-level metrics, traces and actionable alerting."
    }
  ];
  return checks.filter((check) => check.hit).map(({ hit, ...check }) => check);
}

export function policyVerdict(findings) {
  if (findings.some((finding) => finding.severity === "critical")) return "REJECT";
  if (findings.length) return "CONDITIONAL";
  return "CLEAR";
}

export function aggregateRisk(reviews, findings) {
  const aiAverage = reviews.length
    ? reviews.reduce((sum, review) => sum + Number(review.risk_score || 0), 0) / reviews.length
    : 0;
  const policyFloor = findings.reduce((score, finding) => Math.max(score,
    finding.severity === "critical" ? 92 : finding.severity === "high" ? 76 : 55), 0);
  return Math.round(Math.max(aiAverage, policyFloor));
}

export function normalizeReview(raw, reviewer) {
  const vote = ["APPROVE", "CONDITIONAL", "REJECT"].includes(raw?.vote) ? raw.vote : "CONDITIONAL";
  return {
    reviewer_id: reviewer.id,
    reviewer: reviewer.name,
    initials: reviewer.initials,
    color: reviewer.color,
    vote,
    risk_score: Math.max(0, Math.min(100, Number(raw?.risk_score) || 50)),
    headline: String(raw?.headline || "Review requires attention").slice(0, 140),
    reasoning: String(raw?.reasoning || "The proposal needs additional evidence before approval.").slice(0, 900),
    conditions: Array.isArray(raw?.conditions) ? raw.conditions.slice(0, 4).map(String) : [],
    confidence: Math.max(0, Math.min(100, Number(raw?.confidence) || 65))
  };
}

export function fallbackReview(reviewer, findings) {
  const relevant = findings.filter((finding) => {
    const map = {
      security: ["public-data", "embedded-secret", "unencrypted"],
      iam: ["wildcard-iam", "embedded-secret"],
      network: ["public-data", "unencrypted"],
      sre: ["no-rollback", "missing-observability"],
      finops: [],
      compliance: ["public-data", "embedded-secret", "unencrypted", "missing-observability"],
      platform: ["no-rollback", "missing-observability", "wildcard-iam"]
    };
    return map[reviewer.id].includes(finding.id);
  });
  const critical = relevant.some((finding) => finding.severity === "critical");
  return normalizeReview({
    vote: critical ? "REJECT" : relevant.length ? "CONDITIONAL" : "APPROVE",
    risk_score: critical ? 94 : relevant.length ? 72 : 28,
    headline: relevant[0]?.title || `No blocking ${reviewer.name.toLowerCase()} issue detected`,
    reasoning: relevant.length
      ? `${reviewer.name} identified ${relevant.length} control gap${relevant.length > 1 ? "s" : ""} that must be resolved before production approval.`
      : `The submitted evidence does not reveal a blocking issue within the ${reviewer.name.toLowerCase()} mandate.`,
    conditions: relevant.map((finding) => finding.fix),
    confidence: 78
  }, reviewer);
}
