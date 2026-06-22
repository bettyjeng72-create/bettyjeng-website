/* =============================================================================
   Alora, Netlify Function  ·  netlify/functions/alora.js
   The only place the OpenRouter key lives. The browser never sees it.

   Two stages, one short conversation:
     stage "clarify"  -> reads the intake, asks 2 to 4 targeted follow-ups
     stage "generate" -> reads intake + answers, returns the six-section Blueprint

   Cost posture: calls OpenRouter directly (never Netlify's AI Gateway), defaults
   to the self-healing free router so a retired :free slug can't 404 the tool, and
   leans on OpenRouter's own free daily cap as the ultimate backstop. Zero npm
   dependencies, so it deploys clean with no build step.
   ============================================================================= */

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/* Default to OpenRouter's free router: it auto-picks an available free model and
   filters for structured-output support, which is exactly what our JSON needs.
   One-line swap to a cheap paid model later via the ALORA_MODEL env var
   (e.g. "google/gemini-2.5-flash" or "anthropic/claude-haiku-4-5"). */
const MODEL = process.env.ALORA_MODEL || "openrouter/free";

/* The always-free safety net. If the paid model fails (for example OpenRouter
   credits run dry), Alora silently falls back to this instead of breaking. */
const FREE_MODEL = "openrouter/free";

/* CORS: only your domain may call this. Add localhost for local dev. */
const ALLOWED_ORIGINS = [
  "https://bettyjeng.com",
  "https://www.bettyjeng.com",
  "http://localhost:8888",   // netlify dev
  "http://localhost:3000"
];

/* Server-side input caps (mirror the front-end maxlengths; never trust the client). */
const CAPS = { pain: 1500, flow: 4000, who: 600, constraints: 1200, ctxRole: 200, answer: 1200 };

/* Light per-IP throttle window. Free tier is ~200 req/day, clarify+generate = 2 per
   session, so this is friction control, not the real ceiling. */
const RATE = { max: 14, windowMs: 10 * 60 * 1000 };

/* ------------------------------------------------------------------ helpers */
function cors(origin) {
  const ok = ALLOWED_ORIGINS.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };
}

function reply(statusCode, body, origin) {
  return { statusCode, headers: cors(origin), body: JSON.stringify(body) };
}

function clamp(s, max) {
  return String(s == null ? "" : s).slice(0, max).trim();
}

/* Pull JSON out of a model response even if it wraps it in prose or code fences. */
function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try { return JSON.parse(t); } catch (_) { /* fall through */ }
  const first = t.indexOf("{"), last = t.lastIndexOf("}");
  if (first !== -1 && last > first) {
    try { return JSON.parse(t.slice(first, last + 1)); } catch (_) { /* give up */ }
  }
  return null;
}

/* Best-effort per-IP throttle via Netlify Blobs. If Blobs is unavailable for any
   reason, we skip silently rather than fail the request. */
async function throttled(ip) {
  if (!ip) return false;
  try {
    const { getStore } = await import("@netlify/blobs");
    const store = getStore("alora-rate");
    const key = "ip:" + ip;
    const now = Date.now();
    const prev = (await store.get(key, { type: "json" })) || [];
    const recent = prev.filter((t) => now - t < RATE.windowMs);
    if (recent.length >= RATE.max) return true;
    recent.push(now);
    await store.setJSON(key, recent);
    return false;
  } catch (_) {
    return false; // degrade open: rely on honeypot + input caps + free daily cap
  }
}

/* Normalize the raw intake into a compact, model-friendly brief. */
function buildBrief(intake) {
  const goalMode = intake.mode === "goal";
  const lines = [];
  lines.push((goalMode ? "GOAL (no workflow yet): " : "PAIN POINT: ") + clamp(intake.pain, CAPS.pain));
  if (!goalMode && intake.flow) lines.push("CURRENT WORKFLOW (step by step):\n" + clamp(intake.flow, CAPS.flow));
  if (intake.who) lines.push("WHO'S INVOLVED: " + clamp(intake.who, CAPS.who));
  if (intake.constraints) lines.push("CONSTRAINTS: " + clamp(intake.constraints, CAPS.constraints));

  const ctx = [];
  if (intake.ctxTeam) ctx.push("Team/group: " + clamp(intake.ctxTeam, 120));
  if (intake.ctxRole) ctx.push("Role: " + clamp(intake.ctxRole, CAPS.ctxRole));
  if (intake.ctxDeploy) ctx.push("Deployment level: " + clamp(intake.ctxDeploy, 40));
  if (intake.ctxUsers) ctx.push("Users impacted: " + clamp(intake.ctxUsers, 40));
  if (intake.ctxIndustry) ctx.push("Industry: " + clamp(intake.ctxIndustry, 60));
  if (ctx.length) lines.push("CONTEXT: " + ctx.join(" · "));

  return { brief: lines.join("\n\n"), goalMode };
}

/* Shared voice + guardrails for both stages. */
const BRAND = `
Voice: warm, plain-spoken, human-first, practical. You are a change and AI-adoption
strategist, not a hype machine. AI augments people; it is a mirror of our best human
ideals, never a threat to wave around. No fear-mongering, no buzzword soup.
Hard rule: never use em dashes. Use commas, periods, or "to" for ranges.
Method: grounded in Adaptive Engagement Change Management (Hear, Trust, Co-create, Own)
but agnostic and multidisciplinary, pulling from behavioral science, psychology, and
negotiation as useful. Never name-drop frameworks at the user.`;

/* ------------------------------------------------------- stage: CLARIFY */
function clarifyMessages(brief, goalMode) {
  const sys = `You are Alora, diagnosing a workflow before prescribing a fix.
${BRAND}

Your job in THIS step: read the intake and ask 2 to 4 sharp follow-up questions that
fill the gaps most likely to change the diagnosis. Do not solve anything yet.

Hunt for the gaps that usually hide the real root cause, such as:
- Was using the AI tool encouraged, required, or tied to reviews? (adoption vs. mandate)
- Is the AI bolted on beside the work, or built into the workflow?
- Does the described "current workflow" even include the AI step, or only the old manual one?
- How does leadership actually define success or ROI here, and was a baseline ever captured?
- Is there any reinforcement, training, or feedback loop, or was it ship-and-forget?
- Is any bottleneck a person, a policy, or a system outside the team's control?
${goalMode ? "- Since there is no workflow yet, ask what the current manual process looks like and what a good outcome would feel like." : ""}

Rules:
- Pick only the questions that matter for THIS intake. Skip what is already answered.
- Each question must be answerable by a non-specialist in a sentence or two. No jargon.
- Warm and curious, never an interrogation.

Return ONLY valid JSON, no prose, no code fences, in exactly this shape:
{"questions":[{"id":"q1","question":"...","why":"one short line on why you're asking"}]}`;
  return [
    { role: "system", content: sys },
    { role: "user", content: brief }
  ];
}

/* ------------------------------------------------------- stage: GENERATE */
function generateMessages(brief, goalMode, qa) {
  const answered = (qa || []).filter((x) => x && x.answer && String(x.answer).trim());
  const skipped = (qa || []).filter((x) => x && x.question && !(x.answer && String(x.answer).trim()));

  const qaBlock = answered.length
    ? "FOLLOW-UP ANSWERS:\n" + answered.map((x) => "Q: " + clamp(x.question, 300) + "\nA: " + clamp(x.answer, CAPS.answer)).join("\n\n")
    : "FOLLOW-UP ANSWERS: (the user skipped the follow-ups)";

  const skippedBlock = skipped.length
    ? "\n\nUNANSWERED (state any assumption you make to fill these):\n" + skipped.map((x) => "- " + clamp(x.question, 300)).join("\n")
    : "";

  const sys = `You are Alora. Turn the intake (and any answers) into an Insight-to-Action Blueprint.
${BRAND}

Think it through internally first: name the real root cause (process, tool, skill, or
people, often a blend), redraw the workflow lean, and make sure the redrawn workflow
SHOWS the AI step rather than describing only the old manual process. Decide honestly
where AI should automate, where it should assist a human, and where to keep it fully human.
${goalMode ? "There is no existing workflow, so propose a sensible starting workflow as the 'before', then the leaner version as the 'after'." : ""}

Transparency rule: when an answer is missing, do not pretend to know. Make a reasonable,
clearly-labeled assumption and list it in "assumptions". If nothing material is missing,
return an empty assumptions array.

Return ONLY valid JSON, no prose, no code fences, in EXACTLY this shape:
{
  "initiative": "short label, 3 to 6 words",
  "assumptions": ["plain-language assumption you had to make", "..."],
  "diagnosis": { "rootType": "Process|Tool|Skill|People", "secondaryType": "optional or empty", "summary": "2 to 3 sentences on the real root, not the symptom" },
  "workflow": {
    "before": ["step", "step"],
    "after": ["step that includes the AI where it fits", "step"],
    "changes": [{ "change": "what changed", "why": "the payoff" }]
  },
  "fixes": [{ "fix": "a concrete move", "effort": "Low|Medium|High", "impact": "Low|Medium|High", "bucket": "Quick win|Bigger bet" }],
  "aiFit": [{ "step": "a step in the flow", "verdict": "Automate|Human-AI assist|Keep human", "why": "one line" }],
  "humanAngle": [{ "group": "a group this touches", "worry": "their honest fear", "wiifm": "what's genuinely in it for them", "move": "the change-management move that earns trust" }],
  "checklist": [{ "action": "a next step", "owner": "a role", "when": "This week|Week 2|etc." }]
}

Aim for: 1 to 2 assumptions only when needed, 3 to 5 fixes, 3 to 4 aiFit rows,
2 to 3 humanAngle groups, 4 to 6 checklist items, quick wins first.`;

  return [
    { role: "system", content: sys },
    { role: "user", content: brief + "\n\n" + qaBlock + skippedBlock }
  ];
}

/* ------------------------------------------------------- OpenRouter call */
async function callModel(messages, maxTokens, retryHint, model) {
  const msgs = retryHint
    ? messages.concat({ role: "user", content: "Your last reply was not valid JSON. Return ONLY the JSON object, nothing else." })
    : messages;

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + process.env.OPENROUTER_API_KEY,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://bettyjeng.com",
      "X-Title": "Alora"
    },
    body: JSON.stringify({
      model: model,
      messages: msgs,
      temperature: 0.45,
      max_tokens: maxTokens
    })
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const err = new Error("OpenRouter " + res.status);
    err.status = res.status;
    err.detail = detail.slice(0, 300);
    throw err;
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "";
}

/* Call one model, parse, and retry once if the JSON doesn't come back clean. */
async function callForJson(messages, maxTokens, model) {
  let raw = await callModel(messages, maxTokens, false, model);
  let parsed = extractJson(raw);
  if (!parsed) {
    raw = await callModel(messages, maxTokens, true, model);
    parsed = extractJson(raw);
  }
  return parsed;
}

/* Try the configured model first. If it errors (credits dry, provider down) or
   returns nothing usable, fall back to the free router so Alora keeps working. */
async function generateJson(messages, maxTokens) {
  try {
    const out = await callForJson(messages, maxTokens, MODEL);
    if (out) return out;
    if (MODEL !== FREE_MODEL) return await callForJson(messages, maxTokens, FREE_MODEL);
    return out;
  } catch (err) {
    if (MODEL !== FREE_MODEL) {
      console.error("alora primary model failed, falling back to free:", err.status || "", err.message || "");
      return await callForJson(messages, maxTokens, FREE_MODEL);
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ handler */
exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin || "";

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors(origin), body: "" };
  if (event.httpMethod !== "POST") return reply(405, { error: "Method not allowed" }, origin);
  if (!process.env.OPENROUTER_API_KEY) return reply(500, { error: "Server is missing its model key." }, origin);

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch (_) { return reply(400, { error: "Bad request." }, origin); }

  // Honeypot: a hidden field no human fills. If present, pretend success and stop.
  if (body.website) return reply(200, { questions: [] }, origin);

  const ip = event.headers?.["x-nf-client-connection-ip"] || event.headers?.["client-ip"] || "";
  if (await throttled(ip)) {
    return reply(429, { error: "You're going fast. Give it a minute and try again." }, origin);
  }

  const stage = body.stage;
  const intake = body.intake || {};
  if (!intake.pain || !String(intake.pain).trim()) {
    return reply(400, { error: "Tell Alora what's not working first." }, origin);
  }
  const { brief, goalMode } = buildBrief(intake);

  try {
    if (stage === "clarify") {
      const out = await generateJson(clarifyMessages(brief, goalMode), 700);
      const questions = Array.isArray(out?.questions) ? out.questions.slice(0, 4) : [];
      return reply(200, { questions }, origin);
    }

    if (stage === "generate") {
      const out = await generateJson(generateMessages(brief, goalMode, body.qa), 2200);
      if (!out || !out.diagnosis) {
        return reply(502, { error: "Alora couldn't shape a clean Blueprint that time. Please try again." }, origin);
      }
      return reply(200, { blueprint: out }, origin);
    }

    return reply(400, { error: "Unknown stage." }, origin);
  } catch (err) {
    // Never log the key or the user's raw input. Log only a terse marker.
    console.error("alora stage=" + stage + " failed:", err.status || "", err.message || "");
    const msg = err.status === 429
      ? "The free model is busy right now. Try again in a moment."
      : "Something hiccuped reaching the model. Please try again.";
    return reply(502, { error: msg }, origin);
  }
};
