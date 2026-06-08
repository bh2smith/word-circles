"use client";

import { useEffect, useState } from "react";

interface ToastProps {
  message: string;
  duration?: number;
  onDone?: () => void;
}

export default function Toast({
  message,
  duration = 2000,
  onDone,
}: ToastProps) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(false);
      onDone?.();
    }, duration);
    return () => clearTimeout(timer);
  }, [duration, onDone]);

  if (!visible) return null;

  return (
    <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 bg-foreground text-background px-4 py-2 rounded-lg font-bold text-sm shadow-xl shadow-primary/20 animate-fade-in">
      {message}
    </div>
  );
}
