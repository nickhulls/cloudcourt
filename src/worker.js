import {
  REVIEWERS,
  deterministicChecks,
  policyVerdict,
  aggregateRisk,
  normalizeReview,
  fallbackReview
} from "./core.js";

const MODEL = "@cf/zai-org/glm-4.7-flash";

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  }
});

function extractJSON(output) {
  const result = output?.result ?? output;
  const choice = result?.choices?.[0];
  if (choice?.finish_reason === "length") throw new Error("Model response was truncated");
  const content = choice?.message?.content;
  const text = typeof result === "string" ? result
    : result?.response || (Array.isArray(content)
      ? content.filter(part => part.type === "text").map(part => part.text).join("")
      : content) || "";
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Model did not return JSON");
  const review = JSON.parse(match[0]);
  if (!["APPROVE", "CONDITIONAL", "REJECT"].includes(review?.vote)
    || !Number.isFinite(review.risk_score) || !Number.isFinite(review.confidence)
    || typeof review.headline !== "string" || !review.headline.trim()
    || typeof review.reasoning !== "string" || !review.reasoning.trim()
    || !Array.isArray(review.conditions) || !review.conditions.every(item => typeof item === "string")) {
    throw new Error("Model returned an incomplete review");
  }
  return review;
}

async function askReviewer(env, reviewer, proposal, provider, findings) {
  const fallback = reason => ({ ...fallbackReview(reviewer, findings), source: "fallback", fallback_reason: reason });
  if (!env.AI) return fallback("ai_unavailable");
  const system = `You are the ${reviewer.name} member of CloudCourt, an independent cloud architecture review council. Your exclusive mandate is ${reviewer.focus}. Review evidence skeptically. Do not invent missing controls. Return only strict JSON with keys vote (APPROVE, CONDITIONAL, or REJECT), risk_score (0-100), headline, reasoning, conditions (array of at most 4 concise strings), confidence (0-100).`;
  const user = `Cloud provider: ${provider}\n\nProposed change:\n${proposal}\n\nDeterministic policy findings:\n${JSON.stringify(findings)}\n\nCast an independent vote before seeing any other reviewer.`;
  try {
    const response = await env.AI.run(MODEL, {
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      max_completion_tokens: 1200,
      chat_template_kwargs: { enable_thinking: false },
      response_format: { type: "json_object" },
      temperature: 0.2
    });
    return { ...normalizeReview(extractJSON(response), reviewer), source: "workers_ai" };
  } catch (error) {
    console.warn(`Reviewer ${reviewer.id} fell back:`, error?.message);
    return fallback("inference_or_format_error");
  }
}

function deterministicChair(reviews, findings) {
  const policy = policyVerdict(findings);
  const rejected = reviews.filter((review) => review.vote === "REJECT").length;
  const conditional = reviews.filter((review) => review.vote === "CONDITIONAL").length;
  const verdict = policy === "REJECT" || rejected >= 2
    ? "REJECT"
    : policy === "CONDITIONAL" || conditional >= 2 || rejected === 1
      ? "CONDITIONAL"
      : "APPROVE";
  const blockers = findings.map((finding) => finding.fix);
  for (const review of reviews) {
    for (const condition of review.conditions) {
      if (!blockers.includes(condition)) blockers.push(condition);
    }
  }
  return {
    verdict,
    summary: verdict === "REJECT"
      ? "The proposed change exceeds the council's production risk threshold."
      : verdict === "CONDITIONAL"
        ? "The change may proceed only after the listed controls are verified."
        : "The council found no blocking risk in the submitted evidence.",
    blockers: blockers.slice(0, 6),
    dissent: reviews.filter((review) => review.vote !== verdict).map((review) => reviewerDissent(review)),
    decision_basis: `Policy gate: ${policy}. Council vote: ${reviews.filter(r => r.vote === "APPROVE").length} approve, ${conditional} conditional, ${rejected} reject.`
  };
}

const reviewerDissent = (review) => `${review.reviewer}: ${review.vote} - ${review.headline}`;

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function buildEvents(caseId, proposal, reviews, findings, chair) {
  const createdAt = new Date().toISOString();
  const definitions = [
    { kind: "case_submitted", actor: "Clerk", payload: { excerpt: proposal.slice(0, 500) } },
    { kind: "policy_scan", actor: "Policy Gate", payload: { findings, verdict: policyVerdict(findings) } },
    ...reviews.map((review) => ({ kind: "private_vote", actor: review.reviewer, payload: review })),
    { kind: "final_verdict", actor: "Council Chair", payload: chair }
  ];
  let previousHash = "GENESIS";
  const events = [];
  for (let seq = 0; seq < definitions.length; seq += 1) {
    const definition = definitions[seq];
    const payload = JSON.stringify(definition.payload);
    const eventHash = await sha256(`${caseId}|${seq}|${definition.kind}|${definition.actor}|${payload}|${previousHash}`);
    events.push({
      id: crypto.randomUUID(), case_id: caseId, seq, ...definition,
      previous_hash: previousHash, event_hash: eventHash, created_at: createdAt
    });
    previousHash = eventHash;
  }
  return events;
}

async function persist(env, record, events) {
  if (!env.DB) return false;
  try {
    const statements = [
      env.DB.prepare("INSERT INTO cases (id, title, provider, change_text, verdict, risk_score, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(record.id, record.title, record.provider, record.change_text, record.verdict, record.risk_score, record.created_at),
      ...events.map((event) => env.DB.prepare("INSERT INTO events (id, case_id, seq, kind, actor, payload, previous_hash, event_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(event.id, event.case_id, event.seq, event.kind, event.actor, JSON.stringify(event.payload), event.previous_hash, event.event_hash, event.created_at))
    ];
    await env.DB.batch(statements);
    return true;
  } catch (error) {
    console.warn("D1 persistence unavailable:", error?.message);
    return false;
  }
}

async function review(request, env) {
  let input;
  try { input = await request.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const proposal = String(input?.proposal || "").trim();
  const title = String(input?.title || "Architecture change review").trim().slice(0, 120);
  const provider = ["AWS", "Azure", "GCP", "Multi-cloud", "Cloudflare"].includes(input?.provider) ? input.provider : "Multi-cloud";
  if (proposal.length < 40) return json({ error: "Describe the proposed change in at least 40 characters." }, 400);
  if (proposal.length > 6000) return json({ error: "Proposal must be 6,000 characters or fewer." }, 400);

  const started = Date.now();
  const findings = deterministicChecks(proposal);
  const singleReviewer = await askReviewer(env, REVIEWERS[6], proposal, provider, findings);
  const reviews = await Promise.all(REVIEWERS.map((reviewer) => askReviewer(env, reviewer, proposal, provider, findings)));
  const chair = deterministicChair(reviews, findings);
  const riskScore = aggregateRisk(reviews, findings);
  const caseId = crypto.randomUUID();
  const events = await buildEvents(caseId, proposal, reviews, findings, chair);
  const record = {
    id: caseId,
    title,
    provider,
    change_text: proposal,
    verdict: chair.verdict,
    risk_score: riskScore,
    created_at: new Date().toISOString()
  };
  const persisted = await persist(env, record, events);
  return json({
    case: record,
    reviewers: reviews,
    policy_findings: findings,
    council: chair,
    comparison: {
      single_agent: { vote: singleReviewer.vote, risk_score: singleReviewer.risk_score, headline: singleReviewer.headline, source: singleReviewer.source },
      council: { vote: chair.verdict, risk_score: riskScore },
      changed: singleReviewer.vote !== chair.verdict
    },
    events,
    evidence: {
      persisted, chain_head: events.at(-1)?.event_hash, model: MODEL, latency_ms: Date.now() - started,
      ai_reviews: reviews.filter(review => review.source === "workers_ai").length,
      fallback_reviews: reviews.filter(review => review.source === "fallback").length
    }
  });
}

async function getCase(env, id) {
  if (!env.DB) return json({ error: "Database unavailable" }, 503);
  const record = await env.DB.prepare("SELECT * FROM cases WHERE id = ?").bind(id).first();
  if (!record) return json({ error: "Case not found" }, 404);
  const { results } = await env.DB.prepare("SELECT * FROM events WHERE case_id = ? ORDER BY seq").bind(id).all();
  return json({ case: record, events: results.map((event) => ({ ...event, payload: JSON.parse(event.payload) })) });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/api/health") {
      return json({ status: "ok", service: "cloudcourt", ai: Boolean(env.AI), database: Boolean(env.DB), model: MODEL });
    }
    if (request.method === "POST" && url.pathname === "/api/review") return review(request, env);
    const match = request.method === "GET" && url.pathname.match(/^\/api\/cases\/([a-f0-9-]+)$/i);
    if (match) return getCase(env, match[1]);
    if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
    return env.ASSETS.fetch(request);
  }
};
