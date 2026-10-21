import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Confirmation for destructive operations. When `typeToConfirm` is set the user must type the
 * resource name, which is what Terminate and Delete require (DESIGN §5.3).
 */
export function ConfirmAction({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  typeToConfirm,
  destructive = true,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: string;
  typeToConfirm?: string;
  destructive?: boolean;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState("");
  const ready = !typeToConfirm || typed === typeToConfirm;
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setTyped("");
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
        </AlertDialogHeader>
        {children}
        {typeToConfirm && (
          <div className="space-y-2">
            <Label htmlFor="confirm-name">
              {t("Type")} <span className="font-mono font-semibold">{typeToConfirm}</span> {t("to confirm")}
            </Label>
            <Input id="confirm-name" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" className="font-mono" />
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
          <AlertDialogAction
            disabled={!ready}
            className={destructive ? "bg-destructive text-white hover:bg-destructive/90" : undefined}
            onClick={() => {
              setTyped("");
              onConfirm();
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
