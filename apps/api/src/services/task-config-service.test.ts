import { describe, it, expect } from "vitest";
import { ticketTriggerParams } from "./task-config-service.js";
import { renderTemplateString } from "./prompt-template-service.js";

describe("ticketTriggerParams", () => {
  it("renders legacy {{ticket.key}} task_config templates", () => {
    const params = ticketTriggerParams({
      source: "jira",
      externalId: "SCRUM-116",
      title: "Hands-free voice assistant",
      body: "Implement TTS and STT.",
      labels: ["expert-agent-ready"],
      url: "https://example.atlassian.net/browse/SCRUM-116",
    });

    const title = renderTemplateString("{{ticket.key}}: {{ticket.summary}}", params);
    const prompt = renderTemplateString(
      "Implement Jira ticket {{ticket.key}}.\n\nSummary: {{ticket.summary}}\n\nDescription:\n{{ticket.description}}",
      params,
    );

    expect(title).toBe("SCRUM-116: Hands-free voice assistant");
    expect(prompt).toContain("Implement Jira ticket SCRUM-116.");
    expect(prompt).toContain("Implement TTS and STT.");
    expect(params.ticketSource).toBe("jira");
    expect(params.ticketExternalId).toBe("SCRUM-116");
  });
});
