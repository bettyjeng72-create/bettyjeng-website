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

/* Pull JSON out of a model response even if it wraps it in prose or code fences,
   has trailing commas, or got cut off before it finished (truncation repair). */
function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();

  const tryParse = (s) => { try { return JSON.parse(s); } catch (_) { return undefined; } };
  const declutter = (s) => s.replace(/,(\s*[}\]])/g, "$1"); // drop trailing commas

  let v = tryParse(t); if (v !== undefined) return v;

  const first = t.indexOf("{"), last = t.lastIndexOf("}");
  if (first !== -1 && last > first) {
    const sliced = t.slice(first, last + 1);
    v = tryParse(sliced); if (v !== undefined) return v;
    v = tryParse(declutter(sliced)); if (v !== undefined) return v;
  }

  // Truncation repair: model got cut off, so trim any dangling tail, then close
  // open strings, arrays, and objects. Better a partial Blueprint than none.
  if (first !== -1) {
    let body = t.slice(first);
    const closeAndParse = (s) => {
      let inStr = false, esc = false; const stack = [];
      for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; }
        else { if (c === '"') inStr = true; else if (c === "{" || c === "[") stack.push(c); else if (c === "}" || c === "]") stack.pop(); }
      }
      let r = s;
      if (inStr) r += '"';
      for (let i = stack.length - 1; i >= 0; i--) r += stack[i] === "{" ? "}" : "]";
      return tryParse(declutter(r));
    };

    for (let attempt = 0; attempt < 6; attempt++) {
      const v2 = closeAndParse(body);
      if (v2 !== undefined) return v2;
      // Strip the broken tail and try again: a trailing comma, a dangling
      // "key": with no value, or a half-written final key.
      const trimmed = body
        .replace(/\s+$/, "")
        .replace(/,\s*$/, "")
        .replace(/,?\s*"[^"]*"\s*:\s*$/, "")
        .replace(/,?\s*"[^"]*$/, "");
      if (trimmed === body) break;
      body = trimmed;
    }
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

/* Shared role-classification rule. Used wherever we group affected people, so the
   Human Angle and the Augmentation Map treat roles the same way. */
const ROLES = `
Role logic, be precise about how each role actually relates to this workflow:
- Doers: the people who perform the workflow day to day. They carry the biggest change.
- Direct leaders: the people who manage, coach, or review the doers daily. They own
  standards, performance, and coaching.
- Downstream internal: colleagues who receive the output later, for example account
  managers or customer success. They care about quality and handoffs, but they do NOT
  manage or coach the doers.
- External: partners, customers, vendors. They are influenced by the outcome, usually
  have no access to internal systems, and have no role in performance or coaching.

Rules:
- NEVER merge roles from different categories into one group. A direct manager and a
  downstream colleague have different fears, different stakes, and different moves, so
  they never share a card or a heading.
- Do not attribute an action to a role that could not do it. Only doers and direct leaders
  take part in daily coaching, performance reviews, or quality audits of the doers'
  work. External parties do not see internal records, do not attend internal reviews,
  and do not coach staff.
- Name each group as the specific role, not a bundle. Prefer "Account managers" over
  "downstream users (CSMs, partners)". If two roles genuinely share the same relationship,
  stake, and moves, you may name them together, otherwise pick the one that fits.
- Focus on the roles most directly affected by this workflow. Leave out roles whose
  involvement is incidental, rather than inventing a stake for them.
- If the user lists roles without saying what each does, infer their relationship from the
  workflow itself, and do not treat an external party as an internal one.`;

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
- Ask about concrete facts and specifics, not feelings or hypotheticals. Do not ask
  "does it feel slower" or "does anything break." Ask plainly, for example "does the AI
  summary save into the CRM automatically, or does a rep have to submit it manually."
- Never presuppose a problem the user did not describe. If you are probing a possible
  cause, ask about the fact, not the imagined symptom.
- Keep each question to one clear sentence. Warm and curious, never an interrogation.
- The industry or context should sharpen your questions, never make them vaguer or odder.

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
${ROLES}

Think it through internally first: name the real root cause (process, tool, skill, or
people, often a blend), redraw the workflow lean, and make sure the redrawn workflow
SHOWS the AI step rather than describing only the old manual process. Decide honestly
where AI should automate, where it should assist a human, and where to keep it fully human.

Verdict definitions, use them precisely:
- Automate: the system does this step with NO human action. Examples: the tool records the
  call on its own, the summary posts to the CRM automatically. A step where a person clicks,
  types, chooses, reviews, or approves is NOT Automate.
- Human-AI assist: the person and AI work together, for example AI drafts and the person
  edits or approves.
- Keep human: human judgment, empathy, or the relationship carries the step.

Consistency rule, this matters a lot: the after workflow, the fixes, and the aiFit verdicts
must tell ONE coherent story. If your recommendation is to make a tool on by default so no
one has to remember it, then in the after workflow describe it starting automatically, not
as "the rep clicks start," and label that automatic start as Automate. Never keep a manual
click in the workflow and also call it Automate. A required manual step is a behavioral
change with some friction, not automation, so name it honestly rather than dressing it up
as automated. Do not describe the same step as manual in one section and automated in
another.

FINAL CONSISTENCY AUDIT, run this on your draft before you return it, and fix anything
that fails:
1. Does every assumption survive a re-read of the intake? Delete any that the intake or
   answers already answer.
2. Does the after workflow contradict any fix, verdict, or assumption? If a step is
   automatic in one place, it must be automatic everywhere.
3. Is any step labeled Automate that still requires a person to click, type, choose,
   review, or approve? If so, relabel it honestly.
4. Does any fix, move, or checklist item depend on an artifact the new workflow no longer
   produces (for example a manual summary that no longer gets written)? If so, either stage
   it explicitly (a short pilot, or a comparison against historical data) or replace it.
5. Does any move tell people to do something the new workflow already does for them?
   If so, cut it.
6. Would any move require two versions of something the workflow only produces once, or
   two people where there is only one? If so, rewrite it so it is possible in real life.
7. Is any group a bundle of roles with different relationships to the workflow (for example
   a direct manager lumped with downstream colleagues or external partners)? If so, split
   it and keep only the roles that genuinely share that stake.
8. Does any group get assigned an action it could not perform, such as an external partner
   coaching staff or reviewing internal records? If so, fix or remove it.
Return only the corrected Blueprint. Silent, internal audit; do not mention it in output.
${goalMode ? "There is no existing workflow, so propose a sensible starting workflow as the 'before', then the leaner version as the 'after'." : ""}

Fidelity rule for the "before" steps: stay faithful to what the user actually wrote.
Keep their meaning and their own words where you can, lightly cleaned up. Do not
reinterpret or guess a step's purpose. For example, if they say a tool is opened "to
help with research," do not restate it as "to check work"; those mean different things.
When unsure what a step is for, describe it plainly rather than inventing intent.

Transparency rule: when an answer is missing, do not pretend to know. Make a reasonable,
clearly-labeled assumption and list it in "assumptions". If nothing material is missing,
return an empty assumptions array.

Assumption discipline, this is where most errors start:
- NEVER "assume" something the intake or the answers already state. If the workflow says
  the rep clicks a button, that is a stated fact, not an assumption. Re-check the intake
  before you write any assumption, and delete any that is already answered.
- Assume only what you genuinely need and cannot know, and keep it to what changes the advice.
- Once you state an assumption, every later section must obey it. Do not contradict your
  own assumptions.

Role realism, check every move against how the job actually works:
- Picture the real person doing the real task before you recommend anything. One rep runs
  one call and produces ONE record of it, so they either use the AI summary or write their
  own, never both for the same call. Do not propose comparing two versions of the same
  event that only one person could have produced.
- The same applies generally: never suggest a comparison, demo, or exercise that would
  require two people, two systems, or two outputs where the workflow only ever creates one.
  If a comparison is genuinely useful, ground it in something real, for example a rep's
  earlier manual summaries from before the change, a deliberate side-by-side during a short
  pilot, or one rep's AI summary next to a different rep's manual one.
- Respect the rhythm of the role. Do not add steps a busy person plausibly would not do.

Availability rule, do not invent data or artifacts that will not exist:
- Only recommend comparing, measuring, or reviewing things that the new workflow actually
  produces. If AI summaries become the default, then reps will no longer be writing manual
  summaries, so a "compare the AI summary to the rep's manual summary on the same call"
  move is impossible unless you explicitly stage it (for example, a short pilot where a few
  reps intentionally write both, or a comparison against historical summaries from before
  the change). If a move needs a baseline that does not exist, say how to create it.
- Never suggest a habit-change nudge for a behavior the new workflow has already removed.
  If the AI summary is the default starting point, do not advise reps to "start from the AI
  summary," because that is already how it works.

Context discipline: the industry, team, and role are light context. Use them to choose
plain, relevant examples and language, never to invent facts, constraints, or workflow
steps the user did not describe. The workflow logic must come from what the user actually
wrote, not from what you assume is typical for that industry. A change in industry should
never change the underlying diagnosis of the same workflow.

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

Aim for: 0 to 2 assumptions, exactly 3 fixes, exactly 3 aiFit rows, exactly 2
humanAngle groups, 4 checklist items, before and after at most 6 steps each,
changes at most 3, quick wins first.
Keep every string to ONE short sentence. Be sharp and concrete, never wordy.
Critical: you have limited space. A complete, concise Blueprint that closes its
JSON cleanly is far better than a detailed one that gets cut off. Finish every
section and close the JSON.`;

  return [
    { role: "system", content: sys },
    { role: "user", content: brief + "\n\n" + qaBlock + skippedBlock }
  ];
}

/* ------------------------------------------------- stage: METRICS (go deeper) */
function metricsMessages(brief, bpSummary) {
  const sys = `You are Alora, adding a success-measurement layer to a Blueprint you already produced.
${BRAND}

The user is under pressure to prove ROI, and the danger is that "ROI" shrinks to speed
alone. Efficiency-only scorekeeping is the exact logic that turns AI adoption into
layoffs. Your job is a fuller, honest 360 view of success so the human gains stay visible.

Think it through internally first: for THIS workflow and these roles, what would real
success look like beyond time saved? Cover more than one lens, and always include at
least one Human-capability metric and one Quality metric, so success is never measured
on speed alone.

The five lenses:
- Efficiency: time, throughput, effort saved.
- Quality: accuracy, rework, consistency, customer outcomes.
- Human: capability built, confidence, higher-value work, engagement, retention.
- Adoption: real usage, voluntary use, trust in the output.
- Business: downstream customer, revenue-relevant, or risk signals.

On value and numbers, this is a hard rule. You are NOT a calculator, and a wrong number in
a leadership deck destroys the user's credibility. So:
- NEVER assert a computed total: no total dollars saved, no team-wide hours per year, no
  annual figures. Do not multiply out across a team. Do not invent a labor rate.
- DO give the per-unit saving or gain you can honestly ground in the workflow, for example
  "8 to 12 minutes per call" or "2 to 3 hours per rep per week". Per-unit is safe; totals
  are not.
- Then hand the reader the multiplication in "howToSize" so they can size it with their own
  numbers, for example "multiply the hours reclaimed per rep per week by your rep count, by
  your working weeks, by your blended hourly rate".
- For non-time metrics, express value qualitatively and directionally (retention, customer
  experience, risk reduced, capability built), still with no fabricated figures.
- Every value line is directional, not a quote.

Return ONLY valid JSON, no prose, no code fences, in exactly this shape:
{
  "framing": "one plain sentence reframing success as more than speed",
  "metrics": [
    { "metric": "fuller descriptive line for the card",
      "shortName": "2 to 4 words, Title Case, dashboard-ready label, under ~24 characters",
      "lens": "Efficiency|Quality|Human|Adoption|Business",
      "definition": "one plain sentence: what this metric is and how to read it, no formula",
      "why": "one line on why it matters for THIS workflow",
      "value": "the durable value this drives, stated per unit or qualitatively, NEVER as a computed total or dollar figure",
      "howToSize": "the do-this-math line, naming the inputs the reader plugs in, so they can ballpark it themselves",
      "good": "what a good result looks like, in plain words, no formula",
      "signal": "Leading|Lagging" }
  ],
  "estimateNote": "one sentence reminding the reader these are directional estimates, not quotes, and that they should plug in their own rates and volumes"
}

Give 4 to 5 metrics spread across at least three lenses, with Human and Quality both
represented. shortName is a crisp chip label (e.g. "Selling Time Reclaimed"); metric is
the fuller line. Length caps, keep to these so every card renders at the same size:
metric under 15 words, definition under 25 words, why under 22 words, value under 22 words,
howToSize under 28 words, good under 22 words. One sentence each. Remember: value is
per-unit or qualitative only, never a computed total or dollar figure. Ground each metric
in the specific workflow, not generic KPIs. Do not include cadence or baselines. Finish and
close the JSON cleanly; a complete, concise set beats a longer one that gets truncated.`;

  return [
    { role: "system", content: sys },
    { role: "user", content: brief + "\n\nBLUEPRINT SO FAR:\n" + bpSummary }
  ];
}

/* ------------------------------------------------- stage: AUGMENT (go deeper) */
function augmentMessages(brief, bpSummary) {
  const sys = `You are Alora, adding an Augmentation Map to a Blueprint you already produced.
${BRAND}
${ROLES}

Consistency with the new workflow: the leaner workflow below is already decided. Everything
you write must assume it is in place. Never tell someone to do a step the new workflow
removed or automated. For example, if the notetaker now starts automatically, do not say
"start the notetaker," because that click no longer exists. Write every instruction as it
would happen AFTER the change, not before it.

The people affected by this change are afraid, often quietly, that AI is coming for their
jobs. Your job is to replace that fear with a real, walkable path: what changes, what
higher-value work they move toward, and the concrete capabilities to build to get there.
Not "you're safe," which rings hollow. A specific upgraded role and the ladder to reach it.

Think it through internally first: for THIS workflow and these roles, what genuinely
leaves their plate, what higher-value work opens up, and what someone would actually need
to learn to thrive in the new version of their role. Be honest and specific, never generic
reassurance. If the honest answer is that a role shrinks, say what it shifts toward rather
than pretending nothing changes.

Cover the 2 or 3 groups most affected. Go deep on each rather than wide across many.

Return ONLY valid JSON, no prose, no code fences, in exactly this shape:
{
  "framing": "one plain sentence: augmentation is a path, not a promise, and here is theirs",
  "groups": [
    {
      "group": "who this is",
      "fearNamed": "their real fear, said plainly and without softening",
      "aiTakes": "the specific drudgery AI lifts off their plate",
      "movesToward": "the higher-value work they move toward, their upgraded role in concrete terms",
      "ladder": [
        { "capability": "a skill to build", "level": "Foundational|Growing|Advanced", "why": "one line on why this skill matters in the new role" }
      ],
      "firstStep": "the single most useful thing to learn first, so no one is paralyzed"
    }
  ]
}

Give 2 to 3 groups. Each ladder has 3 to 4 capabilities, sequenced from Foundational to
Advanced, so a change leader could hand it to L&D as a starting curriculum. Keep every
string to one short sentence, and keep each "why" to a brief phrase. Ground everything in
the specific workflow, never generic KPIs or stock advice.`;

  return [
    { role: "system", content: sys },
    { role: "user", content: brief + "\n\nBLUEPRINT SO FAR:\n" + bpSummary }
  ];
}

/* ----------------------------------------------- stage: REINFORCE (go deeper) */
function reinforceMessages(brief, bpSummary) {
  const sys = `You are Alora, adding a Reinforcement and Incentivizing layer to a Blueprint you already produced.
${BRAND}

Reinforcement is the step most change efforts skip, and then they wonder why adoption
fades after launch. Your job is the moves that make this change stick and the incentives
that make people want to adopt it, framed so a sponsor could fund them.

Two kinds of move, and label each:
- Reinforcement: rituals, feedback loops, and habits that keep the new way alive after launch.
- Incentive: recognition, rewards, or motivators that make people want to adopt, not just comply.

Motivation stance, this matters most: bias every incentive toward intrinsic motivators
over external pressure. Reach for mastery (people getting visibly better at something),
autonomy (people choosing how they work), progress (people seeing their own momentum),
and belonging (people feeling part of something), rather than compliance, surveillance,
or "do this or else." Never frame an incentive as a threat to someone's job or standing.
If a move could read as fear-based, reframe it around what the person gains.

Vehicles you can use, and you are encouraged to invent others that fit this specific
workflow: light gamification (streaks, progress markers, friendly team visibility),
bite-sized micro-trainings that build confidence in minutes, peer recognition,
early-adopter or mentor roles, small autonomy grants, visible progress dashboards people
actually want to check. Pick or design what genuinely fits these roles; do not force a
tactic that would feel gimmicky here.

Think it through internally first: for THIS workflow and these roles, what would actually
keep the change alive past week three, and what would make people choose the new way.
Ground everything in the specific workflow, never generic "celebrate wins" filler.

On cost: you do NOT know their salaries or vendor prices, so NEVER invent a dollar figure.
Give a relative investment level, name the cost drivers in plain words, and hand them the
math to size it with their own numbers. Everything is an estimate, say so.

Return ONLY valid JSON, no prose, no code fences, in exactly this shape:
{
  "framing": "one plain sentence on why reinforcement is the step that is skipped and paid for later",
  "moves": [
    {
      "move": "the concrete ritual or mechanism",
      "type": "Reinforcement|Incentive",
      "motivator": "the intrinsic driver this taps: Mastery|Autonomy|Progress|Belonging|Recognition",
      "locksIn": "the specific habit or behavior from the Blueprint it protects",
      "cadence": "One-time|Weekly|Monthly|Ongoing",
      "owner": "the role who runs it",
      "investment": "Low|Medium|High",
      "whatItTakes": "plain-language cost drivers, e.g. a few hours of manager time weekly plus a one-time CRM config, never a dollar figure",
      "howToSize": "a short do-this-math line so they can ballpark it with their own numbers"
    }
  ],
  "estimateNote": "one sentence reminding the reader these are directional estimates, not quotes, and to plug in their own rates and vendor prices"
}

Give 4 to 6 moves, a mix of Reinforcement and Incentive, at least two of each. Keep every
string to one clear sentence. Make investment levels relative to each other so a sponsor
can triage at a glance. Every motivator must be intrinsic, never fear or compliance.`;

  return [
    { role: "system", content: sys },
    { role: "user", content: brief + "\n\nBLUEPRINT SO FAR:\n" + bpSummary }
  ];
}
/* Netlify's free tier kills a function at 10 seconds. We self-limit to a budget
   under that so Alora always returns a clean, friendly error instead of a silent
   platform timeout (which gives the user a generic message and logs nothing). */
const TOTAL_BUDGET_MS = 9000;

async function callModel(messages, maxTokens, retryHint, model, timeoutMs) {
  const msgs = retryHint
    ? messages.concat({ role: "user", content: "Your last reply was not valid JSON. Return ONLY the JSON object, nothing else." })
    : messages;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1000, timeoutMs || 8500));
  let res;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: "POST",
      signal: ctrl.signal,
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
  } catch (e) {
    const err = new Error(e.name === "AbortError" ? "model timeout" : "network error");
    err.timeout = e.name === "AbortError";
    throw err;
  } finally {
    clearTimeout(timer);
  }

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

/* Orchestrate within the time budget. One primary attempt; a JSON-retry or a
   free-router fallback only if there is still time, so two slow calls can never
   stack up and blow past Netlify's hard limit. */
async function generateJson(messages, maxTokens) {
  const start = Date.now();
  const left = () => TOTAL_BUDGET_MS - (Date.now() - start);

  try {
    let raw = await callModel(messages, maxTokens, false, MODEL, left());
    let parsed = extractJson(raw);
    if (parsed) return parsed;

    // Bad JSON: one strict retry on the same model, only if time allows.
    if (left() > 3500) {
      raw = await callModel(messages, maxTokens, true, MODEL, left());
      parsed = extractJson(raw);
      if (parsed) return parsed;
    }
    // Still bad: try the free router once if it is a different model and time allows.
    if (MODEL !== FREE_MODEL && left() > 3500) {
      raw = await callModel(messages, maxTokens, false, FREE_MODEL, left());
      parsed = extractJson(raw);
      if (parsed) return parsed;
    }
    return null;
  } catch (err) {
    // Primary failed fast (credits, auth, provider down). Fall back to free only
    // if it was NOT a timeout and there is real budget left for a full call.
    if (!err.timeout && MODEL !== FREE_MODEL && left() > 4000) {
      console.error("alora primary failed, trying free:", err.status || "", err.message || "");
      try {
        const raw = await callModel(messages, maxTokens, false, FREE_MODEL, left());
        return extractJson(raw);
      } catch (e2) { throw e2; }
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
      let out = await generateJson(generateMessages(brief, goalMode, body.qa), 2048);
      // Some models wrap the object; unwrap if the blueprint is nested.
      if (out && !out.diagnosis && typeof out === "object") {
        out = out.blueprint || out.Blueprint || out.result || out;
      }
      if (!out || !out.diagnosis) {
        console.error("alora generate: no usable blueprint", out ? "parsed-but-no-diagnosis" : "unparseable");
        return reply(502, { error: "Alora couldn't shape a clean Blueprint that time. Please try again." }, origin);
      }
      return reply(200, { blueprint: out }, origin);
    }

    if (stage === "metrics") {
      const bpSummary = clamp(body.bpSummary, 1500);
      let out = await generateJson(metricsMessages(brief, bpSummary), 1900);
      if (out && !Array.isArray(out.metrics) && typeof out === "object") {
        out = out.beyondRoi || out.result || out;
      }
      if (!out || !Array.isArray(out.metrics) || !out.metrics.length) {
        console.error("alora metrics: no usable metrics", out ? "parsed-but-empty" : "unparseable");
        return reply(502, { error: "Alora couldn't shape the success metrics that time. Please try again." }, origin);
      }
      out.metrics = out.metrics.slice(0, 5);
      return reply(200, { beyondRoi: out }, origin);
    }

    if (stage === "augment") {
      const bpSummary = clamp(body.bpSummary, 1800);
      let out = await generateJson(augmentMessages(brief, bpSummary), 2000);
      if (out && !Array.isArray(out.groups) && typeof out === "object") {
        out = out.augmentation || out.augmentationMap || out.result || out;
      }
      if (!out || !Array.isArray(out.groups) || !out.groups.length) {
        console.error("alora augment: no usable groups", out ? "parsed-but-empty" : "unparseable");
        return reply(502, { error: "Alora couldn't shape the Augmentation Map that time. Please try again." }, origin);
      }
      out.groups = out.groups.slice(0, 3);
      return reply(200, { augment: out }, origin);
    }

    if (stage === "reinforce") {
      const bpSummary = clamp(body.bpSummary, 1800);
      let out = await generateJson(reinforceMessages(brief, bpSummary), 2000);
      if (out && !Array.isArray(out.moves) && typeof out === "object") {
        out = out.reinforcement || out.result || out;
      }
      if (!out || !Array.isArray(out.moves) || !out.moves.length) {
        console.error("alora reinforce: no usable moves", out ? "parsed-but-empty" : "unparseable");
        return reply(502, { error: "Alora couldn't shape the reinforcement plan that time. Please try again." }, origin);
      }
      out.moves = out.moves.slice(0, 6);
      return reply(200, { reinforce: out }, origin);
    }

    return reply(400, { error: "Unknown stage." }, origin);
  } catch (err) {
    // Never log the key or the user's raw input. Log only a terse marker.
    console.error("alora stage=" + stage + " failed:", err.timeout ? "timeout" : (err.status || ""), err.message || "");
    const msg = err.timeout
      ? "Alora took longer than expected to think this through. Please try again, and shorter answers help."
      : err.status === 429
      ? "The model is busy right now. Try again in a moment."
      : "Something hiccuped reaching the model. Please try again.";
    return reply(502, { error: msg }, origin);
  }
};
