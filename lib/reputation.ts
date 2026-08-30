import { SupabaseClient } from "@supabase/supabase-js";

/**
 * Recalcula y persiste el score de un liquidador.
 * Fórmula simple e intencionalmente conservadora — ajustar constantes
 * con datos reales una vez haya volumen (ver spec de diseño, sección 2).
 */
export async function recalculateScore(
  supabase: SupabaseClient,
  liquidatorId: string
) {
  const { data: rep, error } = await supabase
    .from("reputation_scores")
    .select("*")
    .eq("liquidator_id", liquidatorId)
    .single();

  if (error || !rep) throw new Error("Registro de reputación no encontrado.");

  let score = 5.0;
  score -= rep.disputes_lost * 1.5;
  score -= rep.disputed_ops * 0.2;
  score += Math.min(0.5, Math.floor(rep.completed_ops / 50) * 0.1);
  score = Math.max(0, Math.min(5, score));

  await supabase
    .from("reputation_scores")
    .update({ score: Number(score.toFixed(2)), updated_at: new Date().toISOString() })
    .eq("liquidator_id", liquidatorId);

  // Suspensión automática si la tasa de disputas es muy alta y hay volumen suficiente
  // para que el dato sea significativo (evita suspender a alguien por 1 disputa en 2 ops).
  const disputeRate = rep.completed_ops > 0 ? rep.disputed_ops / rep.completed_ops : 0;
  if (rep.completed_ops >= 10 && disputeRate > 0.1) {
    await supabase
      .from("liquidators")
      .update({ status: "suspended" })
      .eq("id", liquidatorId);
  }

  return score;
}

/**
 * Registra un evento de reputación y actualiza los contadores agregados.
 * Llamar esto desde los endpoints de completar operación / resolver disputa.
 */
export async function recordReputationEvent(
  supabase: SupabaseClient,
  params: {
    liquidatorId: string;
    operationId: string;
    eventType: "completed" | "dispute_opened" | "dispute_lost" | "dispute_won" | "late_response";
    volumeUsd?: number;
  }
) {
  await supabase.from("reputation_events").insert({
    liquidator_id: params.liquidatorId,
    operation_id: params.operationId,
    event_type: params.eventType,
  });

  const { data: rep } = await supabase
    .from("reputation_scores")
    .select("*")
    .eq("liquidator_id", params.liquidatorId)
    .single();

  if (!rep) return;

  const updates: Record<string, number> = {};
  if (params.eventType === "completed") {
    updates.completed_ops = rep.completed_ops + 1;
    updates.total_volume_usd = Number(rep.total_volume_usd) + (params.volumeUsd ?? 0);
  }
  if (params.eventType === "dispute_opened") {
    updates.disputed_ops = rep.disputed_ops + 1;
  }
  if (params.eventType === "dispute_lost") {
    updates.disputes_lost = rep.disputes_lost + 1;
  }

  if (Object.keys(updates).length > 0) {
    await supabase
      .from("reputation_scores")
      .update(updates)
      .eq("liquidator_id", params.liquidatorId);
  }

  await recalculateScore(supabase, params.liquidatorId);
}
