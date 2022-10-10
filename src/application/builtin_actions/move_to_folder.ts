import { Action, RunContext } from "/domain/actions/action.ts";

export default {
  uuid: "move_to_folder",
  title: "Mover para pasta",
  description: "Move os nós para uma pasta",
  builtIn: true,
  multiple: true,
  aspectConstraints: [],
  mimetypeConstraints: [],
  params: ["destination"],
  run,
} as Action;

function run(
  ctx: RunContext,
  uuids: string[],
  params: Record<string, string>
): Promise<void | Error> {
  const parent = params["destination"];

  const batch = uuids.map((u) =>
    ctx.nodeService.update(ctx.principal, u, { parent }, true)
  );

  return Promise.all(batch).then(() => {});
}
