import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createToolPipeline } from "../../../src/tools/pipeline.ts";
import { createSerializeInterceptor } from "../../../src/tools/interceptors/serialize.ts";
import {
  DEFAULT_TOOL_ARGS_MAX_BYTES,
  serializeBoundedToolArguments,
  ToolResourceError,
} from "../../../src/tool_bounds.ts";
import { makeBodies, makeCall } from "../support.ts";

function serializePipeline(): ReturnType<typeof createToolPipeline> {
  return createToolPipeline({ interceptors: [createSerializeInterceptor()] });
}

describe("serialize interceptor", () => {
  test("sets inputBytes from the serialized args and delegates to the body", async () => {
    let inputBytes: number | undefined;
    let bodyRan = false;
    const pipeline = createToolPipeline({
      interceptors: [createSerializeInterceptor()],
      onResult: (_dispatch, r) => {
        inputBytes = r.inputBytes;
      },
    });
    const content = await pipeline.dispatch({
      call: makeCall({ args: { a: 1, b: "two" } }),
      bodies: makeBodies({
        plugin: async () => {
          bodyRan = true;
          return "ok";
        },
      }),
    });
    assert.equal(content, "ok");
    assert.equal(bodyRan, true);
    const expected = Buffer.byteLength(
      serializeBoundedToolArguments({ a: 1, b: "two" }),
      "utf8",
    );
    assert.equal(inputBytes, expected);
  });

  test("throws tool_args_too_large before the body runs", async () => {
    let bodyRan = false;
    const pipeline = serializePipeline();
    await assert.rejects(
      pipeline.dispatch({
        call: makeCall({ args: { blob: "x".repeat(DEFAULT_TOOL_ARGS_MAX_BYTES + 1) } }),
        bodies: makeBodies({
          plugin: async () => {
            bodyRan = true;
            return "never";
          },
        }),
      }),
      (error: unknown) =>
        error instanceof ToolResourceError && error.code === "tool_args_too_large",
    );
    assert.equal(bodyRan, false);
  });

  test("throws tool_args_not_serializable for a cyclic value", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const pipeline = serializePipeline();
    await assert.rejects(
      pipeline.dispatch({
        call: makeCall({ args: cyclic }),
        bodies: makeBodies(),
      }),
      (error: unknown) =>
        error instanceof ToolResourceError &&
        error.code === "tool_args_not_serializable",
    );
  });
});
