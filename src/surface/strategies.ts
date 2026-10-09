/**
 * Browser-side matching for the locator strategies that Playwright has no
 * native equivalent for.
 *
 * These functions are serialized and evaluated inside the page, so they must be
 * self-contained: no imports, no closure over module scope, every input passed
 * explicitly. They return arrays of elements, which the driver converts to
 * handles — the match *count* is as important as the match itself, because an
 * ambiguous result is a failure, not a coin flip.
 */

/** ARIA role -> the tags that actually implement it in legacy markup. */
export const ROLE_SELECTOR: Record<string, string> = {
  textbox:
    "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]):not([type=image]), textarea",
  button: "button, input[type=submit], input[type=button]",
  link: "a[href]",
  combobox: "select",
  checkbox: "input[type=checkbox]",
  radio: "input[type=radio]",
  cell: "td, th",
  row: "tr",
  heading: "h1, h2, h3, h4, h5, h6",
};

export function roleSelector(role: string): string {
  return ROLE_SELECTOR[role.toLowerCase()] ?? role;
}

export interface LabelProximityArgs {
  labelText: string;
  controlSelector: string;
  direction: "after" | "before" | "below" | "right";
  maxDistance: number;
}

/**
 * The workhorse for legacy forms: find the visible text that labels a control,
 * then take the nearest control of the expected kind in document order.
 *
 * ParaBank's login is exactly this shape — `<p><b>Username</b></p>` followed by
 * a nameless `<input>`, with no `<label for>` anywhere — so role+accessible-name
 * targeting finds nothing and this is the strategy that works.
 */
export function matchLabelProximity(args: LabelProximityArgs): Element[] {
  const { labelText, controlSelector, direction, maxDistance } = args;
  const wanted = labelText.trim().toLowerCase();

  // Leaf-ish elements whose own text is the label: skip ancestors that merely
  // contain it, or every wrapper up to <body> would match.
  const labels = Array.from(document.querySelectorAll<HTMLElement>("*")).filter((el) => {
    if ((el.textContent ?? "").trim().toLowerCase() !== wanted) return false;
    return !Array.from(el.children).some(
      (c) => (c.textContent ?? "").trim().toLowerCase() === wanted,
    );
  });
  if (labels.length === 0) return [];

  const controls = Array.from(document.querySelectorAll(controlSelector));
  const backwards = direction === "before";
  const out: Element[] = [];

  for (const label of labels) {
    const ordered = backwards ? [...controls].reverse() : controls;
    let seen = 0;
    for (const control of ordered) {
      const pos = label.compareDocumentPosition(control);
      const isAfter = (pos & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      if (backwards ? isAfter : !isAfter) continue;
      seen += 1;
      if (seen > maxDistance) break;
      out.push(control);
      break;
    }
  }
  return out;
}

export interface TableCellArgs {
  rowColumnHeader: string;
  rowEquals: string;
  columnHeader: string;
  tableIndex?: number;
}

/**
 * Row/column intersection — the classic back-office grid read.
 *
 * Header-relative rather than positional, so it survives reordered columns,
 * added columns and paging. Both headers are matched by their visible text.
 */
export function matchTableCell(args: TableCellArgs): Element[] {
  const { rowColumnHeader, rowEquals, columnHeader, tableIndex } = args;
  const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  // Headers carry footnote markers that vary by tenant and version — ParaBank
  // labels its balance column "Balance*". Stripping trailing punctuation costs
  // no precision (no two columns differ only by a footnote) and saves an
  // artifact from being re-recorded over a typographic detail.
  const loose = (s: string) => norm(s).replace(/[^a-z0-9]+$/, "");
  const findHeader = (headers: string[], wanted: string) => {
    const exact = headers.indexOf(norm(wanted));
    return exact !== -1 ? exact : headers.map(loose).indexOf(loose(wanted));
  };

  const all = Array.from(document.querySelectorAll("table"));
  const tables = tableIndex === undefined ? all : all.slice(tableIndex, tableIndex + 1);
  const out: Element[] = [];

  for (const table of tables) {
    const rows = Array.from(table.rows);
    if (rows.length < 2) continue;

    const headerCells = Array.from(rows[0]!.cells).map((c) => norm(c.textContent));
    const keyIdx = findHeader(headerCells, rowColumnHeader);
    const valIdx = findHeader(headerCells, columnHeader);
    if (keyIdx === -1 || valIdx === -1) continue;

    for (const row of rows.slice(1)) {
      const cells = Array.from(row.cells);
      if (cells.length <= Math.max(keyIdx, valIdx)) continue;
      if (norm(cells[keyIdx]!.textContent) === norm(rowEquals)) out.push(cells[valIdx]!);
    }
  }
  return out;
}

export interface NearAnchorArgs {
  anchorText: string;
  targetSelector: string;
  targetName?: string;
}

/** "The Edit link in the row containing 12345." */
export function matchNearAnchor(args: NearAnchorArgs): Element[] {
  const { anchorText, targetSelector, targetName } = args;
  const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const wanted = norm(anchorText);

  const anchors = Array.from(document.querySelectorAll<HTMLElement>("*")).filter((el) => {
    if (!norm(el.textContent).includes(wanted)) return false;
    return !Array.from(el.children).some((c) => norm(c.textContent).includes(wanted));
  });

  const out: Element[] = [];
  for (const anchor of anchors) {
    // Nearest meaningful container: the table row if there is one, else the
    // anchor's parent. Scoping matters — an unscoped search finds every Edit
    // link on the page.
    const scope = anchor.closest("tr") ?? anchor.parentElement;
    if (!scope) continue;
    for (const el of Array.from(scope.querySelectorAll(targetSelector))) {
      if (targetName && norm(el.textContent) !== norm(targetName)) continue;
      out.push(el);
    }
  }
  return out;
}
