# UIFlow demo: narration script

About 8 minutes. One block per scene, so each scene can be recorded, voiced and
re-done on its own. Sentences are short and spoken-style so a text-to-speech voice
reads them cleanly. Times are targets for the narration, not the raw screen time.

Pronunciation: UIFlow is "you-eye flow". ParaBank is "para bank".

---

## Scene 1 — The idea (45 seconds)
*On screen: the slide, "Record once. Replay forever."*

Most business software was built long before anyone thought about automation. No clean interfaces, no test hooks. Just screens that people click through.

UIFlow works like this. An AI figures out a task once. What it learns is saved as a file that a person can review. After that, the task is replayed with no AI involved at all.

To test this, I chose ParaBank as my legacy application. It is a public demo banking app, and it behaves like the real thing. The login form has no proper labels, no test identifiers, and session ids in every address. That makes it a fair stand-in for the back-office software this is built for.

---

## Scene 2 — Discover (2 minutes)
*On screen: the Discover tab. Type the goal, press Start. The browser appears and acts by itself. Cut the waiting in editing.*

I will describe the task in plain English. Log in as the operator, then read the balance for one account.

That is all I give it. No selectors, no scripts.

Watch the browser. The AI is looking at the screen, choosing the next action, and doing it. It types the username, then the password, then clicks Log In.

This stage is slow, because every decision is a call to a model. That is fine, because it happens once.

Now it opens the accounts overview and reads the balance. It decides the goal is met, and stops.

---

## Scene 3 — The capability (1 minute)
*On screen: the Capabilities tab, the new draft on the left.*

Here is what it produced. Not a recording of clicks, but a capability: a file with inputs, outputs and steps.

Look at one step. It does not hold a single selector. It holds a ranked list of ways to find the element, each with a confidence and a reason. If the page changes, the next best option takes over.

And notice the status. This is a draft. It declares no business outcomes yet. A person adds those during review. I will come back to that.

---

## Scene 4 — Replay with no model (1 minute)
*On screen: Replay tab, the new capability, account 12345. Run it, then run it again.*

Now I replay it. Same task, but look at the counters. Model calls: zero. Tokens: zero.

It finishes in seconds and returns the balance.

On the right, each step shows which option found its element. Number one is the best. If a step starts needing number two or three, the application is drifting, and you find out before anything breaks.

I can run it again, and again, with any account. Slow and costly once. Fast and almost free after that.

---

## Scene 5 — When the answer is "no such account" (2 minutes)
*On screen: Replay tab. Run the draft with account 12346, then the reviewed capability with the same account.*

Real tasks do not always go well. Let me ask for an account that does not exist.

First, the draft. It cannot find the balance, and it was never told what that means. So it does not guess. It escalates.

Now the same request on the reviewed capability. A person has declared that a missing account is a legitimate answer. This time the result is a clear business outcome: account not found. Not a crash. Nobody gets paged. The calling system knows exactly what happened.

That is the difference review makes. Same flow, same input, and a vague escalation becomes a precise answer.

---

## Scene 6 — A decision only a person should make (1 minute 30 seconds)
*On screen: Replay tab. The savings account capability, funding account 12345, "let a human take over" ticked. Run it. The console opens in the page. Approve it there.*

Some actions should never be automatic. Opening a new account cannot be undone.
Its  an irreversible step.
So I run a capability that does exactly that, and I turn on human takeover.

It logs in and fills in the request. Then it reaches the step that cannot be undone, and it stops. The browser stays open, on the same page and in the same session. Automation is locked out, so only one side can act at a time.

The request now waits in the operator console, right here. The person can see where it stopped and why. They review it, and they approve.

Control goes back to the automation. It finishes the job, and returns the new account number. Everything the person did is recorded with the result.

Blocking is recoverable. A wrong transfer is not. That is why a person makes this call.

---

## Scene 7 — Close (30 seconds)
*On screen: the slide, or the Run tab with the last result.*

The AI learns the task once. Replay is cheap and predictable. Known situations become clear answers. And anything unexpected goes to a person, instead of being guessed at.

Thank you.
