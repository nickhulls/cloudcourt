import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";

const env = {
  ASSETS: { fetch: async () => new Response("asset") }
};

test("health endpoint reports available bindings", async () => {
  const response = await worker.fetch(new Request("https://cloudcourt.test/api/health"), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.service, "cloudcourt");
  assert.equal(body.ai, false);
});

test("review endpoint completes with deterministic specialist fallback", async () => {
  const request = new Request("https://cloudcourt.test/api/review", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Unsafe payment API release",
      provider: "AWS",
      proposal: "Deploy an internet-facing SQL database with public access, an embedded plaintext API key, an IAM administrator wildcard policy, and no rollback or monitoring."
    })
  });
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.council.verdict, "REJECT");
  assert.equal(body.reviewers.length, 7);
  assert.equal(body.events.length, 10);
  assert.match(body.evidence.chain_head, /^[a-f0-9]{64}$/);
  assert.equal(body.evidence.ai_reviews, 0);
  assert.equal(body.evidence.fallback_reviews, 7);
  assert.ok(body.reviewers.every(review => review.source === "fallback"));
  assert.equal(body.comparison.single_agent.source, "fallback");
  assert.ok(body.events.filter(event => event.kind === "private_vote")
    .every(event => event.payload.source === "fallback"));
});

const modelReview = {
  vote: "CONDITIONAL", risk_score: 63, confidence: 81,
  headline: "Recovery evidence required",
  reasoning: "Verify the restoration procedure before deploying this change.",
  conditions: ["Demonstrate a successful restore test."]
};

const reviewRequest = () => new Request("https://cloudcourt.test/api/review", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ provider: "AWS", proposal: "Run a private service with workload identity and a tested rollback procedure." })
});

test("GLM chat-completion responses produce AI reviews and record their provenance", async () => {
  let calls = 0;
  const response = await worker.fetch(reviewRequest(), {
    ...env,
    AI: { run: async (_model, input) => {
      calls += 1;
      assert.equal(input.chat_template_kwargs.enable_thinking, false);
      assert.equal(input.response_format.type, "json_object");
      return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(modelReview) } }] };
    } }
  });
  const body = await response.json();
  assert.equal(calls, 8);
  assert.equal(body.evidence.ai_reviews, 7);
  assert.equal(body.evidence.fallback_reviews, 0);
  assert.equal(body.comparison.single_agent.source, "workers_ai");
  assert.ok(body.reviewers.every(review => review.source === "workers_ai"
    && review.headline === modelReview.headline && review.risk_score === modelReview.risk_score));
  assert.ok(body.events.filter(event => event.kind === "private_vote")
    .every(event => event.payload.source === "workers_ai"));
});

test("legacy Workers AI text responses still produce AI reviews", async () => {
  const response = await worker.fetch(reviewRequest(), {
    ...env, AI: { run: async () => ({ response: JSON.stringify(modelReview) }) }
  });
  const body = await response.json();
  assert.equal(body.evidence.ai_reviews, 7);
});

test("a failed specialist is labelled as fallback without hiding successful reviewers", async () => {
  const response = await worker.fetch(reviewRequest(), {
    ...env, AI: { run: async (_model, input) => {
      if (input.messages[0].content.startsWith("You are the Security member")) throw new Error("Inference unavailable");
      return { choices: [{ message: { content: JSON.stringify(modelReview) } }] };
    } }
  });
  const body = await response.json();
  assert.equal(body.evidence.ai_reviews, 6);
  assert.equal(body.evidence.fallback_reviews, 1);
  const security = body.reviewers.find(review => review.reviewer_id === "security");
  assert.equal(security.source, "fallback");
  assert.equal(security.fallback_reason, "inference_or_format_error");
});

for (const [name, output] of [
  ["incomplete JSON", { choices: [{ message: { content: '{}' } }] }],
  ["truncated completion", { choices: [{ finish_reason: "length", message: { content: JSON.stringify(modelReview) } }] }],
  ["reasoning without an answer", { choices: [{ message: { content: null, reasoning_content: "Still thinking" } }] }]
]) {
  test(`${name} is labelled as fallback rather than AI success`, async () => {
    const response = await worker.fetch(reviewRequest(), { ...env, AI: { run: async () => output } });
    const body = await response.json();
    assert.equal(body.evidence.ai_reviews, 0);
    assert.equal(body.evidence.fallback_reviews, 7);
  });
}

test("specialist hint isolation preserves full evidence and the final policy veto", async () => {
  const proposal = "Deploy an internet-facing SQL database with public access, an embedded plaintext API key, an IAM administrator wildcard policy, and no rollback or monitoring.";
  const inputs = [];
  const response = await worker.fetch(new Request("https://cloudcourt.test/api/review", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "AWS", proposal })
  }), {
    ...env, AI: { run: async (_model, input) => {
      inputs.push(input);
      return { choices: [{ message: { content: JSON.stringify({ ...modelReview, vote: "APPROVE", risk_score: 10 }) } }] };
    } }
  });
  const body = await response.json();
  const payloads = inputs.map(input => JSON.parse(input.messages[1].content));
  assert.equal(payloads.length, 8);
  assert.ok(payloads.every(payload => payload.proposal === proposal));
  const hintIds = payload => payload.policy_hints.map(hint => hint.id);
  assert.deepEqual(hintIds(payloads[0]), body.policy_findings.map(hint => hint.id));
  const finops = inputs.findIndex(input => input.messages[0].content.startsWith("You are the FinOps member"));
  const reliability = inputs.findIndex(input => input.messages[0].content.startsWith("You are the Reliability member"));
  assert.deepEqual(hintIds(payloads[finops]), []);
  assert.deepEqual(hintIds(payloads[reliability]), ["no-rollback", "missing-observability"]);
  assert.ok(body.reviewers.every(review => review.vote === "APPROVE"));
  assert.equal(body.comparison.single_agent.vote, "APPROVE");
  assert.equal(body.council.verdict, "REJECT");
  assert.equal(body.evidence.ai_reviews, 7);
  assert.equal(body.evidence.prompt_version, "specialist-v2");
  assert.equal(body.council.vote_verdict, "APPROVE");
  assert.equal(body.council.policy_veto, true);
  assert.equal(body.council.policy_override, true);
  assert.equal(body.council.decision_source, "policy_gate");
  assert.match(body.council.summary, /Policy gate veto.*public-data.*overrides/);
  assert.equal(body.council.risk_basis.reviewer_average, 10);
  assert.equal(body.council.risk_basis.policy_floor, 92);
  assert.equal(body.council.risk_basis.final_score, 92);
});

test("public ALB beside multi-AZ RDS preserves conditional reviewer votes without a policy floor", async () => {
  const response = await worker.fetch(new Request("https://cloudcourt.test/api/review", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "AWS", proposal: "Migrate a payments API to EKS using IRSA and Secrets Manager, RDS Postgres multi-AZ, public ALB (WAF not configured yet)." })
  }), { ...env, AI: { run: async () => ({ choices: [{ message: { content: JSON.stringify(modelReview) } }] }) } });
  const body = await response.json();
  assert.equal(body.council.verdict, "CONDITIONAL");
  assert.equal(body.council.vote_verdict, "CONDITIONAL");
  assert.equal(body.council.policy_veto, false);
  assert.equal(body.council.policy_override, false);
  assert.equal(body.council.decision_source, "council_vote");
  assert.deepEqual(body.policy_findings, []);
  assert.equal(body.case.risk_score, modelReview.risk_score);
  assert.equal(body.council.risk_basis.policy_floor, 0);
  assert.match(body.council.decision_basis, /reviewer average 63; policy floor 0; final 63/);
});

test("a real public database veto explains the override even when all AI votes are conditional", async () => {
  const response = await worker.fetch(new Request("https://cloudcourt.test/api/review", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "AWS", proposal: "Deploy the payments API with a database that holds customer data. The SQL database is public and permits customer queries." })
  }), { ...env, AI: { run: async () => ({ choices: [{ message: { content: JSON.stringify(modelReview) } }] }) } });
  const body = await response.json();
  assert.equal(body.council.vote_verdict, "CONDITIONAL");
  assert.equal(body.council.verdict, "REJECT");
  assert.equal(body.council.policy_override, true);
  assert.match(body.council.summary, /Policy gate veto.*public-data.*CONDITIONAL.*overrides/);
  const reason = body.council.policy_reasons.find(f => f.id === "public-data");
  assert.equal(reason.evidence, "SQL database is public");
  assert.equal(body.council.risk_basis.policy_floor, 92);
  const finalEvent = body.events.find(event => event.kind === "final_verdict");
  assert.deepEqual(finalEvent.payload.policy_reasons, body.council.policy_reasons);
  assert.equal(finalEvent.payload.policy_override, true);
});

test("baseline and specialists start without waiting for a prior model answer", { timeout: 1000 }, async () => {
  const pending = [];
  const response = await worker.fetch(reviewRequest(), {
    ...env, AI: { run: () => new Promise(resolve => {
      pending.push(resolve);
      if (pending.length === 8) {
        for (const complete of pending) complete({ choices: [{ message: { content: JSON.stringify(modelReview) } }] });
      }
    }) }
  });
  const body = await response.json();
  assert.equal(pending.length, 8);
  assert.equal(body.evidence.ai_reviews, 7);
  assert.equal(body.comparison.single_agent.source, "workers_ai");
});
