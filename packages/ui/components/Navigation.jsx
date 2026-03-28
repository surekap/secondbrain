"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./Navigation.module.css";

const NAV_LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/relationships", label: "Relationships" },
  { href: "/groups", label: "Groups" },
  { href: "/projects", label: "Projects" },
  { href: "/agents", label: "Agents" },
  { href: "/search", label: "Search" },
  { href: "/manual/README", label: "Manual" },
];

export default function Navigation() {
  const pathname = usePathname();
  return (
    <header className={styles.header}>
      <div className={styles.left}>
        <Link href="/" className={styles.wordmark}>
          <img
            src="/logo.svg"
            alt=""
            width={22}
            height={22}
            className={styles.wordmarkIcon}
          />
          SecondBrain
        </Link>
      </div>
      <nav className={styles.nav}>
        {NAV_LINKS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className={`${styles.link} ${
              pathname === l.href ||
              (l.href.startsWith("/manual") && pathname.startsWith("/manual"))
                ? styles.active
                : ""
            }`}
          >
            {l.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
