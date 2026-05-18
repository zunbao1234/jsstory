import assert from "node:assert/strict";

process.env.JSSTORY_SKIP_SERVER_LISTEN = "1";

const { __test__ } = await import("./index");

const gatewayError = __test__.normalizeOpenAIError(
  new Error("500 invalid character 'e' looking for beginning of value")
);

assert.match(gatewayError.message, /非 JSON 或损坏的 JSON/);
assert.doesNotMatch(gatewayError.message, /模型 gpt-5\.4 不可用或当前账号无权限/);
assert.equal(__test__.isGatewayNonJsonError("500 invalid character 'e' looking for beginning of value"), true);
assert.equal(__test__.shouldFallbackToChat(new Error("500 invalid character 'e' looking for beginning of value")), true);

const modelError = __test__.normalizeOpenAIError(new Error("model gpt-5.4 not found"));
assert.match(modelError.message, /模型 gpt-5\.4 不可用或当前账号无权限/);
assert.equal(__test__.shouldFallbackToChat(new Error("model gpt-5.4 not found")), false);

const responseFormatError = new Error("response_format json_schema is unsupported");
assert.equal(__test__.shouldFallbackToChat(responseFormatError), true);

assert.equal(__test__.getParallelLimit(), 2);

console.log("error handling tests passed");
