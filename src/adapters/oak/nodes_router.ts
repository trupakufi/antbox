import { AntboxService } from "../../application/antbox_service.ts";
import { Node } from "../../domain/nodes/node.ts";
import { AntboxError } from "../../shared/antbox_error.ts";
import { Either } from "../../shared/either.ts";
import { ContextWithParams } from "./context_with_params.ts";
import { getRequestContext } from "./get_request_context.ts";
import { processError } from "./process_error.ts";
import { sendOK, sendBadRequest } from "./send_response.ts";
import { Context, Router, Status } from "/deps/oak";
import { getQuery } from "/deps/oak/helpers";

export default function (service: AntboxService) {
  const listHandler = (ctx: Context) => {
    const query = getQuery(ctx);

    const parent = query.parent?.length > 0 ? query.parent : undefined;

    return service
      .list(getRequestContext(ctx), parent)
      .then((result) => {
        if (result.isLeft()) {
          return processError(result.value, ctx);
        }

        return sendOK(ctx, result.value);
      })
      .catch((err) => processError(err, ctx));
  };

  const getHandler = (ctx: ContextWithParams) => {
    return service
      .get(getRequestContext(ctx), ctx.params.uuid)
      .then((result) => {
        if (result.isLeft()) {
          return processError(result.value, ctx);
        }

        ctx.response.status = Status.OK;
        ctx.response.type = "json";
        ctx.response.body = result.value;
      })
      .catch((err) => processError(err, ctx));
  };

  const exportHandler = (ctx: ContextWithParams) => {
    const uuid = ctx.params.uuid;
    const requestContext = getRequestContext(ctx);

    return Promise.all([
      service.get(requestContext, uuid),
      service.export(requestContext, uuid),
    ])
      .then(([node, blob]) => {
        if (node.isLeft()) {
          return processError(node.value, ctx);
        }

        if (blob.isLeft()) {
          return processError(blob.value, ctx);
        }

        ctx.response.headers.set("Content-Type", node.value.mimetype);
        ctx.response.headers.set("Content-length", blob.value.size.toString());

        ctx.response.type = "blob";
        ctx.response.body = blob.value;
      })
      .catch((err) => processError(err, ctx));
  };

  const createHandler = async (ctx: Context) => {
    const {
      type,
      metadata,
    }: { type?: "Folder" | "Metanode"; metadata: Partial<Node> } =
      await ctx.request.body().value;

    if (!type) {
      return Promise.resolve(sendBadRequest(ctx, "{ type } not given"));
    }

    if (!metadata?.title) {
      return Promise.resolve(sendBadRequest(ctx, "{ title } not given"));
    }

    const authCtx = getRequestContext(ctx);

    const creator =
      type === "Metanode"
        ? service.createMetanode(authCtx, metadata)
        : service.createFolder(authCtx, metadata);

    return creator
      .then((result) => processEither(ctx, result))
      .catch((err) => processError(err, ctx));
  };

  const updateHandler = async (ctx: ContextWithParams) => {
    const body = await ctx.request.body().value;

    return service
      .update(getRequestContext(ctx), ctx.params.uuid, body)
      .then((result) => {
        if (result.isLeft()) {
          return processError(result.value, ctx);
        }

        sendOK(ctx);
      })
      .catch((err) => processError(err, ctx));
  };

  const deleteHandler = (ctx: ContextWithParams) => {
    return service
      .delete(getRequestContext(ctx), ctx.params.uuid)
      .then(() => {
        sendOK(ctx);
      })
      .catch((err) => processError(err, ctx));
  };

  const copyHandler = async (ctx: ContextWithParams) => {
    const { to }: { to: string } = await ctx.request.body().value;

    return service
      .copy(getRequestContext(ctx), ctx.params.uuid, to)
      .then((result) => {
        if (result.isLeft()) {
          return processError(result.value, ctx);
        }

        sendOK(ctx);
      })
      .catch((err) => processError(err, ctx));
  };

  const duplicateHandler = (ctx: ContextWithParams) => {
    return service
      .duplicate(getRequestContext(ctx), ctx.params.uuid)
      .then((result) => processEither(ctx, result))
      .catch((err) => processError(err, ctx));
  };

  const queryHandler = async (ctx: Context) => {
    const { filters, pageSize, pageToken } = await ctx.request.body().value;

    return service
      .query(getRequestContext(ctx), filters, pageSize, pageToken)
      .then((result) => processEither(ctx, result, result.value))
      .catch((err) => processError(err, ctx));
  };

  const evaluateHandler = (ctx: ContextWithParams) => {
    return service
      .evaluate(getRequestContext(ctx), ctx.params.uuid)
      .then((result) => processEither(ctx, result, result.value))
      .catch((err) => processError(err, ctx));
  };

  const nodesRouter = new Router({ prefix: "/nodes" });

  nodesRouter.get("/:uuid", getHandler);
  nodesRouter.get("/:uuid/-/export", exportHandler);
  nodesRouter.get("/:uuid/-/duplicate", duplicateHandler);
  nodesRouter.get("/:uuid/-/evaluate", evaluateHandler);

  nodesRouter.get("/", listHandler);

  nodesRouter.post("/", createHandler);
  nodesRouter.post("/:uuid/-/copy", copyHandler);
  nodesRouter.post("/-/query", queryHandler);

  nodesRouter.patch("/:uuid", updateHandler);

  nodesRouter.delete("/:uuid", deleteHandler);

  return nodesRouter;
}

function processEither<L extends AntboxError, R>(
  ctx: Context,
  either: Either<L, R>,
  value?: unknown
) {
  if (either.isLeft()) {
    return processError(either.value, ctx);
  }

  return sendOK(ctx, value as Record<string, unknown>);
}
