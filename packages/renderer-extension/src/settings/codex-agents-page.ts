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

export interface RendererCodexAgentsSettingsOptions {
  createClient(): RendererCodexAgentsClient | null;
}

const EMPTY_CATALOG: CodexAgentCatalogResult = {
  available: false,
  models: [],
  defaultModel: null,
};

interface AgentRowMenu {
  element: HTMLElement;
  dispose(): void;
}

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
      const view = document.defaultView ?? window;
      const client = options.createClient();
      const page = document.createElement("div");
      page.className = "codex-agents-page";
      context.content.append(page);

      const head = document.createElement("header");
      head.className = "agents-page-head";
      const headCopy = document.createElement("div");
      headCopy.className = "agents-page-copy";
      const heading = document.createElement("h2");
      heading.className = "agents-page-title";
      heading.textContent = text.title;
      const description = document.createElement("p");
      description.className = "agents-page-description";
      description.textContent = text.description;
      headCopy.append(heading, description);
      const create = document.createElement("button");
      create.type = "button";
      create.className = "agents-new";
      create.textContent = text.create;
      head.append(headCopy, create);
      page.append(head);

      if (!client) {
        page.append(stateText(text.unavailable));
        return;
      }

      const status = document.createElement("p");
      status.className = "agents-status";
      status.setAttribute("role", "status");
      status.hidden = true;
      const list = document.createElement("div");
      list.className = "agents-list";
      list.setAttribute("role", "list");
      const issues = document.createElement("p");
      issues.className = "agents-issues";
      issues.hidden = true;
      page.append(status, list, issues);

      const dingtalk = createDingTalkDispatchSection(
        document,
        client,
        text.dingtalk,
        (id) => text.effortLabels[id] ?? id,
      );
      page.append(dingtalk.root);

      let idCounter = 0;
      let savingEditor = false;
      const editor = createEditor();
      page.append(editor.root);

      let disposed = false;
      let agents: CodexAgentSummary[] = [];
      let catalog: CodexAgentCatalogResult = EMPTY_CATALOG;
      let listGeneration = 0;
      let catalogGeneration = 0;
      let loaded = false;
      let currentDraft: CodexAgentDraft = emptyAgentDraft();
      let effortValue = "";
      let effortControl: HTMLInputElement | null = null;
      let rowMenu: AgentRowMenu | null = null;

      const effortLabel = (id: string): string => text.effortLabels[id] ?? id;

      const setStatus = (value: string | null, failed = false): void => {
        status.hidden = value === null;
        status.textContent = value ?? "";
        status.dataset.failed = failed ? "true" : "false";
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

      const renderRoutes = (): void => {
        list.replaceChildren();
        if (!loaded) {
          for (let index = 0; index < 3; index += 1) list.append(skeletonRow());
          return;
        }
        if (agents.length === 0) {
          const empty = document.createElement("div");
          empty.className = "agents-empty";
          empty.append(stateText(text.empty));
          const action = document.createElement("button");
          action.type = "button";
          action.className = "agents-empty-action";
          action.textContent = text.create;
          action.addEventListener("click", () => openEditor("create"));
          empty.append(action);
          list.append(empty);
          return;
        }
        for (const agent of agents) list.append(agentRow(agent));
      };

      const renderIssues = (result: CodexAgentListResult): void => {
        issues.hidden = result.issues.length === 0;
        issues.textContent =
          result.issues.length > 0 ? `${text.issuesTitle} (${result.issues.length})` : "";
      };

      function agentRow(agent: CodexAgentSummary): HTMLElement {
        const row = document.createElement("div");
        row.className = "agent-row";
        row.setAttribute("role", "listitem");
        row.tabIndex = 0;
        const main = document.createElement("div");
        main.className = "agent-row-main";
        const headingLine = document.createElement("div");
        headingLine.className = "agent-row-heading";
        const name = document.createElement("span");
        name.className = "agent-row-name";
        name.textContent = agent.name;
        const meta = document.createElement("span");
        meta.className = "agent-row-meta";
        meta.textContent = [
          agent.model ?? text.defaultModel,
          agent.reasoningEffort ? effortLabel(agent.reasoningEffort) : null,
        ]
          .filter(Boolean)
          .join(" · ");
        headingLine.append(name, meta);
        const copy = document.createElement("div");
        copy.className = "agent-row-description";
        copy.textContent = agent.description;
        main.append(headingLine, copy);
        const actions = document.createElement("div");
        actions.className = "agent-row-actions";
        const menuButton = document.createElement("button");
        menuButton.type = "button";
        menuButton.className = "agent-row-menu-button";
        menuButton.textContent = "⋯";
        menuButton.setAttribute("aria-label", text.moreActions);
        menuButton.title = text.moreActions;
        menuButton.addEventListener("click", (event) => {
          event.stopPropagation();
          openRowMenu(agent, menuButton);
        });
        actions.append(menuButton);
        row.append(main, actions);
        const activate = (event: Event): void => {
          if (
            event.target instanceof Element &&
            event.target.closest(".agent-row-actions, .agent-menu")
          ) {
            return;
          }
          void editExisting(agent, "edit", row);
        };
        row.addEventListener("click", activate);
        row.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            activate(event);
          }
        });
        return row;
      }

      function skeletonRow(): HTMLElement {
        const row = document.createElement("div");
        row.className = "agent-row agent-row--skeleton";
        const main = document.createElement("div");
        main.className = "agent-row-main";
        main.append(
          element("span", "agent-skeleton agent-skeleton--title"),
          element("span", "agent-skeleton agent-skeleton--description"),
        );
        row.append(main);
        return row;
      }

      function element(tag: string, className: string): HTMLElement {
        const node = document.createElement(tag);
        node.className = className;
        return node;
      }

      function stateText(value: string): HTMLElement {
        const node = document.createElement("p");
        node.className = "agents-state-text";
        node.textContent = value;
        return node;
      }

      const openRowMenu = (agent: CodexAgentSummary, anchor: HTMLElement): void => {
        if (rowMenu) {
          rowMenu.dispose();
          rowMenu = null;
        }
        const menu = document.createElement("div");
        menu.className = "agent-menu";
        menu.setAttribute("role", "menu");
        menu.setAttribute("aria-label", agent.name);
        const actions: { label: string; danger?: boolean; run(): void }[] = [
          { label: text.edit, run: () => void editExisting(agent, "edit") },
          { label: text.duplicate, run: () => void editExisting(agent, "duplicate") },
          { label: text.delete, danger: true, run: () => void deleteAgent(agent) },
        ];
        for (const action of actions) {
          const item = document.createElement("button");
          item.type = "button";
          item.className = `agent-menu-item${action.danger ? " agent-menu-item--danger" : ""}`;
          item.setAttribute("role", "menuitem");
          item.textContent = action.label;
          item.addEventListener("click", () => {
            closeRowMenu();
            action.run();
          });
          menu.append(item);
        }
        const rect = anchor.getBoundingClientRect();
        menu.style.top = `${Math.min(rect.bottom + 4, view.innerHeight - 132)}px`;
        menu.style.left = `${Math.max(8, Math.min(rect.right - 160, view.innerWidth - 168))}px`;
        page.append(menu);
        const onPointerDown = (event: PointerEvent): void => {
          if (event.target instanceof Node && menu.contains(event.target)) return;
          closeRowMenu();
        };
        const onKey = (event: KeyboardEvent): void => {
          if (event.key === "Escape") {
            event.stopPropagation();
            closeRowMenu();
          }
        };
        const timer = view.setTimeout(() => {
          document.addEventListener("pointerdown", onPointerDown, true);
          document.addEventListener("keydown", onKey, true);
        }, 0);
        rowMenu = {
          element: menu,
          dispose() {
            view.clearTimeout(timer);
            document.removeEventListener("pointerdown", onPointerDown, true);
            document.removeEventListener("keydown", onKey, true);
            menu.remove();
          },
        };
      };

      const closeRowMenu = (): void => {
        rowMenu?.dispose();
        rowMenu = null;
      };

      const loadAgents = async (): Promise<void> => {
        const generation = ++listGeneration;
        setStatus(null);
        try {
          const result = await client.list();
          if (disposed || generation !== listGeneration) return;
          loaded = true;
          agents = result.agents;
          renderRoutes();
          renderIssues(result);
          dingtalk.setAgents(agents);
        } catch (error) {
          if (disposed || generation !== listGeneration) return;
          loaded = true;
          list.replaceChildren();
          const failure = document.createElement("div");
          failure.className = "agents-empty";
          failure.append(stateText(text.loadFailed));
          const retry = document.createElement("button");
          retry.type = "button";
          retry.className = "agents-empty-action";
          retry.textContent = text.retry;
          retry.addEventListener("click", () => void loadAgents());
          failure.append(retry);
          list.append(failure);
          setStatus(errorText(error), true);
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
        editor.catalogHint.hidden = catalog.available;
        rebuildModel();
        rebuildEffort(effortValue);
      };

      const modelValue = (): string =>
        editor.model.hidden ? editor.modelInput.value : editor.model.value;

      function rebuildModel(): void {
        const preferred = modelValue() || currentDraft.model;
        if (!catalog.available) {
          editor.model.hidden = true;
          editor.modelInput.hidden = false;
          editor.modelInput.value = preferred;
          return;
        }
        editor.model.hidden = false;
        editor.modelInput.hidden = true;
        editor.model.replaceChildren();
        editor.model.append(new Option(text.modelInherit, ""));
        for (const model of catalog.models) {
          editor.model.append(new Option(model.displayName, model.model));
        }
        if (preferred && !catalog.models.some((model) => model.model === preferred)) {
          editor.model.append(new Option(preferred, preferred));
        }
        editor.model.value = preferred;
      }

      function rebuildEffort(preferred: string): void {
        const options = effortOptionsForModel(catalog, modelValue());
        editor.effortSlot.replaceChildren();
        effortControl = null;
        effortValue = preferred;
        if (options.length === 0) {
          const input = document.createElement("input");
          input.type = "text";
          input.maxLength = 64;
          input.autocomplete = "off";
          input.spellcheck = false;
          input.className = "agent-input";
          input.placeholder = text.effortInherit;
          input.value = preferred;
          input.addEventListener("input", () => {
            effortValue = input.value;
          });
          effortControl = input;
          editor.effortSlot.append(input);
          return;
        }
        const group = document.createElement("div");
        group.className = "agent-segmented";
        group.setAttribute("role", "group");
        group.setAttribute("aria-label", text.effort);
        const choices = [
          { value: "", label: text.effortInherit, title: text.effortInherit },
          ...options.map((option) => ({
            value: option.id,
            label: effortLabel(option.id),
            title: option.description,
          })),
        ];
        if (!choices.some((choice) => choice.value === preferred)) effortValue = "";
        for (const choice of choices) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "agent-segment";
          button.textContent = choice.label;
          button.title = choice.title;
          button.setAttribute("aria-pressed", String(choice.value === effortValue));
          button.addEventListener("click", () => {
            effortValue = choice.value;
            for (const other of group.querySelectorAll<HTMLButtonElement>(".agent-segment")) {
              other.setAttribute("aria-pressed", String(other === button));
            }
          });
          group.append(button);
        }
        editor.effortSlot.append(group);
      }

      function createEditor() {
        const root = document.createElement("div");
        root.className = "agent-editor";
        root.hidden = true;
        const scrim = document.createElement("div");
        scrim.className = "agent-editor-scrim";
        const panel = document.createElement("aside");
        panel.className = "agent-editor-panel";
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-modal", "true");
        const form = document.createElement("form");
        form.noValidate = true;
        const editorHead = document.createElement("header");
        editorHead.className = "agent-editor-head";
        const editorTitle = document.createElement("h3");
        editorTitle.className = "agent-editor-title";
        const close = document.createElement("button");
        close.type = "button";
        close.className = "agent-editor-close";
        close.textContent = "✕";
        close.setAttribute("aria-label", text.cancel);
        close.title = text.cancel;
        editorHead.append(editorTitle, close);

        const editorBody = document.createElement("div");
        editorBody.className = "agent-editor-body";

        const basicGroup = fieldGroup(text.basicGroup);
        const name = input("text");
        name.maxLength = 64;
        name.autocomplete = "off";
        name.spellcheck = false;
        const nameField = labeledField(text.name, text.nameHint, name);
        const descriptionField = textarea(2);
        descriptionField.maxLength = 4_096;
        basicGroup.append(
          nameField,
          labeledField(text.descriptionLabel, text.descriptionHint, descriptionField),
        );

        const modelGroup = fieldGroup(text.modelGroup);
        const model = document.createElement("select");
        model.className = "agent-input agent-select";
        model.setAttribute("aria-label", text.model);
        const modelInput = document.createElement("input");
        modelInput.type = "text";
        modelInput.maxLength = 128;
        modelInput.autocomplete = "off";
        modelInput.spellcheck = false;
        modelInput.className = "agent-input";
        modelInput.placeholder = text.modelInherit;
        modelInput.setAttribute("aria-label", text.model);
        modelInput.hidden = true;
        const modelControls = document.createElement("div");
        modelControls.className = "agent-model-controls";
        modelControls.append(model, modelInput);
        const modelField = labeledField(null, text.modelHint, modelControls);
        const catalogHint = document.createElement("p");
        catalogHint.className = "agent-field-hint";
        catalogHint.textContent = text.catalogUnavailable;
        catalogHint.hidden = true;
        catalogHint.dataset.role = "catalog-hint";
        modelField.append(catalogHint);
        const effortSlot = document.createElement("div");
        effortSlot.className = "agent-effort-slot";
        const effortField = labeledField(text.effort, text.effortHint, effortSlot);
        modelGroup.append(modelField, effortField);

        const instructionsGroup = fieldGroup(text.instructionsGroup);
        const instructions = textarea(6);
        instructions.maxLength = 200_000;
        instructions.spellcheck = false;
        instructions.className = "agent-input agent-instructions";
        instructions.setAttribute("aria-label", text.instructions);
        const instructionsField = document.createElement("div");
        instructionsField.className = "agent-field";
        const instructionsMeta = document.createElement("div");
        instructionsMeta.className = "agent-instruction-meta";
        const instructionsHint = document.createElement("p");
        instructionsHint.className = "agent-field-hint";
        instructionsHint.textContent = text.instructionsHint;
        const instructionCount = document.createElement("span");
        instructionCount.className = "agent-character-count";
        instructionsMeta.append(instructionsHint, instructionCount);
        instructionsField.append(instructions, instructionsMeta);
        instructionsGroup.append(instructionsField);

        const error = document.createElement("p");
        error.className = "agent-editor-error";
        error.setAttribute("role", "alert");
        error.hidden = true;

        const footer = document.createElement("footer");
        footer.className = "agent-editor-footer";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "agent-secondary";
        cancel.textContent = text.cancel;
        const save = document.createElement("button");
        save.type = "submit";
        save.className = "agent-primary";
        save.textContent = text.save;
        footer.append(cancel, save);

        editorBody.append(basicGroup, modelGroup, instructionsGroup, error);
        form.append(editorHead, editorBody, footer);
        panel.append(form);
        root.append(scrim, panel);
        return {
          root,
          panel,
          form,
          title: editorTitle,
          close,
          name,
          description: descriptionField,
          model,
          modelInput,
          modelField,
          catalogHint,
          effortSlot,
          instructions,
          instructionCount,
          error,
          save,
          cancel,
        };
      }

      function labeledField(title: string | null, hint: string, control: HTMLElement): HTMLElement {
        const wrapper = document.createElement("div");
        wrapper.className = "agent-field";
        if (title !== null) {
          const heading = document.createElement("span");
          heading.className = "agent-field-label";
          heading.textContent = title;
          if (control.id) {
            const label = document.createElement("label");
            label.htmlFor = control.id;
            label.textContent = title;
            heading.replaceChildren(label);
          }
          wrapper.append(heading);
        }
        const hintNode = document.createElement("p");
        hintNode.className = "agent-field-hint";
        hintNode.textContent = hint;
        wrapper.append(control, hintNode);
        return wrapper;
      }

      function fieldGroup(title: string): HTMLElement {
        const group = document.createElement("section");
        group.className = "agent-field-group";
        const heading = document.createElement("h4");
        heading.className = "agent-field-group-title";
        heading.textContent = title;
        group.append(heading);
        return group;
      }

      function input(type: string): HTMLInputElement {
        const field = document.createElement("input");
        field.type = type;
        field.id = `codex-agent-field-${++idCounter}`;
        field.className = "agent-input";
        return field;
      }

      function textarea(rows: number): HTMLTextAreaElement {
        const field = document.createElement("textarea");
        field.id = `codex-agent-field-${++idCounter}`;
        field.rows = rows;
        field.className = "agent-input agent-textarea";
        return field;
      }

      const updateInstructionCount = (): void => {
        editor.instructionCount.textContent = text.characterCount.replace(
          "{count}",
          String(editor.instructions.value.length),
        );
      };

      const updateSaveState = (): void => {
        editor.save.disabled =
          savingEditor ||
          editor.name.value.trim().length === 0 ||
          editor.description.value.trim().length === 0 ||
          editor.instructions.value.trim().length === 0;
      };

      const draftErrorText: Record<CodexAgentDraftError, string> = {
        invalid_name: text.invalidName,
        name_taken: text.nameTaken,
        description_required: text.descriptionRequired,
        instructions_required: text.instructionsRequired,
        too_long: text.tooLong,
        model_invalid: text.modelInvalid,
        effort_invalid: text.effortInvalid,
      };

      const controlFor = (field: CodexAgentDraftField): HTMLElement | null =>
        field === "name"
          ? editor.name
          : field === "description"
            ? editor.description
            : field === "model"
              ? editor.model.hidden
                ? editor.modelInput
                : editor.model
              : field === "reasoningEffort"
                ? (effortControl ?? editor.effortSlot)
                : editor.instructions;

      const showError = (message: string, fieldName?: CodexAgentDraftField): void => {
        editor.error.textContent = message;
        editor.error.hidden = false;
        const control = fieldName ? controlFor(fieldName) : null;
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
          editor.modelInput,
          editor.instructions,
          effortControl,
        ]) {
          control?.removeAttribute("aria-invalid");
        }
      };

      let returnFocus: HTMLElement | null = null;

      const openEditor = (
        mode: "create" | "edit" | "duplicate",
        record?: CodexAgentRecord,
        focusTarget?: HTMLElement,
      ): void => {
        closeRowMenu();
        clearError();
        currentDraft =
          mode === "create" || !record
            ? emptyAgentDraft()
            : mode === "edit"
              ? agentDraftFromRecord(record)
              : duplicateAgentDraft(record, agents);
        returnFocus = focusTarget ?? null;
        editor.root.hidden = false;
        editor.title.textContent =
          mode === "create"
            ? text.editorCreateTitle
            : (mode === "edit" ? text.editorEditTitle : text.editorDuplicateTitle).replace(
                "{name}",
                record?.name ?? "",
              );
        editor.name.value = currentDraft.name;
        editor.description.value = currentDraft.description;
        rebuildModel();
        editor.model.value = currentDraft.model;
        editor.modelInput.value = currentDraft.model;
        editor.instructions.value = currentDraft.developerInstructions;
        rebuildEffort(currentDraft.reasoningEffort);
        savingEditor = false;
        editor.save.textContent = text.save;
        updateInstructionCount();
        updateSaveState();
        view.requestAnimationFrame(() => editor.name.focus());
      };

      const closeEditor = (): void => {
        editor.root.hidden = true;
        currentDraft = emptyAgentDraft();
        clearError();
        returnFocus?.focus();
        returnFocus = null;
      };

      const editExisting = async (
        agent: CodexAgentSummary,
        mode: "edit" | "duplicate",
        focusTarget?: HTMLElement,
      ): Promise<void> => {
        try {
          const record = await client.read(agent.fileName);
          if (!disposed) openEditor(mode, record, focusTarget);
        } catch (error) {
          if (!disposed) setStatus(errorText(error), true);
        }
      };

      const deleteAgent = async (agent: CodexAgentSummary): Promise<void> => {
        if (!view.confirm(text.deleteConfirm.replace("{name}", agent.name))) return;
        try {
          await client.remove(agent.fileName, agent.revision);
          if (disposed) return;
          await loadAgents();
        } catch (error) {
          if (disposed) return;
          setStatus(text.deleteFailed, true);
          if (["revision_conflict", "not_found"].includes(codexAgentCodeFromError(error))) {
            await loadAgents();
          }
        }
      };

      for (const control of [editor.name, editor.description, editor.instructions]) {
        control.addEventListener("input", () => {
          updateSaveState();
          if (control === editor.instructions) updateInstructionCount();
        });
      }
      create.addEventListener("click", () => openEditor("create", undefined, create));
      editor.close.addEventListener("click", closeEditor);
      editor.cancel.addEventListener("click", closeEditor);
      editor.form.addEventListener("submit", (event) => {
        event.preventDefault();
        clearError();
        const draft = {
          ...currentDraft,
          name: editor.name.value,
          description: editor.description.value,
          model: modelValue(),
          reasoningEffort: effortValue,
          developerInstructions: editor.instructions.value,
        };
        const problem = validateAgentDraft(draft, agents);
        if (problem) {
          showError(draftErrorText[problem.error], problem.field);
          return;
        }
        savingEditor = true;
        editor.save.disabled = true;
        editor.save.textContent = text.saving;
        void client
          .save(agentSaveParamsFromDraft(draft))
          .then(async () => {
            if (disposed) return;
            closeEditor();
            await loadAgents();
            if (!disposed) setStatus(text.saved);
          })
          .catch((error: unknown) => {
            if (disposed) return;
            const code = codexAgentCodeFromError(error);
            showError(errorText(error), code === "name_taken" ? "name" : undefined);
          })
          .finally(() => {
            if (disposed) return;
            savingEditor = false;
            editor.save.textContent = text.save;
            updateSaveState();
          });
      });
      editor.model.addEventListener("change", () => rebuildEffort(""));
      editor.modelInput.addEventListener("input", () => rebuildEffort(effortValue));
      editor.root.addEventListener("click", (event) => {
        if (event.target === editor.root || event.target === editor.root.firstElementChild) {
          closeEditor();
        }
      });

      const onKey = (event: KeyboardEvent): void => {
        if (event.key !== "Escape" || editor.root.hidden) return;
        event.preventDefault();
        event.stopPropagation();
        closeEditor();
      };
      document.addEventListener("keydown", onKey, true);

      renderRoutes();
      void loadAgents();
      void loadCatalog();
      void dingtalk.load();

      return () => {
        disposed = true;
        listGeneration += 1;
        catalogGeneration += 1;
        closeRowMenu();
        document.removeEventListener("keydown", onKey, true);
        dingtalk.dispose();
      };
    },
  });
}
