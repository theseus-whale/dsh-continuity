import test from "node:test";
import assert from "node:assert/strict";
import { attributeTurnSeqs } from "../src/turn-tag.mjs";

test("用户消息归到后面第一条 assistant 的轮", () => {
  const { turnSeqs, maxTurn } = attributeTurnSeqs([
    { seq: 1, type: "user/message", turn: null },
    { seq: 2, type: "assistant/message", turn: 7 },
    { seq: 3, type: "user/message", turn: null },
    { seq: 4, type: "assistant/message", turn: 7 },
  ]);
  assert.deepEqual(turnSeqs.get(7), [1, 2, 3, 4]);
  assert.equal(maxTurn, 7);
});

test("末尾没有 assistant 的用户消息不归属（当轮未产出）", () => {
  const { turnSeqs } = attributeTurnSeqs([
    { seq: 1, type: "assistant/message", turn: 3 },
    { seq: 2, type: "user/message", turn: null },
  ]);
  assert.deepEqual(turnSeqs.get(3), [1]);
});

test("两个轮各自归属", () => {
  const { turnSeqs } = attributeTurnSeqs([
    { seq: 1, type: "user/message", turn: null },
    { seq: 2, type: "assistant/message", turn: 1 },
    { seq: 3, type: "user/message", turn: null },
    { seq: 4, type: "assistant/message", turn: 2 },
  ]);
  assert.deepEqual(turnSeqs.get(1), [1, 2]);
  assert.deepEqual(turnSeqs.get(2), [3, 4]);
});
