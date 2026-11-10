import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Plus, Search, UserPlus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { AccountForm } from "@/admin/account-form";
import { GrantSheet } from "@/admin/grant-sheet";
import { AdminLayout } from "@/admin/layout";
import { createUser } from "@/api/accounts";
import { listUsers } from "@/api/authz";
import type { DirectoryUser } from "@/api/types";
import { EmptyState, ErrorState, Spinner } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatTimestamp } from "@/lib/format";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/admin/users")({ component: UsersPage });

const PAGE_SIZE = 50;

function UsersPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [grant, setGrant] = useState<{ user?: DirectoryUser }>();
  const [creating, setCreating] = useState(false);
  const query = useQuery({
    queryKey: ["authz", "user-directory", search.trim(), offset],
    queryFn: ({ signal }) => listUsers({ query: search.trim(), limit: PAGE_SIZE, offset }, signal),
  });
  const users = query.data?.users ?? [];
  const create = useMutation({
    gcTime: 0,
    mutationFn: createUser,
    onSuccess: (user) => {
      create.reset();
      setCreating(false);
      setSearch(user.email || user.subject || "");
      setOffset(0);
      void queryClient.invalidateQueries({ queryKey: ["authz", "user-directory"] });
      void queryClient.invalidateQueries({ queryKey: ["authz", "users"] });
      toast.success(t("Local user created."));
    },
  });

  return (
    <AdminLayout
      title={t("User management")}
      description={t("Manage local users and their Argonaut grants.")}
      actions={query.isSuccess && (
        <>
          <Button variant="outline" onClick={() => setGrant({})}>
            <Plus aria-hidden />
            {t("New grant")}
          </Button>
          <Button
            disabled={!query.data.accountCreationAvailable}
            title={query.data.accountCreationAvailable ? undefined : t("Configure an OIDC issuer to create users.")}
            onClick={() => {
              create.reset();
              setCreating(true);
            }}
          >
            <UserPlus aria-hidden />
            {t("Create user")}
          </Button>
        </>
      )}
    >
      <label className="relative w-full max-w-sm">
        <span className="sr-only">{t("Search users")}</span>
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setOffset(0);
          }}
          placeholder={t("Search by name, email or OIDC subject")}
          className="bg-card pl-9"
        />
      </label>
      {query.error ? (
        <ErrorState error={query.error} />
      ) : query.isPending ? (
        <Spinner />
      ) : users.length ? (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <Table className="min-w-[780px]">
            <TableHeader>
              <TableRow className="bg-muted/40">
                <TableHead>{t("Name")}</TableHead>
                <TableHead>{t("Email")}</TableHead>
                <TableHead>{t("OIDC subject (sub)")}</TableHead>
                <TableHead>{t("Last sign-in")}</TableHead>
                <TableHead className="text-right">{t("Actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((user) => (
                <TableRow key={user.subject ? `user:${user.subject}` : `email:${user.email}`}>
                  <TableCell className="font-medium">{user.name || "—"}</TableCell>
                  <TableCell>
                    {user.email ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="break-all">{user.email}</span>
                        <span className={cn("rounded-full px-2 py-0.5 text-xs", user.emailVerified ? "bg-phase-ok-bg text-phase-ok" : "bg-phase-susp-bg text-phase-susp")}>
                          {t(!user.subject ? "Pending sign-in" : user.emailVerified ? "Verified email" : "Unverified email")}
                        </span>
                      </div>
                    ) : "—"}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{user.subject || "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{formatTimestamp(user.lastLoginAt)}</TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      <Button asChild variant="ghost" size="sm">
                        <Link to="/admin/authz" search={{ subject: user.subject || user.email }}>{t("View grants")}</Link>
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setGrant({ user })}>{t("Grant")}</Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <EmptyState
          title={t(search.trim() ? "No matching users" : "No users yet")}
          description={search.trim() ? undefined : t("Users appear here after creation or sign-in.")}
        />
      )}
      {(offset > 0 || query.data?.hasMore) && (
        <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
          <span>{t("Page {{page}}", { page: offset / PAGE_SIZE + 1 })}</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={offset === 0 || query.isFetching} onClick={() => setOffset(offset - PAGE_SIZE)}>
              {t("Previous")}
            </Button>
            <Button variant="outline" size="sm" disabled={!query.data?.hasMore || query.isFetching} onClick={() => setOffset(offset + PAGE_SIZE)}>
              {t("Next")}
            </Button>
          </div>
        </div>
      )}
      {grant && <GrantSheet open user={grant.user} onOpenChange={(open) => { if (!open) setGrant(undefined); }} />}
      <Dialog open={creating} onOpenChange={(open) => {
        if (create.isPending) return;
        if (!open) create.reset();
        setCreating(open);
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Create user")}</DialogTitle>
            <DialogDescription>{t("Add a local user by email. The user is linked on sign-in with the matching verified Logto email.")}</DialogDescription>
          </DialogHeader>
          {creating && <AccountForm pending={create.isPending} error={create.error} onSubmit={(user) => create.mutate(user)} />}
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
