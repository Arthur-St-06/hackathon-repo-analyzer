❯ I don't quite understand this entire repo, and what actions should I take to  
  test this out                                                                 

⏺ Let me explore the repo to give you a clear picture.

  Searched for 1 pattern, read 8 files, listed 1 directory (ctrl+o to expand)
  ⎿  Loaded repo-analyzer/AGENTS.md

⏺ Here's a clear picture of what this repo is and how to test it:

  ---
  What this repo is

  A two-agent AI pipeline for finding contributor-fixable bugs in
  pytorch/pytorch, plus a Next.js frontend to display results.

  The pipeline has two agents (defined as markdown prompt files):

  1. Surface agent (agents/surface.md) — reads data/corpus_filtered.json (1120
  pytorch GitHub issues, title+labels only), applies domain/exclusion/inclusion
  rules, and writes raw findings to findings/raw/
  2. Validator agent (agents/validator.md) — takes each raw finding, calls the
  GitHub API via gh CLI to check for linked PRs, maintainer signals, repro
  scripts, etc., scores confidence, and routes findings to:
    - findings/validated/ (confidence ≥ 0.75)
    - findings/needs_review/ (0.40–0.74)
    - findings/rejected/ (< 0.40 or hard blockers like "won't fix")

  The pipeline has already been run — output is in findings/:

  - 21 actionable (validated), 25 needs review, 9 rejected out of 55 total
  findings

  The frontend (repo-analyzer/) is a Next.js app that reads 
  public/data/findings.json and public/data/summary.json to display results.

  ---
  How to test it

  Option A — Run the frontend (view already-computed results)
  cd repo-analyzer
  npm install
  npm run dev
  # Open http://localhost:3000
  The frontend currently only shows a repo URL input — looks like it's still
  being built out.

  Option B — Re-run the surface agent (generate new raw findings from scratch)
  In Claude Code, you'd give it the prompt in agents/surface.md as instructions
  and point it at data/corpus_filtered.json.

  Option C — Re-run the validator agent on a specific raw finding
  gh issue view 71774 --repo pytorch/pytorch --json
  title,body,labels,state,createdAt,comments
  Then follow the steps in agents/validator.md. This requires gh CLI
  authenticated to GitHub.

  Prerequisite check for validator:
  gh auth status

  ---
  What would you like to do — explore the existing findings, build out the
  frontend UI, or re-run part of the pipeline?

❯ <ide_opened_file>The user opened the file /Users/lancewilson/Documents/GitHub 
  /hackathon-repo-analyzer/repo-analyzer/eslint.config.mjs in the IDE. This may 
   or may not be related to the current task.</ide_opened_file>                 

❯ Just trying to understand this. Can the program get user input (if the front  
  end is a chatbot like ChatGPT or Claude), rerun the agent(s), then output     
  findings to frontend?                                                         

⏺ Yes, architecturally this is totally doable — but the current repo has only
  the pieces, not the glue connecting them. Here's the honest picture:

  What exists now

  [agents/surface.md]     ← Claude prompt instructions (not executable code)
  [agents/validator.md]   ← Claude prompt instructions (not executable code)
  [data/corpus_filtered.json] ← Pre-fetched pytorch issues (static file)
  [findings/]             ← Pre-computed results (static files)
  [repo-analyzer/]        ← Next.js frontend (skeleton — just a URL input)

  The agents are markdown documents written for a human or AI to follow manually
   — they're not scripts you can call programmatically. Everything in findings/
  was produced by running Claude Code against those prompts by hand.

  What you'd need to build to make it chatbot-like

  User types repo URL
          ↓
  [Next.js API route]  ←─── needs to be built
          ├── 1. Fetch issues from GitHub API (currently done offline, hardcoded
   to pytorch)
          ├── 2. Call Claude API with surface.md prompt + fetched issues corpus
          │         (returns raw findings as JSON)
          ├── 3. For each raw finding, call Claude API with validator.md prompt
          │         (validator also needs live GitHub API calls for PR data)
          └── 4. Stream/return enriched findings to frontend
                  ↓
  [Frontend]  ←─── needs to display findings (currently just a text input)

  The real complexity

  - Scale: The surface agent reads 1120 issues. At Claude API rates, running the
   full pipeline on a new repo could take minutes and significant cost.
  - GitHub API: The validator calls gh CLI — that works on your machine but
  needs to become direct GitHub API calls in a web server context.
  - Streaming: Results wouldn't come back all at once — you'd want to stream
  findings to the UI as they're validated, like Claude's thinking output.
  - Arbitrary repos: The corpus is currently pytorch-specific with hardcoded
  domain rules (CUDA, kernels, etc.) — for a generic repo analyzer, the agent
  prompts would need to be dynamically adapted.

  The short version

  The repo is structured like a hackathon prototype: the AI logic works (proven
  by the pre-run findings), but the pipeline is manual, not wired to a live web
  interface. Making it fully chatbot-driven would mean building the Claude API
  integration + GitHub API fetching + a real results UI in the Next.js app.

  Want to start wiring that up, or focus on a specific piece first?

❯ Let's start focusing on the surface agent. What are good options to peruse    
  through a high number of issues? Also, is there any drawback for the agent to 
   read a high number of issues?                                                

⏺ Good questions — these are the two core bottlenecks for making the surface
  agent work in a real web app.

  Options for fetching a large number of issues

  GitHub GraphQL API (best for this use case)
  - Single request can fetch 100 issues with all fields you need
  - Paginate with a cursor for more — 1120 issues = ~12 requests
  - Much more efficient than REST (fewer round trips, only get fields you ask
  for)
  - Requires a GitHub token

  gh CLI (what the validator currently uses, fine for local/server use)
  gh issue list --repo pytorch/pytorch --limit 1120 \
    --json number,title,url,state,createdAt,labels

  GitHub REST API (simplest but slowest)
  - 100 issues per page, need to paginate manually
  - Rate limit: 5,000 requests/hour authenticated

  Pre-fetch + cache (current approach — static corpus_filtered.json)
  - Zero latency during agent run, but goes stale
  - Fine for a fixed target repo, doesn't work for arbitrary user input

  ---
  Drawbacks of the agent reading many issues

  Yes, significant ones:

  1. Context window ceiling
  The current corpus is 1120 issues × ~80 tokens ≈ ~90K tokens, plus the
  365-line surface agent prompt. That fits in Claude's 200K window — barely. A
  large repo like cpython or rust-lang/rust with 5,000+ open issues would
  overflow it entirely.

  2. "Lost in the middle" degradation
  LLMs pay less attention to content buried in the middle of a very long
  context. Issues #400–800 of a 1120-issue list are at higher risk of being
  poorly triaged than the ones at the top and bottom.

  3. Cost scales linearly
  Every run re-reads the entire corpus. At Claude API pricing, 90K input tokens
  per run adds up fast if users can trigger it on demand.

  4. Latency
  Claude has to process all 1120 issues before returning anything. No results
  until the full inference completes.

  ---
  The better architecture

  The surface agent is doing two jobs that should be split:

  [All issues from GitHub]
          ↓
  [Code-based pre-filter]  ← apply the D1/D2/E1-E11 rules in plain code (fast,
  free, instant)
          ↓  (reduces 1120 → ~150-200 domain-relevant candidates)
  [Claude surface agent]   ← only reads pre-filtered candidates, applies
  qualitative judgment
          ↓
  [Raw findings]

  The rules in agents/surface.md are mostly deterministic (label checks, keyword
   matches, state checks) — they don't need AI. Only the final prioritization
  and surface_reasoning writing genuinely needs Claude. Implementing the filters
   in code first would cut Claude's input by ~85%, remove the context ceiling
  problem, cut cost, and reduce latency significantly.

  Want to build that pre-filter layer as a Next.js API route?

❯ Explain it to me.                                                             
  So what scrapes all the issues from the repository? (Is the prefilter         
  scraping the issues?)                                                         
  And what analyzes it next?                                                    

⏺ Sure. Here's the actual flow, step by step:

  ---
  Step 1 — Scraping (done manually, offline, before any agent ran)

  Someone ran a GitHub API command like:
  gh issue list --repo pytorch/pytorch --limit 1120 \
    --json number,title,url,state,createdAt,labels

  That output got saved as data/corpus_filtered.json. That's the entire
  "scraping" step — it's just a snapshot of 1120 GitHub issues stored as a JSON
  file.

  The pre-filter I described is NOT a scraper. It would be a separate step after
   scraping that reduces 1120 issues down before Claude reads them.

  ---
  Step 2 — Surface agent (Claude reads the scraped file)

  Claude is given the instructions in agents/surface.md and told: "read
  corpus_filtered.json and pick the best bug candidates."

  Claude reads all 1120 issues and applies the triage rules from the prompt —
  label checks, keyword checks, priority scoring — then writes one JSON file per
   candidate into findings/raw/.

  ---
  Step 3 — Validator agent (Claude + live GitHub API calls)

  Claude is given agents/validator.md and one raw finding file. It then:
  - Calls gh issue view {number} to read the full issue body and comments
  - Calls gh search prs to find any linked pull requests
  - Scores confidence, assigns an action, writes an enriched JSON to
  findings/validated/, findings/needs_review/, or findings/rejected/

  This runs once per raw finding — so if surface produced 30 raw findings,
  validator runs 30 times.

  ---
  The full picture

  GitHub API
      ↓  (gh issue list — scraping, done once manually)
  corpus_filtered.json   ← 1120 issues, title + labels only, no body text
      ↓
  Claude (surface agent) ← reads all 1120, picks ~30 candidates
      ↓
  findings/raw/          ← ~30 JSON files, one per candidate
      ↓
  Claude (validator)     ← runs once per raw finding, makes live GitHub API
  calls
      ↓
  findings/validated/    ← high confidence bugs
  findings/needs_review/ ← medium confidence
  findings/rejected/     ← noise or blockers

  ---
  So to directly answer your questions:
  - What scrapes the issues? A gh CLI command run manually — just a one-time
  data dump
  - What analyzes it next? Claude, using the surface agent prompt as its
  instructions
  - The pre-filter would sit between those two — reducing what Claude has to
  read, implemented as code (not AI)

❯ <ide_opened_file>The user opened the file /Users/lancewilson/Documents/GitHub 
  /hackathon-repo-analyzer/data/corpus_filtered.json in the IDE. This may or    
  may not be related to the current task.</ide_opened_file>                     

❯ What if it's a big project with tens of thousands of issues?                  

⏺ That's where the current design breaks completely. Three hard problems hit at
  once:

  Problem 1 — Context window overflow

  Claude's limit is 200K tokens. 10,000 issues × ~80 tokens = 800K tokens — 4×
  over the ceiling. Claude simply can't read them all in one shot.

  Problem 2 — Fetching is slow and expensive

  10,000 issues = 100 paginated GitHub API requests just to get the raw data.
  That's before any AI runs.

  Problem 3 — Quality degrades anyway

  Even if context weren't a limit, research shows LLMs perform worse as input
  length grows — issues buried in the middle get less attention.

  ---
  The layered solution

  Think of it as a funnel — each layer is cheaper and faster than the one below
  it:

  GitHub API (10,000 issues)
          ↓
  Layer 1: GitHub search query    ← free, instant, done before fetching
    e.g. is:open label:"bug"     → cuts to ~2,000
          ↓
  Layer 2: Code-based filter      ← label/keyword rules in plain code, no AI
    (the D1/D2/E1-E11 rules      → cuts to ~300
     from surface.md)
          ↓
  Layer 3: Claude surface agent   ← reads only ~300, picks 25-35 findings
          ↓
  Layer 4: Claude validator       ← runs once per finding (~30 times)
          ↓
  findings/

  Layer 1 (GitHub search) is the biggest win for large repos — you use GitHub's
  own index so you never even fetch the irrelevant issues. Instead of:
  gh issue list --limit 10000  # fetches everything
  you do:
  gh issue list --search "is:open label:bug" --limit 500  # pre-filtered by
  GitHub

  Layer 2 (code filter) handles the remaining noise — things the label filter
  missed, applying the deterministic rules from agents/surface.md that don't
  need AI (state checks, keyword checks, module exclusions).

  Layer 3 is where Claude finally enters, but now it's reading 300 issues
  instead of 10,000 — well within context limits.

  ---
  The tradeoff

  Layer 1 and 2 filters are repo-specific. The pytorch pipeline knows to look
  for module: correctness (silent) because pytorch uses that label. A random
  repo on GitHub might label bugs completely differently or not at all.

  For an arbitrary repo, the funnel gets harder — you'd either need to read a
  sample of labels/issues first to understand the repo's conventions, or fall
  back to keyword-only filtering, which is less precise.

  Want to start building the pre-filter layer in code?

❯ Not quite yet. Just wondering if we need more agents to split the steps up?   
  And what does this imply?                                                     

⏺ Yes, and it's worth thinking through carefully because it has real
  architectural implications.

  Where more agents make sense

  For a large repo, the surface agent is doing too much in one shot. You could
  split it into:

  [Repo Analyzer agent]     ← reads a sample of the repo to understand its
                               domain, label conventions, and bug patterns
                               (makes the pipeline work for ANY repo, not just
  pytorch)
          ↓
  [Fetcher agent]           ← paginates GitHub API, applies fast code-based
                               filters, builds the corpus for this specific repo
          ↓
  [Surface agents × N]      ← multiple instances running IN PARALLEL, each
                               handling a chunk of ~300 issues
          ↓
  [Aggregator agent]        ← merges results from all surface agents,
                               deduplicates, calibrates final volume (25-35)
          ↓
  [Validator agents × N]    ← already one-per-finding, naturally parallel

  What this implies

  You need an orchestrator. Right now a human manually runs each agent in
  sequence. With multiple parallel agents, something has to coordinate them —
  decide what runs when, pass data between agents, handle failures, and report
  progress. That orchestrator is either:

  - Code (a Next.js API route that calls Claude API in sequence/parallel)
  - A manager agent (a Claude instance that decides which sub-agents to invoke
  and when)

  Parallelism is the big win. The validator already runs once per finding —
  naturally parallel. Splitting the surface agent into chunks means a
  10,000-issue repo takes roughly the same wall-clock time as a 1,000-issue
  repo, because chunks run simultaneously instead of sequentially.

  Errors propagate. If the Repo Analyzer agent misreads the repo's conventions
  (e.g., thinks it's a ML project when it's a web framework), every downstream
  agent inherits that mistake. More agents = more failure points = harder to
  debug.

  Cost multiplies. Each agent is a Claude API call. Parallel surface agents are
  faster but cost the same total tokens. An orchestrator agent adds its own cost
   on top.

  The core tradeoff

  ┌────────────────────────────┬─────────────────────────────────────────────┐
  │        Fewer agents        │                 More agents                 │
  ├────────────────────────────┼─────────────────────────────────────────────┤
  │ Simpler to build           │ Each agent is more focused → better quality │
  ├────────────────────────────┼─────────────────────────────────────────────┤
  │ Single point of failure    │ Parallelizable → handles large repos        │
  ├────────────────────────────┼─────────────────────────────────────────────┤
  │ Hits context limits fast   │ Each agent uses less context                │
  ├────────────────────────────┼─────────────────────────────────────────────┤
  │ Hard to rerun one step     │ Modular — rerun just the failed step        │
  ├────────────────────────────┼─────────────────────────────────────────────┤
  │ Works fine for small repos │ Required for arbitrary repos at scale       │
  └────────────────────────────┴─────────────────────────────────────────────┘

  For a hackathon demo targeting a fixed repo like pytorch, the current
  two-agent design is probably fine. For a general-purpose tool where users
  paste any GitHub URL, you'd want the orchestrator + parallel surface agents
  pattern.

❯ I also gathered something: We are not reading the full issue description and  
  comments. We are just reading the title and the label(s) of the issue.        
  The validator agent (or validator process if we are using about two to three  
  agents) reads the descriptions after the surface process filters out desired  
  issues.                                                                       
  How does this change everything?                                              

⏺ That's a really sharp observation, and it changes the scaling picture
  significantly.

  What it means for the surface agent

  Title + labels per issue is tiny — maybe 20-30 tokens each, not the 80 I
  estimated before. That means:

  1,000 issues × 30 tokens  =  30K tokens   ← fits easily
  5,000 issues × 30 tokens  = 150K tokens   ← still fits in one call
  10,000 issues × 30 tokens = 300K tokens   ← needs chunking into ~2 batches

  The surface agent is essentially doing a metadata scan — it never needs the
  description at all. That's actually a very smart design. The expensive reading
   is deliberately deferred.

  What it means for the validator

  The validator is where the real reading happens. It fetches the full body AND
  all comments for each issue via gh issue view. A pytorch issue could have 20+
  long comments. But crucially:

  Validator runs on ~30 findings, NOT on 10,000 issues

  So even if each validator call is expensive and slow, it only fires a small
  number of times regardless of how large the original repo is. And it's
  naturally parallel — 30 findings can run simultaneously.

  The pipeline is already well-designed for this

  10,000 issues (title + labels only)
          ↓
  Surface agent     ← cheap, metadata only, runs ONCE
          ↓
  ~30 raw findings
          ↓
  Validator × 30    ← expensive, reads everything, runs in PARALLEL
          ↓
  ~20 actionable findings

  The cost and time of the pipeline scales with findings count, not with issue 
  count. That's the key insight.

  What actually changes for large repos

  The bottleneck shifts:

  ┌───────────────────────┬─────────────────────┬───────────────────────────┐
  │         Step          │   Small repo (1K    │  Large repo (10K issues)  │
  │                       │       issues)       │                           │
  ├───────────────────────┼─────────────────────┼───────────────────────────┤
  │ Fetching from GitHub  │ Fast                │ Slow — 100 paginated      │
  │ API                   │                     │ requests                  │
  ├───────────────────────┼─────────────────────┼───────────────────────────┤
  │ Surface agent         │ Easy, one call      │ Needs 2-3 chunks          │
  ├───────────────────────┼─────────────────────┼───────────────────────────┤
  │ Validator             │ Same (~30 calls)    │ Same (~30 calls)          │
  └───────────────────────┴─────────────────────┴───────────────────────────┘

  The validator cost stays constant. The surface agent needs chunking only above
   ~6K issues. The real bottleneck for very large repos is GitHub API 
  pagination, not Claude.

  One caveat

  This design assumes issue titles are descriptive enough to triage on. PyTorch
  is a well-maintained project with good titles. For repos with vague titles
  like "bug report" or "it's broken", the surface agent would struggle — and
  you'd want to fetch a short body preview (first 200 characters) to give it
  more signal, which adds a bit of token cost but not much.

❯ Just to clarify, what agent(s) do we have to use for the surface process (the 
   prefilter), and how would we implement the model(s)?                         

⏺ Good clarifying question. Let me be precise:

  The surface process = two distinct steps

  Step 1 — Code filter (NOT an agent)

  This is just a TypeScript/JavaScript function. No Claude involved. It
  mechanically applies the deterministic rules from agents/surface.md:

  Does title start with "DISABLED"?     → exclude  (E1)
  Does labels include "skipped"?        → exclude  (E2)
  Does labels include "module: cuda"?   → include  (D2-A)
  Does title contain "matmul"?          → include  (D2-B)
  Is state == "CLOSED"?                 → exclude  (E9)
  ...

  These are all string checks and array membership tests — no reasoning needed.
  Free, runs in milliseconds.

  Step 2 — ONE Claude call (the actual surface agent)

  After the code filter reduces 10,000 → ~300 issues, you make a single Claude
  API call:

  System prompt:  contents of agents/surface.md
  User message:   the ~300 filtered issues as JSON
  Expected output: 25-35 raw findings as JSON

  This is not an "agent" in the tool-use sense — it's a single inference call.
  Claude reads, reasons, and returns structured JSON. No back-and-forth loop
  needed.

  ---
  How to implement

  In a Next.js API route, using the Anthropic SDK:

  import Anthropic from "@anthropic-ai/sdk";

  // Step 1 — code filter (free, instant)
  const filtered = issues.filter(issue => {
    if (issue.title.startsWith("DISABLED")) return false;
    if (issue.labels.includes("skipped")) return false;
    if (issue.state === "CLOSED") return false;
    // ... rest of D1/D2/E1-E11 rules
    return true;
  });

  // Step 2 — Claude surface agent (one API call)
  const client = new Anthropic();
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8096,
    system: surfaceAgentPrompt,        // contents of agents/surface.md
    messages: [{
      role: "user",
      content: JSON.stringify(filtered) // ~300 issues
    }]
  });

  ---
  Model choice

  Use Sonnet for the surface agent, not Haiku. The qualitative judgment —
  deciding between borderline issues, writing surface_reasoning, calibrating
  volume to 25-35 — needs real reasoning ability. Haiku would be faster and
  cheaper but would miss nuance in the prioritization step.

  ---
  Summary

  ┌───────────────┬────────────────────────┬────────┬──────────────────────┐
  │     Step      │       What it is       │ Model  │         Cost         │
  ├───────────────┼────────────────────────┼────────┼──────────────────────┤
  │ Code filter   │ TypeScript function    │ None   │ Free                 │
  ├───────────────┼────────────────────────┼────────┼──────────────────────┤
  │ Surface agent │ Single Claude API call │ Sonnet │ ~30-50K input tokens │
  └───────────────┴────────────────────────┴────────┴──────────────────────┘

  Two steps, one Claude call, no tool-use loop needed.

❯ How can we reduce the number of input tokens?                                 

⏺ Several approaches, ranked by impact:

  1. Compact format instead of JSON (biggest win)

  JSON is verbose — field names repeat for every issue. Switch to a
  pipe-delimited format:

  # Instead of this (~60 tokens per issue):
  {"number":71774,"title":"matmul returns uninitialized
  memory...","state":"OPEN","labels":["triaged","module: linear
  algebra","module: correctness (silent)"],"createdAt":"2022-01-25T18:11:30Z"}

  # Send this (~20 tokens per issue):
  71774 | matmul returns uninitialized memory for int64 tensors | OPEN |
  triaged,linear algebra,correctness silent | 2022

  300 issues × 40 tokens saved = 12,000 fewer tokens.

  2. Strip fields Claude doesn't need

  ┌───────────┬───────────┬─────────────────────────────┐
  │   Field   │  Needed?  │             Why             │
  ├───────────┼───────────┼─────────────────────────────┤
  │ number    │ Yes       │ Output ID                   │
  ├───────────┼───────────┼─────────────────────────────┤
  │ title     │ Yes       │ Core signal                 │
  ├───────────┼───────────┼─────────────────────────────┤
  │ state     │ Yes       │ E9 rule                     │
  ├───────────┼───────────┼─────────────────────────────┤
  │ labels    │ Yes       │ D1/D2/E rules               │
  ├───────────┼───────────┼─────────────────────────────┤
  │ createdAt │ Year only │ P4 rule (2+ years open)     │
  ├───────────┼───────────┼─────────────────────────────┤
  │ url       │ No        │ Reconstructable from number │
  └───────────┴───────────┴─────────────────────────────┘

  3. Prompt caching

  The agents/surface.md prompt is ~3,500 tokens and never changes between runs.
  Anthropic's prompt caching lets you pay for it once, then reuse it across
  calls:

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    system: [{
      type: "text",
      text: surfaceAgentPrompt,
      cache_control: { type: "ephemeral" }  // cache this
    }],
    messages: [{
      role: "user",
      content: JSON.stringify(filtered)     // only this changes per run
    }]
  });

  Cached tokens cost 10× less on subsequent calls. Big win if users run this
  multiple times.

  4. Label shortcodes

  Labels like "module: correctness (silent)" are long. You can map them to codes
   at the top of the message:

  LABEL CODES: CS=correctness silent, P=performance, R=regression, LA=linear
  algebra
  71774 | matmul returns uninitialized memory | OPEN | triaged,LA,CS | 2022

  ---
  Combined impact

  300 issues, before optimization:  ~18,000 tokens (issues) + 3,500 (prompt) =
  21,500
  300 issues, after optimization:   ~6,000 tokens (issues) + 350 (prompt,
  cached) = 6,350

  ~70% reduction in billed tokens per run after the first cached call.

❯ When you say combined impact, do you mean if I used all these solutions at    
  once?                                                                         

⏺ Yes exactly. The math stacks like this:

  Start:           18,000 tokens (issues as JSON) + 3,500 (prompt)
  After #1:         6,000 tokens (compact format)  + 3,500 (prompt)   ← format
  change
  After #2:         5,000 tokens (stripped fields) + 3,500 (prompt)   ← field
  removal
  After #3:         5,000 tokens (issues)          + 350  (prompt)    ← prompt
  caching
  After #4:         4,500 tokens (shortcodes)      + 350  (prompt)    ← label
  compression

  Final:  ~4,850 billed tokens vs ~21,500 original

  Each optimization is independent and they all apply simultaneously — none of
  them conflict with each other.

  The one caveat: prompt caching only kicks in on the second and subsequent 
  calls for a given session. The very first call still pays full price for the
  prompt. After that, the 3,500 tokens drop to ~350.

  So the 70% figure is accurate for repeat runs. A one-off single run is more
  like 50% reduction (just from format + field stripping + shortcodes, without
  the cache benefit).

❯ I just realized something. The labels that are assigned to different issues   
  will be categorized by the agent (or script), and be stored, so that once the 
   user gets the list of issues (based on their input), then the list of        
  categories of labels are stored.                                              
  If the user decides to use a different repo, we would delete the category and 
   start anew.                                                                  
                                                                                
  How does this sound?                                                          

⏺ That's a solid design decision. Let me make sure I understand what you're
  describing:

  User inputs repo URL
          ↓
  Fetch issues from GitHub API
          ↓
  Discover & store the repo's unique label set    ← new step you're describing
    e.g. pytorch: ["module: cuda", "module: correctness (silent)", ...]
    e.g. react:   ["bug", "good first issue", "needs triage", ...]
          ↓
  Code filter + surface agent run against those labels
          ↓
  Findings displayed in frontend
          ↑
  If user switches repo → clear stored labels, start fresh

  This is smart for a few reasons:

  It makes the pipeline repo-agnostic. Right now the surface agent has
  pytorch-specific labels hardcoded into the prompt. If you discover labels
  dynamically and store them, the agent can adapt to any repo's conventions.

  It avoids re-fetching labels on every run. If the user refines their search or
   reruns the agent on the same repo, the label set is already known — no
  redundant API calls.

  ---
  One thing worth thinking through: label discovery is not the same as label 
  understanding.

  Fetching all unique labels from a repo tells you what labels exist. But
  understanding which ones indicate bugs vs features vs infrastructure still
  requires either:

  - A small Claude call upfront to categorize the discovered labels — "here are 
  47 labels from this repo, which ones signal actionable bugs?"
  - Or hardcoding rules for common patterns (bug, regression, correctness) that
  appear across most repos

  The first option (a tiny Claude call just for label categorization) is
  probably the cleanest. It's cheap — just a list of label names, no issue
  content — and it makes the pipeline genuinely work for any repo.

  Does that match what you had in mind, or were you thinking the label storage
  was purely for caching/performance?

❯ <ide_opened_file>The user opened the file /Users/lancewilson/Documents/GitHub 
  /hackathon-repo-analyzer/data/corpus_filtered.json in the IDE. This may or    
  may not be related to the current task.</ide_opened_file>                     
❯ It kind of matches. Using a list of label names with no issue content is how  
  it maximizes caching/performance.                                             

⏺ Exactly right. And it's a good fit for prompt caching specifically because
  labels are stable — they rarely change compared to issues. That stability is
  what makes them ideal cache candidates.

  The data hierarchy by how often each layer changes:

  Label set          ← changes rarely   → cache aggressively, clear on repo
  switch
  Issue metadata     ← changes daily    → fetch fresh each run, compact format
  Issue body/comments← changes per issue → only fetch for validated findings
  (validator)

  So in practice the cached inputs to Claude look like:

  [CACHED — stable]
  System prompt (surface.md rules)
  Repo label set: ["module: cuda", "module: correctness (silent)", "triaged",
  ...]

  [NOT CACHED — changes each run]
  Filtered issues in compact format:
  71774 | matmul returns uninitialized memory | OPEN | LA,CS | 2022
  ...

  The cached portion (prompt + label set) gets written once and reused. Claude
  only bills full price for the fresh issue list on each run.

  The one implication of this design: when the user switches repos, you're not
  just clearing the label cache — you're also invalidating the prompt cache,
  because the label set embedded in the cached context has changed. The next run
   after a repo switch always pays full price. Every run after that is cheap
  again.

  That's an acceptable tradeoff — repo switches are infrequent compared to
  reruns on the same repo.

❯ With the current structure, how many tokens are we using, and what conditions 
   use the least/most tokens?                                                   

⏺ Let me check the actual data to give real numbers.

  Read 1 file (ctrl+o to expand)

⏺ Bash(python3 -c "
      import json…)
  ⎿  Interrupted · What should Claude do instead?

❯ Let's try this again.                                                         

⏺ Let me get the numbers using simpler commands.

  Read 1 file (ctrl+o to expand)

⏺ Good. I can work out the numbers from the file sizes. 1 token ≈ 4 characters.

  Current token counts

  Surface agent (one call):
  corpus_filtered.json:  406,114 bytes ÷ 4  =  ~101,500 tokens
  surface.md prompt:      19,049 bytes ÷ 4  =    ~4,750 tokens

  Total input:                                 ~106,250 tokens

  Validator agent (per finding, ~30 calls):
  validator.md prompt:    19,340 bytes ÷ 4  =    ~4,835 tokens
  raw finding JSON:                          =      ~500 tokens
  gh issue view response (body + comments)  =  ~5,000–20,000 tokens

  Total per call:                              ~10,000–25,000 tokens

  ---
  What causes the most/fewest tokens

  Surface agent — varies by issue:

  ┌─────────────────────────┬────────────┬──────────────────────────────────┐
  │        Condition        │   Token    │               Why                │
  │                         │   count    │                                  │
  ├─────────────────────────┼────────────┼──────────────────────────────────┤
  │ Short title + 1 label   │ ~40 tokens │ Minimal content                  │
  ├─────────────────────────┼────────────┼──────────────────────────────────┤
  │ Long title + many       │ ~150       │ pytorch labels are verbose       │
  │ labels                  │ tokens     │ strings                          │
  ├─────────────────────────┼────────────┼──────────────────────────────────┤
  │ Average issue           │ ~90 tokens │ 406KB ÷ 1,120 issues             │
  └─────────────────────────┴────────────┴──────────────────────────────────┘

  Validator agent — varies by issue age/activity:

  ┌─────────────────────────────┬───────────────┬───────────────────────────┐
  │          Condition          │  Token count  │            Why            │
  ├─────────────────────────────┼───────────────┼───────────────────────────┤
  │ New issue, no comments      │ ~6,000 tokens │ Just prompt + body        │
  ├─────────────────────────────┼───────────────┼───────────────────────────┤
  │ Old issue, 30+ comments     │ ~25,000       │ Every comment is fetched  │
  │                             │ tokens        │                           │
  ├─────────────────────────────┼───────────────┼───────────────────────────┤
  │ Issue with long repro       │ ~20,000       │ Code blocks are           │
  │ scripts                     │ tokens        │ token-heavy               │
  └─────────────────────────────┴───────────────┴───────────────────────────┘

  ---
  After all optimizations

  Compact format + strip URL + year-only date + label shortcodes:
    406KB → ~150KB → ~37,500 tokens (issues)
    +4,750 tokens (prompt, first run)
    +475 tokens (prompt, cached subsequent runs)

  First run:   ~42,250 tokens
  After that:  ~37,975 tokens  (prompt cached)

  ~60% reduction from the current 106,250 — and you're well under the 200K
  context window with room to spare for larger repos.

❯ Is the 42,250 based off the PyTorch repo?                                     

⏺ Yes. That 42,250 is specific to the pytorch corpus as it exists right now:

  - 1,120 issues already pre-fetched and stored in corpus_filtered.json
  - pytorch-specific verbose labels like "module: correctness (silent)",
  "module: linear algebra" — these are longer than typical repo labels like
  "bug" or "enhancement"
  - Pre-filtered — someone already removed issues before saving this file, so
  1,120 is not the full pytorch issue count

  For a different repo the numbers shift:

  ┌─────────────────────┬──────────────────────┬────────────────────────────┐
  │        Repo         │     Open issues      │     Estimated tokens       │
  │                     │                      │        (optimized)         │
  ├─────────────────────┼──────────────────────┼────────────────────────────┤
  │ pytorch/pytorch     │ ~1,120               │ ~38,000                    │
  │                     │ (pre-filtered)       │                            │
  ├─────────────────────┼──────────────────────┼────────────────────────────┤
  │ A small project     │ ~200 issues          │ ~7,000                     │
  ├─────────────────────┼──────────────────────┼────────────────────────────┤
  │ A large project     │ ~5,000 issues        │ ~170,000                   │
  ├─────────────────────┼──────────────────────┼────────────────────────────┤
  │ A very large        │ ~10,000 issues       │ ~340,000 ← over limit      │
  │ project             │                      │                            │
  └─────────────────────┴──────────────────────┴────────────────────────────┘

  So the optimizations keep pytorch comfortably inside the 200K window, but a
  very large repo with 10,000 issues would still overflow — which brings back
  the chunking strategy as a necessary fallback for those cases.

  The cutoff is roughly 6,000 issues before chunking becomes necessary, assuming
   the optimized compact format.