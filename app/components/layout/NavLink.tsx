import { Link, useRouterState } from "@tanstack/react-router";

export function NavLink({
  to,
  params,
  active,
  exact = false,
  children,
}: {
  to: string;
  params?: Record<string, string> | undefined;
  active?: boolean | undefined;
  exact?: boolean | undefined;
  children: React.ReactNode;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isActive = active ?? (pathname === to || pathname.startsWith(`${to}/`));
  return (
    <Link
      to={to}
      {...(params !== undefined ? { params } : {})}
      className={isActive ? "nav-link active" : "nav-link"}
      {...(exact ? { activeOptions: { exact: true } } : {})}
    >
      {children}
    </Link>
  );
}
