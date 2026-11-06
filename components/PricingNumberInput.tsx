"use client";

import { useState } from "react";

type Props = {
  value: number;
  onValue: (value: number) => void;
  disabled?: boolean;
  className?: string;
  integer?: boolean;
  placeholder?: string;
};

export default function PricingNumberInput({
  value,
  onValue,
  disabled = false,
  className,
  integer = false,
  placeholder,
}: Props) {
  const [input, setInput] = useState({ sourceValue: value, draft: value > 0 ? String(value) : "" });
  if (input.sourceValue !== value) {
    setInput({ sourceValue: value, draft: value > 0 ? String(value) : "" });
  }

  const commit = () => {
    const parsed = Number(input.draft);
    const next = Number.isFinite(parsed) ? Math.max(0, integer ? Math.trunc(parsed) : parsed) : 0;
    setInput({ sourceValue: next, draft: next > 0 ? String(next) : "" });
    onValue(next);
  };

  return (
    <input
      type="text"
      inputMode={integer ? "numeric" : "decimal"}
      disabled={disabled}
      className={className}
      placeholder={placeholder}
      value={input.draft}
      onChange={(event) => {
        const next = event.target.value.trim();
        const pattern = integer ? /^\d*$/ : /^\d*(?:\.\d*)?$/;
        if (pattern.test(next)) setInput((current) => ({ ...current, draft: next }));
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}
