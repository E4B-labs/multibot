import { describe, expect, it } from "vitest";
import { filterSearchResults, searchText, type SearchResult } from "./search.ts";

const rows: SearchResult[] = [
  { id: "old", kind: "message", title: "Old", subtitle: "deployment", at: 1 },
  { id: "new", kind: "agent", title: "Deploy bot", subtitle: "updates", at: 2 },
];

describe("search index helpers", () => {
  it("matches case-insensitively across indexed fields", () => {
    expect(searchText("DEPLOY", "Daily deployment")).toBe(true);
    expect(searchText("missing", "Daily deployment")).toBe(false);
  });

  it("filters by tab and keeps newest records first", () => {
    expect(filterSearchResults(rows, "deploy", "all").map((row) => row.id)).toEqual(["new", "old"]);
    expect(filterSearchResults(rows, "deploy", "agent").map((row) => row.id)).toEqual(["new"]);
  });
});
