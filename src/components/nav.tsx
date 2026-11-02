"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "./ui";

const ITEMS = [
  { href: "/", label: "Dashboard" },
  { href: "/inquiries", label: "Inquiries" },
  { href: "/catalogue", label: "Catalogue" },
  { href: "/quotations", label: "Quotations" },
  { href: "/settings", label: "Company settings" },
  { href: "/team", label: "Team" },
];

export function Nav({ horizontal = false }: { horizontal?: boolean }) {
  const path = usePathname();
  const active = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  return (
    <nav aria-label="Main" className={horizontal ? "flex gap-1 overflow-x-auto" : "space-y-0.5"}>
      {ITEMS.map((i) => (
        <Link key={i.href} href={i.href} aria-current={active(i.href) ? "page" : undefined}
          className={cx("block whitespace-nowrap rounded-md px-3 py-2 text-sm transition-colors",
            active(i.href) ? "bg-navy-700 font-medium text-white" : "text-navy-100 hover:bg-navy-800 hover:text-white")}>
          {i.label}
        </Link>
      ))}
    </nav>
  );
}
