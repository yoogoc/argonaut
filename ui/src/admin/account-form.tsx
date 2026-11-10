import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import type { NewAccount } from "@/api/accounts";
import { ErrorState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function AccountForm({
  setup = false, pending, error, onSubmit,
}: {
  setup?: boolean;
  pending: boolean;
  error?: unknown;
  onSubmit: (user: NewAccount, token: string) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [user, setUser] = useState<NewAccount>({ name: "", email: "" });
  const [token, setToken] = useState("");
  const fields = [
    { key: "name", label: "Display name", maxLength: 128, autoComplete: "name" },
    { key: "email", label: "Email", required: true, type: "email", maxLength: 254, autoComplete: "email" },
  ] as const;

  return (
    <form className="space-y-4" onSubmit={(e) => {
      e.preventDefault();
      if (!pending) onSubmit(user, token);
    }}>
      {error ? <ErrorState error={error} /> : null}
      {setup && (
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-token`}>{t("Setup token")}</Label>
          <Input id={`${id}-token`} type="password" value={token} onChange={(e) => setToken(e.target.value)} required autoComplete="off" />
        </div>
      )}
      {fields.map(({ key, label, ...props }) => (
        <div key={key} className="space-y-1.5">
          <Label htmlFor={`${id}-${key}`}>{t(label)}</Label>
          <Input id={`${id}-${key}`} value={user[key]} onChange={(e) => setUser({ ...user, [key]: e.target.value })} {...props} />
        </div>
      ))}
      <Button type="submit" className="w-full" disabled={pending}>
        {t(pending ? "Creating…" : setup ? "Create administrator" : "Create user")}
      </Button>
    </form>
  );
}
