"use client";

import { useEffect, useState } from "react";
import { getBrowserClient } from "@/lib/supabase";

type Operation = {
  id: string;
  kind: "buy" | "sell";
  payment_method_id: string;
  amount_sent: number;
  amount_received: number;
  status: string;
  created_at: string;
};

export default function LiquidatorDashboard() {
  const [queue, setQueue] = useState<Operation[]>([]);
  const [myOps, setMyOps] = useState<Operation[]>([]);
  const [liquidatorId, setLiquidatorId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [claiming, setClaiming] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      const supabase = getBrowserClient();
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) return;

      const { data: liq } = await supabase
        .from("liquidators")
        .select("id")
        .eq("profile_id", userData.user.id)
        .single();
      if (liq) setLiquidatorId(liq.id);

      const res = await fetch("/api/operations?status=pending_match");
      const { operations } = await res.json();
      setQueue(operations ?? []);
      setLoading(false);
    }
    load();
  }, []);

  async function handleClaim(operationId: string) {
    if (!liquidatorId) return;
    setClaiming(operationId);
    try {
      const res = await fetch(`/api/operations/${operationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "claim", liquidatorId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setQueue((prev) => prev.filter((op) => op.id !== operationId));
      setMyOps((prev) => [...prev, data.operation]);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setClaiming(null);
    }
  }

  if (loading) return <div className="p-6">Cargando cola de operaciones…</div>;

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-8">
      <h1 className="text-2xl font-semibold">Panel de Liquidador</h1>

      <section>
        <h2 className="text-lg font-medium mb-3">Operaciones disponibles</h2>
        {queue.length === 0 && (
          <p className="text-sm text-gray-500">No hay operaciones pendientes por ahora.</p>
        )}
        <ul className="space-y-3">
          {queue.map((op) => (
            <li
              key={op.id}
              className="border rounded-lg p-4 flex items-center justify-between"
            >
              <div>
                <p className="font-medium">
                  {op.kind === "sell" ? "Cliente vende" : "Cliente compra"} —{" "}
                  {op.payment_method_id}
                </p>
                <p className="text-sm text-gray-500">
                  Envía ${op.amount_sent} · Recibe ${op.amount_received}
                </p>
              </div>
              <button
                onClick={() => handleClaim(op.id)}
                disabled={claiming === op.id}
                className="px-4 py-2 rounded-md bg-black text-white text-sm disabled:opacity-50"
              >
                {claiming === op.id ? "Tomando…" : "Tomar operación"}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="text-lg font-medium mb-3">Mis operaciones activas</h2>
        {myOps.length === 0 && (
          <p className="text-sm text-gray-500">Aún no has tomado ninguna operación.</p>
        )}
        <ul className="space-y-3">
          {myOps.map((op) => (
            <li key={op.id} className="border rounded-lg p-4">
              <p className="font-medium">
                {op.payment_method_id} — ${op.amount_sent}
              </p>
              <p className="text-sm text-gray-500">Estado: {op.status}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
