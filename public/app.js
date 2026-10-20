const form = document.querySelector("#review-form");
const proposal = document.querySelector("#proposal");
const count = document.querySelector("#character-count");
const progress = document.querySelector("#progress");
const results = document.querySelector("#results");
const progressBar = document.querySelector("#progress-bar");
const progressLabel = document.querySelector("#progress-label");
const progressPercent = document.querySelector("#progress-percent");
const agentProgress = document.querySelector("#progress-agents");
const reviewerNames = ["Security", "Identity", "Network", "Reliability", "FinOps", "Compliance", "Platform"];
const riskyDemo = `We plan to release a customer-facing payment API on AWS. The Application Load Balancer accepts traffic from 0.0.0.0/0 and forwards to containers in public subnets. The service uses an IAM administrator wildcard policy so deployment is faster. A static API key is embedded in the container environment. Transaction exports are written to a publicly accessible S3 bucket without encryption. To meet the launch date, we will deploy without rollback and skip monitoring for the first week.`;

proposal.addEventListener("input", () => { count.textContent = `${proposal.value.length.toLocaleString()} / 6,000`; });
document.querySelector("#load-demo").addEventListener("click", () => {
  proposal.value = riskyDemo;
  count.textContent = `${proposal.value.length.toLocaleString()} / 6,000`;
  document.querySelector("#review").scrollIntoView({ behavior: "smooth" });
});

function setProgress(value, label) {
  progressBar.style.width = `${value}%`;
  progressPercent.textContent = `${String(value).padStart(2, "0")}%`;
  progressLabel.textContent = label;
  [...agentProgress.children].forEach((node, index) => node.classList.toggle("active", value >= 18 + index * 8));
}

function startProgress() {
  agentProgress.innerHTML = reviewerNames.map((name) => `<span>${name}</span>`).join("");
  progress.classList.remove("hidden");
  results.classList.add("hidden");
  const steps = [[8,"Clerk is preparing the case..."],[18,"Policy gate is scanning controls..."],[37,"Reviewers are reading independently..."],[62,"Private votes are being filed..."],[79,"Council chair is weighing dissent..."],[91,"Evidence chain is being sealed..."]];
  let index = 0;
  setProgress(...steps[0]);
  return setInterval(() => { index = Math.min(index + 1, steps.length - 1); setProgress(...steps[index]); }, 850);
}

const escapeHTML = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[char]));

function render(data) {
  document.querySelector("#result-title").textContent = data.case.title;
  const stamp = document.querySelector("#verdict-stamp");
  stamp.textContent = data.council.verdict;
  stamp.className = `verdict-stamp ${data.council.verdict.toLowerCase()}`;
  document.querySelector("#risk-score").textContent = data.case.risk_score;
  document.querySelector("#risk-meter").style.width = `${data.case.risk_score}%`;
  document.querySelector("#decision-basis").textContent = data.council.decision_basis;
  document.querySelector("#council-summary").textContent = data.council.summary;
  document.querySelector("#blockers").innerHTML = data.council.blockers.length
    ? data.council.blockers.map((item) => `<li>${escapeHTML(item)}</li>`).join("")
    : "<li>No blocking condition identified in the submitted evidence.</li>";
  document.querySelector("#single-vote").textContent = data.comparison.single_agent.vote;
  document.querySelector("#single-risk").textContent = `${data.comparison.single_agent.risk_score}/100`;
  document.querySelector("#council-vote").textContent = data.comparison.council.vote;
  document.querySelector("#council-risk").textContent = `${data.comparison.council.risk_score}/100`;
  document.querySelector("#comparison-note").textContent = data.comparison.changed
    ? "The council changed the single architecture reviewer's initial decision."
    : "The council preserved the single reviewer's decision; compare the risk score and reasoning depth.";
  document.querySelector("#reviewer-grid").innerHTML = data.reviewers.map((review) => `
    <article class="reviewer-card">
      <div class="reviewer-top"><span class="reviewer-avatar" style="color:${escapeHTML(review.color)}">${escapeHTML(review.initials)}</span><div><h4>${escapeHTML(review.reviewer)}</h4><small>CONFIDENCE ${escapeHTML(review.confidence)}%</small></div></div>
      <span class="reviewer-score">RISK ${escapeHTML(review.risk_score)}</span>
      <span class="vote ${escapeHTML(review.vote)}">${escapeHTML(review.vote)}</span>
      <h5>${escapeHTML(review.headline)}</h5>
      <p>${escapeHTML(review.reasoning)}</p>
    </article>`).join("");
  document.querySelector("#timeline").innerHTML = data.events.map((event) => `
    <div class="event"><span class="event-seq">${String(event.seq).padStart(2,"0")}</span><span class="event-kind">${escapeHTML(event.kind).toUpperCase()}</span><div><div class="event-actor">${escapeHTML(event.actor)}</div><div class="event-hash">${escapeHTML(event.event_hash)}</div></div></div>`).join("");
  document.querySelector("#chain-hash").textContent = data.evidence.chain_head;
  const copyButton = document.querySelector("#copy-link");
  copyButton.dataset.caseId = data.case.id;
  copyButton.textContent = data.evidence.persisted ? "COPY CASE LINK" : "COPY CASE ID";
  progress.classList.add("hidden");
  results.classList.remove("hidden");
  results.scrollIntoView({ behavior: "smooth", block: "start" });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = form.querySelector("button[type=submit]");
  submit.disabled = true;
  const timer = startProgress();
  try {
    const response = await fetch("/api/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: form.title.value, provider: form.provider.value, proposal: proposal.value })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "The council could not complete this review.");
    clearInterval(timer);
    setProgress(100, "Verdict sealed.");
    setTimeout(() => render(data), 250);
  } catch (error) {
    clearInterval(timer);
    progress.classList.add("hidden");
    alert(error.message);
  } finally { submit.disabled = false; }
});

document.querySelector("#copy-link").addEventListener("click", async (event) => {
  const id = event.currentTarget.dataset.caseId;
  const value = event.currentTarget.textContent.includes("LINK") ? `${location.origin}/api/cases/${id}` : id;
  await navigator.clipboard.writeText(value);
  event.currentTarget.textContent = "COPIED";
  setTimeout(() => { event.currentTarget.textContent = value.includes("http") ? "COPY CASE LINK" : "COPY CASE ID"; }, 1500);
});
