import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { slashCollateral, releaseCollateral } from "@/lib/matching";
import { recordReputationEvent } from "@/lib/reputation";

/**
 * POST /api/disputes
 * body: { operationId, openedBy, reason, evidence? }
 * Abre una disputa. Congela el colateral (no lo libera hasta resolver).
 */
export async function POST(req: NextRequest) {
  const supabase = getServiceClient();
  const body = await req.json();
  const { operationId, openedBy, reason, evidence } = body;

  const { data: operation } = await supabase
    .from("operations")
    .select("liquidator_id")
    .eq("id", operationId)
    .single();

  const { data: dispute, error } = await supabase
    .from("disputes")
    .insert({
      operation_id: operationId,
      opened_by: openedBy,
      reason,
      evidence: evidence ?? [],
      status: "open",
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await supabase.from("operations").update({ status: "dispute_opened" }).eq("id", operationId);

  if (operation?.liquidator_id) {
    await recordReputationEvent(supabase, {
      liquidatorId: operation.liquidator_id,
      operationId,
      eventType: "dispute_opened",
    });
  }

  return NextResponse.json({ dispute }, { status: 201 });
}

/**
 * PATCH /api/disputes
 * body: { disputeId, resolution: "resolved_client" | "resolved_liquidator" | "resolved_split",
 *         resolvedBy, notes, slashAmount? }
 *
 * Solo debe ser llamado desde el panel de admin (rol 'admin').
 * La verificación de rol se hace en el middleware / capa de autenticación,
 * no aquí — este endpoint asume que ya se validó.
 */
export async function PATCH(req: NextRequest) {
  const supabase = getServiceClient();
  const body = await req.json();
  const { disputeId, resolution, resolvedBy, notes, slashAmount } = body;

  const { data: dispute } = await supabase
    .from("disputes")
    .select("*, operations(*)")
    .eq("id", disputeId)
    .single();

  if (!dispute) return NextResponse.json({ error: "Disputa no encontrada." }, { status: 404 });

  const operation = (dispute as any).operations;

  await supabase
    .from("disputes")
    .update({
      status: resolution,
      resolution_notes: notes,
      resolved_by: resolvedBy,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", disputeId);

  if (resolution === "resolved_client") {
    // El liquidador pierde colateral, se compensa al cliente
    await slashCollateral(supabase, {
      operationId: operation.id,
      liquidatorId: operation.liquidator_id,
      amount: slashAmount ?? operation.collateral_locked,
      reason: `Disputa perdida: ${notes ?? "sin detalle"}`,
    });
    await recordReputationEvent(supabase, {
      liquidatorId: operation.liquidator_id,
      operationId: operation.id,
      eventType: "dispute_lost",
    });
  } else if (resolution === "resolved_liquidator") {
    await releaseCollateral(supabase, { operationId: operation.id });
    await recordReputationEvent(supabase, {
      liquidatorId: operation.liquidator_id,
      operationId: operation.id,
      eventType: "dispute_won",
    });
  }
  // resolved_split: requiere lógica manual de reparto, se deja para revisión caso por caso

  await supabase.from("operations").update({ status: "completed" }).eq("id", operation.id);

  return NextResponse.json({ ok: true });
}
