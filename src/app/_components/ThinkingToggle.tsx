"use client";

/** How hard ScopeBot thinks about an upload. Maps to Gemini's thinking level: quick = low, thorough = medium. */
export type ThinkingMode = "quick" | "thorough";

const MODES: { value: ThinkingMode; label: string; hint: string }[] = [
  { value: "quick", label: "Quick", hint: "About 10 seconds. Less reasoning shown." },
  { value: "thorough", label: "Thorough", hint: "About 25 seconds. Shows its reasoning as it works." },
];

export function ThinkingToggle({
  value,
  onChange,
  disabled,
  aiConnected,
}: {
  value: ThinkingMode;
  onChange: (mode: ThinkingMode) => void;
  disabled?: boolean;
  /** False when the server has no Gemini key: ScopeBot uses rules and the choice has no effect. */
  aiConnected: boolean;
}) {
  const active = MODES.find((m) => m.value === value)!;
  return (
    <div className={disabled ? "opacity-50" : ""}>
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold uppercase text-gray-400">ScopeBot</span>
        <div role="radiogroup" aria-label="ScopeBot thinking mode" className="flex rounded-lg border border-gray-600 p-0.5">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              role="radio"
              aria-checked={value === m.value}
              title={m.hint}
              disabled={disabled === true || !aiConnected}
              onClick={() => onChange(m.value)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                value === m.value ? "bg-purple-600 text-white" : "text-gray-300 hover:bg-gray-800"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-1 text-xs text-gray-500">
        {aiConnected ? active.hint : "No Gemini key on the server: basic rule-based mode."}
      </p>
    </div>
  );
}
