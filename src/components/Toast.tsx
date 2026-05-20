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
    <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 bg-white text-black px-4 py-2 rounded font-bold text-sm shadow-lg animate-fade-in">
      {message}
    </div>
  );
}
