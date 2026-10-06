import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { bf, type BfEnv } from "./brewfather";

const UNITS =
  "All Brewfather data is METRIC: volumes in liters, fermentables in kg, hops and misc in grams, temps in °C, gravity in SG (1.050). Convert imperial values before sending.";

const page = {
  limit: z.number().int().min(1).max(50).optional().describe("Items per page, default 10, max 50"),
  start_after: z.string().optional().describe("_id of the last item from the previous page"),
};

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}

function fail(e: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }] };
}

const wrap =
  <A>(fn: (args: A) => Promise<unknown>) =>
  async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (e) {
      return fail(e);
    }
  };

export function buildServer(env: BfEnv): McpServer {
  const server = new McpServer({ name: "brewfather", version: "1.0.0" });

  server.registerTool(
    "list_recipes",
    {
      description: "List Brewfather recipes (id, name, author, type, style, equipment). Use get_recipe for full detail.",
      inputSchema: page,
      annotations: { readOnlyHint: true },
    },
    wrap(({ limit, start_after }) => bf(env, "/recipes", { query: { limit, start_after } })),
  );

  server.registerTool(
    "get_recipe",
    {
      description: `Get one recipe with all fields (fermentables, hops, yeasts, miscs, mash, fermentation, water). ${UNITS}`,
      inputSchema: { id: z.string().describe("Recipe _id") },
      annotations: { readOnlyHint: true },
    },
    wrap(({ id }) => bf(env, `/recipes/${encodeURIComponent(id)}`)),
  );

  server.registerTool(
    "create_recipe",
    {
      description: [
        "Create a NEW recipe in Brewfather. Returns its id.",
        UNITS,
        "Common fields: name (required), type ('All Grain' | 'Extract' | 'Partial Mash'), batchSize (L), boilTime (min), efficiency (%),",
        "fermentables [{name, amount (kg), type, color (EBC), yield?}], hops [{name, amount (g), use ('Boil'|'Dry Hop'|'Whirlpool'|'First Wort'|'Mash'), time, alpha}],",
        "yeasts [{name, amount, type ('Ale'|'Lager'|...), form ('Dry'|'Liquid'), attenuation?}], miscs [{name, amount, use, time, type}], style {name}, notes.",
        "Brewfather calculates OG/FG/IBU/color itself. Confirm the recipe with the user before creating it.",
      ].join(" "),
      inputSchema: {
        recipe: z.looseObject({ name: z.string() }).describe("Recipe JSON in Brewfather's Recipe Object shape"),
      },
    },
    wrap(({ recipe }) => bf(env, "/recipes", { method: "POST", body: recipe })),
  );

  server.registerTool(
    "update_recipe",
    {
      description: [
        "Update an existing recipe. Shallow merge: top-level fields you send replace the stored ones, others are kept.",
        "ARRAYS REPLACE ENTIRELY: to change one hop, send the full hops list. Always get_recipe first and send the complete edited array.",
        "Overwrites the current working version (no new version is created).",
        UNITS,
        "Confirm the change with the user before updating.",
      ].join(" "),
      inputSchema: {
        id: z.string().describe("Recipe _id"),
        changes: z.looseObject({}).describe("Top-level recipe fields to set"),
      },
      annotations: { idempotentHint: true },
    },
    wrap(({ id, changes }) =>
      bf(env, `/recipes/${encodeURIComponent(id)}`, { method: "PATCH", body: changes }),
    ),
  );

  server.registerTool(
    "get_inventory",
    {
      description: `List inventory items of one type. Amounts: fermentables in kg, hops/miscs in g, yeasts in units/packs. ${UNITS}`,
      inputSchema: {
        type: z.enum(["fermentables", "hops", "yeasts", "miscs"]),
        in_stock_only: z.boolean().optional().describe("Only items with inventory > 0"),
        ...page,
      },
      annotations: { readOnlyHint: true },
    },
    wrap(({ type, in_stock_only, limit, start_after }) =>
      bf(env, `/inventory/${type}`, {
        query: { inventory_exists: in_stock_only, limit, start_after, complete: true },
      }),
    ),
  );

  // --- Batches (read-only) ---

  server.registerTool(
    "list_batches",
    {
      description:
        "List brew batches (id, name, batch number, status, brewer, brew date, recipe name). Filter by status to find what's fermenting. Use get_batch for full detail.",
      inputSchema: {
        status: z.enum(BATCH_STATUSES).optional().describe("Only batches with this status"),
        ...page,
      },
      annotations: { readOnlyHint: true },
    },
    wrap(({ status, limit, start_after }) =>
      bf(env, "/batches", { query: { status, limit, start_after, order_by: "brewDate", order_by_direction: "desc" } }),
    ),
  );

  server.registerTool(
    "get_batch",
    {
      description: `Get one batch with all fields: its recipe, measured values (OG, FG, volumes, mash pH), dates and notes. ${UNITS}`,
      inputSchema: { id: z.string().describe("Batch _id") },
      annotations: { readOnlyHint: true },
    },
    wrap(({ id }) => bf(env, `/batches/${encodeURIComponent(id)}`)),
  );

  server.registerTool(
    "get_readings",
    {
      description: [
        "Fermentation readings for a batch from a hydrometer (Tilt, iSpindel) or manual entries: gravity (SG), temp (°C), plus device battery/signal.",
        "Default returns only the latest reading. Set history to get the most recent readings, newest first.",
        "Times are ISO 8601 UTC.",
      ].join(" "),
      inputSchema: {
        id: z.string().describe("Batch _id"),
        history: z.boolean().optional().describe("Return recent history instead of only the latest"),
        max: z.number().int().min(1).max(500).optional().describe("History size, default 50, max 500"),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ id, history, max }) => {
      const bid = encodeURIComponent(id);
      if (!history) return withIsoTime(await bf(env, `/batches/${bid}/readings/last`));
      const all = (await bf(env, `/batches/${bid}/readings`)) as Reading[];
      const recent = [...all].sort((a, b) => (b.time ?? 0) - (a.time ?? 0)).slice(0, max ?? 50);
      return { total: all.length, returned: recent.length, readings: recent.map(withIsoTime) };
    }),
  );

  server.registerTool(
    "get_brewtracker",
    {
      description:
        "Brew day tracker for a batch: current stage and step, and the full stage list. Use it to answer 'what's next' or 'how long is left' during a brew. Brewfather saves it at events, not every second, so compute time left from the step's start time.",
      inputSchema: { id: z.string().describe("Batch _id") },
      annotations: { readOnlyHint: true },
    },
    wrap(({ id }) => bf(env, `/batches/${encodeURIComponent(id)}/brewtracker`)),
  );

  server.registerTool(
    "set_batch_status",
    {
      description: [
        "Change a batch's status. This is the ONLY batch write tool; there is no delete.",
        "To remove, retire, or 'delete' a batch, set status to Archived. It hides the batch and can be undone by setting another status.",
        "Confirm the batch name and new status with the user before calling.",
      ].join(" "),
      inputSchema: {
        id: z.string().describe("Batch _id"),
        status: z.enum(BATCH_STATUSES),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    wrap(({ id, status }) =>
      bf(env, `/batches/${encodeURIComponent(id)}`, { method: "PATCH", body: { status } }),
    ),
  );

  return server;
}

const BATCH_STATUSES = ["Planning", "Brewing", "Fermenting", "Conditioning", "Completed", "Archived"] as const;

type Reading = { time?: number; [k: string]: unknown };

function withIsoTime(r: unknown): unknown {
  if (r && typeof r === "object" && typeof (r as Reading).time === "number") {
    return { ...(r as Reading), time: new Date((r as Reading).time as number).toISOString() };
  }
  return r;
}
