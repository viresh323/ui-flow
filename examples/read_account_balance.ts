import { writeFileSync } from "node:fs";
import { Capability, SCHEMA_VERSION } from "../src/artifact/index.js";
import { contentHash } from "../src/artifact/integrity.js";

/** Locator bundles are named so tenant overlays can retarget one without a diff. */
const usernameField = {
  id: "username_field",
  describe: "Username input on the customer login panel",
  region: { framePath: [] },
  candidates: [
    // ParaBank has no <label for>, so role+name is unavailable here. The recorder
    // ranked label proximity first because the visible label is what a tenant
    // rebrand is least likely to change.
    {
      candidate: {
        using: "label_proximity" as const,
        labelText: "Username",
        controlRole: "textbox",
        direction: "after" as const,
        maxDistance: 3,
      },
      confidence: 0.85,
      rationale: "Visible label text; survives CSS/branding changes and id churn.",
    },
    {
      candidate: { using: "field_name" as const, name: "username", formName: "login" },
      confidence: 0.8,
      rationale: "Server-rendered form field name; stable across versions of the vendor product.",
    },
    {
      candidate: { using: "css" as const, selector: "form[name=login] input[type=text]" },
      confidence: 0.5,
      rationale: "Structural fallback.",
    },
  ],
  match: { requireUnique: true, minConfidence: 0.4, onMultiple: "fail" as const },
};

const passwordField = {
  ...usernameField,
  id: "password_field",
  describe: "Password input on the customer login panel",
  candidates: [
    {
      candidate: {
        using: "label_proximity" as const,
        labelText: "Password",
        controlRole: "textbox",
        direction: "after" as const,
        maxDistance: 3,
      },
      confidence: 0.85,
    },
    {
      candidate: { using: "field_name" as const, name: "password", formName: "login" },
      confidence: 0.8,
    },
  ],
};

const balanceCell = {
  id: "balance_cell",
  describe: "Balance column for the requested account in the Accounts Overview grid",
  region: { framePath: [] },
  candidates: [
    {
      // The durable way to read a back-office grid: intersect a row identified by
      // its key column with a column identified by its header.
      candidate: {
        using: "table_cell" as const,
        rowMatch: { columnHeader: "Account", equals: "${account_id}" },
        columnHeader: "Balance",
      },
      confidence: 0.9,
      rationale:
        "Header-relative intersection; independent of row order, paging and column count.",
    },
    {
      candidate: { using: "near_anchor" as const, anchorText: "${account_id}", targetRole: "cell" },
      confidence: 0.55,
    },
  ],
  match: { requireUnique: true, minConfidence: 0.4, onMultiple: "fail" as const },
};

const loginButton = {
  id: "login_button",
  describe: "Log In submit button",
  region: { framePath: [] },
  candidates: [
    {
      candidate: { using: "role_name" as const, role: "button", name: "Log In", exact: true },
      confidence: 0.8,
    },
    {
      candidate: { using: "css" as const, selector: "form[name=login] input[type=submit]" },
      confidence: 0.6,
    },
  ],
  match: { requireUnique: true, minConfidence: 0.4, onMultiple: "fail" as const },
};

const draft = {
  kind: "capability" as const,
  schemaVersion: SCHEMA_VERSION,
  id: "read_account_balance",
  version: "1.0.0",
  name: "Read account balance",
  description:
    "Signs in as the configured operator and returns the current balance for a given account number from the Accounts Overview screen. Read-only.",
  surface: "web" as const,
  app: {
    product: "parabank",
    productVersionRange: "*",
    entryPoint: { path: "/parabank/index.htm", requiresSession: true },
  },

  contract: {
    inputs: [
      {
        name: "account_id",
        description: "The account number to read",
        type: { kind: "account_number" as const },
        required: true,
        sensitivity: "pii" as const,
      },
    ],
    outputs: [
      {
        name: "balance",
        description: "Current balance",
        type: { kind: "money" as const, currency: "USD" },
        sensitivity: "pii" as const,
        fromBinding: "balance_text",
        transforms: [
          { op: "trim" as const },
          { op: "strip_currency" as const },
          { op: "to_number" as const },
        ],
        required: true,
      },
    ],
    outcomes: [
      {
        code: "LOGIN_FAILED",
        description: "Operator credentials rejected by the application.",
        detect: { assert: "text_matches" as const, pattern: "could not be verified", flags: "i" },
        outputs: [],
        terminal: true,
        appliesTo: ["submit_login"],
      },
      {
        code: "ACCOUNT_NOT_FOUND",
        description:
          "The requested account is not visible to this operator. A legitimate answer, not a failure.",
        detect: {
          assert: "not" as const,
          of: { assert: "element_present" as const, locator: balanceCell },
        },
        outputs: [],
        terminal: true,
        // Checked where it can first be observed: the balance cell failing to
        // resolve IS the not-found signal.
        appliesTo: ["read_balance"],
      },
    ],
  },

  flow: {
    steps: [
      {
        id: "open_login",
        intent: "Open the ParaBank login page",
        action: {
          do: "navigate" as const,
          url: { from: "literal" as const, value: "/parabank/index.htm" },
        },
        risk: "safe" as const,
        postconditions: [
          { assert: "text_matches" as const, pattern: "Customer Login", flags: "i" },
        ],
      },
      {
        id: "enter_username",
        intent: "Type the operator username",
        action: {
          do: "type" as const,
          target: usernameField,
          value: { from: "secret" as const, secret: "tenant.parabank.operator_user" },
          sensitivity: "secret" as const,
          clearFirst: true,
        },
        risk: "safe" as const,
      },
      {
        id: "enter_password",
        intent: "Type the operator password",
        action: {
          do: "type" as const,
          target: passwordField,
          value: { from: "secret" as const, secret: "tenant.parabank.operator_password" },
          sensitivity: "secret" as const,
          clearFirst: true,
        },
        risk: "safe" as const,
      },
      {
        id: "submit_login",
        intent: "Submit the login form",
        action: { do: "click" as const, target: loginButton },
        risk: "reversible" as const,
        postconditions: [
          {
            assert: "any" as const,
            of: [
              { assert: "text_matches" as const, pattern: "Accounts Overview", flags: "i" },
              { assert: "text_matches" as const, pattern: "could not be verified", flags: "i" },
            ],
          },
        ],
      },
      {
        id: "read_balance",
        intent: "Read the Balance cell for the requested account",
        action: {
          do: "read" as const,
          target: balanceCell,
          source: "text" as const,
          into: "balance_text",
          transforms: [],
        },
        risk: "safe" as const,
      },
    ],
    checkpoint: {
      description:
        "Accounts Overview is displayed and a balance was read for the requested account.",
      assert: {
        assert: "all" as const,
        of: [
          { assert: "text_matches" as const, pattern: "Accounts Overview", flags: "i" },
          { assert: "element_present" as const, locator: balanceCell },
        ],
      },
    },
  },

  recoveries: [
    {
      code: "SESSION_EXPIRED",
      description: "Session cookie dropped; the app bounced us back to the login screen mid-flow.",
      detect: { assert: "text_matches" as const, pattern: "Customer Login", flags: "i" },
      handle: { strategy: "reenter" as const, fromStepId: "enter_username" },
      maxAttempts: 2,
      appliesTo: ["read_balance"],
    },
    {
      code: "TRANSIENT_APP_ERROR",
      description: "Intermittent 500 / error page from the application server.",
      detect: { assert: "text_matches" as const, pattern: "an internal error has occurred", flags: "i" },
      handle: { strategy: "retry_step" as const, backoffMs: 2000 },
      maxAttempts: 3,
      appliesTo: "all_steps" as const,
    },
  ],

  policy: {
    maxRisk: "reversible" as const,
    requires: {
      origins: ["https://parabank.parasoft.com", "http://localhost:8080"],
      pathPrefixes: ["/parabank/"],
      actions: ["navigate", "click", "type", "read"] as const,
      secrets: ["tenant.parabank.operator_user", "tenant.parabank.operator_password"],
    },
    irreversibleStepPolicy: "require_human_confirmation" as const,
    returnsDataClasses: ["public", "internal", "pii"] as const,
  },

  escalation: {
    on: [
      "locator_unresolved",
      "locator_ambiguous",
      "unknown_condition",
      "recovery_exhausted",
    ] as const,
    holdSessionMs: 900000,
    allowResume: true,
  },

  provenance: {
    discoveryRunId: "run_01JBX9",
    transcriptSha256: "0".repeat(64),
    model: "hand-written",
    recordedAt: "2026-09-06T12:00:00.000Z",
    review: { status: "draft" as const },
  },
};

// Hash the *parsed* artifact: zod fills defaults, so hashing the draft would
// not match what replay later recomputes from the stored file.
const parsed = Capability.parse({ ...draft, integrity: { contentSha256: "0".repeat(64) } });
parsed.integrity.contentSha256 = contentHash(parsed as unknown as Record<string, unknown>);
writeFileSync("examples/read_account_balance.json", JSON.stringify(parsed, null, 2));
console.log(
  "VALID:",
  parsed.id,
  "v" + parsed.version,
  "| steps:",
  parsed.flow.steps.length,
  "| outcomes:",
  parsed.contract.outcomes.length,
  "| recoveries:",
  parsed.recoveries.length,
);
