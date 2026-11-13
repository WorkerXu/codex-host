import type {
  CodexAgentCatalogResult,
  CodexAgentListResult,
  CodexAgentRecord,
  CodexAgentSummary,
} from "@codexhost/shared-contracts";

import {
  codexAgentCodeFromError,
  type RendererCodexAgentsClient,
} from "../renderer-codex-agents-client.js";
import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from "./core.js";
import {
  agentDraftFromRecord,
  agentSaveParamsFromDraft,
  duplicateAgentDraft,
  effortOptionsForModel,
  emptyAgentDraft,
  validateAgentDraft,
  type CodexAgentDraft,
  type CodexAgentDraftError,
  type CodexAgentDraftField,
} from "./codex-agents-form.js";
import type { RendererSettingsMessages } from "./localization.js";
import { createDingTalkDispatchSection } from "./dingtalk-dispatch-section.js";
import { createPreferenceGroup, preferenceId } from "./preference-ui.js";

export interface RendererCodexAgentsSettingsOptions {
  createClient(): RendererCodexAgentsClient | null;
}

const EMPTY_CATALOG: CodexAgentCatalogResult = {
  available: false,
  models: [],
  defaultModel: null,
};

const INPUT_CLASS =
  "h-8 w-full rounded-md border border-settings-border bg-settings-surface px-2.5 text-[13px] text-settings-text outline-none focus:border-settings-focus aria-[invalid=true]:border-settings-danger";
const TEXTAREA_CLASS =
  "w-full resize-y rounded-md border border-settings-border bg-settings-surface px-2.5 py-2 text-[13px] leading-5 text-settings-text outline-none focus:border-settings-focus aria-[invalid=true]:border-settings-danger";
const SECONDARY_BUTTON_CLASS =
  "inline-flex h-8 items-center gap-1.5 rounded-md border border-settings-border bg-settings-surface px-3 text-[13px] font-medium text-settings-text transition-colors hover:bg-settings-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-settings-focus disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY_BUTTON_CLASS =
  "inline-flex h-8 items-center gap-1.5 rounded-md border-0 bg-settings-primary px-3 text-[13px] font-medium text-settings-primary-text transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-settings-focus disabled:cursor-not-allowed disabled:opacity-50";
const DANGER_BUTTON_CLASS =
  "inline-flex h-8 items-center gap-1.5 rounded-md border border-settings-border bg-transparent px-3 text-[13px] font-medium text-settings-danger transition-colors hover:bg-settings-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-settings-focus disabled:cursor-not-allowed disabled:opacity-50";

export function createCodexAgentsSettingsPage(
  messages: RendererSettingsMessages,
  options: RendererCodexAgentsSettingsOptions,
): RendererSettingsPageDefinition {
  const text = messages.codexAgents;
  return Object.freeze({
    id: "codex-agents",
    label: messages.pageLabels["codex-agents"],
    icon: "agents",
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;
      const client = options.createClient();
      const heading = document.createElement("div");
      heading.className = "settings-section-label";
      heading.textContent = messages.pageLabels["codex-agents"];
      const description = document.createElement("p");
      description.className = "settings-page-description";
      description.textContent = text.description;
      context.content.append(heading, description);

      if (!client) {
        const unavailable = document.createElement("p");
        unavailable.className = "settings-page-description";
        unavailable.textContent = text.unavailable;
        context.content.append(unavailable);
        return;
      }

      const listSection = createPreferenceGroup(document, text.listTitle);
      const listToolbar = document.createElement("div");
      listToolbar.className =
        "flex items-center justify-between gap-3 border-b border-settings-divider px-4 py-2.5";
      const listHint = document.createElement("p");
      listHint.className = "m-0 min-w-0 text-xs leading-[18px] text-settings-muted";
      listHint.textContent = text.listDescription;
      const listActions = document.createElement("div");
      listActions.className = "flex shrink-0 gap-2";
      const refresh = button(document, text.refresh, "secondary");
      const create = button(document, text.create, "primary");
      listActions.append(refresh, create);
      listToolbar.append(listHint, listActions);
      const status = document.createElement("p");
      status.className =
        "m-0 px-4 py-2 text-xs text-settings-muted data-[failed=true]:text-settings-danger";
      status.setAttribute("role", "status");
      const agentList = document.createElement("div");
      agentList.className = "flex flex-col";
      const issues = document.createElement("div");
      issues.className = "flex flex-col gap-1 px-4 pb-3";
      listSection.card.append(listToolbar, status, agentList, issues);

      const editor = createEditor();
      const dingtalk = createDingTalkDispatchSection(document, client, text.dingtalk);
      context.content.append(listSection.group, editor.group, dingtalk.root);

      let disposed = false;
      let agents: CodexAgentSummary[] = [];
      let catalog: CodexAgentCatalogResult = EMPTY_CATALOG;
      let listGeneration = 0;
      let catalogGeneration = 0;
      let listLoaded = false;
      let currentDraft: CodexAgentDraft = emptyAgentDraft();
      let effortControl: HTMLInputElement | HTMLSelectElement | null = null;

      const setStatus = (value: string, failed = false): void => {
        status.textContent = value;
        status.dataset.failed = failed ? "true" : "false";
      };

      const catalogHint = document.createElement("div");
      catalogHint.className = "hidden text-xs leading-[18px] text-settings-muted";
      catalogHint.textContent = text.catalogUnavailable;
      editor.modelList.after(catalogHint);

      function createEditor(): {
        group: HTMLElement;
        fields: HTMLElement;
        title: HTMLElement;
        form: HTMLFormElement;
        error: HTMLElement;
        save: HTMLButtonElement;
        cancel: HTMLButtonElement;
        name: HTMLInputElement;
        description: HTMLTextAreaElement;
        model: HTMLInputElement;
        effortSlot: HTMLElement;
        effortId: string;
        instructions: HTMLTextAreaElement;
        modelList: HTMLDataListElement;
      } {
        const { group, card } = createPreferenceGroup(document, text.create);
        const header = group.querySelector("h3");
        const title = header ?? document.createElement("h3");
        if (!header) title.className = "m-0 text-[13px] font-semibold text-settings-text";

        const form = document.createElement("form");
        form.className = "flex flex-col gap-4 px-4 py-4";
        form.noValidate = true;

        const nameId = preferenceId("agent-name");
        const name = document.createElement("input");
        name.id = nameId;
        name.type = "text";
        name.maxLength = 64;
        name.autocomplete = "off";
        name.spellcheck = false;
        name.className = INPUT_CLASS;
        const nameField = field(document, text.name, text.nameHint, nameId, name);

        const descriptionId = preferenceId("agent-description");
        const descriptionField = document.createElement("textarea");
        descriptionField.id = descriptionId;
        descriptionField.rows = 2;
        descriptionField.maxLength = 4_096;
        descriptionField.className = TEXTAREA_CLASS;
        const descriptionRow = field(
          document,
          text.descriptionLabel,
          text.descriptionHint,
          descriptionId,
          descriptionField,
        );

        const modelId = preferenceId("agent-model");
        const model = document.createElement("input");
        model.id = modelId;
        model.type = "text";
        model.maxLength = 128;
        model.autocomplete = "off";
        model.spellcheck = false;
        model.className = INPUT_CLASS;
        model.placeholder = text.modelPlaceholder;
        model.setAttribute("list", preferenceId("agent-model-list"));
        const modelList = document.createElement("datalist");
        modelList.id = model.getAttribute("list") ?? "";
        const modelRow = field(document, text.model, text.modelHint, modelId, model);
        modelRow.append(modelList);

        const effortId = preferenceId("agent-effort");
        const effortSlot = document.createElement("div");
        const effortRow = field(document, text.effort, text.effortHint, effortId, effortSlot);

        const instructionsId = preferenceId("agent-instructions");
        const instructions = document.createElement("textarea");
        instructions.id = instructionsId;
        instructions.rows = 9;
        instructions.maxLength = 200_000;
        instructions.spellcheck = false;
        instructions.className = `${TEXTAREA_CLASS} min-h-40 font-mono text-xs`;
        const instructionsRow = field(
          document,
          text.instructions,
          text.instructionsHint,
          instructionsId,
          instructions,
        );

        const error = document.createElement("p");
        error.className = "m-0 text-xs leading-[18px] text-settings-danger";
        error.setAttribute("role", "alert");
        error.hidden = true;

        const footer = document.createElement("div");
        footer.className = "flex items-center justify-end gap-2";
        const cancel = button(document, text.cancel, "secondary");
        const save = button(document, text.save, "primary");
        save.type = "submit";
        footer.append(cancel, save);

        const fields = document.createElement("div");
        fields.className = "flex flex-col gap-4";
        fields.append(
          nameField,
          descriptionRow,
          modelRow,
          effortRow,
          instructionsRow,
          error,
          footer,
        );
        form.append(fields);
        card.append(form);
        group.hidden = true;
        return {
          group,
          fields,
          title,
          form,
          error,
          save,
          cancel,
          name,
          description: descriptionField,
          model,
          effortSlot,
          effortId,
          instructions,
          modelList,
        };
      }

      function field(
        owner: Document,
        label: string,
        hint: string,
        controlId: string,
        control: HTMLElement,
      ): HTMLElement {
        const wrapper = owner.createElement("div");
        wrapper.className = "flex flex-col gap-1.5";
        const labelElement = owner.createElement("label");
        labelElement.htmlFor = controlId;
        labelElement.className = "text-[13px] leading-5 font-medium text-settings-text";
        labelElement.textContent = label;
        const hintElement = owner.createElement("div");
        hintElement.id = `${controlId}-hint`;
        hintElement.className = "text-xs leading-[18px] text-settings-muted";
        hintElement.textContent = hint;
        control.setAttribute("aria-describedby", hintElement.id);
        wrapper.append(labelElement, hintElement, control);
        return wrapper;
      }

      const effortValue = (): string =>
        effortControl instanceof HTMLSelectElement
          ? effortControl.value
          : (effortControl?.value ?? "");

      function rebuildEffort(preferred: string): void {
        const options = effortOptionsForModel(catalog, editor.model.value);
        if (options.length > 0) {
          const select = document.createElement("select");
          select.className = INPUT_CLASS;
          select.append(new Option(text.effortPlaceholder, ""));
          for (const option of options) {
            const element = new Option(option.id, option.id);
            element.title = option.description;
            select.append(element);
          }
          select.value = options.some((option) => option.id === preferred) ? preferred : "";
          effortControl = select;
        } else {
          const input = document.createElement("input");
          input.type = "text";
          input.maxLength = 64;
          input.autocomplete = "off";
          input.spellcheck = false;
          input.className = INPUT_CLASS;
          input.placeholder = text.effortPlaceholder;
          input.value = preferred;
          effortControl = input;
        }
        effortControl.id = editor.effortId;
        effortControl.setAttribute("aria-describedby", `${editor.effortId}-hint`);
        editor.effortSlot.replaceChildren(effortControl);
      }

      const showError = (message: string, fieldName?: CodexAgentDraftField): void => {
        editor.error.textContent = message;
        editor.error.hidden = false;
        const control =
          fieldName === "name"
            ? editor.name
            : fieldName === "description"
              ? editor.description
              : fieldName === "model"
                ? editor.model
                : fieldName === "reasoningEffort"
                  ? effortControl
                  : fieldName === "developerInstructions"
                    ? editor.instructions
                    : null;
        control?.setAttribute("aria-invalid", "true");
        control?.focus();
      };

      const clearError = (): void => {
        editor.error.hidden = true;
        editor.error.textContent = "";
        for (const control of [
          editor.name,
          editor.description,
          editor.model,
          editor.instructions,
          effortControl,
        ]) {
          control?.removeAttribute("aria-invalid");
        }
      };

      const readDraft = (): CodexAgentDraft => ({
        ...currentDraft,
        name: editor.name.value,
        description: editor.description.value,
        model: editor.model.value,
        reasoningEffort: effortValue(),
        developerInstructions: editor.instructions.value,
      });

      const draftErrorText: Record<CodexAgentDraftError, string> = {
        invalid_name: text.invalidName,
        name_taken: text.nameTaken,
        description_required: text.descriptionRequired,
        instructions_required: text.instructionsRequired,
        too_long: text.tooLong,
        model_invalid: text.modelInvalid,
        effort_invalid: text.effortInvalid,
      };

      const openEditor = (
        mode: "create" | "edit" | "duplicate",
        record?: CodexAgentRecord,
      ): void => {
        clearError();
        currentDraft =
          mode === "create" || !record
            ? emptyAgentDraft()
            : mode === "edit"
              ? agentDraftFromRecord(record)
              : duplicateAgentDraft(record, agents);
        editor.group.hidden = false;
        editor.title.textContent =
          mode === "create"
            ? text.editorCreateTitle
            : (mode === "edit" ? text.editorEditTitle : text.editorDuplicateTitle).replace(
                "{name}",
                record?.name ?? "",
              );
        editor.name.value = currentDraft.name;
        editor.description.value = currentDraft.description;
        editor.model.value = currentDraft.model;
        editor.instructions.value = currentDraft.developerInstructions;
        rebuildEffort(currentDraft.reasoningEffort);
        editor.save.disabled = false;
        editor.save.textContent = text.save;
        editor.group.scrollIntoView({ block: "nearest" });
        editor.name.focus();
      };

      const editExisting = async (
        agent: CodexAgentSummary,
        mode: "edit" | "duplicate",
      ): Promise<void> => {
        try {
          const record = await client.read(agent.fileName);
          if (!disposed) openEditor(mode, record);
        } catch (error) {
          setStatus(text.readFailed.replace("{reason}", errorText(error)), true);
        }
      };

      const renderIssues = (result: CodexAgentListResult): void => {
        issues.replaceChildren();
        if (result.issues.length === 0) return;
        const title = document.createElement("div");
        title.className = "text-xs font-medium text-settings-warning";
        title.textContent = text.issuesTitle;
        issues.append(title);
        for (const issue of result.issues) {
          const row = document.createElement("div");
          row.className = "text-xs leading-[18px] text-settings-muted";
          row.textContent = `${issue.fileName} — ${text.issues[issue.reason]}`;
          issues.append(row);
        }
      };

      const renderAgents = (result: CodexAgentListResult): void => {
        agents = result.agents;
        agentList.replaceChildren();
        if (agents.length === 0) {
          const empty = document.createElement("p");
          empty.className = "m-0 px-4 py-6 text-center text-xs text-settings-muted";
          empty.textContent = listLoaded ? text.empty : text.loading;
          agentList.append(empty);
          renderIssues(result);
          return;
        }
        for (const agent of agents) {
          const row = document.createElement("div");
          row.className =
            "flex items-start justify-between gap-4 border-t border-settings-divider px-4 py-3 first:border-t-0";
          const main = document.createElement("div");
          main.className = "flex min-w-0 flex-col gap-1";
          const title = document.createElement("div");
          title.className = "flex min-w-0 items-baseline gap-2";
          const name = document.createElement("strong");
          name.className = "truncate text-[13px] leading-5 font-semibold text-settings-text";
          name.textContent = agent.name;
          const fileName = document.createElement("span");
          fileName.className = "truncate font-mono text-[11px] text-settings-subtle";
          fileName.textContent = agent.fileName;
          title.append(name, fileName);
          const copy = document.createElement("div");
          copy.className = "line-clamp-2 text-xs leading-[18px] text-settings-muted";
          copy.textContent = agent.description;
          const meta = document.createElement("div");
          meta.className = "text-xs leading-[18px] text-settings-subtle";
          meta.textContent = `${agent.model ?? text.modelPlaceholder} · ${
            agent.reasoningEffort ?? text.effortPlaceholder
          }`;
          main.append(title, copy, meta);
          const actions = document.createElement("div");
          actions.className = "flex shrink-0 gap-1.5";
          const edit = button(document, text.edit, "secondary");
          edit.addEventListener("click", () => void editExisting(agent, "edit"));
          const duplicate = button(document, text.duplicate, "secondary");
          duplicate.addEventListener("click", () => void editExisting(agent, "duplicate"));
          const remove = button(document, text.delete, "danger");
          remove.addEventListener("click", () => void deleteAgent(agent, remove));
          actions.append(edit, duplicate, remove);
          row.append(main, actions);
          agentList.append(row);
        }
        renderIssues(result);
      };

      const deleteAgent = async (
        agent: CodexAgentSummary,
        control: HTMLButtonElement,
      ): Promise<void> => {
        const confirm = document.defaultView?.confirm;
        if (
          !confirm?.(
            text.deleteConfirm.replace("{name}", agent.name).replace("{file}", agent.fileName),
          )
        ) {
          return;
        }
        control.disabled = true;
        try {
          await client.remove(agent.fileName, agent.revision);
          if (disposed) return;
          await loadAgents();
          setStatus(text.saved);
        } catch (error) {
          if (disposed) return;
          setStatus(text.deleteFailed.replace("{reason}", errorText(error)), true);
          if (["revision_conflict", "not_found"].includes(codexAgentCodeFromError(error))) {
            await loadAgents();
          }
        } finally {
          control.disabled = false;
        }
      };

      const errorText = (error: unknown): string => {
        const code = codexAgentCodeFromError(error);
        if (code === "revision_conflict") return text.revisionConflict;
        if (code === "not_found") return text.notFound;
        if (code === "name_taken") return text.nameTaken;
        if (code === "invalid_name") return text.invalidName;
        if (code === "invalid_file_name") return text.fileInvalid;
        if (code === "unavailable") return text.unavailable;
        return text.genericError;
      };

      const loadAgents = async (): Promise<void> => {
        const generation = ++listGeneration;
        setStatus(text.refreshing);
        try {
          const result = await client.list();
          if (disposed || generation !== listGeneration) return;
          listLoaded = true;
          renderAgents(result);
          dingtalk.setAgents(agents);
          setStatus("");
        } catch (error) {
          if (disposed || generation !== listGeneration) return;
          listLoaded = true;
          setStatus(`${text.loadFailed} (${codexAgentCodeFromError(error)})`, true);
        }
      };

      const loadCatalog = async (): Promise<void> => {
        const generation = ++catalogGeneration;
        try {
          const result = await client.catalog();
          if (disposed || generation !== catalogGeneration) return;
          catalog = result;
        } catch {
          if (disposed || generation !== catalogGeneration) return;
          catalog = EMPTY_CATALOG;
        }
        editor.modelList.replaceChildren();
        for (const model of catalog.models) {
          const option = document.createElement("option");
          option.value = model.model;
          option.label = model.displayName;
          editor.modelList.append(option);
        }
        catalogHint.classList.toggle("hidden", catalog.available);
        rebuildEffort(effortValue());
      };

      editor.model.addEventListener("input", () => rebuildEffort(effortValue()));
      editor.cancel.addEventListener("click", () => {
        editor.group.hidden = true;
        currentDraft = emptyAgentDraft();
        clearError();
      });
      editor.form.addEventListener("submit", (event) => {
        event.preventDefault();
        clearError();
        const draft = readDraft();
        const problem = validateAgentDraft(draft, agents);
        if (problem) {
          showError(draftErrorText[problem.error], problem.field);
          return;
        }
        editor.save.disabled = true;
        editor.save.textContent = text.saving;
        void client
          .save(agentSaveParamsFromDraft(draft))
          .then(async (record) => {
            if (disposed) return;
            currentDraft = agentDraftFromRecord(record);
            editor.group.hidden = true;
            await loadAgents();
            if (!disposed) setStatus(text.saved);
          })
          .catch(async (error: unknown) => {
            if (disposed) return;
            const code = codexAgentCodeFromError(error);
            showError(errorText(error), code === "name_taken" ? "name" : undefined);
            if (code === "revision_conflict" || code === "not_found") {
              await loadAgents();
            }
          })
          .finally(() => {
            if (disposed) return;
            editor.save.disabled = false;
            editor.save.textContent = text.save;
          });
      });
      refresh.addEventListener("click", () => {
        refresh.disabled = true;
        void loadAgents().finally(() => {
          refresh.disabled = false;
        });
      });
      create.addEventListener("click", () => openEditor("create"));

      void loadAgents();
      void loadCatalog();
      void dingtalk.load();

      return () => {
        disposed = true;
        listGeneration += 1;
        catalogGeneration += 1;
        dingtalk.dispose();
      };
    },
  });

  function button(
    document: Document,
    label: string,
    variant: "primary" | "secondary" | "danger",
  ): HTMLButtonElement {
    const element = document.createElement("button");
    element.type = "button";
    element.className =
      variant === "primary"
        ? PRIMARY_BUTTON_CLASS
        : variant === "secondary"
          ? SECONDARY_BUTTON_CLASS
          : DANGER_BUTTON_CLASS;
    element.textContent = label;
    return element;
  }
}
