import { describe, expect, it } from "vitest";
import { textContent, normalizeEntries } from "../packages/runtime/src/normalize";

describe("public transcript projection", () => {
  it("includes visible text without exposing reasoning, provider signatures, or image payloads", () => {
    const text = textContent([
      {type: "thinking", thinking: "private internal reasoning", signature: "provider-token"},
      {type: "text", text: "Visible answer"},
      {type: "image", data: "private-base64"},
      {type: "text", text: " and result."},
    ]);
    expect(text).toBe("Visible answer and result.");
  });

  it("emits stable entry identities for durable replay and normalizes tool roles", () => {
    const entries = [{id: "entry-7", model: [
      {role: "assistant", content: [{type: "text", text: "Done"}], timestamp: 1_000},
      {role: "toolResult", content: [{type: "text", text: "result"}]},
    ]}];
    const first = normalizeEntries(entries as unknown as Parameters<typeof normalizeEntries>[0]);
    expect(first).toEqual(normalizeEntries(entries as unknown as Parameters<typeof normalizeEntries>[0]));
    expect(first.map(message => [message.id, message.role, message.text])).toEqual([
      ["pi:entry-7:0", "assistant", "Done"], ["pi:entry-7:1", "tool", "result"],
    ]);
    expect(first[0].createdAt).toBe("1970-01-01T00:00:01.000Z");
  });
});
