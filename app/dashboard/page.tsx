"use client";

import { useState } from "react";
import { getBrowserClient } from "@/lib/supabase";

const METHODS = ["paypal", "binance", "zinli", "wally", "airtm", "usdt_bep20"];

export default function ClientDashboard() {
  const [kind, setKind] = useState<"buy" | "sell">("sell");
  const [method, setMethod] = useState(METHODS[0]);
  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  async function handleSubmit() {
    setStatus("Creando operación…");
    const supabase = getBrowserClient();
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) {
      setStatus("Debes iniciar sesión.");
      return;
    }

    // NOTA: la tasa aplicada debería venir de /api/rates (a construir) —
    // aquí se deja un placeholder simple para que el flujo sea funcional.
    const rateApplied = 40; // Bs por USD, ejemplo
    const amountSent = Number(amount);
    const amountReceived = kind === "sell" ? amountSent * rateApplied : amountSent / rateApplied;

    const res = await fetch("/api/operations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: userData.user.id,
        kind,
        paymentMethodId: method,
        amountSent,
        amountReceived,
        rateApplied,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      setStatus(`Error: ${data.error}`);
      return;
    }
    setStatus("Operación creada. Esperando que un liquidador la tome…");
  }

  return (
    <div className="p-6 max-w-md mx-auto space-y-4">
      <h1 className="text-2xl font-semibold">Nueva operación</h1>

      <div className="flex gap-2">
        <button
          className={`flex-1 py-2 rounded-md ${kind === "sell" ? "bg-black text-white" : "border"}`}
          onClick={() => setKind("sell")}
        >
          Vender divisas
        </button>
        <button
          className={`flex-1 py-2 rounded-md ${kind === "buy" ? "bg-black text-white" : "border"}`}
          onClick={() => setKind("buy")}
        >
          Comprar divisas
        </button>
      </div>

      <select
        value={method}
        onChange={(e) => setMethod(e.target.value)}
        className="w-full border rounded-md p-2"
      >
        {METHODS.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>

      <input
        type="number"
        placeholder="Monto en USD"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        className="w-full border rounded-md p-2"
      />

      <button
        onClick={handleSubmit}
        className="w-full py-2 rounded-md bg-black text-white"
      >
        Confirmar operación
      </button>

      {status && <p className="text-sm text-gray-500">{status}</p>}
    </div>
  );
}
