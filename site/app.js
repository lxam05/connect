"use strict";

/* ============================================================
   Helpers
   ============================================================ */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const wait = (ms) => new Promise((r) => setTimeout(r, reduceMotion ? 0 : ms));

let toastTimer;
function toast(msg) {
  const t = $(".toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied to clipboard");
  } catch {
    toast("Copy failed. Select the text instead.");
  }
}

/* Light highlighter for shell, dotenv and JSON snippets. */
function hl(src, lang = "sh") {
  let s = esc(src);
  if (lang === "env") {
    return s
      .split("\n")
      .map((l) => {
        if (l.startsWith("#")) return `<span class="com">${l}</span>`;
        const i = l.indexOf("=");
        if (i < 0) return l;
        const k = l.slice(0, i);
        const v = l.slice(i + 1);
        const cls = v.startsWith("keysmith://") ? "ph" : "pk";
        return `<span class="k">${k}</span>=<span class="${cls}">${v}</span>`;
      })
      .join("\n");
  }
  if (lang === "json") {
    return s
      .replace(/("[^"]*")(\s*:)/g, '<span class="k">$1</span>$2')
      .replace(/(:\s*|\[\s*|,\s*)("[^"]*")/g, '$1<span class="pk">$2</span>');
  }
  return s
    .split("\n")
    .map((l) => {
      if (/^\s*#/.test(l)) return `<span class="com">${l}</span>`;
      return l
        .replace(/(#[^\n]*)$/, '<span class="com">$1</span>')
        .replace(/\b(keysmith)\b(?!:)/g, '<span class="k">$1</span>')
        .replace(/(keysmith:\/\/[\w/]+)/g, '<span class="ph">$1</span>')
        .replace(/(\[keysmith:redacted\])/g, '<span class="ph">$1</span>');
    })
    .join("\n");
}

function codeBlock(src, { lang = "sh", title } = {}) {
  const label = title ?? { sh: "Terminal", env: ".env", json: "JSON" }[lang] ?? lang;
  return `<div class="code"><div class="code-head"><span>${label}</span><button class="copy" type="button" data-copy="${esc(src).replace(/"/g, "&quot;")}">Copy</button></div><pre><code>${hl(src, lang)}</code></pre></div>`;
}

/* ============================================================
   Content
   ============================================================ */
const ENV_STRIPE = `# Stripe (managed by keysmith)
STRIPE_SECRET_KEY=keysmith://myapp/stripe/STRIPE_SECRET_KEY
STRIPE_PUBLISHABLE_KEY=pk_test_51N8h…
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_51N8h…`;
const ENV_RESEND = `# Resend (managed by keysmith)
RESEND_API_KEY=keysmith://myapp/resend/RESEND_API_KEY`;

const CLI = [
  {
    cmd: "setup",
    desc: "Gives the project every key it needs: scan, import plain-text secrets, connect, route the dev script through keysmith, verify.",
    out: `$ keysmith setup
• Moved into the Keychain: FOO_API_KEY
✓ Stripe · "Gap Detector sandbox" (acct_1T4s…): ready
✓ OpenAI: ready
✓ Other secrets: ready
• dev script: keysmith run -- next dev
Done: 3 service(s) connected and verified.`,
  },
  {
    cmd: "scan",
    desc: "Shows which services and secrets the project needs, without changing anything.",
    out: `$ keysmith scan
project shop (/Users/you/shop)
  · Stripe (not_connected)
      dependency stripe; process.env.STRIPE_SECRET_KEY in lib/stripe.ts
  · OpenAI (not_connected)
      process.env.OPENAI_API_KEY in lib/ai.ts
Run \`keysmith setup\` to connect everything.`,
  },
  {
    cmd: "list",
    desc: "Services Keysmith can connect, and the steps each one may need from you.",
    out: `$ keysmith list
stripe   Stripe — STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
         · Approve a pairing code in the browser (Stripe CLI sign-in), unless the Stripe CLI is already signed in.
resend   Resend — RESEND_API_KEY
         · Paste one Full access API key (from resend.com/api-keys) into a hidden macOS dialog.`,
  },
  {
    cmd: "connect",
    desc: "Gets keys, stores them in the Keychain and writes placeholders to .env. Safe to run twice.",
    out: `$ keysmith connect stripe resend
• Signing in with the Stripe CLI
✓ Stripe connected ✓ Test mode, account acct_1T4s….
  .env: STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
• Opening resend.com/api-keys
✓ Resend connected ✓ sending-only key stored
  .env: RESEND_API_KEY`,
  },
  {
    cmd: "status",
    desc: "What's connected, in which mode, and when it expires. Never prints a value.",
    out: `$ keysmith status
project myapp (/Users/you/myapp)
  stripe   connected · test mode · acct_1T4s… · expires 2027-01-21
  resend   connected`,
  },
  {
    cmd: "verify",
    desc: "Calls a harmless read endpoint to prove each key works.",
    out: `$ keysmith verify
✓ stripe: STRIPE_SECRET_KEY works (test mode, account acct_1T4s…).
✓ resend: RESEND_API_KEY is valid (sending access).`,
  },
  {
    cmd: "rotate",
    desc: "Creates a new key, verifies it, swaps it in the vault, then revokes the old one.",
    out: `$ keysmith rotate resend
Rotate the resend key? Running apps must restart. [y/N] y
✓ Resend key rotated ✓ New sending key verified and stored; old key revoked.`,
  },
  {
    cmd: "run",
    desc: "Runs your command with real values injected. Anything it prints that matches a secret is redacted.",
    out: `$ keysmith run -- node -e 'console.log(process.env.STRIPE_SECRET_KEY)'
[keysmith:redacted]

$ keysmith run -- next dev
  ▲ Next.js 15  ready on http://localhost:3000`,
  },
  {
    cmd: "doctor",
    desc: "Checks that secrets are fenced off from your agent and from git.",
    out: `$ keysmith doctor
✓ Claude Code deny rules: All recommended deny rules are set.
✓ .env is gitignored: /Users/you/myapp/.gitignore
✓ Keychain access: Read/write works.
✓ Stripe CLI: /opt/homebrew/bin/stripe
✓ Platform: macOS`,
  },
];

const MCP_TOOLS = [
  ["list_services", "", "Services available and what each needs from a person."],
  [
    "connect",
    "(service, tier?)",
    "Connects a service. Returns progress or the one step you need to take.",
  ],
  ["status", "", "Connected services, mode and expiry. Metadata only."],
  ["verify", "(service)", "Proves a stored key works without returning it."],
  ["rotate", "(service, confirm?)", "Replaces a key. Asks you to confirm first."],
  [
    "request",
    "(service, method, path, body?)",
    "Calls the provider's API with auth added and the response redacted.",
  ],
];

const DENY = [
  "Bash(security find-generic-password*)",
  "Bash(security find-internet-password*)",
  "Bash(security dump-keychain*)",
  "Read(~/.keysmith/**)",
  "Read(~/.config/stripe/**)",
  "Read(~/.config/resend/**)",
  "Bash(cat ~/.config/stripe/*)",
  "Bash(stripe config --list*)",
  "Bash(stripe listen*)",
  "Bash(supabase projects api-keys*)",
  "Bash(vercel env pull*)",
  "Bash(neonctl connection-string*)",
  "Read(~/.supabase/**)",
  "Read(~/.config/neonctl/**)",
];

/* ---------- docs ---------- */
const DOCS = [
  {
    group: "Getting started",
    pages: [
      {
        slug: "introduction",
        title: "Introduction",
        body: () => `
<p class="intro">Keysmith lets a coding agent add Stripe, Resend and similar services to your project on its own, without the agent ever seeing a secret.</p>
<p>When the agent calls <code>connect("stripe")</code>, Keysmith does the setup, and stops only for steps that need a person, such as approving a pairing code or pasting one key into a system dialog. Keys go into the macOS Keychain. Your <code>.env</code> only ever holds placeholders.</p>
${codeBlock(ENV_STRIPE + "\n" + ENV_RESEND, { lang: "env" })}
<p>Real values are injected only when your app runs, through <code>keysmith run</code>. Anything the process prints that matches a secret is replaced with <code>[keysmith:redacted]</code>.</p>
<h2 id="what-you-get">What you get</h2>
<ul>
  <li>A CLI for setting up, checking and rotating keys.</li>
  <li>An MCP server so Claude Code and other agents can do the setup for you.</li>
  <li>No <code>get</code> or <code>reveal</code> command. Values can't be read back out.</li>
</ul>
<div class="callout">This is an MVP. It runs on macOS only, uses test and sandbox keys only, and supports Stripe and Resend.</div>`,
      },
      {
        slug: "quickstart",
        title: "Quickstart",
        body: () => `
<p class="intro">Install Keysmith, register it with your agent, and check your setup. It takes about a minute.</p>
<h2 id="install">Install</h2>
${codeBlock("npm install -g keysmith")}
<h2 id="add-to-agent">Add it to Claude Code</h2>
${codeBlock("claude mcp add keysmith -- keysmith mcp")}
<h2 id="check">Check your setup</h2>
<p><code>doctor</code> confirms your agent's deny rules, your <code>.gitignore</code> and Keychain access. <code>--fix</code> adds <code>.env</code> to <code>.gitignore</code> if it's missing.</p>
${codeBlock("keysmith doctor --fix")}
<h2 id="connect">Ask your agent</h2>
${codeBlock(`claude "add Stripe payments and Resend email"
#   → approve the Stripe pairing code in your browser
#   → paste one Resend key into the macOS dialog`)}
<h2 id="run">Run your app through Keysmith</h2>
${codeBlock('npm pkg set scripts.dev="keysmith run -- next dev"\nnpm run dev')}
<h2 id="confirm">Confirm nothing leaked</h2>
${codeBlock(`cat .env                                   # placeholders + pk_test_ only
grep -rE "sk_test_|rk_test_|re_[A-Za-z0-9]{8}" . --exclude-dir=node_modules   # nothing`)}`,
      },
    ],
  },
  {
    group: "Reference",
    pages: [
      {
        slug: "cli",
        title: "CLI",
        body: () => `
<p class="intro">Every command returns metadata only. Add <code>--json</code> for machine-readable output.</p>
<table class="ref-table"><thead><tr><th>Command</th><th>What it does</th></tr></thead><tbody>
${[
  ["keysmith list", "Services and the steps each may need from you"],
  [
    "keysmith connect stripe resend",
    "Gets keys, stores them in the Keychain, writes placeholders. Safe to run twice. <code>--tier capture</code> skips provider CLIs and asks you to paste.",
  ],
  ["keysmith status", "Connected services, mode and expiry, with no values"],
  ["keysmith verify [service]", "Proves keys work against a harmless read endpoint"],
  ["keysmith rotate resend", "New key, verify, swap in vault, revoke old key"],
  ["keysmith run -- &lt;cmd&gt;", "Runs with real values injected and output redacted"],
  [
    "keysmith doctor [--fix]",
    "Checks agent deny rules, <code>.gitignore</code>, Keychain access and the Stripe CLI",
  ],
  ["keysmith mcp", "Starts the MCP server over stdio"],
]
  .map(([c, d]) => `<tr><td><code>${c}</code></td><td>${d}</td></tr>`)
  .join("")}
</tbody></table>
<p>There is deliberately no <code>get</code> or <code>reveal</code> command.</p>
<h2 id="examples">Examples</h2>
${CLI.filter((c) => ["setup", "status", "verify"].includes(c.cmd))
  .map((c) => codeBlock(c.out.replace(/^\$ /, ""), { title: `keysmith ${c.cmd}` }))
  .join("")}`,
      },
      {
        slug: "mcp",
        title: "MCP tools",
        body: () => `
<p class="intro">Your agent talks to Keysmith through these tools. All of them return metadata only.</p>
<table class="ref-table"><thead><tr><th>Tool</th><th>What it does</th></tr></thead><tbody>
${MCP_TOOLS.map(([n, a, d]) => `<tr><td><code>${n}${esc(a)}</code></td><td>${d}</td></tr>`).join("")}
</tbody></table>
<h2 id="rotate-confirm">Confirming a rotation</h2>
<p><code>rotate</code> asks you to confirm through MCP elicitation when your client supports it. Otherwise it returns <code>confirmation_required</code>, and the agent must call it again with <code>confirm: true</code> after you say yes.</p>
<h2 id="request">Calling provider APIs</h2>
<p><code>request</code> sends a call to <code>api.stripe.com</code> or <code>api.resend.com</code> with auth added and the response redacted. Endpoints that create or return keys are blocked, and calls that change data on live keys are refused.</p>
<div class="callout"><code>keysmith run</code> is not available over MCP. Only you can start a process that holds real values.</div>`,
      },
    ],
  },
  {
    group: "Services",
    pages: [
      {
        slug: "stripe",
        title: "Stripe",
        body: () => stripeBody(),
      },
      {
        slug: "resend",
        title: "Resend",
        body: () => resendBody(),
      },
    ],
  },
  {
    group: "Concepts",
    pages: [
      {
        slug: "run-and-redaction",
        title: "Run and redaction",
        body: () => `
<p class="intro"><code>keysmith run</code> starts your command with real values in its environment and filters what it prints.</p>
${codeBlock(`{ "scripts": { "dev": "keysmith run -- next dev" } }`, { lang: "json", title: "package.json" })}
<h2 id="how">How values get in</h2>
<p>Keysmith reads <code>.env</code>, swaps each <code>keysmith://</code> placeholder for the value in the Keychain, and passes the result to the child process as environment variables. Secrets are never passed as command-line arguments, so they don't show up in <code>ps</code>.</p>
<h2 id="redaction">What gets redacted</h2>
<p>Exact secret values and well-known key shapes, such as <code>sk_test_</code> and <code>re_</code>, are replaced with <code>[keysmith:redacted]</code> in stdout and stderr.</p>
${codeBlock(`keysmith run -- node -e 'console.log(process.env.STRIPE_SECRET_KEY)'
[keysmith:redacted]`)}
<div class="callout">Redaction can't catch a secret your program changes before printing it, for example by base64-encoding it.</div>`,
      },
      {
        slug: "threat-model",
        title: "Threat model",
        body: () => `
<p class="intro">What Keysmith protects against, and what it doesn't yet.</p>
<h2 id="protects">Protects against</h2>
<p>Secrets ending up in <code>.env</code>, git, logs, terminal output, chat transcripts, screenshots and your agent's context window.</p>
<ul>
<li>No CLI command, MCP tool or log returns a secret. Only the runner and the proxy can resolve a value.</li>
<li>Secrets are never passed as command-line arguments.</li>
<li><code>~/.keysmith/index.json</code> (mode 0600) holds metadata only: service, env var, mode, created, expiry, tier and provider key id.</li>
<li><code>.gitignore</code> is fixed up, including un-ignoring <code>.env.example</code> under Next.js's <code>.env*</code> rule.</li>
</ul>
<h2 id="gap">Known gap: processes running as you</h2>
<p>On macOS, any process running as you may be able to read Keychain items that trust the binary that created them, which here is <code>node</code>. An agent with unrestricted shell access could call <code>security find-generic-password</code> or read the Stripe CLI's config directly.</p>
<p><code>keysmith doctor</code> checks that your Claude Code settings deny the obvious paths:</p>
${codeBlock(JSON.stringify(DENY, null, 2), { lang: "json", title: ".claude/settings.json → permissions.deny" })}
<p>These are guardrails, not a sandbox. An agent could still write a script that does the same thing. A signed helper app with Touch ID is on the <a href="#/roadmap">roadmap</a>.</p>`,
      },
      {
        slug: "adding-a-provider",
        title: "Adding a provider",
        body: () => `
<p class="intro">Each service is a recipe: one file that knows how to get, check and replace that provider's keys.</p>
<p>Implement the <code>Recipe</code> interface in <code>src/recipes/&lt;id&gt;.ts</code> and register it in <code>registry.ts</code>.</p>
<table class="ref-table"><thead><tr><th>Member</th><th>Purpose</th></tr></thead><tbody>
<tr><td><code>detect</code></td><td>Reports whether the service is already connected</td></tr>
<tr><td><code>connect</code></td><td>Gets and stores keys</td></tr>
<tr><td><code>verify</code></td><td>Proves the key works with a harmless read</td></tr>
<tr><td><code>rotate</code></td><td>Optional. Replaces and revokes a key</td></tr>
<tr><td><code>auth</code>, <code>hosts</code></td><td>How the proxy adds credentials, and which hosts it may call</td></tr>
</tbody></table>
<h2 id="tiers">Connection order</h2>
<p><code>connect</code> tries each way of getting a key in turn, from least to most effort for you:</p>
<ol>
<li>Provisioning API</li>
<li>The provider's own CLI</li>
<li>OAuth</li>
<li>A guided page plus a hidden paste dialog</li>
</ol>`,
      },
    ],
  },
];
const DOC_PAGES = DOCS.flatMap((g) => g.pages);

function stripeBody() {
  return `
<p class="intro">Stripe connects through the Stripe CLI's browser sign-in. You approve one pairing code.</p>
<h2 id="steps">How it connects</h2>
<ol>
<li>Keysmith runs <code>stripe login --non-interactive</code>. You confirm the pairing code in your browser. If the CLI isn't installed, your agent asks you before running <code>brew install stripe/stripe-cli/stripe</code>.</li>
<li>It reads the CLI's test-mode restricted key and publishable key in-process, without changing the CLI's config.</li>
<li>It verifies with <code>GET /v1/balance</code>, which must return <code>livemode: false</code>, and checks the key can use Checkout.</li>
</ol>
<div class="callout">Recent Stripe CLI versions (1.53.1 tested) no longer store test keys locally after sign-in. When that happens, Keysmith opens the Stripe dashboard's API keys page and asks you to paste the key into the hidden dialog instead.</div>
<h2 id="env">What lands in .env</h2>
${codeBlock(ENV_STRIPE, { lang: "env" })}
<p>Publishable keys are public by design, so they're written as-is.</p>
<h2 id="expiry">Expiry</h2>
<p>Keys from the CLI last 90 days. <code>keysmith status</code> warns you 14 days before they expire.</p>
<h2 id="profiles">Profiles</h2>
<p>Set <code>KEYSMITH_STRIPE_PROFILE</code> to use a profile created with <code>stripe login --project-name</code>.</p>`;
}

function resendBody() {
  return `
<p class="intro">Resend has no OAuth or provisioning API, so you paste one key, once. Keysmith turns it into a narrower one.</p>
<h2 id="steps">How it connects</h2>
<ol>
<li>If the Resend CLI already holds exactly one full-access key, Keysmith reuses it. Otherwise it opens resend.com/api-keys and shows a hidden-input macOS dialog. The key goes from the dialog straight to the Keychain, never through your agent or terminal.</li>
<li>It uses that full-access key to create a <strong>sending-only</strong> key. Only the sending key is used by your app. The full-access key stays in the Keychain for rotation.</li>
<li><code>rotate</code> creates a new sending key, verifies it, swaps it in, then deletes the old one. Restart running processes to pick it up.</li>
</ol>
<h2 id="env">What lands in .env</h2>
${codeBlock(ENV_RESEND, { lang: "env" })}
<h2 id="sandbox">Testing</h2>
<p>Resend has no test-mode keys. Until you verify a domain, Resend only delivers to your own address, which works as a sandbox.</p>`;
}

/* ============================================================
   Pages
   ============================================================ */
const icons = {
  copy: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  key: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="12" r="4.5"/><path d="M12.5 12H21M17.5 12v3.5M20.5 12v2.5"/></svg>',
};

function homePage() {
  return `
<section class="hero">
  <div class="wrap">
    <a class="pill" href="#/docs/mcp"><b>v0.1</b>MCP server for Claude Code</a>
    <h1 class="display">Your agent connects the API.<br />You keep the keys.</h1>
    <p class="lede">Keysmith stores API keys in the macOS Keychain, writes placeholders to <code>.env</code> and adds real values only when your app runs. Your coding agent does the setup without ever reading a secret.</p>
    <div class="hero-actions">
      <a class="btn btn-light" href="#/docs/quickstart">Get started</a>
      <span class="install"><span>npm install -g keysmith</span><button type="button" data-copy="npm install -g keysmith" aria-label="Copy install command">${icons.copy}</button></span>
    </div>

    <div class="demo" id="demo">
      <div class="demo-bar">
        <div class="dots"><i></i><i></i><i></i></div>
        <span>~/myapp — claude</span>
        <button class="replay" type="button">Replay</button>
      </div>
      <div class="demo-grid">
        <div class="chat" aria-live="polite"></div>
        <div class="side">
          <div class="side-tabs" role="tablist">
            <button role="tab" aria-selected="true" data-tab="env">.env</button>
            <button role="tab" aria-selected="false" data-tab="keychain">Keychain</button>
            <button role="tab" aria-selected="false" data-tab="term">terminal</button>
          </div>
          <div class="side-pane" role="tabpanel"></div>
        </div>
      </div>
    </div>
  </div>
</section>

<section class="section">
  <div class="wrap">
    <div class="section-head">
      <h2 class="h2">One file, two readers.</h2>
      <p class="lede">Your agent reads <code>.env</code> and sees placeholders. Your app gets real values, and only while it's running.</p>
    </div>
    <div class="views">
      <div class="view">
        <h3>What your agent sees</h3>
        <p>Safe to read, commit by accident, or paste into a chat.</p>
        <pre>${hl(ENV_STRIPE.split("\n").slice(1, 3).join("\n") + "\n" + ENV_RESEND.split("\n")[1], "env")}</pre>
      </div>
      <div class="view">
        <h3>What your app gets</h3>
        <p>Injected by <code>keysmith run</code>. Never written to disk.</p>
        <pre><span class="k">STRIPE_SECRET_KEY</span>=<span class="pk">rk_test_51N8h••••••••••••</span>
<span class="k">STRIPE_PUBLISHABLE_KEY</span>=<span class="pk">pk_test_51N8h…</span>
<span class="k">RESEND_API_KEY</span>=<span class="pk">re_8Kq2••••••••••••</span></pre>
        <button class="reveal-btn" type="button" data-reveal>keysmith reveal</button>
      </div>
    </div>
  </div>
</section>

<section class="section">
  <div class="wrap">
    <div class="section-head">
      <h2 class="h2">From prompt to running app.</h2>
      <p class="lede">What happens after you ask your agent to add payments.</p>
    </div>
    <div class="steps">
      ${[
        ["Connect", "The agent calls connect. Keysmith picks the least-effort way to get a key."],
        ["Approve", "You click Allow on a pairing code, or paste one key into a system dialog."],
        [
          "Store",
          "The key goes into the macOS Keychain. Nothing is written to disk in plain text.",
        ],
        [
          "Placeholder",
          "<code>.env</code> gets a <code>keysmith://</code> reference the agent can read safely.",
        ],
        ["Run", "<code>keysmith run</code> adds real values to your app and redacts its output."],
      ]
        .map(
          ([t, d], i) =>
            `<div class="step"><span class="n">${String(i + 1).padStart(2, "0")}</span><h3>${t}</h3><p>${d}</p></div>`,
        )
        .join("")}
    </div>
  </div>
</section>

<section class="section">
  <div class="wrap">
    <div class="section-head">
      <h2 class="h2">A small CLI with no reveal command.</h2>
      <p class="lede">Set up, check, rotate and run. Nothing prints a secret.</p>
    </div>
    <div class="term" id="cli-term">
      <div class="term-list" role="tablist" aria-label="Commands">
        ${CLI.map((c, i) => `<button role="tab" aria-selected="${i === 0}" data-i="${i}">keysmith ${c.cmd}</button>`).join("")}
      </div>
      <div class="term-out" role="tabpanel"></div>
    </div>
  </div>
</section>

<section class="section">
  <div class="wrap">
    <div class="section-head">
      <h2 class="h2">Six tools for your agent.</h2>
      <p class="lede">Register once with <code>claude mcp add keysmith -- keysmith mcp</code>. Every tool returns metadata only.</p>
    </div>
    <div class="tools-grid">
      ${MCP_TOOLS.map(([n, a, d]) => `<div><code>${n}<em>${esc(a)}</em></code><p>${d}</p></div>`).join("")}
    </div>
  </div>
</section>

<section class="section">
  <div class="wrap">
    <div class="section-head">
      <h2 class="h2">Honest about the edges.</h2>
      <p class="lede">Keysmith keeps secrets out of the places they usually leak from. It isn't a sandbox yet.</p>
    </div>
    <div class="ledger">
      <div class="yes">
        <h3>Keeps secrets out of</h3>
        <ul>
          <li>.env files and git history</li>
          <li>Your agent's context window and chat transcripts</li>
          <li>Terminal output, logs and screenshots</li>
          <li>Process arguments visible in <code>ps</code></li>
        </ul>
      </div>
      <div class="no">
        <h3>Doesn't stop yet</h3>
        <ul>
          <li>A process running as you that reads the Keychain directly</li>
          <li>A program that encodes a secret before printing it</li>
          <li>Anything outside macOS</li>
        </ul>
      </div>
    </div>
    <p style="margin-top:32px"><a class="btn btn-ghost btn-sm" href="#/security">Read the threat model</a></p>
  </div>
</section>

<section class="cta">
  <div class="wrap">
    <h2 class="display" style="font-size:clamp(36px,5.6vw,64px)">Give your agent the job,<br />not the keys.</h2>
    <p class="lede">Install, register with Claude Code, and ask for payments.</p>
    <div class="hero-actions">
      <a class="btn btn-light" href="#/docs/quickstart">Read the quickstart</a>
      <a class="btn btn-ghost" href="https://github.com/lxam05/connect" rel="noopener">View on GitHub</a>
    </div>
  </div>
</section>`;
}

function infoCard(id, name, logo, badge, desc, vars) {
  return `
<a class="svc" href="https://github.com/lxam05/connect#how-each-service-connects" rel="noopener">
  <div class="svc-top"><span class="logo soon">${logo}</span><span class="badge live">${badge}</span></div>
  <h3>${name}</h3><p>${desc}</p>
  <div class="vars">${vars.map((v) => `<code>${v}</code>`).join("")}</div>
</a>`;
}

function integrationsPage() {
  const svcCard = (id, name, logo, badge, desc, vars) => `
<a class="svc" href="#/integrations/${id}">
  <div class="svc-top"><span class="logo ${id}">${logo}</span><span class="badge live">${badge}</span></div>
  <h3>${name}</h3><p>${desc}</p>
  <div class="vars">${vars.map((v) => `<code>${v}</code>`).join("")}</div>
</a>`;
  return `
<section class="page-head"><div class="wrap">
  <h1 class="h2" style="font-size:clamp(36px,5vw,56px)">Integrations</h1>
  <p class="lede">Services Keysmith can connect today. Each one is a single recipe file.</p>
</div></section>
<section style="padding:56px 0 120px"><div class="wrap">
  <div class="cards">
    ${svcCard("stripe", "Stripe", "S", "Available", "Payments in test mode. Sign in with the Stripe CLI and approve a pairing code.", ["STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY"])}
    ${svcCard("resend", "Resend", "R", "Available", "Transactional email. Paste one key and Keysmith creates a sending-only key from it.", ["RESEND_API_KEY"])}
    ${infoCard("supabase", "Supabase", "S", "No paste", "Reads the project's keys through the Supabase CLI. The service role key goes to the Keychain.", ["SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_URL"])}
    ${infoCard("neon", "Neon", "N", "No paste", "Stores the database connection string from the Neon CLI.", ["DATABASE_URL"])}
    ${infoCard("vercel", "Vercel", "▲", "Import", "Pulls a linked project's development env vars into the Keychain and deletes the temp file.", ["any env var"])}
    ${infoCard("paste", "OpenAI, Anthropic, Clerk & more", "+", "One paste", "Guided paste with a key check for OpenAI, Anthropic, Clerk, SendGrid, Twilio, Postmark and Cloudflare.", ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"])}
    <a class="svc" href="#/docs/adding-a-provider">
      <div class="svc-top"><span class="logo soon">+</span><span class="badge">Open source</span></div>
      <h3>Add a provider</h3><p>Write a recipe with detect, connect, verify and rotate, then register it.</p>
      <div class="vars"><code>src/recipes/&lt;id&gt;.ts</code></div>
    </a>
  </div>
</div></section>`;
}

function servicePage(id) {
  const meta = {
    stripe: {
      name: "Stripe",
      logo: "S",
      body: stripeBody,
      rows: [
        ["You'll need to", "Approve a pairing code in your browser"],
        ["Mode", "Test only"],
        ["Key lifetime", "90 days, with a warning 14 days before"],
        ["Verified with", "GET /v1/balance"],
        ["Blocked through proxy", "/v1/api_keys, /v2/iam"],
      ],
    },
    resend: {
      name: "Resend",
      logo: "R",
      body: resendBody,
      rows: [
        ["You'll need to", "Paste one full-access key into a hidden dialog"],
        ["Key used by your app", "Sending access only"],
        ["Rotation", "Automatic: create, verify, swap, revoke"],
        ["Verified with", "Read-only API call"],
        ["Blocked through proxy", "/api-keys"],
      ],
    },
  }[id];
  if (!meta) return notFound();
  return `
<section class="page-head"><div class="wrap">
  <div class="crumbs"><a href="#/integrations">Integrations</a><span>/</span><span>${meta.name}</span></div>
  <div style="display:flex;align-items:center;gap:16px"><span class="logo ${id}" style="width:52px;height:52px;font-size:22px">${meta.logo}</span><h1 class="h2" style="font-size:clamp(34px,5vw,52px)">${meta.name}</h1></div>
</div></section>
<div class="wrap detail">
  <article class="prose">${meta.body()}</article>
  <aside class="meta-box"><dl>${meta.rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>
    <div style="padding:16px 0"><a class="btn btn-light btn-sm" style="width:100%" href="#/docs/quickstart">Connect ${meta.name}</a></div>
  </aside>
</div>`;
}

function securityPage() {
  const page = DOC_PAGES.find((p) => p.slug === "threat-model");
  return `
<section class="page-head"><div class="wrap">
  <h1 class="h2" style="font-size:clamp(36px,5vw,56px)">Security</h1>
  <p class="lede">Keysmith is built so that no command, tool or log can hand a secret back. Here's exactly how far that goes.</p>
</div></section>
<div class="wrap detail">
  <article class="prose">${page.body()}</article>
  <aside class="meta-box"><dl>
    <div><dt>Where keys live</dt><dd>macOS Keychain, service <code>keysmith</code></dd></div>
    <div><dt>Metadata file</dt><dd><code>~/.keysmith/index.json</code>, mode 0600</dd></div>
    <div><dt>Reveal command</dt><dd>None, by design</dd></div>
    <div><dt>Over MCP</dt><dd>Metadata only. <code>run</code> isn't exposed.</dd></div>
    <div style="padding:16px 0"><button class="btn btn-ghost btn-sm" style="width:100%" type="button" data-copy='${JSON.stringify(DENY, null, 2)}'>Copy deny rules</button></div>
  </dl></aside>
</div>`;
}

function roadmapPage() {
  return `
<section class="page-head"><div class="wrap">
  <h1 class="h2" style="font-size:clamp(36px,5vw,56px)">Roadmap</h1>
  <p class="lede">What's shipped and what's next.</p>
</div></section>
<section style="padding:24px 0 120px"><div class="wrap">
  <ol class="timeline">
    <li><span class="when now">v0.1, now</span><div><h3>MVP</h3><p>CLI and MCP server for macOS, with Stripe and Resend in test and sandbox mode.</p>
      <ul><li>Keychain storage with placeholders in <code>.env</code></li><li><code>keysmith run</code> with output redaction</li><li>Resend key rotation</li><li><code>doctor</code> checks for agent deny rules and <code>.gitignore</code></li></ul></div></li>
    <li><span class="when">Next</span><div><h3>Zero-touch Stripe</h3><p>Use Stripe's managed API keys, encrypted to Keysmith's public key, so connecting Stripe needs no paste at all.</p></div></li>
    <li><span class="when">Next</span><div><h3>Signed Keychain helper</h3><p>A signed helper app owns the Keychain items and asks for Touch ID. The CLI and MCP server talk to it over a local socket, which closes the same-user gap.</p></div></li>
    <li><span class="when">Later</span><div><h3>Local HTTP proxy</h3><p>Even your running app only holds placeholders. The proxy adds credentials on the way out.</p></div></li>
    <li><span class="when">Later</span><div><h3>More of everything</h3><p>More recipes, live mode behind explicit confirmation, and Linux and Windows backends.</p></div></li>
  </ol>
</div></section>`;
}

function docsPage(slug) {
  const idx = DOC_PAGES.findIndex((p) => p.slug === slug);
  if (idx < 0) return notFound();
  const page = DOC_PAGES[idx];
  const body = page.body();
  const headings = [...body.matchAll(/<h2 id="([^"]+)">([^<]+)<\/h2>/g)];
  const prev = DOC_PAGES[idx - 1];
  const next = DOC_PAGES[idx + 1];
  return `
<div class="wrap docs">
  <nav class="docs-nav" aria-label="Docs">
    ${DOCS.map(
      (g) =>
        `<h4>${g.group}</h4>${g.pages.map((p) => `<a href="#/docs/${p.slug}"${p.slug === slug ? ' aria-current="page"' : ""}>${p.title}</a>`).join("")}`,
    ).join("")}
  </nav>
  <div>
    <div class="docs-mobile"><label class="sr" for="docsel" hidden>Page</label>
      <select id="docsel">${DOCS.map((g) => `<optgroup label="${g.group}">${g.pages.map((p) => `<option value="${p.slug}"${p.slug === slug ? " selected" : ""}>${p.title}</option>`).join("")}</optgroup>`).join("")}</select>
    </div>
    <article class="prose"><h1>${page.title}</h1>${body}</article>
    <div class="pager">
      ${prev ? `<a href="#/docs/${prev.slug}">Previous<span>${prev.title}</span></a>` : ""}
      ${next ? `<a class="next" href="#/docs/${next.slug}">Next<span>${next.title}</span></a>` : ""}
    </div>
  </div>
  <aside class="toc">${headings.length ? `<h4>On this page</h4>${headings.map((h) => `<a href="#/docs/${slug}#${h[1]}">${h[2]}</a>`).join("")}` : ""}</aside>
</div>`;
}

function notFound() {
  return `<section class="page-head" style="border:0;min-height:50vh"><div class="wrap">
  <h1 class="h2" style="font-size:48px">Page not found</h1>
  <p class="lede">That address doesn't match a page. Search with ⌘K or go back to the home page.</p>
  <div class="hero-actions" style="justify-content:flex-start"><a class="btn btn-light" href="#/">Go home</a></div>
</div></section>`;
}

/* ============================================================
   Hero demo
   ============================================================ */
function initDemo() {
  const root = $("#demo");
  if (!root) return;
  const chat = $(".chat", root);
  const pane = $(".side-pane", root);
  const tabs = $$(".side-tabs button", root);
  let run = 0;
  const state = { env: "", keychain: [], term: "", tab: "env" };

  const renderPane = (flash) => {
    tabs.forEach((t) => t.setAttribute("aria-selected", String(t.dataset.tab === state.tab)));
    let html;
    if (state.tab === "env")
      html = state.env
        ? hl(state.env, "env")
        : '<p class="empty">No keys yet. Your agent hasn\'t connected anything.</p>';
    else if (state.tab === "keychain")
      html = state.keychain.length
        ? state.keychain
            .map(
              (a) =>
                `<span class="com">service</span> keysmith\n<span class="com">account</span> ${a}\n<span class="com">value  </span> <span class="ph">••••••••••••••••</span>  <span class="com">no reveal command</span>\n`,
            )
            .join("\n")
        : '<p class="empty">The Keychain is empty. Keys appear here when a service connects.</p>';
    else
      html = state.term
        ? hl(state.term)
        : '<p class="empty">Nothing running. Your app starts here once services are connected.</p>';
    pane.innerHTML = html;
    if (flash) {
      pane.classList.remove("flash");
      void pane.offsetWidth;
      pane.classList.add("flash");
    }
  };
  tabs.forEach((t) =>
    t.addEventListener("click", () => {
      state.tab = t.dataset.tab;
      renderPane();
    }),
  );

  const add = (who, html) => {
    const el = document.createElement("div");
    el.className = "msg";
    el.innerHTML = `<span class="who">${who}</span><div class="body">${html}</div>`;
    chat.appendChild(el);
    return el;
  };
  const typing = async (id) => {
    const el = add("agent", '<span class="typing"><i></i><i></i><i></i></span>');
    await wait(900);
    el.remove();
    return id === run;
  };
  const waitClick = (btn) => new Promise((r) => btn.addEventListener("click", r, { once: true }));

  async function play() {
    const id = ++run;
    chat.innerHTML = "";
    $(".mac-dialog-scrim", root)?.remove();
    Object.assign(state, { env: "", keychain: [], term: "", tab: "env" });
    renderPane();

    await wait(400);
    if (id !== run) return;
    add("you", "Add Stripe payments and Resend email.");
    if (!(await typing(id))) return;

    const t1 = add(
      "agent",
      `<div class="tool"><div class="call">connect(<b>"stripe"</b>)</div><div class="res wait">Approve pairing code in your browser</div>
       <div class="human-action"><span class="code-chip">BDJT-GTZJ</span><button class="btn btn-brass btn-sm pulse" type="button">Allow in browser</button></div></div>`,
    );
    const allow = $("button", t1);
    await waitClick(allow);
    if (id !== run) return;
    $(".human-action", t1).remove();
    $(".res", t1).className = "res ok";
    $(".res", t1).textContent = "Stripe connected. Test mode, account acct_1T4s…";
    state.env = ENV_STRIPE;
    state.keychain.push("myapp/stripe/STRIPE_SECRET_KEY");
    state.tab = "env";
    renderPane(true);

    if (!(await typing(id))) return;
    const t2 = add(
      "agent",
      `<div class="tool"><div class="call">connect(<b>"resend"</b>)</div><div class="res wait">Paste one Resend key into the macOS dialog</div></div>`,
    );
    await wait(500);
    if (id !== run) return;
    const stored = await resendDialog(id);
    if (id !== run) return;
    if (!stored) {
      $(".res", t2).textContent = "Dialog canceled. Nothing was stored.";
      const retry = add(
        "agent",
        `Want to try again? <button class="btn btn-ghost btn-sm" type="button" style="margin-left:8px">Show the dialog</button>`,
      );
      await waitClick($("button", retry));
      if (id !== run) return;
      retry.remove();
      $(".res", t2).textContent = "Paste one Resend key into the macOS dialog";
      if (!(await resendDialog(id))) return play();
    }
    $(".res", t2).className = "res ok";
    $(".res", t2).textContent = "Resend connected. Sending-only key stored.";
    state.env = ENV_STRIPE + "\n" + ENV_RESEND;
    state.keychain.push("myapp/resend/RESEND_API_KEY", "myapp/resend/full-access (vault only)");
    renderPane(true);

    if (!(await typing(id))) return;
    add(
      "agent",
      `Both services are connected and your <code>dev</code> script now starts with <code>keysmith run</code>. I never saw either key.`,
    );
    await wait(700);
    if (id !== run) return;
    state.tab = "term";
    state.term = `$ npm run dev
> keysmith run -- next dev
  ▲ Next.js 15  ready on http://localhost:3000

$ keysmith run -- node -e 'console.log(process.env.STRIPE_SECRET_KEY)'
[keysmith:redacted]`;
    renderPane(true);
  }

  function resendDialog(id) {
    return new Promise((resolve) => {
      const scrim = document.createElement("div");
      scrim.className = "mac-dialog-scrim";
      scrim.innerHTML = `<div class="mac-dialog" role="dialog" aria-label="Keysmith secure paste">
        <div class="icon">${icons.key}</div>
        <h4>Keysmith wants a Resend API key</h4>
        <p>Paste a Full access key from resend.com/api-keys. It goes straight to your Keychain. Your agent won't see it.</p>
        <div class="mac-field"><span class="dots"></span><span class="caret"></span></div>
        <div class="mac-actions"><button type="button" data-a="cancel">Cancel</button><button type="button" class="primary" data-a="ok" disabled>Store in Keychain</button></div>
      </div>`;
      root.appendChild(scrim);
      const dots = $(".dots", scrim);
      const ok = $('[data-a="ok"]', scrim);
      (async () => {
        await wait(600);
        for (let i = 0; i < 18 && id === run && scrim.isConnected; i++) {
          dots.textContent += "•";
          await wait(28);
        }
        ok.disabled = false;
        ok.focus({ preventScroll: true });
      })();
      scrim.addEventListener("click", (e) => {
        const a = e.target.closest("button")?.dataset.a;
        if (!a) return;
        scrim.remove();
        resolve(a === "ok");
      });
    });
  }

  $(".replay", root).addEventListener("click", play);
  play();
}

function initCliTerm() {
  const root = $("#cli-term");
  if (!root) return;
  const out = $(".term-out", root);
  const btns = $$(".term-list button", root);
  const show = (i) => {
    btns.forEach((b) => b.setAttribute("aria-selected", String(+b.dataset.i === i)));
    const c = CLI[i];
    out.innerHTML = `<p class="desc">${c.desc}</p><pre>${hl(c.out).replace(/^\$ /gm, '<span class="prompt">$ </span>').replace(/✓/g, '<span class="okc">✓</span>')}</pre>`;
  };
  btns.forEach((b) => b.addEventListener("click", () => show(+b.dataset.i)));
  root.addEventListener("keydown", (e) => {
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
    const cur = btns.findIndex((b) => b.getAttribute("aria-selected") === "true");
    const n =
      (cur + (e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1) + btns.length) %
      btns.length;
    btns[n].focus();
    show(n);
    e.preventDefault();
  });
  show(0);
}

/* ============================================================
   Router
   ============================================================ */
function route() {
  const hash = location.hash.replace(/^#/, "") || "/";
  const [path, anchor] = hash.split("#");
  const parts = path.split("/").filter(Boolean);
  let html;
  let section = "";
  if (!parts.length) html = homePage();
  else if (parts[0] === "docs") {
    html = docsPage(parts[1] || "introduction");
    section = "docs";
  } else if (parts[0] === "integrations") {
    html = parts[1] ? servicePage(parts[1]) : integrationsPage();
    section = "integrations";
  } else if (parts[0] === "security") {
    html = securityPage();
    section = "security";
  } else if (parts[0] === "roadmap") {
    html = roadmapPage();
    section = "roadmap";
  } else html = notFound();

  const main = $("#main");
  const samePage = main.dataset.path === path;
  if (!samePage) {
    main.innerHTML = html;
    main.dataset.path = path;
    $$(".nav-links a").forEach((a) =>
      a.dataset.nav === section
        ? a.setAttribute("aria-current", "page")
        : a.removeAttribute("aria-current"),
    );
    const title = $("h1", main)?.textContent;
    document.title = parts.length && title ? `${title} | Keysmith` : "Keysmith";
    initDemo();
    initCliTerm();
    $("#docsel")?.addEventListener("change", (e) => (location.hash = `#/docs/${e.target.value}`));
  }
  closeMenu();
  if (anchor) document.getElementById(anchor)?.scrollIntoView();
  else if (!samePage) {
    window.scrollTo(0, 0);
    main.focus({ preventScroll: true });
  }
}

/* ============================================================
   Global UI: menu, copy, reveal, palette
   ============================================================ */
const nav = $(".nav");
const menuBtn = $(".menu-btn");
function closeMenu() {
  nav.classList.remove("open");
  menuBtn.setAttribute("aria-expanded", "false");
}
menuBtn.addEventListener("click", () => {
  const open = nav.classList.toggle("open");
  menuBtn.setAttribute("aria-expanded", String(open));
});

document.addEventListener("click", (e) => {
  const c = e.target.closest("[data-copy]");
  if (c) return copyText(c.dataset.copy);
  if (e.target.closest("[data-reveal]"))
    toast("There's no reveal command. Values exist only inside the running process.");
});

const PALETTE_ITEMS = [
  { title: "Home", href: "#/", kind: "Page" },
  { title: "Integrations", href: "#/integrations", kind: "Page" },
  { title: "Stripe", href: "#/integrations/stripe", kind: "Integration" },
  { title: "Resend", href: "#/integrations/resend", kind: "Integration" },
  { title: "Security", href: "#/security", kind: "Page" },
  { title: "Roadmap", href: "#/roadmap", kind: "Page" },
  ...DOC_PAGES.map((p) => ({ title: p.title, href: `#/docs/${p.slug}`, kind: "Docs" })),
  ...CLI.map((c) => ({ title: `keysmith ${c.cmd}`, href: "#/docs/cli", kind: "Command" })),
  ...MCP_TOOLS.map(([n]) => ({ title: n, href: "#/docs/mcp", kind: "MCP tool" })),
];
const pal = $(".palette");
const palInput = $("input", pal);
const palList = $("ul", pal);
let palSel = 0;
let palResults = [];
let palReturn = null;

function renderPalette() {
  const q = palInput.value.trim().toLowerCase();
  palResults = PALETTE_ITEMS.filter((i) => !q || `${i.title} ${i.kind}`.toLowerCase().includes(q));
  palSel = Math.min(palSel, Math.max(0, palResults.length - 1));
  palList.innerHTML = palResults.length
    ? palResults
        .map(
          (r, i) =>
            `<li role="option" aria-selected="${i === palSel}" data-i="${i}"><span>${esc(r.title)}</span><small>${r.kind}</small></li>`,
        )
        .join("")
    : `<li class="none">No results for "${esc(palInput.value)}". Try a command name like rotate.</li>`;
  palList.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
}
function openPalette() {
  palReturn = document.activeElement;
  pal.hidden = false;
  palInput.value = "";
  palSel = 0;
  renderPalette();
  palInput.focus();
}
function closePalette() {
  pal.hidden = true;
  palReturn?.focus?.();
}
function choose(i) {
  const r = palResults[i];
  if (!r) return;
  closePalette();
  location.hash = r.href;
}
$$("[data-open-palette]").forEach((b) => b.addEventListener("click", openPalette));
palInput.addEventListener("input", () => {
  palSel = 0;
  renderPalette();
});
palList.addEventListener("click", (e) => {
  const li = e.target.closest("li[data-i]");
  if (li) choose(+li.dataset.i);
});
pal.addEventListener("click", (e) => {
  if (e.target === pal) closePalette();
});
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (pal.hidden) openPalette();
    else closePalette();
    return;
  }
  if (pal.hidden) return;
  if (e.key === "Escape") closePalette();
  else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    palSel =
      (palSel + (e.key === "ArrowDown" ? 1 : -1) + palResults.length) %
      Math.max(1, palResults.length);
    renderPalette();
  } else if (e.key === "Enter") choose(palSel);
});

window.addEventListener("hashchange", route);
route();
