// Search for the Competitors list. Three tiers run in order and a later one runs only when the one before found nothing:
// exact (every chip holds, ignoring case and accents), close spelling (edit distance), and similar meaning (ranked by the hub).
// Chips: word, "phrase", -word, field:value, -field:value. The fields are name, org, flag, status, and about.

export const SEARCH_FIELDS = ["name", "org", "flag", "status", "about"];
export const MEANING_LIMIT = 10;

/** Lower case with accents removed, so "Café" and "cafe" are the same word. */
export function normalize(value) {
  return String(value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Splits the search box into chips. An unknown `word:` prefix stays part of the word. A lone hyphen is dropped. */
export function parseQuery(text) {
  const source = String(text ?? "");
  const chips = [];
  let i = 0;
  while (i < source.length) {
    if (/\s/.test(source[i])) { i++; continue; }
    let negate = false;
    if (source[i] === "-" && i + 1 < source.length && !/\s/.test(source[i + 1])) { negate = true; i++; }
    let field = null;
    const prefix = /^([a-z]+):/i.exec(source.slice(i));
    if (prefix && SEARCH_FIELDS.includes(prefix[1].toLowerCase())) { field = prefix[1].toLowerCase(); i += prefix[0].length; }
    let value;
    let phrase = false;
    if (source[i] === '"') {
      const end = source.indexOf('"', i + 1);
      value = source.slice(i + 1, end < 0 ? source.length : end);
      i = end < 0 ? source.length : end + 1;
      phrase = true;
    } else {
      let j = i;
      while (j < source.length && !/\s/.test(source[j])) j++;
      value = source.slice(i, j);
      i = j;
    }
    const clean = normalize(value).trim();
    if (/[\p{L}\p{N}]/u.test(clean)) chips.push({ negate, field, value: clean, phrase });
  }
  return chips;
}

function fieldText(row, field) {
  const flags = Array.isArray(row.flags) ? row.flags.join(" ") : "";
  const about = `${row.about || ""} ${(Array.isArray(row.topics) ? row.topics : []).join(" ")}`;
  if (field === "name") return normalize(row.name);
  if (field === "org") return normalize(row.org);
  if (field === "flag") return normalize(flags);
  if (field === "status") return normalize(`${row.status} ${row.status === "new" ? "new version" : row.status === "current" ? "up to date" : "not checked"}`);
  if (field === "about") return normalize(about);
  return normalize(`${row.name || ""} ${row.org || ""} ${flags} ${about}`);
}

const FIELD_LABEL = { name: "name", org: "organization", flag: "product", status: "status", about: "summary" };

/** Where an unfielded word matched, for the "why" line. */
function whereMatched(row, value) {
  const places = [["name", "name"], ["org", "organization"], ["flag", "product"], ["about", "summary"]];
  const found = places.filter(([field]) => fieldText(row, field).includes(value)).map(([, label]) => label);
  return found.length ? found : ["details"];
}

export function editDistance(a, b, limit = 3) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (current[j] < best) best = current[j];
    }
    if (best > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length];
}

/** A short word allows no typos, a medium one allows one, a long one allows two. */
export function allowedEdits(length) {
  return length <= 3 ? 0 : length <= 6 ? 1 : 2;
}

function tokensOf(row) {
  return [...new Set(fieldText(row, null).split(/[^a-z0-9]+/).filter((token) => token.length > 1))];
}

/** Every chip that is not a loose word must hold exactly: fields, phrases, and negations. */
function holdsExactly(row, chip) {
  const hit = fieldText(row, chip.field).includes(chip.value);
  return chip.negate ? !hit : hit;
}

const isLoose = (chip) => !chip.negate && !chip.field && !chip.phrase;

/** Whether a row meets every chip that a close or meaning match must still obey. */
export function meetsConstraints(row, chips) {
  return chips.every((chip) => isLoose(chip) || holdsExactly(row, chip));
}

/**
 * Runs the tiers. `meaningIds` is the hub's ranked answer for the third tier; leave it out until the first two found nothing.
 * Returns { tier, rows, why, needsMeaning }. `why` maps a row id to one sentence on what matched.
 */
export function searchCompetitors(rows, text, { meaningIds } = {}) {
  const list = rows || [];
  const chips = parseQuery(text);
  if (!chips.length) return { tier: "all", rows: list, why: new Map(), needsMeaning: false };
  const why = new Map();

  const exact = list.filter((row) => chips.every((chip) => holdsExactly(row, chip)));
  if (exact.length) {
    for (const row of exact) {
      const reasons = chips.filter((chip) => !chip.negate).map((chip) => (chip.field ? `${FIELD_LABEL[chip.field]} has ${chip.value}` : `${chip.value} in ${whereMatched(row, chip.value).join(", ")}`));
      why.set(row.id, `Matched ${reasons.join("; ")}`);
    }
    return { tier: "exact", rows: exact, why, needsMeaning: false };
  }

  const loose = chips.filter(isLoose);
  const close = [];
  if (loose.length) {
    for (const row of list) {
      if (!chips.every((chip) => isLoose(chip) || holdsExactly(row, chip))) continue;
      const tokens = tokensOf(row);
      let total = 0;
      const notes = [];
      let ok = true;
      for (const chip of loose) {
        if (fieldText(row, null).includes(chip.value)) continue;
        const allowed = allowedEdits(chip.value.length);
        let best = null;
        for (const token of tokens) {
          const distance = editDistance(chip.value, token, allowed);
          if (distance <= allowed && (best === null || distance < best.distance)) best = { token, distance };
        }
        if (!best) { ok = false; break; }
        total += best.distance;
        notes.push(`"${chip.value}" is close to "${best.token}"`);
      }
      if (ok && notes.length) { close.push({ row, total }); why.set(row.id, `Close spelling: ${notes.join("; ")}`); }
    }
  }
  if (close.length) {
    close.sort((a, b) => a.total - b.total || String(a.row.name).localeCompare(String(b.row.name)));
    return { tier: "close", rows: close.map((item) => item.row), why, needsMeaning: false };
  }

  if (!loose.length) return { tier: "none", rows: [], why, needsMeaning: false };
  if (!Array.isArray(meaningIds)) return { tier: "none", rows: [], why, needsMeaning: true };
  const byId = new Map(list.map((row) => [row.id, row]));
  const similar = meaningIds.map((id) => byId.get(id)).filter((row) => row && meetsConstraints(row, chips)).slice(0, MEANING_LIMIT);
  for (const row of similar) why.set(row.id, "Similar meaning, ranked best first");
  return { tier: similar.length ? "meaning" : "none", rows: similar, why, needsMeaning: false };
}

/** The sentence under the search box: how many rows, and for the second and third tiers that the list is no longer an exact match. */
export function searchNote(result, shown, total) {
  if (result.tier === "all") return "";
  if (result.tier === "exact") return `${shown} of ${total} match.`;
  if (result.tier === "close") return `Nothing matches exactly. ${shown} with close spelling, closest first.`;
  if (result.tier === "meaning") return `Nothing matches by spelling. ${shown} with a similar meaning, best first.`;
  return result.needsMeaning ? "Nothing matches. Looking for similar meanings." : "Nothing matches.";
}
