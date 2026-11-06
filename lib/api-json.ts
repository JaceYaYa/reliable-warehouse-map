import { GoodsFlowError } from "./goods-flow";

/**
 * Keeps API failures machine-readable for the client. Cloudflare will otherwise
 * turn an uncaught route error into an empty/non-JSON 500 response, which used
 * to surface as "Unexpected end of JSON input" in the pricing screen.
 */
export async function withJsonErrors(
  handler: () => Promise<Response>,
  fallbackMessage: string,
) {
  try {
    return await handler();
  } catch (error) {
    if(error instanceof GoodsFlowError) return Response.json({error:error.message},{status:error.status});
    if(/CHECK constraint failed:.*goods|CHECK constraint failed: valid/i.test(String(error)))return Response.json({error:"库存或计价批次刚有变化，本次未保存；请刷新后重新核对"},{status:409});
    console.error(`[api] ${fallbackMessage}`, error);
    const invalidJson = error instanceof SyntaxError;
    return Response.json(
      {
        ok: false,
        error: invalidJson ? "提交的数据格式不正确，请刷新页面后重试" : fallbackMessage,
      },
      {
        status: invalidJson ? 400 : 500,
        headers: { "cache-control": "no-store" },
      },
    );
  }
}
