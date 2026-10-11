import type { ControlAction } from "@scout/core";
import { ControlError, type ControlRunner } from "@scout/ops";

export async function controlPlanResponse(runner: ControlRunner, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  if (body.target === "stack") {
    if (typeof body.name !== "string" || !/^[a-z0-9-]{1,32}$/.test(body.name)) return { status: 400, body: { error: "name must be a stack name" } };
    if (typeof body.action !== "string") return { status: 400, body: { error: "action is required" } };
    if (body.hard !== undefined && typeof body.hard !== "boolean") return { status: 400, body: { error: "hard must be a boolean" } };
    const plan = await runner.plan("stack", body.name, body.action as "start", body.hard === true);
    return { status: plan?.refusalKind === "unknown" && !plan.steps?.length ? 404 : 200, body: { plan } };
  }
  if (body.target !== "service" && body.target !== "listener" && body.target !== "recipe") return { status: 400, body: { error: "target must be service, listener or recipe" } };
  if (typeof body.id !== "number" || !Number.isSafeInteger(body.id) || body.id <= 0) return { status: 400, body: { error: "id must be a positive integer" } };
  if (!["start", "stop", "restart", "disable", "enable"].includes(body.action as string)) return { status: 400, body: { error: "action must be start, stop, restart, disable or enable" } };
  if (body.hard !== undefined && typeof body.hard !== "boolean" || body.hard === true && body.action !== "stop") return { status: 400, body: { error: "hard must be a boolean and is allowed only for stop" } };
  const plan = await runner.plan(body.target, body.id, body.action as ControlAction, body.hard === true);
  return plan ? { status: 200, body: { plan } } : { status: 404, body: { error: "not found" } };
}

export async function controlRunResponse(runner: ControlRunner, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  if (body.confirm !== true || typeof body.planId !== "string" || typeof body.token !== "string") return { status: 400, body: { error: "planId, token and confirm: true are required" } };
  try {
    const { status, ...result } = await runner.run(body.planId, body.token);
    return { status, body: result };
  } catch (err) {
    if (err instanceof ControlError) return { status: err.status, body: { error: err.message } };
    return { status: 409, body: { error: "changed since the plan" } };
  }
}
