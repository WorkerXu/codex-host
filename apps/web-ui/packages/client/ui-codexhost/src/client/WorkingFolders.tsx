import { useEffect, useState } from "react";
import type { DirectoryListing } from "@deepseek-ai/dsh-api-remotes/client";
import type { PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import {
  Button,
  IconChevronRightOutlineRegular,
  IconFolderCloseRegular,
  IconPlusOutlineRegular,
  Modal,
} from "@deepseek-ai/dsh-client-ui-primitives";
import { workingFoldersApi, type WorkingFoldersView } from "./api.ts";
import css from "./WorkingFolders.module.css";

type Props = PropsRuntime<"conversation.input.dock"> &
  PropsLocale<"codexhostImport"> & {
    listDirectory(path?: string, signal?: AbortSignal): Promise<DirectoryListing>;
  };
type Translate = Props["t"];
const leaf = (path: string) =>
  path
    .replace(/[\\/]+$/u, "")
    .split(/[\\/]/u)
    .at(-1) || path;

export function WorkingFolders({ sessionId, useSession, useSessions, listDirectory, t }: Props) {
  const readonly = useSession((session) => Boolean(session.removed || session.subagent));
  const remote = useSessions((state) =>
    sessionId === undefined ? false : Boolean(state.byId[sessionId]?.projectionValues?.remoteHost),
  );
  if (!sessionId || remote || readonly) return null;
  return (
    <FolderControl key={sessionId} sessionId={sessionId} listDirectory={listDirectory} t={t} />
  );
}

function FolderControl({
  sessionId,
  listDirectory,
  t,
}: Pick<Props, "listDirectory"> & { sessionId: string; t: Translate }) {
  const [state, setState] = useState<WorkingFoldersView>();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void workingFoldersApi.read(sessionId, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setState(value);
      },
      () => undefined,
    );
    return () => controller.abort();
  }, [sessionId]);
  const primary = state?.folders[0];
  const extra = Math.max(0, (state?.folders.length ?? 0) - 1);
  return (
    <div className={css.control}>
      <Button
        variant="toolbar"
        size="sm"
        icon={<IconFolderCloseRegular size={16} />}
        aria-label={t("folders.title")}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={state?.folders.join("\n")}
        onClick={() => setOpen(true)}
      >
        <span className={css.label}>{primary ? leaf(primary) : t("folders.title")}</span>
        {extra ? <span className={css.count}>+{extra}</span> : null}
      </Button>
      {open ? (
        <FolderDialog
          sessionId={sessionId}
          listDirectory={listDirectory}
          t={t}
          onClose={() => setOpen(false)}
          onSaved={(next) => {
            setState(next);
            setOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function FolderDialog({
  sessionId,
  listDirectory,
  t,
  onClose,
  onSaved,
}: Pick<Props, "listDirectory"> & {
  sessionId: string;
  t: Translate;
  onClose(): void;
  onSaved(value: WorkingFoldersView): void;
}) {
  const [view, setView] = useState<WorkingFoldersView>();
  const [folders, setFolders] = useState<string[]>([]);
  const [browsing, setBrowsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void workingFoldersApi.read(sessionId, controller.signal).then(
      (value) => {
        if (controller.signal.aborted) return;
        setView(value);
        setFolders(value.folders);
      },
      () => {
        if (!controller.signal.aborted) setError(t("folders.loadError"));
      },
    );
    return () => controller.abort();
  }, [sessionId, t]);
  const add = (path: string) => {
    if (!folders.includes(path) && folders.length < 64) setFolders([...folders, path]);
    setBrowsing(false);
  };
  const save = async () => {
    setSaving(true);
    setError("");
    try {
      onSaved(await workingFoldersApi.write(sessionId, folders));
    } catch {
      setError(t("folders.saveError"));
      setSaving(false);
    }
  };
  const close = () => {
    if (!saving) onClose();
  };
  const recent = view?.recent.filter((folder) => !folders.includes(folder)).slice(0, 8) ?? [];
  return (
    <Modal
      open
      title={t("folders.title")}
      closeLabel={t("folders.close")}
      onClose={close}
      className={css.dialog}
      contentClassName={css.content}
      footer={
        !browsing && view ? (
          <>
            <Button onClick={close} disabled={saving}>
              {t("folders.cancel")}
            </Button>
            <Button
              variant="primary"
              onClick={() => void save()}
              disabled={saving || !folders.length}
            >
              {t(saving ? "folders.saving" : "folders.save")}
            </Button>
          </>
        ) : undefined
      }
    >
      {error ? (
        <p className={css.error} role="alert">
          {error}
        </p>
      ) : null}
      {!view && !error ? <p role="status">{t("folders.loading")}</p> : null}
      {view && browsing ? (
        <FolderBrowser
          listDirectory={listDirectory}
          t={t}
          onPick={add}
          onBack={() => setBrowsing(false)}
        />
      ) : null}
      {view && !browsing ? (
        <>
          {!view.additionalDirectories ? (
            <p className={css.hint}>{t("folders.primaryOnly")}</p>
          ) : null}
          {folders.length ? (
            <ul className={css.list}>
              {folders.map((folder, index) => (
                <li className={css.row} key={folder}>
                  <IconFolderCloseRegular size={16} />
                  <span className={css.path} title={folder}>
                    <span className={css.folderName}>{leaf(folder)}</span>
                    {leaf(folder) !== folder ? (
                      <span className={css.folderDetail}>{folder}</span>
                    ) : null}
                  </span>
                  {index === 0 ? (
                    <span className={css.primary}>{t("folders.primary")}</span>
                  ) : (
                    <Button
                      size="sm"
                      disabled={saving}
                      onClick={() =>
                        setFolders([folder, ...folders.filter((value) => value !== folder)])
                      }
                    >
                      {t("folders.makePrimary")}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    disabled={saving || folders.length === 1}
                    aria-label={t("folders.removePath", { path: folder })}
                    onClick={() => setFolders(folders.filter((value) => value !== folder))}
                  >
                    {t("folders.remove")}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          <Button
            className={css.add}
            size="sm"
            disabled={saving || folders.length >= 64}
            icon={<IconPlusOutlineRegular size={16} />}
            onClick={() => setBrowsing(true)}
          >
            {t("folders.add")}
          </Button>
          {recent.length ? (
            <>
              <h3 className={css.section}>{t("folders.recent")}</h3>
              <ul className={css.list}>
                {recent.map((folder) => (
                  <li key={folder}>
                    <Button
                      className={css.directory}
                      size="sm"
                      title={folder}
                      disabled={saving || folders.length >= 64}
                      icon={<IconPlusOutlineRegular size={16} />}
                      onClick={() => add(folder)}
                    >
                      <span className={css.path}>{folder}</span>
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      ) : null}
    </Modal>
  );
}

function FolderBrowser({
  listDirectory,
  t,
  onPick,
  onBack,
}: Pick<Props, "listDirectory"> & {
  t: Translate;
  onPick(path: string): void;
  onBack(): void;
}) {
  const [request, setRequest] = useState<{ path?: string }>({});
  const [path, setPath] = useState("");
  const [listing, setListing] = useState<DirectoryListing>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void listDirectory(request.path, controller.signal).then(
      (value) => {
        if (controller.signal.aborted) return;
        setListing(value);
        setPath(value.path);
      },
      () => {
        if (!controller.signal.aborted) setFailed(true);
      },
    );
    return () => controller.abort();
  }, [listDirectory, request]);
  const browse = (target: string) => {
    if (!target.trim()) return;
    setPath(target);
    setListing(undefined);
    setFailed(false);
    setRequest({ path: target.trim() });
  };
  const parent = listing?.crumbs.at(-2);
  return (
    <>
      <form
        className={css.toolbar}
        onSubmit={(event) => {
          event.preventDefault();
          browse(path);
        }}
      >
        <Button size="sm" onClick={onBack}>
          {t("folders.back")}
        </Button>
        <input
          className={css.input}
          value={path}
          aria-label={t("folders.path")}
          placeholder={t("folders.path")}
          onChange={(event) => setPath(event.currentTarget.value)}
        />
        <Button size="sm" variant="outline" type="submit" disabled={!path.trim()}>
          {t("folders.browse")}
        </Button>
      </form>
      {failed ? (
        <p role="alert" className={css.error}>
          {t("folders.directoryError")}
        </p>
      ) : null}
      {!listing && !failed ? <p role="status">{t("folders.loading")}</p> : null}
      {listing ? (
        <>
          <ul className={css.list}>
            {parent ? (
              <li>
                <Button size="sm" onClick={() => browse(parent.path)}>
                  {t("folders.parent")}
                </Button>
              </li>
            ) : null}
            {listing.entries
              .filter((entry) => !entry.hidden)
              .map((entry) => (
                <li key={entry.path}>
                  <Button
                    className={css.directory}
                    size="sm"
                    icon={<IconFolderCloseRegular size={16} />}
                    onClick={() => browse(entry.path)}
                  >
                    <span className={css.path}>{entry.name}</span>
                    <IconChevronRightOutlineRegular size={14} />
                  </Button>
                </li>
              ))}
          </ul>
          <Button variant="primary" size="sm" onClick={() => onPick(listing.path)}>
            {t("folders.use")}
          </Button>
        </>
      ) : null}
    </>
  );
}
