"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

type ToastItem = { id: string; title: string; tone: "info" | "success" | "danger" };

const ToastContext = createContext<{ push: (title: string, tone?: ToastItem["tone"]) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const push = useCallback((title: string, tone: ToastItem["tone"] = "info") => {
    const id = crypto.randomUUID();
    setToasts((current) => [...current, { id, title, tone }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((item) => item.id !== id));
    }, 4000);
  }, []);
  const value = useMemo(() => ({ push }), [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role="status"
            className={`pointer-events-auto rounded-card border px-4 py-3 text-sm shadow-md ${
              toast.tone === "danger"
                ? "border-danger bg-danger-bg text-danger"
                : toast.tone === "success"
                  ? "border-success bg-success-bg text-success"
                  : "border-border bg-card text-fg"
            }`}
          >
            {toast.title}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within ToastProvider");
  }
  return context;
}
