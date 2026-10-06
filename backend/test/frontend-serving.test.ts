import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { FakeLLMClient } from "./helpers";

/**
 * Phase 4 — automatic frontend-serving smoke test. Catches the class of bug
 * where the built bundle fails to render (e.g. missing React state that a
 * runtime-less `vite build` lets through): GET / must return real HTML with
 * the app root element, and /api routes must keep their JSON contract instead
 * of being swallowed by the static catch-all. Runs in `bun test` — no browser.
 */

function stubDist(): string {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-dist-"));
  writeFileSync(
    join(dir, "index.html"),
    `<!doctype html><html><head><title>Jarvis</title></head><body><div id="root"></div><script type="module" src="/assets/index.js"></script></body></html>`,
    "utf8",
  );
  return dir;
}

describe("frontend serving (GET /)", () => {
  it("returns the built index.html for the SPA entry route", async () => {
    const app = createApp({ llm: new FakeLLMClient(), frontendDist: stubDist() });
    const res = await app.handle(new Request("http://localhost/"));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div id="root"></div>');
  });

  it("SPA fallback serves index.html for unknown non-API routes", async () => {
    const app = createApp({ llm: new FakeLLMClient(), frontendDist: stubDist() });
    const res = await app.handle(new Request("http://localhost/some/client/route"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="root"></div>');
  });

  it("/api/health stays JSON — the static catch-all never swallows API routes", async () => {
    const app = createApp({ llm: new FakeLLMClient(), frontendDist: stubDist() });
    const res = await app.handle(new Request("http://localhost/api/health"));
    expect(res.status).toBe(200);
    const h = await res.json() as any;
    expect(h.status).toBe("ok");
  });

  it("unknown /api/* paths return the JSON 404 contract, not index.html", async () => {
    const app = createApp({ llm: new FakeLLMClient(), frontendDist: stubDist() });
    const res = await app.handle(new Request("http://localhost/api/does-not-exist"));
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error.code).toBe("NOT_FOUND");
  });
});
