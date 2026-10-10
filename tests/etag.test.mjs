// A CDN that compresses a response marks its ETag weak; the value must
// still round-trip into If-Match unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { cleanETag } from "../dist/transport.js";

test("cleanETag strips the weak marker and quotes", () => {
  assert.equal(cleanETag('W/"c8f12687c41becc81a4bee0e521aeace"'), "c8f12687c41becc81a4bee0e521aeace");
  assert.equal(cleanETag('"abc"'), "abc");
  assert.equal(cleanETag("abc"), "abc");
  assert.equal(cleanETag(' w/"x" '), "x");
  assert.equal(cleanETag(null), "");
});
