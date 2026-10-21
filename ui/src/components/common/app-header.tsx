import { Link, useNavigate } from "@tanstack/react-router";
import { Check, ChevronDown, Languages, LogOut, Monitor, Moon, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useMyPermissions } from "@/api/authz";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LANGUAGES } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useSession } from "@/stores/session";
import { type ThemePreference, useTheme } from "@/stores/theme";

import { Logo } from "./logo";
import { NamespaceSwitcher } from "./namespace-switcher";

const navClass =
  "flex h-8 items-center rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";
const navActive = "bg-accent font-semibold text-foreground";

export function AppHeader() {
  const { t } = useTranslation();
  const { data: permissions } = useMyPermissions();
  const showAdmin = !!permissions && (permissions.superAdmin || (permissions.grants ?? []).some((g) => g.role === "admin"));

  const items: { to: string; label: string }[] = [
    { to: "/workflows", label: t("Workflows") },
    { to: "/templates", label: t("Templates") },
    { to: "/cluster-templates", label: t("Cluster templates") },
    { to: "/components", label: t("Components") },
    { to: "/crons", label: t("CronWorkflows") },
  ];
  if (showAdmin) items.push({ to: "/admin/authz", label: t("Permissions") });

  return (
    <header className="sticky top-0 z-40 flex flex-wrap items-center gap-x-5 gap-y-2 border-b bg-background px-4 py-2 sm:px-6">
      <Link to="/workflows" aria-label="argonaut">
        <Logo />
      </Link>
      <nav aria-label={t("Main")} className="flex flex-wrap gap-1">
        {items.map((item) => (
          <Link key={item.to} to={item.to} className={navClass} activeProps={{ className: cn(navClass, navActive) }}>
            {item.label}
          </Link>
        ))}
      </nav>
      <div className="ml-auto flex items-center gap-2">
        <NamespaceSwitcher />
        <UserMenu />
      </div>
    </header>
  );
}

function UserMenu() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const user = useSession((s) => s.user);
  const logout = useSession((s) => s.logout);
  const preference = useTheme((s) => s.preference);
  const setPreference = useTheme((s) => s.setPreference);
  const name = user?.name || user?.email || user?.subject || "";

  const themes: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
    { value: "light", label: t("Light"), icon: Sun },
    { value: "dark", label: t("Dark"), icon: Moon },
    { value: "system", label: t("System"), icon: Monitor },
  ];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-2">
          <span aria-hidden className="flex size-7 items-center justify-center rounded-full bg-primary/15 text-xs font-bold text-primary">
            {name.slice(0, 1).toUpperCase()}
          </span>
          <span className="max-w-40 truncate">{name}</span>
          <ChevronDown className="size-3.5 opacity-60" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="space-y-0.5">
          <div className="truncate">{name}</div>
          {user?.email && user.email !== name && <div className="truncate text-xs font-normal text-muted-foreground">{user.email}</div>}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Sun aria-hidden />
            {t("Theme")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {themes.map(({ value, label, icon: Icon }) => (
              <DropdownMenuItem key={value} onSelect={() => setPreference(value)}>
                <Icon aria-hidden />
                {label}
                {preference === value && <Check className="ml-auto" aria-hidden />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Languages aria-hidden />
            {t("Language")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {LANGUAGES.map((lang) => (
              <DropdownMenuItem key={lang.code} onSelect={() => void i18n.changeLanguage(lang.code)}>
                {lang.label}
                {i18n.language === lang.code && <Check className="ml-auto" aria-hidden />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            logout();
            void navigate({ to: "/login" });
          }}
        >
          <LogOut aria-hidden />
          {t("Sign out")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
