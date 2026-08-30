"use client";

import { useEffect, useState } from "react";
import { getBrowserClient } from "@/lib/supabase";

type Dispute = {
  id: string;
  operation_id: string;
  reason: string;
  status: string;
  created_at: string;
};

export default function AdminDisputesPage() {
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [adminId, setAdminId] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      const supabase = getBrowserClient();
      const { data: userData } = await supabase.auth.getUser();
      setAdminId(userData.user?.id ?? null);

      const { data } = await supabase
        .from("disputes")
        .select("*")
        .eq("status", "open")
        .order("created_at", { ascending: true });
      setDisputes(data ?? []);
    }
    load();
  }, []);

  async function resolve(
    disputeId: string,
    resolution: "resolved_client" | "resolved_liquidator"
  ) {
    const res = await fetch("/api/disputes", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        disputeId,
        resolution,
        resolvedBy: adminId,
        notes: notes[disputeId] ?? "",
      }),
    });
    if (res.ok) {
      setDisputes((prev) => prev.filter((d) => d.id !== disputeId));
    } else {
      const data = await res.json();
      alert(data.error);
    }
  }

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <h1 className="text-2xl font-semibold">Disputas abiertas</h1>
      {disputes.length === 0 && (
        <p className="text-sm text-gray-500">No hay disputas pendientes. 🎉</p>
      )}
      {disputes.map((d) => (
        <div key={d.id} className="border rounded-lg p-4 space-y-3">
          <p className="text-sm text-gray-500">Operación: {d.operation_id}</p>
          <p className="font-medium">{d.reason}</p>
          <textarea
            placeholder="Notas de resolución (visibles para ambas partes)"
            className="w-full border rounded-md p-2 text-sm"
            value={notes[d.id] ?? ""}
            onChange={(e) => setNotes((prev) => ({ ...prev, [d.id]: e.target.value }))}
          />
          <div className="flex gap-2">
            <button
              onClick={() => resolve(d.id, "resolved_client")}
              className="px-4 py-2 rounded-md bg-red-600 text-white text-sm"
            >
              Favor del cliente (penaliza liquidador)
            </button>
            <button
              onClick={() => resolve(d.id, "resolved_liquidator")}
              className="px-4 py-2 rounded-md bg-green-600 text-white text-sm"
            >
              Favor del liquidador
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
