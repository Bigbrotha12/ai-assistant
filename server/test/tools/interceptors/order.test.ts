import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  JOB_TOOL_INTERCEPTOR_ORDER,
  createJobToolInterceptors,
} from "../../../src/tools/interceptors/order.ts";
import { makeLedger } from "../support.ts";

describe("job interceptor order", () => {
  test("the factory emits exactly the documented canonical order", () => {
    const ledger = makeLedger();
    const interceptors = createJobToolInterceptors({ ledger });
    assert.deepEqual(
      interceptors.map((interceptor) => interceptor.name),
      [...JOB_TOOL_INTERCEPTOR_ORDER],
    );
  });

  test("load-bearing pairings: fence<serialize, replay<cache, budget<execution", () => {
    const ledger = makeLedger();
    const names = createJobToolInterceptors({ ledger }).map(
      (interceptor) => interceptor.name,
    );
    assert.ok(names.indexOf("fence") < names.indexOf("serialize"));
    assert.ok(names.indexOf("replay") < names.indexOf("cache"));
    assert.ok(
      names.indexOf("budget") < names.indexOf("execution"),
      "budget must wrap execution for quarantine to fire",
    );
  });
});
