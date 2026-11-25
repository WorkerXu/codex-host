import { useEffect, useId, useState, useSyncExternalStore, type ReactNode } from "react";
import clsx from "clsx";
import {
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
  Menu,
  Tooltip,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { ObservableSnapshot } from "@deepseek-ai/dsh-client-store";
import type { PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type { SidebarPanelMetadata, SidebarRootInjected } from "./contract/slots.ts";
import css from "./SidebarRoot.module.css";

function PanelGroupLabel({
  label,
  badge,
}: {
  label: string;
  badge: ObservableSnapshot<number | undefined>;
}) {
  const count = useSyncExternalStore(badge.subscribe, badge.getSnapshot);
  return (
    <span className={css.panelGroupLabel}>
      <span className={css.panelTitle} title={label}>
        {label}
      </span>
      {count !== undefined && <span className={css.panelBadge}>{count}</span>}
    </span>
  );
}

export function PanelGroupRow({
  groupId,
  label,
  panels,
  wide,
  usePanelInfo,
  selectPanel,
  renderIcon,
}: {
  groupId: string;
  label: string;
  panels: readonly SidebarPanelMetadata[];
  wide: boolean;
  renderIcon: (active: boolean) => ReactNode;
} & Pick<PropsRuntime<"sidebar">, "usePanelInfo"> &
  Pick<SidebarRootInjected, "selectPanel">) {
  const activePanelId = usePanelInfo(({ activePanelId }) =>
    panels.some(({ id }) => id === activePanelId) ? activePanelId : null,
  );
  const storageKey = `codexhost.web.sidebar.group.${groupId}`;
  const [expanded, setExpanded] = useState(() => {
    try {
      return activePanelId !== null || localStorage.getItem(storageKey) === "true";
    } catch {
      return activePanelId !== null;
    }
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const childrenId = useId();
  useEffect(() => {
    if (activePanelId !== null) setExpanded(true);
  }, [activePanelId]);
  useEffect(() => {
    if (wide) setMenuOpen(false);
  }, [wide]);

  const active = activePanelId !== null;
  const icon = (
    <span className={css.panelGlyph} aria-hidden="true">
      {renderIcon(active)}
    </span>
  );
  if (!wide) {
    return (
      <Menu
        anchor={
          <Tooltip label={label} delayMs={500} disabled={menuOpen}>
            <button
              type="button"
              className={clsx(css.panelRow, (active || menuOpen) && css.panelActive)}
              aria-label={label}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(!menuOpen)}
            >
              {icon}
            </button>
          </Tooltip>
        }
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        onSelect={(id) => {
          const member = panels.find((panel) => panel.id === id);
          if (member) selectPanel(member.id);
          setMenuOpen(false);
        }}
        items={panels.map(({ id, label, group }) => ({
          id,
          label: group ? <PanelGroupLabel label={label} badge={group.badgeCount} /> : label,
        }))}
        selectedId={activePanelId ?? undefined}
        side="right"
        portal
        autoFocus
      />
    );
  }

  return (
    <div className={css.panelGroup}>
      <button
        type="button"
        className={clsx(css.panelRow, active && !expanded && css.panelActive)}
        aria-controls={expanded ? childrenId : undefined}
        aria-expanded={expanded}
        onClick={() => {
          setExpanded(!expanded);
          try {
            localStorage.setItem(storageKey, String(!expanded));
          } catch {
            return;
          }
        }}
      >
        {icon}
        <span className={css.panelTitle} title={label}>
          {label}
        </span>
        <span className={css.panelGroupChevron} aria-hidden="true">
          {expanded ? (
            <IconChevronDownOutlineRegular size={14} />
          ) : (
            <IconChevronRightOutlineRegular size={14} />
          )}
        </span>
      </button>
      {expanded && (
        <div id={childrenId} className={css.panelGroupMembers}>
          {panels.map(({ id, label, group }) => (
            <button
              key={id}
              type="button"
              className={clsx(css.panelRow, activePanelId === id && css.panelActive)}
              aria-current={activePanelId === id ? "page" : undefined}
              onClick={() => selectPanel(id)}
            >
              {group ? <PanelGroupLabel label={label} badge={group.badgeCount} /> : label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
