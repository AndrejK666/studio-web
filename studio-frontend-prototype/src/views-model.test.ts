import { describe, expect, it } from "vitest";

import {
  blankView,
  fromViewObject,
  labelField,
  pageQuery,
  problems,
  toQuery,
  toViewObject,
  type ViewSpec,
} from "./views-model";

const active: ViewSpec = {
  id: "v1",
  name: "Active projects",
  type: "project",
  columns: ["name", "status"],
  conditions: [{ field: "status", op: "_eq", value: "active" }],
  relations: ["uses"],
  sort: { field: "name", direction: "asc" },
};

describe("a view compiles to the query endpoint's body", () => {
  it("columns, conditions, related objects and order", () => {
    expect(toQuery(active)).toEqual({
      type: "project",
      fields: ["name", "status"],
      where: { status: { _eq: "active" } },
      order_by: [{ field: "name", direction: "asc" }],
      include: { uses: { fields: ["name"], order_by: [{ field: "name" }], limit: 5 } },
    });
  });

  it("ANDs several conditions and coerces by the field's kind", () => {
    const q = toQuery({
      ...active,
      relations: [],
      conditions: [
        { field: "status", op: "_neq", value: "archived" },
        { field: "version", op: "_gt", value: "2" },
        { field: "target_at", op: "_is_null", value: "" },
      ],
    });
    expect(q.where).toEqual({
      _and: [
        { status: { _neq: "archived" } },
        { version: { _gt: 2 } },
        { target_at: { _is_null: true } },
      ],
    });
  });

  it("a page adds the reader's sort, search and window to the view's own", () => {
    const q = pageQuery(active, { q: "apo", sort: { key: "status", dir: "desc" }, offset: 50, limit: 25 });
    expect(q.order_by).toEqual([{ field: "status", direction: "desc" }]);
    expect(q.offset).toBe(50);
    expect(q.limit).toBe(25);
    expect(q.where).toEqual({
      _and: [
        { status: { _eq: "active" } },
        {
          _or: [
            { name: { _contains: "apo" } },
            { title: { _contains: "apo" } },
            { description: { _contains: "apo" } },
          ],
        },
      ],
    });
  });

  it("a relation column's sort key is not a field, so the view's order stays", () => {
    const q = pageQuery(active, { q: "", sort: { key: "rel:uses", dir: "asc" }, offset: 0, limit: 10 });
    expect(q.order_by).toEqual([{ field: "name", direction: "asc" }]);
  });
});

describe("a view is stored as a `view` object and read back", () => {
  it("round-trips, with the compiled query beside what the editor needs", () => {
    const stored = toViewObject(active);
    expect(stored.query).toEqual(toQuery(active));
    expect(stored.view_kind).toBe("object");
    expect(fromViewObject(stored)).toEqual(active);
  });

  it("ignores a view this screen did not write", () => {
    expect(fromViewObject({ id: "x", name: "graph", query: { type: "no-such-entity" } })).toBeNull();
    expect(fromViewObject({ name: "no id", query: { type: "project" } })).toBeNull();
  });
});

describe("what the editor refuses to save", () => {
  it("names what is missing or wrong", () => {
    const blank = blankView("project", "v2");
    expect(problems(blank)).toEqual(["Give the view a name."]);
    expect(
      problems({
        ...blank,
        name: "x",
        columns: ["colour"],
        relations: ["members"],
        conditions: [{ field: "version", op: "_eq", value: "two" }],
      }),
    ).toEqual([
      "`colour` is not a field of project.",
      "`members` is not a relation of project.",
      "`version` takes a number.",
    ]);
  });

  it("a type's label is its name, then its title", () => {
    expect(labelField("project")).toBe("name");
  });
});
