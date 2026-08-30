import { SupabaseClient } from "@supabase/supabase-js";

/**
 * Motor de matching — Modelo A (cola de pedidos) + asignación asistida.
 *
 * No asigna "a ciegas": filtra liquidadores que puedan cubrir la operación
 * con su colateral disponible, ordena por reputación, y dentro de la app
 * el liquidador con mejor prioridad la ve primero en su cola. El propio
 * liquidador la "toma" (claimOperation) — así el sistema nunca compromete
 * a alguien sin su acción explícita.
 */

const COLLATERAL_MULTIPLIER = 1.2; // colateral bloqueado = monto * 1.2 (cubre volatilidad de tasa)

export interface EligibleLiquidator {
  liquidatorId: string;
  score: number;
  availableCollateral: number;
  currentOpenOps: number;
}

/**
 * Devuelve liquidadores elegibles para una operación, ordenados por
 * reputación descendente. No asigna todavía — solo calcula elegibilidad.
 */
export async function findEligibleLiquidators(
  supabase: SupabaseClient,
  params: { paymentMethodId: string; amountUsdEquivalent: number }
): Promise<EligibleLiquidator[]> {
  const requiredCollateral = params.amountUsdEquivalent * COLLATERAL_MULTIPLIER;

  const { data: liquidators, error } = await supabase
    .from("liquidators")
    .select(
      `id, status, max_concurrent_ops, payment_methods,
       collateral_accounts ( total_balance, locked_balance ),
       reputation_scores ( score )`
    )
    .eq("status", "active")
    .contains("payment_methods", [params.paymentMethodId]);

  if (error) throw error;

  const { data: openCounts } = await supabase
    .from("operations")
    .select("liquidator_id")
    .in("status", [
      "matched",
      "awaiting_payment",
      "payment_sent",
      "liquidator_verifying",
      "liquidator_paying",
    ]);

  const openOpsByLiquidator = new Map<string, number>();
  for (const row of openCounts ?? []) {
    if (!row.liquidator_id) continue;
    openOpsByLiquidator.set(
      row.liquidator_id,
      (openOpsByLiquidator.get(row.liquidator_id) ?? 0) + 1
    );
  }

  const eligible: EligibleLiquidator[] = [];

  for (const l of liquidators ?? []) {
    const collateral = Array.isArray(l.collateral_accounts)
      ? l.collateral_accounts[0]
      : l.collateral_accounts;
    const reputation = Array.isArray(l.reputation_scores)
      ? l.reputation_scores[0]
      : l.reputation_scores;

    const available = collateral
      ? Number(collateral.total_balance) - Number(collateral.locked_balance)
      : 0;
    const currentOpenOps = openOpsByLiquidator.get(l.id) ?? 0;

    if (available < requiredCollateral) continue;
    if (currentOpenOps >= l.max_concurrent_ops) continue;

    eligible.push({
      liquidatorId: l.id,
      score: reputation ? Number(reputation.score) : 5,
      availableCollateral: available,
      currentOpenOps,
    });
  }

  return eligible.sort((a, b) => b.score - a.score);
}

/**
 * Un liquidador "toma" una operación de la cola. Bloquea colateral y
 * transiciona la operación a 'matched'. Usa una transacción a nivel de
 * aplicación con verificación optimista (status check) para evitar que
 * dos liquidadores tomen la misma operación en simultáneo.
 */
export async function claimOperation(
  supabase: SupabaseClient,
  params: { operationId: string; liquidatorId: string; amountUsdEquivalent: number }
) {
  const requiredCollateral = params.amountUsdEquivalent * COLLATERAL_MULTIPLIER;

  // 1. Verificar que la operación sigue disponible (nadie más la tomó)
  const { data: op, error: opError } = await supabase
    .from("operations")
    .select("id, status")
    .eq("id", params.operationId)
    .eq("status", "pending_match")
    .single();

  if (opError || !op) {
    throw new Error("La operación ya no está disponible.");
  }

  // 2. Verificar colateral disponible del liquidador
  const { data: account, error: accError } = await supabase
    .from("collateral_accounts")
    .select("id, total_balance, locked_balance")
    .eq("liquidator_id", params.liquidatorId)
    .single();

  if (accError || !account) throw new Error("Cuenta de colateral no encontrada.");

  const available = Number(account.total_balance) - Number(account.locked_balance);
  if (available < requiredCollateral) {
    throw new Error("Colateral insuficiente para tomar esta operación.");
  }

  // 3. Bloquear colateral
  const { error: lockError } = await supabase
    .from("collateral_accounts")
    .update({ locked_balance: Number(account.locked_balance) + requiredCollateral })
    .eq("id", account.id);
  if (lockError) throw lockError;

  await supabase.from("collateral_transactions").insert({
    collateral_account_id: account.id,
    operation_id: params.operationId,
    type: "lock",
    amount: requiredCollateral,
    reason: "Bloqueo al tomar operación",
  });

  // 4. Transicionar la operación (con condición de status para evitar carrera)
  const { data: updated, error: updateError } = await supabase
    .from("operations")
    .update({
      liquidator_id: params.liquidatorId,
      status: "matched",
      matched_at: new Date().toISOString(),
      collateral_locked: requiredCollateral,
    })
    .eq("id", params.operationId)
    .eq("status", "pending_match") // condición de carrera: solo si sigue pending
    .select()
    .single();

  if (updateError || !updated) {
    // Revertir el bloqueo si alguien más ganó la carrera
    await supabase
      .from("collateral_accounts")
      .update({ locked_balance: Number(account.locked_balance) })
      .eq("id", account.id);
    throw new Error("Otro liquidador tomó esta operación primero.");
  }

  return updated;
}

/**
 * Libera el colateral bloqueado cuando una operación se completa sin disputa.
 */
export async function releaseCollateral(
  supabase: SupabaseClient,
  params: { operationId: string }
) {
  const { data: op } = await supabase
    .from("operations")
    .select("liquidator_id, collateral_locked")
    .eq("id", params.operationId)
    .single();

  if (!op?.liquidator_id || !op.collateral_locked) return;

  const { data: account } = await supabase
    .from("collateral_accounts")
    .select("id, locked_balance")
    .eq("liquidator_id", op.liquidator_id)
    .single();

  if (!account) return;

  await supabase
    .from("collateral_accounts")
    .update({
      locked_balance: Math.max(0, Number(account.locked_balance) - Number(op.collateral_locked)),
    })
    .eq("id", account.id);

  await supabase.from("collateral_transactions").insert({
    collateral_account_id: account.id,
    operation_id: params.operationId,
    type: "unlock",
    amount: op.collateral_locked,
    reason: "Operación completada sin disputa",
  });
}

/**
 * Aplica una penalización (slash) al colateral de un liquidador que
 * perdió una disputa.
 */
export async function slashCollateral(
  supabase: SupabaseClient,
  params: { operationId: string; liquidatorId: string; amount: number; reason: string }
) {
  const { data: account } = await supabase
    .from("collateral_accounts")
    .select("id, total_balance, locked_balance")
    .eq("liquidator_id", params.liquidatorId)
    .single();

  if (!account) throw new Error("Cuenta de colateral no encontrada.");

  await supabase
    .from("collateral_accounts")
    .update({
      total_balance: Number(account.total_balance) - params.amount,
      locked_balance: Math.max(0, Number(account.locked_balance) - params.amount),
    })
    .eq("id", account.id);

  await supabase.from("collateral_transactions").insert({
    collateral_account_id: account.id,
    operation_id: params.operationId,
    type: "slash",
    amount: params.amount,
    reason: params.reason,
  });
}
