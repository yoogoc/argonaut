import "./index.css";
import "@/lib/i18n";
import "@/stores/theme";

import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { queryClient } from "@/lib/query";

import { router } from "./router";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={300}>
        <RouterProvider router={router} />
        <Toaster richColors closeButton position="top-right" />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
