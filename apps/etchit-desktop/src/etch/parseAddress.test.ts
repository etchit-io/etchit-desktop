import { describe, expect, it } from "vitest";
import { parseAddressFromOutput } from "./parseAddress";

const REAL_ADDR = "f4b86ae19e4b1e625ea2af9b15015340443988407f0ae56d28a1050e64ece167";

describe("parseAddressFromOutput", () => {
  it("returns null on empty output", () => {
    expect(parseAddressFromOutput("")).toBeNull();
  });

  it("returns null when there is no hex run", () => {
    expect(parseAddressFromOutput("uploaded successfully\ncost: 0.001 ANT")).toBeNull();
  });

  it("returns the first 64-hex token found", () => {
    const out = `connecting…\nuploaded to: ${REAL_ADDR}\ncost: 0.001 ANT\n`;
    expect(parseAddressFromOutput(out)).toBe(REAL_ADDR);
  });

  it("normalises uppercase to lowercase", () => {
    expect(parseAddressFromOutput(REAL_ADDR.toUpperCase())).toBe(REAL_ADDR);
  });

  it("ignores hex runs that aren't exactly 64 chars", () => {
    expect(parseAddressFromOutput("abc123\n")).toBeNull();
    expect(parseAddressFromOutput("a".repeat(63) + " " + "b".repeat(64))).toBe("b".repeat(64));
  });

  it("survives surrounding punctuation", () => {
    expect(parseAddressFromOutput(`{"address":"${REAL_ADDR}","status":"ok"}`)).toBe(REAL_ADDR);
    expect(parseAddressFromOutput(`address=${REAL_ADDR};`)).toBe(REAL_ADDR);
  });
});
