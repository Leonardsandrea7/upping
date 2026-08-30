import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

/**
 * POST /api/operations
 * Crea una operación nueva en estado 'pending_match'.
 * El cliente debe estar autenticado (se valida el JWT de Supabase en
 * el middleware — ver middleware.ts).
 */
export async function POST(req: NextRequest) {
  const supabase = getServiceClient();
  const body = await req.json();

  const { clientId, kind, paymentMethodId, amountSent, amountReceived, rateApplied } = body;

  if (!clientId || !kind || !paymentMethodId || !amountSent || !amountReceived) {
    return NextResponse.json({ error: "Faltan campos requeridos." }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("operations")
    .insert({
      client_id: clientId,
      kind,
      payment_method_id: paymentMethodId,
      amount_sent: amountSent,
      amount_received: amountReceived,
      rate_applied: rateApplied,
      status: "pending_match",
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ operation: data }, { status: 201 });
}

/**
 * GET /api/operations?status=pending_match&paymentMethodId=binance
 * Lista operaciones — usado por el tablero del liquidador para ver
 * la cola de pedidos disponibles.
 */
export async function GET(req: NextRequest) {
  const supabase = getServiceClient();
  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status");
  const paymentMethodId = searchParams.get("paymentMethodId");

  let query = supabase.from("operations").select("*").order("created_at", { ascending: true });
  if (status) query = query.eq("status", status);
  if (paymentMethodId) query = query.eq("payment_method_id", paymentMethodId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ operations: data });
}
