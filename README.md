# UIFlow: record once, replay forever

An LLM figures out how to do a task in a legacy web app the first time. What it
learned becomes a typed, versioned, reviewable **capability**. After that the
capability is replayed deterministically — no model in the decision loop.

Built against [ParaBank](https://parabank.parasoft.com), a JSP demo banking app
whose login form has no `<label for>`, no test IDs, `jsessionid` in every URL,
and inputs with no accessible name. That is the point: it is the profile of the
back-office software this system exists for.

## Quick start

```bash
docker run -d -p 8080:8080 --name parabank parasoft/parabank
until curl -sf -o /dev/null http://localhost:8080/parabank/index.htm; do sleep 3; done
curl -sL -o /dev/null http://localhost:8080/parabank/initializeDB.htm
```

```bash
npm install && npx playwright install chromium
cp .env.example .env      # add GOOGLE_API_KEY
```

Replay needs no API key at all:

```bash
npm run replay -- --artifact examples/read_account_balance.json --param account_id=12345
```

In Windows PowerShell the `--` is swallowed before it reaches the script, so
`--artifact` arrives missing. Call the CLI directly instead:

```bash
npx tsx src/index.ts replay --artifact examples/read_account_balance.json --param account_id=12345
```

Discovery does:

```bash
npm run discover -- --goal "read the balance for account 12345" --param account_id=12345
```

## Demo UI

```bash
npm run ui        # http://127.0.0.1:8801
```

A page over the same CLI:

- **Discover** — type a goal in plain English and watch the model drive the browser,
  with a live view, the stage it is in, and a count of model calls and tokens.
- **Replay** — pick any capability, fill in its parameters, and watch it run with the
  model-call counter stuck at zero. Each step shows which locator candidate won.
- **Capabilities** — two capabilities side by side: their steps, ranked locators,
  and whether they declare any business outcomes.
- **Human handoff** — tick "let a human take over" and a suspended run opens the
  operator console inside the page. A *repair* (an element that cannot be found)
  gets click and type controls. An *approval* (an irreversible step) gets a
  read-only screenshot and two buttons, because the operator's job there is to
  decide, not to do the step by hand.
- **Clear** wipes the page and the server's memory of the last run, for a clean
  start. A page that reconnects is otherwise shown the last run again.

Each run is the real `src/index.ts` command started as a child process, so nothing
the page shows is simulated. Runs are headless by default so the browser is seen
once, in the page; there is a checkbox to show the real window as well. One run at
a time. The page binds to `127.0.0.1` only (`UI_PORT` changes the port, default
8801) and serves nothing but capability JSON under `examples/` and `runs/`.

Narration and slide material for recording a demo lives in `docs/`:
`narration-script.md`, `idea-slide.pptx`, and `make-audio.ps1`, which turns the
script into one WAV per scene with the voices built into Windows
(`pwsh -File docs/make-audio.ps1 -ListVoices`; use `pwsh`, as Windows PowerShell
sees fewer voices).

## What ships as evidence

`examples/read_account_balance.json` is hand-written — the reference the schema
was designed against. It is generated from `examples/read_account_balance.ts`
(`npm run build-example`), which also recomputes its integrity hash; edit the
`.ts`, not the JSON.

`examples/discovered/` is the real thing: a capability Gemini discovered, plus
the trace it was compiled from. `examples/discovered-write/` is the same for a
flow that cannot be undone, opening a savings account, and is what
`confirm-check` and the approval handoff use. Neither needs an API key to
inspect, and the compiler can be re-run over the first offline:

```bash
npm run recompile -- --run examples/discovered
```

That is also how compiler iteration stays free — discovery is the expensive
half, and changing how a trace is distilled should not cost a run.

## The two halves

| | Discovery | Replay |
|---|---|---|
| Model | yes, one node | **never** |
| Cost | dollars | fractions of a cent |
| Runs | once per flow | thousands |
| Output | a capability artifact | typed outputs, or a declared outcome |

`src/replay/` imports nothing from `src/providers/`. That is the guarantee, held
by the import graph rather than by discipline.

## How targeting survives

A step does not carry a selector. It carries a **ranked bundle of candidate
strategies** with a confidence and a written rationale each, and replay takes
the first that resolves *uniquely*.

This is not defensive padding. On ParaBank's login the obvious approach —
`getByRole("textbox", {name: "Username"})` — matches nothing, because the input
has no accessible name. The label is a bold paragraph sitting next to it. So
`label_proximity` carries the step, `field_name` backs it up, and CSS is last.

The same mechanism is the multi-tenant answer: a rebrand breaks the text-based
candidates but not the structural ones, and an older version breaks CSS but not
the label. One recording per vendor product, with a `TenantOverlay` patching the
one locator that differs rather than forking the flow (the overlay schema exists;
applying one at run time is not built yet).

Every run reports **which candidate index won**. Rising indices across runs are
drift showing up before it becomes an outage.

### The model never writes a locator

During discovery the model points at elements by `[ref=eN]` out of the
accessibility tree it was just shown — it cannot invent a ref that resolves.
The durable candidates are then **harvested from the element itself**
(`src/discovery/harvest.ts`): role, accessible name, neighbouring label text,
form field name, table header intersection, CSS path.

That also means a coordinate-native computer-use model drops in unchanged:
swap "the element at ref e34" for "the element at (340, 210)" and everything
downstream is identical.

## Three kinds of thing going wrong

The distinction lives in the **schema**, not in replay code, so it is reviewable
per capability and the engine stays dumb:

- `contract.outcomes` — **legitimate answers that are not success.**
  `ACCOUNT_NOT_FOUND` is a result the caller asked for, not a crash. Declared in
  the contract with a detector, so a calling agent knows in advance it may come
  back.
- `recoveries` — **conditions we handle ourselves.** Session expiry, a transient
  500. Declared and bounded, so "dismiss the interstitial" is a reviewed
  behaviour rather than a global heuristic that might dismiss a real dialog.
- anything undeclared — **hard failure**, with the step, what was expected and
  what was observed.

Ordering matters, and it is the subtlest part: a declared business outcome
*explains* a step failure and outranks escalation. The balance cell failing to
resolve because the account does not exist is an answer — summoning a human for
it would be a bug.

Verified end to end against the live app (`npm run taxonomy-check`):

```
PASS  happy path           success {"balance":-2300}
PASS  unknown account      business_outcome/ACCOUNT_NOT_FOUND
PASS  bad credentials      business_outcome/LOGIN_FAILED
PASS  missing parameter    failed/MISSING_INPUT
PASS  tampered artifact    failed/INTEGRITY_MISMATCH
```

## Tests

```bash
npm test          # 74 unit tests, no browser, no container, no API key
npm run typecheck # the TypeScript compiler, no output files
```

Pure logic only — locator bundle construction, value coercion, policy,
integrity, secrets, redaction. The integration checks below need a live
container and are run separately.

| Script | Covers |
|---|---|
| `npm run taxonomy-check` | all four replay result branches |
| `npm run handoff-check` | pause, human acts, resume, complete |
| `npm run confirm-check` | an operator authorising an irreversible step |
| `npm run resolve-check` | locator bundles against the live app |

## Safety

- **Allowlist per tenant**, intersected with what the capability declares. A
  capability can narrow its permissions, never widen them. Denies beat allows —
  ParaBank's `initializeDB.htm` wipes the database and sits under an otherwise
  allowed path prefix.
- **Irreversible steps** (money movement, account creation) default to
  requiring a human decision. Blocking is recoverable; a wrong transfer is not.
- **Secrets are references.** An artifact carries
  `{from: "secret", secret: "tenant.parabank.operator_password"}`; the value is
  fetched at the moment of use, restricted to what the capability declared, and
  registered with the logger so it redacts even if something interpolates it.
  There is no field where a credential could be written.
- **Integrity**: canonical hash verified before execution. An artifact edited
  after review will not run.
- **Ambiguity fails.** Acting on the wrong row in a banking grid is worse than
  not acting.

## Human handoff

```bash
npm run replay -- --artifact <path> --param account_id=12345 --operator 8790
```

With a console attached, an escalation **suspends** the run instead of ending
it. The browser is never torn down. `cedeControl()` flips a single-valued owner
marker; from that instant every automation entry point throws and only the
operator entry points work, so at no moment can both sides act. The operator
drives the same tab, with the same cookies and the same half-filled form, from a
screenshot they click on. When they hand back, the run resumes from the step
that stopped.

An irreversible step is handled differently, because it is a decision and not a
repair. The console shows the screen read-only with two buttons, *Approve &
resume* and *Refuse*. Approving lets the automation perform the step itself,
once. The operator must not click the button on the page: do it by hand and the
resumed step then fails, because the button it wants has already gone.

Everything the human did is recorded — redacted — and returned to the caller on
`result.humanActions`, because a caller that gets a success needs to know
whether a person had to touch it.

Verified end to end (`npm run handoff-check`) with the realistic failure: the
automation is given a password that has been rotated, login is refused, a human
signs in by hand, and the run completes.

```
PASS  intervention raised
PASS  controller flipped to human
PASS  automation is locked out during the handoff
PASS  operator actions recorded (7)
PASS  password the operator typed was not stored
PASS  control returned to automation
PASS  run resumed and completed (status: success)
PASS  output produced after the handoff: {"account_12345_balance":"-$2300.00"}
```

## Layout

```
src/artifact/     the schema — capability, locator, conditions, result, integrity
src/replay/       deterministic execution. no model, no provider imports
src/discovery/    LangGraph pipeline: prepare -> observe -> decide -> act -> compile
src/surface/      the seam. driver.ts is the interface; playwright is one impl
src/providers/    LangChain chat models, provider factory, prompt compression
src/config/       tenant config, allowlist, secret store
src/escalation/   the operator console: suspend a run, hand the session to a person
src/obs/          structured logging with redaction at the boundary
src/ui/           the demo UI (server.ts + one static page)
scripts/          integration checks against the live app (see Tests)
tests/            unit tests, no browser or container
examples/         capabilities: one hand-written, two discovered
docs/             slide, narration script and audio generator for a demo recording
```

`src/surface/driver.ts` is the seam the write-up's §3.7 answer rests on. The
verbs are `click` / `type` / `read` — what a human operator would recognise, and
what means the same thing on a Windows UIA surface. Nothing above that line
imports Playwright.

## Switching providers

One env var, `AI_PROVIDER`, with the seam being LangChain's `BaseChatModel` so
the agent loop never learns which provider is behind it. Adding one is an entry
in the `PROVIDERS` map in `src/providers/aiProvider.ts`.

Free-tier quotas are lower than documented and vary per model — `gemini-3.5-flash`
reported a limit of 5 requests/minute — so the provider paces itself and honours
the server's own `retryDelay` on a 429.

## Known gaps

- `flow.steps` is a flat list: no loops, no branches. "Read the balance for every
  account" cannot be expressed yet. Deliberate — a step list is reviewable by a
  human in a way a small programming language is not.
- Compiled capabilities land as `review: draft` with an empty `outcomes` list.
  Discovery only ever sees the happy path, so anything written there
  automatically would be a guess wearing the costume of a reviewed decision.
- A compiled capability can declare an input that no step uses. `open_savings_account`
  declares `funding_account_id`, but no step selects the funding account, so the
  form's default (the first account in its list) pays whatever value is passed.
  Discovery saw "12345" once and generalised it into a parameter without wiring it
  to anything. It is another reason a discovered capability stays a draft until a
  person reviews it.
- If an operator performs an irreversible step by hand instead of approving it, the
  resumed run does not notice and fails on the step it expected to do itself.
  The console now steers approvals away from this, but the engine does not detect it.
- `TenantOverlay` is schema only. Nothing applies an overlay at run time.
- Review status is recorded, not enforced: replay runs a `draft` capability the
  same as an `approved` one.
- Web only. The desktop driver is designed for, not built.

## Future state

These items are gaps in the current code. Each item describes the planned state.
None of them exists today, except where an item says what exists.

**Review and approval**

- A command signs a capability file again after a person edits it. Today an edit
  changes the hash, and no command calculates it again. The `contentHash`
  function in `src/artifact/integrity.ts` already does the calculation.
- A different person approves the file than the person who made it. The approval
  record stores the reviewer name and the time.
- A web interface lets the support team start a discovery run, add outcomes and
  recoveries, and approve a file. The interface shows secret names only. It never
  shows secret values. Today the demo UI (`npm run ui`) can start a discovery run
  and replay a capability on one machine, and show a capability's steps and
  locators. It cannot add outcomes or recoveries, approve a file, or edit anything.
- The compiler makes better drafts. It sets the output type from the value read
  (for example `money`). It adds checks after the steps. It does not put one test
  value in an output name.

**Policy**

- Replay checks that each step action appears in `policy.requires.actions`.
  Today only the tenant check uses this list.
- The compiler writes the pages that the flow visited into
  `policy.requires.pathPrefixes`. Today it copies the whole tenant allowlist.
- `allow_with_audit` writes an audit record. Today it only allows the step.

**Tenants and secrets**

- The tenant policy is stored by tenant ID, in a file or a database. Today one
  tenant is fixed in `src/config/config.ts`.
- A vault supplies the secrets. The `SecretStore` interface in
  `src/config/secrets.ts` is ready for it. Today the secrets come from `.env`.
- A run selects the login account at run time. Today each capability file names
  one fixed secret for each field.

**Handoff**

- The operator console needs a sign-in. The operator name comes from the sign-in.
  Today the operator types the name.
- The operator console is reachable by the whole team, behind a sign-in. Today it
  has no sign-in and listens only on `127.0.0.1`, and it refuses any request whose
  Host or Origin is not its own.
- A shared queue shows the open interventions. The system makes sure that only
  one operator holds a run at one time.
- An `escalated` or `failed` result starts an alert or a ticket. Today replay only
  prints the result.
- An operator can turn a repeated escalation into a new outcome or recovery.
