import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("../db/schema.js", () => ({
  promptTemplates: {
    id: "prompt_templates.id",
    isDefault: "prompt_templates.is_default",
    repoUrl: "prompt_templates.repo_url",
  },
  repos: {
    id: "repos.id",
    repoUrl: "repos.repo_url",
  },
}));

import { db } from "../db/client.js";
import {
  getPromptTemplate,
  saveDefaultPromptTemplate,
  saveRepoPromptTemplate,
  listPromptTemplates,
  renderTemplateString,
  resolveTemplateParam,
  findUnresolvedTemplatePlaceholders,
} from "./prompt-template-service.js";

describe("renderTemplateString", () => {
  it("substitutes {{param}} placeholders", () => {
    const result = renderTemplateString("Hello {{name}}!", { name: "World" });
    expect(result).toBe("Hello World!");
  });

  it("substitutes multiple and repeated placeholders", () => {
    const result = renderTemplateString("{{a}} and {{b}} and {{a}}", { a: "1", b: "2" });
    expect(result).toBe("1 and 2 and 1");
  });

  it("tolerates whitespace around placeholder names", () => {
    expect(renderTemplateString("{{ name }}", { name: "x" })).toBe("x");
  });

  it("leaves unknown placeholders intact", () => {
    expect(renderTemplateString("Hi {{missing}}", { name: "x" })).toBe("Hi {{missing}}");
  });

  it("renders {{#if param}}...{{/if}} when param is truthy", () => {
    expect(renderTemplateString("a{{#if flag}} mid {{/if}}b", { flag: true })).toBe("a mid b");
  });

  it("drops {{#if}} body when param is falsy", () => {
    expect(renderTemplateString("a{{#if flag}} mid {{/if}}b", { flag: false })).toBe("ab");
  });

  it("drops {{#if}} body when param is missing", () => {
    expect(renderTemplateString("a{{#if flag}} mid {{/if}}b", {})).toBe("ab");
  });

  it("renders {{#if}} with nested {{param}} substitution", () => {
    expect(
      renderTemplateString("{{#if has_name}}Hello {{name}}{{/if}}", {
        has_name: true,
        name: "Ada",
      }),
    ).toBe("Hello Ada");
  });

  it("handles non-string params by coercing to string", () => {
    expect(renderTemplateString("count={{n}}", { n: 42 })).toBe("count=42");
  });

  it("treats null/undefined params as empty string", () => {
    expect(renderTemplateString("x={{v}}y", { v: null })).toBe("x=y");
  });

  it("substitutes dotted {{ticket.key}} paths from nested params", () => {
    const result = renderTemplateString("{{ticket.key}}: {{ticket.summary}}", {
      ticket: { key: "SCRUM-116", summary: "Voice assistant" },
    });
    expect(result).toBe("SCRUM-116: Voice assistant");
  });

  it("resolveTemplateParam supports dotted paths", () => {
    const params = { ticket: { key: "SCRUM-1" } };
    expect(resolveTemplateParam(params, "ticket.key")).toBe("SCRUM-1");
    expect(resolveTemplateParam(params, "missing")).toBeUndefined();
  });

  it("findUnresolvedTemplatePlaceholders ignores if blocks", () => {
    expect(findUnresolvedTemplatePlaceholders("{{ticket.key}} ok {{#if x}}y{{/if}}")).toEqual([
      "ticket.key",
    ]);
  });
});

describe("prompt-template-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getPromptTemplate", () => {
    it("returns repo-level override when available", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              id: "repo-1",
              promptTemplateOverride: "Custom prompt",
              autoMerge: true,
            },
          ]),
        }),
      });

      const result = await getPromptTemplate("https://github.com/o/r");
      expect(result.template).toBe("Custom prompt");
      expect(result.autoMerge).toBe(true);
    });

    it("falls back to global default when no repo override", async () => {
      let selectCallCount = 0;
      (db.select as any) = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            selectCallCount++;
            if (selectCallCount === 1) {
              // Repo lookup — no override
              return Promise.resolve([
                { id: "repo-1", promptTemplateOverride: null, autoMerge: true },
              ]);
            }
            // Global default lookup
            return Promise.resolve([{ id: "pt-1", template: "Global template", autoMerge: false }]);
          }),
        }),
      }));

      const result = await getPromptTemplate("https://github.com/o/r");
      expect(result.template).toBe("Global template");
      expect(result.autoMerge).toBe(true); // Uses repo's autoMerge
    });

    it("falls back to hardcoded default when no global template", async () => {
      let selectCallCount = 0;
      (db.select as any) = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            selectCallCount++;
            // All lookups return empty
            return Promise.resolve([]);
          }),
        }),
      }));

      const result = await getPromptTemplate("https://github.com/o/r");
      expect(result.id).toBe("builtin");
      expect(result.template).toBeDefined();
      expect(result.autoMerge).toBe(false);
    });

    it("returns global default when no repoUrl provided", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: "pt-1", template: "Default", autoMerge: false }]),
        }),
      });

      const result = await getPromptTemplate();
      expect(result.template).toBe("Default");
    });
  });

  describe("saveDefaultPromptTemplate", () => {
    it("updates existing default template", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: "pt-1" }]),
        }),
      });

      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });

      await saveDefaultPromptTemplate("New template", true);
      expect(db.update).toHaveBeenCalled();
    });

    it("inserts new default template when none exists", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined),
      });

      await saveDefaultPromptTemplate("New template", false);
      expect(db.insert).toHaveBeenCalled();
    });
  });

  describe("saveRepoPromptTemplate", () => {
    it("updates existing repo template", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: "pt-1" }]),
        }),
      });

      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });

      await saveRepoPromptTemplate("https://github.com/o/r", "Template", true);
      expect(db.update).toHaveBeenCalled();
    });

    it("inserts new repo template when none exists", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      let capturedValues: any;
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          capturedValues = vals;
          return Promise.resolve(undefined);
        }),
      });

      await saveRepoPromptTemplate("https://github.com/o/r.git", "Template", false);

      expect(db.insert).toHaveBeenCalled();
      // URL should be normalized
      expect(capturedValues.repoUrl).toBe("https://github.com/o/r");
    });
  });

  describe("listPromptTemplates", () => {
    it("returns all prompt templates", async () => {
      const templates = [{ id: "pt-1" }, { id: "pt-2" }];
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockResolvedValue(templates),
      });

      const result = await listPromptTemplates();
      expect(result).toEqual(templates);
    });
  });
});
