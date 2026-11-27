import { describe, expect, it } from "vitest";
import type { CatalogNode, ComponentDetail, RegistryEntry } from "../api/types";
import { detailType, hostsOf, neededItems, projectsUsing, providedItems, rowType, typeCounts, usedItems } from "./component-page";

const node = (value: CatalogNode["value"]): CatalogNode => ({ type_id: "gts.cf.studio.catalog.gear.v1~", instance_id: "n1", value });
const entry = (over: Partial<RegistryEntry> = {}): RegistryEntry => ({
  name: "billing",
  kind: "gear",
  state: "declared",
  capabilities: [],
  orphaned: false,
  occurrences: [{ project_id: "p1", project_name: "Shop", repo: "acme/shop", path: "gears/billing", declared_in: "gear.gdl" }],
  ...over,
});
const detail = (over: Partial<ComponentDetail> = {}): ComponentDetail => ({
  name: "billing",
  component_type: "gear",
  type_reason: "",
  docs: [],
  provides: {
    capabilities: [],
    hosts: [],
    extension_points: [],
    plugins: [],
    mcp_tools: [],
    types: [],
    screens: [],
    ports: [],
    variables: [],
  },
  needs: { components: [], services: [], databases: [], runtime: [], connections: [] },
  used_by: { components: [], kits: [] },
  engine: [],
  ...over,
});

describe("component types on rows", () => {
  it("takes the catalogue's type, then the registry's kind", () => {
    expect(rowType({ node: node({ component_type: "mfe" }) })).toBe("mfe");
    expect(rowType({ node: node({}), entry: entry({ kind: "plugin" }) })).toBe("plugin");
    expect(rowType({ entry: entry({ kind: "frontx" }) })).toBe("other");
    expect(detailType(detail({ component_type: "infra" }), "other")).toBe("infra");
    expect(detailType(detail({ component_type: "nonsense" }), "gear")).toBe("gear");
    expect(detailType(null, "kit")).toBe("kit");
  });

  it("names a plugin's hosts as the catalogue laid them", () => {
    expect(hostsOf(node({ component_hosts: ["credstore", 3] }))).toEqual(["credstore"]);
    expect(hostsOf(node({}))).toEqual([]);
    expect(hostsOf(undefined)).toEqual([]);
  });

  it("counts each type in the filter's order", () => {
    expect(typeCounts(["mfe", "gear", "gear", "other"])).toEqual([
      { type: "gear", count: 2 },
      { type: "mfe", count: 1 },
      { type: "other", count: 1 },
    ]);
  });
});

describe("a component page's sections", () => {
  it("lists what it provides and needs, one item each", () => {
    const d = detail({
      provides: {
        ...detail().provides,
        capabilities: ["rest"],
        implements: "cf.x.plugin.v1~",
        mcp_tools: [{ name: "tests_list", description: "Lists runs", effect: "read" }],
        openapi: true,
        events: false,
      },
      needs: { components: ["types-registry"], services: ["studio-tasks"], databases: ["postgres"], runtime: [], connections: [] },
    });
    expect(providedItems(d).map((i) => `${i.kind}:${i.name}`)).toEqual([
      "item_capability:rest",
      "item_fills:cf.x.plugin.v1~",
      "item_tool:tests_list",
      "item_contract:OpenAPI",
    ]);
    expect(neededItems(d).map((i) => i.kind)).toEqual(["item_dependency", "item_service", "item_database"]);
    expect(providedItems(detail())).toEqual([]);
  });

  it("says where it is used: declared, by product, by code, by components and kits", () => {
    const e = entry({
      consumers: [
        { project_id: "p2", project_name: "Insight", via: ["cargo", "product"] },
        { project_id: "p3", project_name: "", via: ["product"] },
      ],
    });
    const d = detail({
      used_by: {
        components: ["oagw"],
        kits: [{ kit: "project-tests", kit_name: "Tests", gear: "billing", types: ["ci-run"], mcp_tools: [], routes: [] }],
      },
    });
    expect(usedItems(d, e).map((i) => `${i.kind}:${i.name}${i.note ? `:${i.note}` : ""}`)).toEqual([
      "item_declared_in:Shop",
      "item_product_of:Insight",
      "item_used_by_project:Insight:cargo",
      "item_product_of:p3",
      "item_used_by_component:oagw",
      "item_kit:Tests:ci-run",
    ]);
    expect(usedItems(null, undefined)).toEqual([]);
    expect(projectsUsing(e)).toEqual(["Shop", "Insight", "p3"]);
  });
});
