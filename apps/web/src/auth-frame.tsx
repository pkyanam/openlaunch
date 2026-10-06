import type { ReactNode } from "react";
import { UserButton } from "@clerk/react";
import logoUrl from "../../site/public/icon.svg?url";

function AuthFooter({
  includeLegalLinks = true,
}: {
  includeLegalLinks?: boolean;
}) {
  return (
    <nav className="auth-footer" aria-label="Account resources">
      <a href="/docs">Documentation</a>
      {includeLegalLinks && (
        <>
          <a href="/docs/terms">Terms</a>
          <a href="/docs/privacy">Privacy</a>
        </>
      )}
    </nav>
  );
}

function AuthCardFrame({
  children,
  signedIn = false,
  includeLegalLinks = true,
}: {
  children: ReactNode;
  signedIn?: boolean;
  includeLegalLinks?: boolean;
}) {
  return (
    <main className="auth-screen">
      <section className="auth-card account-status-card">
        <a className="auth-brand" href="/">
          <img src={logoUrl} width="48" height="42" alt="" />
          <span>openlaunch</span>
        </a>
        {signedIn && (
          <div className="auth-account-control">
            <span>Signed in</span>
            <UserButton />
          </div>
        )}
        {children}
        <AuthFooter includeLegalLinks={includeLegalLinks} />
      </section>
    </main>
  );
}

export { AuthCardFrame, AuthFooter };
