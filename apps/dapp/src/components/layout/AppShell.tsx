import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { FEATURES } from "../../features/registry";
import { TopBar } from "./TopBar";

// Fixed sidebar + scrolling content. The connected app lives inside here.
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img src="/icon.png" alt="" />
          <span className="word">Loroco</span>
        </div>
        {FEATURES.map((f) => (
          <NavLink
            key={f.path}
            to={f.path}
            end={f.path === "/"}
            className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}
          >
            <span className="ico">{f.icon}</span>
            {f.title}
          </NavLink>
        ))}
        <div className="sidebar-foot">
          dApp Console · client of the Loroco wallet.
          <br />
          The wallet stays the security authority.
        </div>
      </aside>
      <div className="main">
        <TopBar />
        <div className="content">{children}</div>
      </div>
    </div>
  );
}

// Standard page header used by feature screens.
export function PageHead({ title, blurb }: { title: ReactNode; blurb?: ReactNode }) {
  return (
    <div className="page-head">
      <h1>{title}</h1>
      {blurb && <p>{blurb}</p>}
    </div>
  );
}
