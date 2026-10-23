import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { REDACTED, Redactor, createRedactStream, redactJson } from "../src/redact.js";

const SECRET = "sk_test_51AbCdEfGhIjKlMnOpQrStUvWx";

async function pipeChunks(redactor: Redactor, chunks: string[]): Promise<string> {
  const out: string[] = [];
  const stream = Readable.from(chunks.map((c) => Buffer.from(c))).pipe(
    createRedactStream(redactor),
  );
  for await (const c of stream) out.push(String(c));
  return out.join("");
}

describe("Redactor", () => {
  it("redacts known values", () => {
    const r = new Redactor(["supersecretvalue123"]);
    expect(r.redact("x=supersecretvalue123;")).toBe(`x=${REDACTED};`);
  });

  it("ignores values too short to be secrets", () => {
    const r = new Redactor(["abc"]);
    expect(r.redact("abc abc")).toBe("abc abc");
  });

  it("redacts well-known key shapes without knowing the value", () => {
    const r = new Redactor();
    expect(r.redact("key: rk_test_ABCDEFGHIJKLMNOP")).toBe(`key: ${REDACTED}`);
    expect(r.redact("re_abcdefghijklmnopqrstuvwx")).toBe(REDACTED);
    expect(r.redact("whsec_abcdefghijklmnop")).toBe(REDACTED);
  });

  it("prefers the longest overlapping secret", () => {
    const r = new Redactor(["abcdefgh", "abcdefghijkl"], false);
    expect(r.redact("abcdefghijkl")).toBe(REDACTED);
  });
});

describe("createRedactStream", () => {
  it("redacts a secret split across chunks", async () => {
    const r = new Redactor([SECRET]);
    const out = await pipeChunks(r, [
      "before ",
      SECRET.slice(0, 10),
      SECRET.slice(10, 20),
      SECRET.slice(20) + " after",
    ]);
    expect(out).toBe(`before ${REDACTED} after`);
    expect(out).not.toContain(SECRET.slice(8, 20));
  });

  it("redacts a secret split one byte at a time", async () => {
    const r = new Redactor([SECRET]);
    const out = await pipeChunks(r, [...("pre:" + SECRET + ":post")]);
    expect(out).toBe(`pre:${REDACTED}:post`);
  });

  it("emits ordinary output without holding it back", () => {
    const r = new Redactor([SECRET]);
    expect(r.splitSafe("ready on http://localhost:3000\n")).toEqual({
      emit: "ready on http://localhost:3000\n",
      carry: "",
    });
  });

  it("only carries a tail that could start a secret", () => {
    const r = new Redactor([SECRET]);
    expect(r.splitSafe("hello sk_te")).toEqual({ emit: "hello ", carry: "sk_te" });
  });

  it("handles multibyte characters split across chunks", async () => {
    const r = new Redactor([SECRET]);
    const buf = Buffer.from("héllo ✓");
    const out: string[] = [];
    const s = Readable.from([buf.subarray(0, 2), buf.subarray(2, 9), buf.subarray(9)]).pipe(
      createRedactStream(r),
    );
    for await (const c of s) out.push(String(c));
    expect(out.join("")).toBe("héllo ✓");
  });
});

describe("redactJson", () => {
  it("redacts secret-named fields and known values", () => {
    const r = new Redactor(["knownvalue12345"]);
    expect(
      redactJson(
        { id: "k1", token: "anything", nested: [{ note: "has knownvalue12345" }], n: 1 },
        r,
      ),
    ).toEqual({ id: "k1", token: REDACTED, nested: [{ note: `has ${REDACTED}` }], n: 1 });
  });
});
