import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as zlib from "zlib";

import { packChart, unpackNames } from "./chart-package";

function chart(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gbx-chart-"));
  const dir = path.join(root, "studio-web");
  fs.mkdirSync(path.join(dir, "templates"), { recursive: true });
  fs.mkdirSync(path.join(dir, "charts", "api", "templates"), { recursive: true });
  fs.writeFileSync(path.join(dir, "Chart.yaml"), "apiVersion: v2\nname: studio-web\nversion: 0.1.0\n");
  fs.writeFileSync(path.join(dir, "values.yaml"), "api:\n  image:\n    repository: studio-web/api\n");
  fs.writeFileSync(path.join(dir, "charts", "api", "templates", "deployment.yaml"), "kind: Deployment\n");
  return dir;
}

describe("packing the generated chart", () => {
  it("lays it out as helm package does, under the chart's folder", () => {
    const dir = chart();
    const files = unpackNames(packChart(dir));
    expect(files.map((f) => f.name)).toEqual([
      "studio-web/Chart.yaml",
      "studio-web/charts/api/templates/deployment.yaml",
      "studio-web/values.yaml",
    ]);
    expect(files[0]?.body).toContain("name: studio-web");
  });

  it("is a gzip the server recognises", () => {
    const packed = packChart(chart());
    expect(packed[0]).toBe(0x1f);
    expect(packed[1]).toBe(0x8b);
    expect(() => zlib.gunzipSync(packed)).not.toThrow();
  });

  it("refuses a folder that is not a chart", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gbx-not-chart-"));
    expect(() => packChart(dir)).toThrow(/no Chart.yaml/);
  });
});
