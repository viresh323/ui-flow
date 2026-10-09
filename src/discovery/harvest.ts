import type { Locator } from "../artifact/index.js";

/**
 * Turning "the model pointed at this element" into a durable locator bundle.
 *
 * This is the hinge between the two halves of the system. During discovery the
 * model picks targets the easy way — by `[ref=eN]` out of the accessibility
 * tree it was just shown. Refs are perfect for discovery and worthless for
 * replay: they are assigned per snapshot and mean nothing tomorrow.
 *
 * So the model never authors a locator. We inspect the element it chose and
 * derive the candidates ourselves, from what the page actually says. That is
 * both more reliable than asking a model to invent selectors (it cannot
 * hallucinate an attribute that is not there) and the reason this design ports
 * to a coordinate-native computer-use model unchanged: swap "the element at
 * ref eN" for "the element at (x, y)" and everything downstream is identical.
 */

export interface HarvestedTarget {
  tagName: string;
  role: string | null;
  accessibleName: string | null;
  /** Visible text that labels this control, when there is no accessible name. */
  labelText: string | null;
  fieldName: string | null;
  formName: string | null;
  /** Set when the element is a cell in a table with a usable header row. */
  tablePosition: { columnHeader: string; rowKeyHeader: string; rowKeyValue: string } | null;
  cssPath: string;
  ownText: string | null;
}

/**
 * Browser-side. Serialized into the page, so it must be self-contained: no
 * imports, no closure over module scope.
 */
export function describeElement(el: Element): HarvestedTarget {
  const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

  const tagName = el.tagName.toLowerCase();
  const type = (el as HTMLInputElement).type?.toLowerCase() ?? "";

  const roleOf = (): string | null => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    if (tagName === "a" && el.hasAttribute("href")) return "link";
    if (tagName === "button") return "button";
    if (tagName === "select") return "combobox";
    if (tagName === "textarea") return "textbox";
    if (tagName === "td" || tagName === "th") return "cell";
    if (tagName === "input") {
      if (type === "submit" || type === "button") return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      return "textbox";
    }
    return null;
  };

  // Approximation of accname resolution, in the order that matters for the
  // markup we actually meet. Deliberately conservative: a wrong accessible name
  // produces a candidate that silently matches the wrong control.
  const accessibleNameOf = (): string | null => {
    const aria = norm(el.getAttribute("aria-label"));
    if (aria) return aria;
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const t = norm(document.getElementById(labelledBy)?.textContent);
      if (t) return t;
    }
    const id = el.getAttribute("id");
    if (id) {
      const t = norm(document.querySelector(`label[for="${id}"]`)?.textContent);
      if (t) return t;
    }
    if (tagName === "input" && (type === "submit" || type === "button")) {
      const v = norm((el as HTMLInputElement).value);
      if (v) return v;
    }
    if (tagName === "button" || tagName === "a") {
      const t = norm(el.textContent);
      if (t) return t;
    }
    const title = norm(el.getAttribute("title"));
    return title || null;
  };

  /**
   * The legacy-form case: no <label for>, just visible text sitting before the
   * control. Walk backwards in document order for the nearest non-empty leaf
   * text — which on ParaBank is the <b>Username</b> inside a <p>.
   */
  const labelTextOf = (): string | null => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let previous: string | null = null;
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const position = el.compareDocumentPosition(node);
      if ((position & Node.DOCUMENT_POSITION_PRECEDING) === 0) break;
      const text = norm(node.textContent);
      if (text.length > 0 && text.length <= 60) previous = text;
    }
    return previous;
  };

  const tablePositionOf = (): HarvestedTarget["tablePosition"] => {
    const cell = el.closest("td, th") as HTMLTableCellElement | null;
    const row = cell?.closest("tr") as HTMLTableRowElement | null;
    const table = row?.closest("table") as HTMLTableElement | null;
    if (!cell || !row || !table || table.rows.length < 2) return null;

    const headers = Array.from(table.rows[0]!.cells).map((c) => norm(c.textContent));
    const colIndex = Array.from(row.cells).indexOf(cell);
    if (colIndex < 0 || colIndex >= headers.length) return null;
    if (row === table.rows[0]) return null;

    // The key column is the first one that is not this one — conventionally the
    // identifier the row is looked up by.
    const keyIndex = colIndex === 0 ? 1 : 0;
    if (keyIndex >= headers.length || keyIndex >= row.cells.length) return null;

    return {
      columnHeader: headers[colIndex]!,
      rowKeyHeader: headers[keyIndex]!,
      rowKeyValue: norm(row.cells[keyIndex]!.textContent),
    };
  };

  const cssPathOf = (): string => {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      let part = node.tagName.toLowerCase();
      const nameAttr = node.getAttribute("name");
      if (nameAttr) {
        part += `[name="${nameAttr}"]`;
        parts.unshift(part);
        break;
      }
      const siblings = node.parentElement
        ? Array.from(node.parentElement.children).filter((c) => c.tagName === node!.tagName)
        : [];
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(" > ");
  };

  const form = el.closest("form");

  return {
    tagName,
    role: roleOf(),
    accessibleName: accessibleNameOf(),
    labelText: labelTextOf(),
    fieldName: el.getAttribute("name"),
    formName: form?.getAttribute("name") ?? null,
    tablePosition: tablePositionOf(),
    cssPath: cssPathOf(),
    ownText: norm(el.textContent).slice(0, 80) || null,
  };
}

/**
 * Build the ranked bundle from what we harvested.
 *
 * Ordering is by expected durability across tenants and versions, not by what
 * happened to be found first:
 *   1. role + accessible name  — most portable, and the only one that ports to
 *      a desktop UIA surface unchanged
 *   2. table intersection      — header-relative, survives reordering and paging
 *   3. visible label proximity — survives rebranding and id churn
 *   4. form field name         — stable per vendor product, not per tenant
 *   5. css path                — always available, encodes incidental structure
 *
 * `parameterise` turns a literal observed on screen into `${param}`, which is
 * what makes the recorded flow reusable with different inputs.
 */
export function buildLocatorBundle(
  id: string,
  harvested: HarvestedTarget,
  parameterise: (literal: string) => string,
  opts: { purpose?: "act" | "read" } = {},
): Locator {
  const candidates: Array<{ candidate: Record<string, unknown>; confidence: number; rationale: string }> = [];

  /**
   * A read target must not be identified by the value being read.
   *
   * On a confirmation screen the new account number is a link whose accessible
   * name *is* the number. Recording `role_name: {name: "13566"}` produces a
   * locator that can only find the element if you already know the answer — so
   * it works once, during discovery, and never again. Whenever the element's
   * name is just its content, that name is evidence, not identity.
   */
  const nameIsContent =
    harvested.accessibleName !== null && harvested.accessibleName === harvested.ownText;
  const nameUsable = harvested.accessibleName !== null && !(opts.purpose === "read" && nameIsContent);

  if (harvested.role && harvested.accessibleName && nameUsable) {
    candidates.push({
      candidate: {
        using: "role_name",
        role: harvested.role,
        name: parameterise(harvested.accessibleName),
        exact: true,
      },
      confidence: 0.9,
      rationale: "Role plus accessible name; the most portable strategy and the one that ports to a desktop surface.",
    });
  }

  if (harvested.tablePosition) {
    const { columnHeader, rowKeyHeader, rowKeyValue } = harvested.tablePosition;
    candidates.push({
      candidate: {
        using: "table_cell",
        rowMatch: { columnHeader: rowKeyHeader, equals: parameterise(rowKeyValue) },
        columnHeader,
      },
      confidence: 0.88,
      rationale: "Header-relative row/column intersection; independent of row order, paging and column count.",
    });
  }

  // Offered whenever the element has no usable name of its own — which now
  // includes a read target whose name is merely its own content. On a
  // confirmation screen the surrounding text ("Your new account number:") is
  // the durable identity; the number beside it is the answer.
  if (harvested.labelText && harvested.role && !nameUsable) {
    candidates.push({
      candidate: {
        using: "label_proximity",
        labelText: parameterise(harvested.labelText),
        controlRole: harvested.role,
        direction: "after",
        maxDistance: 3,
      },
      confidence: 0.85,
      rationale: "Control has no accessible name; the visible label is what a tenant rebrand is least likely to change.",
    });
  }

  if (harvested.fieldName) {
    candidates.push({
      candidate: {
        using: "field_name",
        name: harvested.fieldName,
        ...(harvested.formName ? { formName: harvested.formName } : {}),
      },
      confidence: 0.8,
      rationale: "Server-rendered form field name; stable across versions of the same vendor product.",
    });
  }

  candidates.push({
    candidate: { using: "css", selector: harvested.cssPath },
    confidence: 0.45,
    rationale: "Structural fallback; encodes incidental layout, so ranked last.",
  });

  /**
   * Soundness filter, and the most important line in this file.
   *
   * If any candidate discriminates on a parameter, every candidate must — a
   * strategy with no `${param}` in it cannot tell one row from another, so it
   * will happily return whatever sits in the recorded position. On an accounts
   * grid that means answering a query about account B with account A's balance,
   * reported as success. A locator that cannot express the question must not be
   * allowed to answer it.
   *
   * Dropping them can leave a target with a single candidate, and that is the
   * correct trade: failing to resolve is recoverable, a confidently wrong
   * balance is not.
   */
  const carriesParam = (c: Record<string, unknown>) => JSON.stringify(c).includes("${");
  const parameterised = candidates.filter((c) => carriesParam(c.candidate));
  const sound = parameterised.length > 0 ? parameterised : candidates;

  return {
    id,
    describe: describeForHuman(harvested, nameUsable),
    region: { framePath: [] },
    candidates: sound,
    match: { requireUnique: true, minConfidence: 0.4, onMultiple: "fail" },
  } as unknown as Locator;
}

function describeForHuman(h: HarvestedTarget, nameUsable = true): string {
  const what = h.role ?? h.tagName;
  // A read target named by its own content must not be *described* by it
  // either: "link 13566" tells a reviewer nothing about what the step reads.
  if (h.accessibleName && nameUsable) return `${what} "${h.accessibleName}"`;
  if (h.tablePosition) return `${h.tablePosition.columnHeader} cell for the requested row`;
  if (h.labelText) return `${what} labelled "${h.labelText}"`;
  if (h.fieldName) return `${what} named "${h.fieldName}"`;
  return `${what} at ${h.cssPath}`;
}
