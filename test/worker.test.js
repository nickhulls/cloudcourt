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
});
