# Design notes

Write-up for the computer-use automation take-home. The README covers how to run
it; this covers why it is shaped the way it is, and answers §3.7, which is
design-only.

Everything asserted here was verified against a live app. Where something is
untested or unresolved I say so.

---

## 1. The central bet

Discovery and replay are not two modes of one system. They are two systems with
opposite requirements, joined by a document.

|  | Discovery | Replay |
|---|---|---|
| Needs | to handle a screen nobody has seen before | to do the same thing identically, forever |
| Tolerates | slowness, cost, non-determinism | none of those |
| Model | yes, in exactly one node | never |
| Frequency | once per flow | thousands of times |

Treating them as one system produces the worst of both: an agent that is slow
and expensive in production, or a replayer too rigid to have ever been recorded.
Splitting them puts all the intelligence in the cheap half and all the
reliability in the expensive-to-get-wrong half.

The guarantee is structural rather than aspirational: `src/replay/` imports
nothing from `src/providers/`. There is no code path by which replay can call a
model, because the module graph does not contain one.

The document joining them — the **capability artifact** — is therefore the most
important thing in the repo, and got the most design attention.

---

## 2. Targeting: a ranked bundle, not a selector

This is the decision I would defend hardest.

A step does not say "click `#loginBtn`". It carries an ordered list of candidate
strategies, each with a confidence and a written rationale, and replay takes the
first that resolves **uniquely**.

I did not arrive at this from first principles; the target app forced it. On
ParaBank's login screen the obvious approach fails outright:

```
- paragraph [ref=e32]: Username
- textbox [active] [ref=e34]          ← no accessible name
- paragraph [ref=e35]: Password
- textbox [ref=e37]                   ← no accessible name
- button "Log In" [ref=e39]           ← this one has a name
```

`getByRole("textbox", { name: "Username" })` matches nothing. The label is a
bold paragraph sitting next to the input, with no `for` attribute joining them.
So `label_proximity` — find the visible text, take the nearest control of the
expected role — is not a fallback here, it is the only thing that works. The
Log In button, which does have a name, resolves by `role_name`.

Ordering is by **expected durability**, not by what the recorder found first:

1. `role_name` — most portable, and the only strategy that ports to a desktop
   UIA surface unchanged
2. `table_cell` — header-relative row/column intersection; survives reordering,
   paging and added columns
3. `label_proximity` — survives rebranding and id churn
4. `field_name` — stable per vendor product, not per tenant
5. `css` — always available, encodes incidental structure

### Two rules that fall out of this, both safety properties

**Ambiguity fails.** `match.onMultiple` defaults to `"fail"`, not `"first"`.
Clicking the wrong row in a banking grid is worse than not clicking.

**A candidate that cannot express the parameter must not answer the question.**
This one I learned the hard way, and it is the most important line in the
codebase. Before the fix, asking for a nonexistent account returned
`-$2300.00` and reported **success** — resolution had fallen through to the CSS
path `tr:nth-of-type(1) > td:nth-of-type(2)`, which is positional, so it
returned the *first row's* balance. A query about one customer answered with
another customer's money, silently.

The cause is structural: a candidate containing no `${account_id}` is incapable
of discriminating between rows. So the compiler now drops non-parameterised
candidates from any bundle where another candidate is parameterised
(`src/discovery/harvest.ts`). That can leave a target with fewer fallbacks, and
that is the correct trade — failing to resolve is recoverable, a confidently
wrong balance is not.

### The model never writes a locator

During discovery the model points at elements by `[ref=eN]` out of the
accessibility tree it was just shown. It cannot invent a ref that resolves. We
then **harvest** the durable identifiers from the element it chose — role,
accessible name, neighbouring label text, form field name, table header
intersection, CSS path — and build the bundle ourselves.

This is strictly better than asking a model to author selectors, and it is why
the design ports to a coordinate-native computer-use model without change: swap
"the element at ref e34" for "the element at (340, 210)" and everything
downstream is identical. (Google's `gemini-2.5-computer-use-preview` is exactly
that shape. It has no free-tier quota — `limit: 0` — so it is designed for, not
built against.)

---

## 3. Three kinds of thing going wrong

The brief's hardest requirement is distinguishing expected business outcomes,
recoverable conditions, and hard failures. I put that distinction in the
**schema**, not in replay code:

- `contract.outcomes` — legitimate answers that are not success. Declared with a
  detector, so a calling agent knows in advance that `ACCOUNT_NOT_FOUND` may come
  back and what shape it arrives in. It is part of the function signature.
- `recoveries` — conditions the run handles itself, declared and bounded. This
  is why "dismiss the maintenance banner" is a reviewed, scoped behaviour rather
  than a global heuristic that might one day dismiss a real confirmation dialog.
- everything undeclared — hard failure, reporting the step, what was expected
  and what was observed.

The engine stays dumb. It does not decide what counts as an error; the artifact
declares it and a human reviewed that declaration.

**Ordering is the subtle part**, and I got it wrong first. A declared business
outcome *explains* a step failure and outranks escalation. The balance cell
failing to resolve because the account does not exist is an answer the caller
asked for — escalating it summons a person to answer a question the artifact
already knows. The catch order is: business outcome → recovery → escalation →
hard failure.

Scoping matters too. `BusinessOutcome.appliesTo` exists because an unscoped
detector fires at the wrong time: "no balance cell for this account" is
trivially true on the login screen, so an unscoped `ACCOUNT_NOT_FOUND` would
fire at step one.

Verified against the live app (`npm run taxonomy-check`):

```
PASS  happy path           success {"balance":-2300}
PASS  unknown account      business_outcome/ACCOUNT_NOT_FOUND
PASS  bad credentials      business_outcome/LOGIN_FAILED
PASS  missing parameter    failed/MISSING_INPUT
PASS  tampered artifact    failed/INTEGRITY_MISMATCH
```

---

## 4. §3.7a — Surface abstraction

> *What's the seam between "how we perceive/act on a surface" and "the recorded
> flow"?*

The seam is `src/surface/driver.ts`. Nothing above it imports Playwright. The
artifact schema, the replay engine, the error taxonomy, the discovery loop and
the escalation machinery are all written against that interface.

Three properties make it portable rather than merely abstracted:

**The verbs are what a human operator would recognise.** `click`, `type`,
`select`, `press`, `read`, `navigate`. Not `dispatchPointerEvent`. "Click the
control named Log In" survives a port to a desktop app; "dispatch a pointer
event at (340, 210)" does not. This is the level at which a recorded flow stays
true across surfaces.

**Perception is the accessibility tree, not the DOM.** `observe()` returns
`page.ariaSnapshot({ mode: "ai" })` — roles, names, structure, and `[ref=eN]`
handles, descending into framesets. Chosen over markup for three reasons: it is
an order of magnitude cheaper in tokens, it is what a model can actually reason
over, and **it is the representation a desktop surface can also produce**.
Windows UI Automation exposes a control type and a Name for every element; that
is the same shape.

**Locator strategies are per-surface, the bundle is not.** The `Locator`
schema — ranked candidates, confidence, match policy, region scoping — is
surface-neutral. Which `using` values a driver can honour is not.

### What a port actually costs

| Surface | Driver work | Schema work |
|---|---|---|
| Modern web app | none | none |
| Legacy web app (framesets, table soup) | none — this is the built case | none; `region.framePath` already exists |
| Windows desktop (UIA) | new driver: perception via UIA tree, actions via UIA patterns | add `automation_id` and `uia_path` candidate kinds |
| Terminal / green-screen | new driver: screen-buffer perception, keystroke actions | add `screen_region` candidate kind (row/column) |

For the desktop case specifically: `role_name` maps almost directly onto UIA's
ControlType + Name, which is why it is ranked first. `table_cell` maps onto the
UIA Grid pattern. `label_proximity` maps onto the LabeledBy property with the
same geometric fallback. `field_name` and `css` have no analogue and would
simply never appear in a desktop artifact — the bundle degrades, which is what
it is for.

The honest limit: `describeTarget()` currently returns a DOM-flavoured
`HarvestedTarget`. A desktop driver would populate the same fields from UIA, but
the interface leans slightly web-ward (`cssPath`, `formName`) and would want a
small generalisation. I would rather note that than claim the abstraction is
cleaner than it is.

---

## 5. §3.7b — Multi-tenant reuse and drift

> *Hundreds of tenants, ~20 apps each, many running the same vendor product
> configured, branded and versioned differently. How do you avoid re-recording
> per tenant, and how do you manage drift?*

### Bind artifacts to products, not tenants

`Capability.app` names a **product** (`parabank`) and a version range. It does
not name a tenant, a hostname or a credential. Base URL, secrets and allowlist
come from tenant config at invocation time.

So the unit of recording is one flow per vendor product, not per tenant.
Hundreds of tenants sharing a core banking product share one artifact.

### The bundle already spans the axis tenants vary on

This is the part that makes the claim more than an assertion. Tenants of the
same product differ along predictable axes, and different candidate strategies
fail along different ones:

| Tenant difference | Breaks | Survives |
|---|---|---|
| Rebranded labels, translated UI | `label_proximity`, `text` | `field_name`, `table_cell`, `css` |
| Restyled / re-themed | `css` | everything else |
| Different product version | `css`, sometimes `field_name` | `role_name`, `label_proximity` |
| Extra approval step configured on | nothing — needs an overlay | — |

A single artifact therefore covers most tenant variation with no
per-tenant work, because the strategies that break are not the strategies that
carry the step.

I have partial evidence rather than proof: the footnote-marker case is real and
handled. ParaBank labels its balance column `Balance*`, and the compiled
artifact hardcoded that. Rather than re-record for a tenant whose column reads
`Balance`, header matching falls back to ignoring trailing punctuation. That is
exactly the shape of cosmetic per-tenant variance, caught in the wild.

I did **not** get to run one artifact against two differently-configured
instances. Both a local container and the public ParaBank are live, so the
experiment is cheap; I ran out of time before doing it, and I would not claim
the multi-tenant story is validated until I have.

### Overlays, deliberately narrow

Where a tenant genuinely differs, `TenantOverlay` patches the base rather than
forking it. An overlay may:

- `retarget` one locator by id
- adjust a `timeout`
- `insert_step` / `skip_step`
- `add_recovery` / `add_outcome`

It may **not** change the contract. Callers must see identical inputs and
outputs across tenants or the whole reuse story collapses into per-tenant
special-casing. The risk is real — some tenant will eventually need an extra
required input, forcing a fork of the base capability — and I think that is the
right forcing function rather than a flaw.

Locators carry stable ids precisely so an overlay can retarget one without a
structural diff.

### Drift detection comes free

Every run reports, per locator, **which candidate index won**:

```
enter_username   cand 0  label_proximity   21ms
submit_login     cand 0  role_name         12ms
read_balance     cand 0  table_cell        16ms
```

A capability that used to resolve on candidate 0 and now needs candidate 2 is
still passing — and is one change away from breaking. Aggregate that per tenant
and per capability and you get drift detection as a byproduct of normal
operation, with no synthetic monitoring and no scheduled canaries. Rising
indices are the alert.

The signal is noisier than I would like. Candidate index varies with render
timing: a first pass can miss while the page is still settling and the retry
then wins on candidate 0. In production I would compare distributions over a
window rather than alerting on single runs, and I would want to characterise
that noise properly before trusting a threshold.

### At scale

Thousands of app instances means the registry, not the artifact, does the work:
capabilities keyed by `(product, version range)`, overlays keyed by
`(tenant, capability)`, resolved at invocation. Promotion is per artifact
version with `provenance.review.status` gating production use — a capability a
model wrote is a `draft` until a person signs it off, and the compiler never
emits anything else.

---

## 6. Safety decisions, and why each is conservative

- **Allowlist is intersected, never unioned.** The effective grant is tenant
  allowance ∩ capability declaration. A capability can narrow its permissions;
  it can never widen them. Checked at load, not discovered mid-run.
- **Denies beat allows.** ParaBank's `initializeDB.htm` wipes the database and
  sits *under* an otherwise-legitimate allowed prefix. "Allowed by prefix" is
  not good enough on its own.
- **Irreversible steps require a human by default.** Money movement, account
  creation, anything not undoable from the UI. Blocking is recoverable; a wrong
  transfer is not. *(Implemented and gated; not yet exercised by a capability —
  see §8.)*
- **Secrets are references, not values.** An artifact carries
  `{from: "secret", secret: "tenant.parabank.operator_password"}`. There is no
  field in the schema where a credential could be written, so §3.4 is satisfied
  by construction rather than by a redaction pass someone forgets to update.
  Resolution is restricted to what the capability declared, and every resolved
  value registers with the logger so it redacts even if something interpolates
  it.
- **Integrity is verified before execution.** Canonical key-sorted hash. An
  artifact hand-edited after review will not run.
- **Logs go to stderr.** stdout carries exactly one thing — the result payload —
  because a calling agent pipes it into a JSON parser, and a stray log line
  there is a broken contract rather than a cosmetic nuisance.

---

## 7. Human handoff: the control-transfer model

Two things must be true simultaneously for a handoff to be real: the *session*
survives, and *ownership* is unambiguous at every instant. A system where both
sides can act is worse than one where neither can.

Ownership is single-valued and enforced by the driver. `cedeControl()` flips one
marker; from that instant every automation entry point throws, and only
`operatorClick` / `operatorType` / `operatorPress` / `operatorNavigate` work.
They are mirror images gated in opposite directions.

The browser is never torn down — same tab, same cookies, same half-filled form.
With a console attached, an escalation *suspends* the run: the promise stays
pending, the operator works, and the run resumes from the step that stopped.

What the human did is recorded, redacted, and returned on `result.humanActions`
— part of the result contract rather than buried in a log, because a caller that
gets a success needs to know whether a person had to touch it.

One intervention per step. If the same step stops again after a human touched
it, their fix did not work, and looping them is worse than failing.

Verified with the realistic failure — a rotated password, login refused, a human
signs in by hand, the run completes:

```
PASS  automation is locked out during the handoff
PASS  operator actions recorded (7)
PASS  password the operator typed was not stored
PASS  control returned to automation
PASS  run resumed and completed (status: success)
PASS  output produced after the handoff: {"account_12345_balance":"-$2300.00"}
```

The console itself is deliberately plain — a screenshot you click on, plus
type/press/note and hand-back/abort. The brief permits mocking it; the mechanism
underneath is genuine. Posting coordinates against a live session is what a real
co-browsing console does too, just at 30fps over WebRTC instead of on refresh.

---

## 8. Known gaps

Stated plainly, because a gap I have named is cheaper for a reviewer than one
they find.

- **Recoveries are declared but never triggered.** `SESSION_EXPIRED` and
  `TRANSIENT_APP_ERROR` sit in the example artifact untested. The fault-injection
  proxy that would exercise them (~50 lines between runner and container) was
  designed and not built. This is the gap I would close first: the brief is
  emphatic that runtime conditions are the interesting failures.
- **The irreversible-step gate is untested.** `authorizeStep` blocks money
  movement pending confirmation, but no capability exercises it. A second
  discovered flow — "open a new savings account, stop at the confirmation
  screen" — would prove it and would also make the schema look less fitted to
  one example.
- **`flow.steps` is a flat list.** No loops, no branches. "Read the balance for
  every account" cannot be expressed. Deliberate: a step list is reviewable by a
  human in a way a small programming language is not. It is also the thing most
  likely to need adding.
- **Multi-tenant is unvalidated**, as described in §5.
- **Compiled contracts need a human pass.** The compiler emitted an output named
  `account_12345_balance` — a discovery literal baked into the contract. It now
  warns rather than silently shipping it; auto-renaming identifiers seemed worse
  than flagging.
- **One surface.** Web only. The desktop driver is designed for, not built.

---

## 9. What I would do with another week

In order:

1. Fault injection, so the recoverable branch is demonstrated rather than
   declared.
2. A second capability covering a write flow, to exercise the irreversible gate
   and to pressure-test the schema against a second shape.
3. The two-tenant experiment — one artifact, two ParaBank instances — to turn
   §5 from an argument into a result.
5. A `uia` driver skeleton, far enough to prove the seam holds rather than to
   ship desktop support.
