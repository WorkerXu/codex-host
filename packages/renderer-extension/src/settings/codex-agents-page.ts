import {
  defaultDingTalkAgentDispatch,
  defaultDingTalkDispatchSettings,
  dingtalkAgentReadyForDispatch,
  type CodexAgentCatalogResult,
  type CodexAgentListResult,
  type CodexAgentRecord,
  type CodexAgentSummary,
  type DingTalkAgentDispatch,
  type DingTalkDispatchAgentStatus,
  type DingTalkDispatchSettings,
} from "@codexhost/shared-contracts";

import {
  codexAgentCodeFromError,
  type RendererCodexAgentsClient,
} from "../renderer-codex-agents-client.js";
import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from "./core.js";
import {
  agentDingTalkDraft,
  agentDraftFromRecord,
  agentSaveParamsFromDraft,
  duplicateAgentDraft,
  effortOptionsForModel,
  emptyAgentDraft,
  validateAgentDraft,
  withAgentDingTalk,
  type CodexAgentDraft,
  type CodexAgentDraftError,
  type CodexAgentDraftField,
} from "./codex-agents-form.js";
import type { RendererSettingsMessages } from "./localization.js";
import {
  readDingTalkAgentTargets,
  resolveDingTalkAgentTarget,
  type DingTalkAgentTargets,
} from "./dingtalk-agent-targets.js";
import { createAgentAvatar, type CodexAgentAvatarState } from "./codex-agent-avatar.js";
import { openAgentMenu, type AgentMenuHandle } from "./agent-card-menu.js";
import { deleteCodexAgent } from "./agent-delete.js";

export interface RendererCodexAgentsSettingsOptions {
  createClient(): RendererCodexAgentsClient | null;
}

const EMPTY_CATALOG: CodexAgentCatalogResult = {
  available: false,
  models: [],
  defaultModel: null,
};

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
      const heading = document.createElement("h2");
      heading.className = "agents-page-title";
      heading.textContent = text.title;
      head.append(heading);
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
      list.className = "agents-grid";
      list.setAttribute("role", "list");
      const emptyCopy = document.createElement("p");
      emptyCopy.className = "agents-empty-copy";
      emptyCopy.textContent = text.empty;
      emptyCopy.hidden = true;
      const issues = document.createElement("p");
      issues.className = "agents-issues";
      issues.hidden = true;
      page.append(status, list, emptyCopy, issues);

      let dispatchSettings: DingTalkDispatchSettings = defaultDingTalkDispatchSettings();
      let dispatchStatus: Record<string, DingTalkDispatchAgentStatus> = {};
      let dispatchStatusTimer: number | null = null;
      let editingFile: string | null = null;
      let createCard: HTMLButtonElement | null = null;
      let dispatchQueue: Promise<void> = Promise.resolve();
      const persistDispatch = (
        mutate: (current: DingTalkDispatchSettings) => DingTalkDispatchSettings,
      ): Promise<DingTalkDispatchSettings> => {
        const run = dispatchQueue.then(async () => {
          const next = mutate(dispatchSettings);
          if (next === dispatchSettings) return dispatchSettings;
          const saved = await client.saveDispatchSettings(next);
          dispatchSettings = saved;
          if (loaded) renderRoutes();
          return saved;
        });
        dispatchQueue = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      };
      let targets: DingTalkAgentTargets = { available: false, sections: [] };
      const loadTargets = async (): Promise<void> => {
        try {
          targets = await readDingTalkAgentTargets(view);
        } catch {
          targets = { available: false, sections: [] };
        }
        if (!disposed) renderDingtalkTargetOptions();
      };

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
      let rowMenu: AgentMenuHandle | null = null;

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
        if (code === "invalid_name") return text.invalidName;
        if (code === "invalid_file_name") return text.fileInvalid;
        if (code === "unavailable") return text.unavailable;
        return text.genericError;
      };

      const runtimeStates = new Map<string, CodexAgentAvatarState>();

      const isParticipating = (agent: CodexAgentSummary): boolean =>
        dispatchSettings.agents[agent.fileName]?.enabled === true;

      const stateLabel = (agent: CodexAgentSummary): string => {
        if (!isParticipating(agent) && !runtimeStates.has(agent.fileName)) return text.stateResting;
        const state = runtimeStates.get(agent.fileName) ?? "idle";
        return state === "working"
          ? text.stateWorking
          : state === "waiting"
            ? text.stateWaiting
            : state === "done"
              ? text.stateDone
              : text.stateIdle;
      };

      const setEditingCard = (fileName: string | null): void => {
        for (const card of list.querySelectorAll<HTMLElement>(".agent-card[data-agent-file]")) {
          const active = card.dataset.agentFile === fileName;
          card.classList.toggle("agent-card--editing", active);
          if (active) card.setAttribute("aria-current", "true");
          else card.removeAttribute("aria-current");
        }
      };

      const renderRoutes = (): void => {
        closeRowMenu();
        list.replaceChildren();
        createCard = null;
        if (!loaded) {
          emptyCopy.hidden = true;
          for (let index = 0; index < 3; index += 1) list.append(skeletonCard());
          return;
        }
        emptyCopy.hidden = agents.length > 0;
        for (const agent of agents) list.append(agentCard(agent));
        createCard = newAgentCard();
        list.append(createCard);
      };

      const renderIssues = (result: CodexAgentListResult): void => {
        issues.hidden = result.issues.length === 0;
        issues.textContent =
          result.issues.length > 0 ? `${text.issuesTitle}（${result.issues.length}）` : "";
      };

      function agentCard(agent: CodexAgentSummary): HTMLElement {
        const card = document.createElement("div");
        card.className = "agent-card";
        card.dataset.agentName = agent.name;
        card.dataset.agentFile = agent.fileName;
        card.setAttribute("role", "listitem");
        card.tabIndex = 0;
        if (editingFile === agent.fileName) {
          card.classList.add("agent-card--editing");
          card.setAttribute("aria-current", "true");
        }

        const top = document.createElement("div");
        top.className = "agent-card-top";
        const avatar = document.createElement("span");
        avatar.className = "agent-card-avatar";
        avatar.append(
          createAgentAvatar(
            document,
            agent.name,
            runtimeStates.get(agent.fileName) ?? "idle",
            !isParticipating(agent) && !runtimeStates.has(agent.fileName),
          ),
        );
        const tools = document.createElement("div");
        tools.className = "agent-card-tools";
        const action = document.createElement("span");
        action.className = "agent-card-action";
        action.textContent = stateLabel(agent);
        const menuButton = document.createElement("button");
        menuButton.type = "button";
        menuButton.className = "agent-card-menu";
        menuButton.textContent = "⋯";
        menuButton.setAttribute("aria-label", text.moreActions);
        menuButton.setAttribute("aria-haspopup", "menu");
        menuButton.title = text.moreActions;
        menuButton.addEventListener("click", (event) => {
          event.stopPropagation();
          openRowMenu(agent, menuButton);
        });
        tools.append(action, menuButton);
        top.append(avatar, tools);

        const name = document.createElement("div");
        name.className = "agent-card-name";
        name.textContent = agent.name;
        name.title = agent.name;

        const description = document.createElement("p");
        description.className = "agent-card-description";
        description.textContent = agent.description;
        description.title = agent.description;

        const tags = document.createElement("div");
        tags.className = "agent-card-tags";
        const model = document.createElement("span");
        model.className = "agent-card-tag";
        model.textContent = [
          agent.model ?? text.defaultModel,
          agent.reasoningEffort ? effortLabel(agent.reasoningEffort) : null,
        ]
          .filter(Boolean)
          .join(" · ");
        tags.append(model);
        if (isParticipating(agent)) {
          const participating = document.createElement("span");
          participating.className = "agent-card-tag agent-card-tag--dispatch";
          participating.textContent = text.participating;
          tags.append(participating);
        }
        const targetMissing =
          isParticipating(agent) &&
          !dingtalkAgentReadyForDispatch(dispatchSettings.agents[agent.fileName]);
        if (typeof agent.lastDispatchedAt === "number") {
          const dispatched = document.createElement("span");
          dispatched.className = "agent-card-tag";
          dispatched.textContent = text.lastDispatched.replace(
            "{time}",
            relativeTime(agent.lastDispatchedAt),
          );
          tags.append(dispatched);
        }

        const dispatchLine = document.createElement("p");
        dispatchLine.className = "agent-dingtalk-status";
        const last = dispatchStatus[agent.fileName];
        dispatchLine.hidden = !last;
        dispatchLine.textContent = last ? dispatchStatusText(last) : "";
        card.append(top, name, description, tags, dispatchLine);
        if (targetMissing) {
          const warning = document.createElement("p");
          warning.className = "agent-dingtalk-warning";
          warning.textContent = text.dingtalk.agentNeedsTarget;
          card.append(warning);
        }
        const activate = (event: Event): void => {
          if (
            event.target instanceof Element &&
            event.target.closest(".agent-card-tools, .agent-menu")
          ) {
            return;
          }
          void editExisting(agent, "edit", card);
        };
        card.addEventListener("click", activate);
        card.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            activate(event);
          }
        });
        return card;
      }

      function newAgentCard(): HTMLButtonElement {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "agent-card agent-card--new";
        card.setAttribute("role", "listitem");
        const plus = document.createElement("span");
        plus.className = "agent-card-new-plus";
        plus.textContent = "+";
        const label = document.createElement("span");
        label.className = "agent-card-new-label";
        label.textContent = text.createCard;
        card.append(plus, label);
        card.addEventListener("click", () => openEditor("create", undefined, card));
        return card;
      }

      function skeletonCard(): HTMLElement {
        const card = document.createElement("div");
        card.className = "agent-card agent-card--skeleton";
        card.setAttribute("role", "presentation");
        const top = document.createElement("div");
        top.className = "agent-card-top";
        top.append(
          element("span", "agent-skeleton agent-skeleton--avatar"),
          element("span", "agent-skeleton agent-skeleton--menu"),
        );
        const name = element("span", "agent-skeleton agent-skeleton--title");
        const description = element("span", "agent-skeleton agent-skeleton--description");
        const tags = element("span", "agent-skeleton agent-skeleton--tags");
        card.append(top, name, description, tags);
        return card;
      }

      function element(tag: string, className: string): HTMLElement {
        const node = document.createElement(tag);
        node.className = className;
        return node;
      }

      function relativeTime(value: number): string {
        const delta = Math.max(0, Date.now() - value);
        const minute = 60_000;
        const hour = 60 * minute;
        const day = 24 * hour;
        if (delta < minute) return "刚刚";
        if (delta < hour) return `${Math.floor(delta / minute)} 分钟前`;
        if (delta < day) return `${Math.floor(delta / hour)} 小时前`;
        if (delta < 7 * day) return `${Math.floor(delta / day)} 天前`;
        return new Date(value).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
      }

      function stateText(value: string): HTMLElement {
        const node = document.createElement("p");
        node.className = "agents-state-text";
        node.textContent = value;
        return node;
      }

      const openRowMenu = (agent: CodexAgentSummary, anchor: HTMLElement): void => {
        closeRowMenu();
        const card = anchor.closest<HTMLElement>(".agent-card");
        card?.classList.add("agent-card--menu-open");
        anchor.setAttribute("aria-expanded", "true");
        rowMenu = openAgentMenu({
          document,
          view,
          container: page,
          anchor,
          label: agent.name,
          items: [
            { label: text.edit, run: () => void editExisting(agent, "edit") },
            { label: text.duplicate, run: () => void editExisting(agent, "duplicate") },
            { label: text.delete, danger: true, run: () => openDeleteDialog(agent) },
          ],
          onClose() {
            card?.classList.remove("agent-card--menu-open");
            anchor.setAttribute("aria-expanded", "false");
            rowMenu = null;
          },
        });
      };

      const closeRowMenu = (): void => {
        const menu = rowMenu;
        rowMenu = null;
        menu?.close();
      };

      const loadAgents = async (): Promise<void> => {
        const generation = ++listGeneration;
        setStatus(null);
        try {
          const result = await client.list();
          if (disposed || generation !== listGeneration) return;
          loaded = true;
          agents = result.agents;
          if (editingFile && !agents.some((agent) => agent.fileName === editingFile)) {
            editingFile = null;
          }
          renderRoutes();
          renderIssues(result);
          void loadDispatch();
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

      const dispatchSignature = (settings: DingTalkDispatchSettings): string =>
        Object.entries(settings.agents)
          .map(([fileName, agent]) => `${fileName}:${agent.enabled ? 1 : 0}`)
          .sort()
          .join("|");

      const loadDispatch = async (): Promise<void> => {
        try {
          const next = await client.dispatchSettings();
          if (disposed) return;
          const changed = dispatchSignature(next) !== dispatchSignature(dispatchSettings);
          dispatchSettings = next;
          if (changed) renderRoutes();
        } catch {
          /* The list keeps working; saving opens the editor again. */
        }
      };

      function dispatchStatusText(value: DingTalkDispatchAgentStatus): string {
        const result =
          value.result === "replied"
            ? text.dingtalk.dispatchReplied
            : value.result === "failed"
              ? text.dingtalk.dispatchFailed
              : text.dingtalk.dispatchSkipped;
        const clock = new Date(value.lastDispatchAt).toLocaleString([], {
          month: "numeric",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
        return `${text.dingtalk.agentLastDispatch} ${clock} · ${result}${value.detail ? `（${value.detail}）` : ""}`;
      }

      const renderDingtalkStatus = (): void => {
        for (const card of list.querySelectorAll<HTMLElement>(".agent-card[data-agent-file]")) {
          const line = card.querySelector<HTMLElement>(".agent-dingtalk-status");
          const value = dispatchStatus[card.dataset.agentFile ?? ""];
          if (line) {
            line.hidden = !value;
            line.textContent = value ? dispatchStatusText(value) : "";
          }
        }
        const value = editingFile ? dispatchStatus[editingFile] : undefined;
        editor.dingtalkStatus.hidden = !value;
        editor.dingtalkStatus.textContent = value ? dispatchStatusText(value) : "";
      };

      const loadDispatchStatus = async (): Promise<void> => {
        try {
          const next = await client.dispatchStatus();
          if (disposed) return;
          dispatchStatus = next;
          renderDingtalkStatus();
        } catch {
          /* Status is supplementary; keep the last known values. */
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
        name.autocomplete = "off";
        name.spellcheck = false;
        const nameError = fieldError();
        nameError.dataset.field = "name";
        const nameField = labeledField(text.name, text.nameHint, name, nameError);
        const descriptionField = textarea(2);
        descriptionField.maxLength = 4_096;
        const descriptionError = fieldError();
        descriptionError.dataset.field = "description";
        const descriptionFieldWrapper = labeledField(
          text.descriptionLabel,
          text.descriptionHint,
          descriptionField,
          descriptionError,
        );
        basicGroup.append(nameField, descriptionFieldWrapper);

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
        const modelError = fieldError();
        modelError.dataset.field = "model";
        modelField.append(catalogHint, modelError);
        const effortSlot = document.createElement("div");
        effortSlot.className = "agent-effort-slot";
        const effortError = fieldError();
        effortError.dataset.field = "reasoningEffort";
        const effortField = labeledField(text.effort, text.effortHint, effortSlot, effortError);
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
        const instructionsError = fieldError();
        instructionsError.dataset.field = "developerInstructions";
        instructionsField.append(instructions, instructionsMeta, instructionsError);
        instructionsGroup.append(instructionsField);

        const dingtalkGroup = fieldGroup(text.dingtalk.agentSection);
        const dingtalkSwitchRow = document.createElement("label");
        dingtalkSwitchRow.className = "dingtalk-switch-row agent-dingtalk-switch";
        const dingtalkSwitchCopy = document.createElement("span");
        dingtalkSwitchCopy.className = "dingtalk-switch-copy";
        const dingtalkSwitchTitle = document.createElement("span");
        dingtalkSwitchTitle.className = "dingtalk-switch-title";
        dingtalkSwitchTitle.textContent = text.dingtalk.agentEnabled;
        const dingtalkSwitchHint = document.createElement("span");
        dingtalkSwitchHint.className = "dingtalk-switch-hint";
        dingtalkSwitchHint.textContent = text.dingtalk.agentEnabledHint;
        dingtalkSwitchCopy.append(dingtalkSwitchTitle, dingtalkSwitchHint);
        const dingtalkEnabled = document.createElement("input");
        dingtalkEnabled.type = "checkbox";
        dingtalkEnabled.className = "dingtalk-switch";
        dingtalkEnabled.setAttribute("aria-label", text.dingtalk.agentEnabled);
        dingtalkSwitchRow.append(dingtalkSwitchCopy, dingtalkEnabled);

        const dingtalkBody = document.createElement("div");
        dingtalkBody.className = "agent-dingtalk-body";
        const dingtalkTargetField = document.createElement("div");
        dingtalkTargetField.className = "agent-field";
        const dingtalkTargetTitle = document.createElement("span");
        dingtalkTargetTitle.className = "agent-field-label";
        dingtalkTargetTitle.textContent = text.dingtalk.agentTarget;
        const dingtalkSection = document.createElement("select");
        dingtalkSection.className = "agent-input agent-select";
        dingtalkSection.setAttribute("aria-label", text.dingtalk.agentSectionLabel);
        const dingtalkProject = document.createElement("select");
        dingtalkProject.className = "agent-input agent-select";
        dingtalkProject.setAttribute("aria-label", text.dingtalk.agentProjectLabel);
        const dingtalkTargetRow = document.createElement("div");
        dingtalkTargetRow.className = "agent-target-fields";
        const sectionField = document.createElement("label");
        sectionField.className = "agent-target-field";
        sectionField.append(
          document.createTextNode(text.dingtalk.agentSectionLabel),
          dingtalkSection,
        );
        const projectField = document.createElement("label");
        projectField.className = "agent-target-field";
        projectField.append(
          document.createTextNode(text.dingtalk.agentProjectLabel),
          dingtalkProject,
        );
        dingtalkTargetRow.append(sectionField, projectField);
        const dingtalkTargetHint = document.createElement("p");
        dingtalkTargetHint.className = "agent-field-hint";
        dingtalkTargetHint.textContent = text.dingtalk.agentTargetHint;
        dingtalkTargetField.append(dingtalkTargetTitle, dingtalkTargetRow, dingtalkTargetHint);

        const dingtalkReplyField = document.createElement("div");
        dingtalkReplyField.className = "agent-field";
        const dingtalkReplyTitle = document.createElement("span");
        dingtalkReplyTitle.className = "agent-field-label";
        dingtalkReplyTitle.textContent = text.dingtalk.agentReply;
        const dingtalkReplyGroup = document.createElement("div");
        dingtalkReplyGroup.className = "agent-segmented";
        dingtalkReplyGroup.setAttribute("role", "group");
        dingtalkReplyGroup.setAttribute("aria-label", text.dingtalk.agentReply);
        const dingtalkReply = new Map<"group" | "direct", HTMLButtonElement>();
        for (const [value, label] of [
          ["group", text.dingtalk.agentReplyGroup],
          ["direct", text.dingtalk.agentReplyDirect],
        ] as const) {
          const option = document.createElement("button");
          option.type = "button";
          option.className = "agent-segment";
          option.dataset.value = value;
          option.textContent = label;
          option.setAttribute("aria-pressed", "false");
          option.addEventListener("click", () => {
            for (const [key, button] of dingtalkReply) {
              button.setAttribute("aria-pressed", String(key === value));
            }
          });
          dingtalkReply.set(value, option);
          dingtalkReplyGroup.append(option);
        }
        dingtalkReplyField.append(dingtalkReplyTitle, dingtalkReplyGroup);
        const dingtalkStatus = document.createElement("p");
        dingtalkStatus.className = "agent-dingtalk-status";
        dingtalkStatus.hidden = true;
        dingtalkBody.append(dingtalkTargetField, dingtalkReplyField, dingtalkStatus);
        dingtalkGroup.append(dingtalkSwitchRow, dingtalkBody);

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

        editorBody.append(basicGroup, modelGroup, instructionsGroup, dingtalkGroup, error);
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
          fieldErrors: {
            name: nameError,
            description: descriptionError,
            model: modelError,
            reasoningEffort: effortError,
            developerInstructions: instructionsError,
          } satisfies Record<CodexAgentDraftField, HTMLElement>,
          dingtalkEnabled,
          dingtalkBody,
          dingtalkSection,
          dingtalkProject,
          dingtalkTargetHint,
          dingtalkReply,
          dingtalkStatus,
          error,
          save,
          cancel,
        };
      }

      function fieldError(): HTMLElement {
        const node = document.createElement("p");
        node.className = "agent-field-error";
        node.setAttribute("role", "alert");
        node.hidden = true;
        return node;
      }

      function labeledField(
        title: string | null,
        hint: string,
        control: HTMLElement,
        error?: HTMLElement,
      ): HTMLElement {
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
        if (error) wrapper.append(error);
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
        clearError();
        const field = fieldName ? editor.fieldErrors[fieldName] : null;
        if (field) {
          field.textContent = message;
          field.hidden = false;
        } else {
          editor.error.textContent = message;
          editor.error.hidden = false;
        }
        const control = fieldName ? controlFor(fieldName) : null;
        control?.setAttribute("aria-invalid", "true");
        control?.focus();
      };

      const clearError = (): void => {
        editor.error.hidden = true;
        editor.error.textContent = "";
        for (const field of Object.values(editor.fieldErrors)) {
          field.hidden = true;
          field.textContent = "";
        }
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
      /** Kept while the native section catalog is unreadable, so saving keeps it. */
      let editorDingtalkTarget = {
        sectionId: null as string | null,
        projectId: null as string | null,
        projectPath: null as string | null,
        projectRoots: [] as string[],
      };

      const renderDingtalkEnabled = (): void => {
        const on = editor.dingtalkEnabled.checked;
        editor.dingtalkBody.dataset.disabled = String(!on);
        editor.dingtalkBody.inert = !on;
      };

      const fillProjectOptions = (sectionId: string | null, preferred: string | null): void => {
        const section = sectionId
          ? (targets.sections.find((entry) => entry.id === sectionId) ?? null)
          : null;
        const projects = section?.projects ?? [];
        editor.dingtalkProject.replaceChildren();
        const placeholder = new Option(text.dingtalk.agentProjectPlaceholder, "");
        editor.dingtalkProject.append(placeholder);
        for (const project of projects) {
          editor.dingtalkProject.append(new Option(project.name, project.id));
        }
        const chosen =
          preferred && projects.some((project) => project.id === preferred)
            ? preferred
            : projects.length === 1
              ? (projects[0]?.id ?? "")
              : "";
        editor.dingtalkProject.value = chosen;
        editor.dingtalkProject.disabled = projects.length <= 1;
        if (!targets.available) {
          editor.dingtalkTargetHint.textContent = text.dingtalk.agentTargetsUnavailable;
        } else if (section && projects.length === 0) {
          editor.dingtalkTargetHint.textContent = text.dingtalk.agentNoLocalProject;
        } else {
          editor.dingtalkTargetHint.textContent = text.dingtalk.agentTargetHint;
        }
      };

      function renderDingtalkTargetOptions(
        sectionId?: string | null,
        projectId?: string | null,
      ): void {
        const chosenSection =
          sectionId !== undefined ? sectionId : editor.dingtalkSection.value || null;
        const chosenProject =
          projectId !== undefined ? projectId : editor.dingtalkProject.value || null;
        editor.dingtalkSection.replaceChildren();
        editor.dingtalkSection.append(new Option(text.dingtalk.agentSectionPlaceholder, ""));
        for (const section of targets.sections) {
          const suffix = `（${section.projects.length}）`;
          editor.dingtalkSection.append(new Option(`${section.name}${suffix}`, section.id));
        }
        editor.dingtalkSection.disabled = !targets.available || targets.sections.length === 0;
        editor.dingtalkSection.value =
          chosenSection && targets.sections.some((section) => section.id === chosenSection)
            ? chosenSection
            : "";
        fillProjectOptions(editor.dingtalkSection.value || null, chosenProject);
      }

      const setDingtalkDraft = (draft: DingTalkAgentDispatch): void => {
        editorDingtalkTarget = {
          sectionId: draft.sectionId,
          projectId: draft.projectId,
          projectPath: draft.projectPath,
          projectRoots: [...draft.projectRoots],
        };
        editor.dingtalkEnabled.checked = draft.enabled;
        renderDingtalkTargetOptions(draft.sectionId, draft.projectId);
        for (const [scope, button] of editor.dingtalkReply) {
          button.setAttribute("aria-pressed", String(scope === draft.replyScope));
        }
        renderDingtalkEnabled();
      };

      const readDingtalkDraft = (): DingTalkAgentDispatch => {
        if (!targets.available) {
          return {
            enabled: editor.dingtalkEnabled.checked,
            replyScope:
              editor.dingtalkReply.get("direct")?.getAttribute("aria-pressed") === "true"
                ? "direct"
                : "group",
            ...editorDingtalkTarget,
          };
        }
        const sectionId = editor.dingtalkSection.value || null;
        const projectId = editor.dingtalkProject.value || null;
        const { project } = resolveDingTalkAgentTarget(targets, sectionId, projectId);
        return {
          enabled: editor.dingtalkEnabled.checked,
          replyScope:
            editor.dingtalkReply.get("direct")?.getAttribute("aria-pressed") === "true"
              ? "direct"
              : "group",
          sectionId,
          projectId: project?.id ?? null,
          projectPath: project?.path ?? null,
          projectRoots: project ? [...project.roots] : [],
        };
      };

      const openEditor = (
        mode: "create" | "edit" | "duplicate",
        record?: CodexAgentRecord,
        focusTarget?: HTMLElement,
      ): void => {
        closeRowMenu();
        clearError();
        editingFile = mode === "edit" ? (record?.fileName ?? null) : null;
        setEditingCard(editingFile);
        currentDraft =
          mode === "create" || !record
            ? emptyAgentDraft()
            : mode === "edit"
              ? agentDraftFromRecord(record)
              : duplicateAgentDraft(record);
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
        editor.title.title = editor.title.textContent ?? "";
        rebuildModel();
        editor.model.value = currentDraft.model;
        editor.modelInput.value = currentDraft.model;
        editor.instructions.value = currentDraft.developerInstructions;
        rebuildEffort(currentDraft.reasoningEffort);
        setDingtalkDraft(
          mode === "edit" && record
            ? agentDingTalkDraft(dispatchSettings, record.fileName)
            : defaultDingTalkAgentDispatch(),
        );
        renderDingtalkStatus();
        savingEditor = false;
        editor.save.textContent = text.save;
        updateInstructionCount();
        updateSaveState();
        view.requestAnimationFrame(() => editor.name.focus());
      };

      const closeEditor = (): void => {
        editor.root.hidden = true;
        currentDraft = emptyAgentDraft();
        editingFile = null;
        setEditingCard(null);
        clearError();
        returnFocus?.focus();
        returnFocus = null;
      };

      const editExisting = async (
        agent: CodexAgentSummary,
        mode: "edit" | "duplicate",
        focusTarget?: HTMLElement,
      ): Promise<void> => {
        if (mode === "edit") {
          editingFile = agent.fileName;
          setEditingCard(agent.fileName);
        }
        try {
          const record = await client.read(agent.fileName);
          if (!disposed) openEditor(mode, record, focusTarget);
        } catch (error) {
          if (!disposed) {
            editingFile = null;
            setEditingCard(null);
            setStatus(errorText(error), true);
          }
        }
      };

      function openDeleteDialog(agent: CodexAgentSummary): void {
        if (!client) return;
        const returnFocus =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const dialog = document.createElement("dialog");
        dialog.className = "agent-confirm";
        const form = document.createElement("form");
        form.className = "agent-confirm-form";
        const title = document.createElement("h3");
        title.className = "agent-confirm-title";
        title.textContent = text.deleteTitle;
        const message = document.createElement("p");
        message.className = "agent-confirm-message";
        message.textContent = text.deleteConfirm.replace("{name}", agent.name);
        const error = document.createElement("p");
        error.className = "agent-confirm-error";
        error.setAttribute("role", "alert");
        error.hidden = true;
        const actions = document.createElement("div");
        actions.className = "agent-confirm-actions";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "agent-secondary";
        cancel.textContent = text.cancel;
        const confirm = document.createElement("button");
        confirm.type = "submit";
        confirm.className = "agent-danger";
        confirm.textContent = text.delete;
        actions.append(cancel, confirm);
        form.append(title, message, error, actions);
        dialog.append(form);
        page.append(dialog);

        let busy = false;
        const close = (): void => {
          dialog.close();
          dialog.remove();
          returnFocus?.focus();
        };
        cancel.addEventListener("click", close);
        dialog.addEventListener("cancel", (event) => {
          if (busy) event.preventDefault();
        });
        dialog.addEventListener("close", () => dialog.remove());
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          if (busy) return;
          busy = true;
          error.hidden = true;
          cancel.disabled = true;
          confirm.disabled = true;
          confirm.textContent = text.deleting;
          void deleteCodexAgent({
            fileName: agent.fileName,
            revision: agent.revision,
            remove: (fileName, revision) => client.remove(fileName, revision),
            reload: loadAgents,
            isStale: (failure) =>
              ["revision_conflict", "not_found"].includes(codexAgentCodeFromError(failure)),
          }).then((result) => {
            if (disposed) return;
            if (result.ok) {
              close();
              return;
            }
            busy = false;
            cancel.disabled = false;
            confirm.disabled = false;
            confirm.textContent = text.delete;
            error.textContent = text.deleteFailed;
            error.hidden = false;
          });
        });
        dialog.showModal();
        cancel.focus();
      }

      for (const control of [editor.name, editor.description, editor.instructions]) {
        control.addEventListener("input", () => {
          updateSaveState();
          if (control === editor.instructions) updateInstructionCount();
        });
      }
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
        const problem = validateAgentDraft(draft);
        if (problem) {
          showError(draftErrorText[problem.error], problem.field);
          return;
        }
        savingEditor = true;
        editor.save.disabled = true;
        editor.save.textContent = text.saving;
        void client
          .save(agentSaveParamsFromDraft(draft))
          .then(async (record) => {
            if (disposed) return;
            const choice = readDingtalkDraft();
            const dispatchSaved = await persistDispatch((current) =>
              withAgentDingTalk(current, record.fileName, choice),
            ).then(
              () => true,
              () => false,
            );
            if (disposed) return;
            closeEditor();
            await loadAgents();
            if (!disposed) {
              if (dispatchSaved) setStatus(text.saved);
              else setStatus(text.dingtalk.agentSaveFailed, true);
            }
          })
          .catch((error: unknown) => {
            if (disposed) return;
            const code = codexAgentCodeFromError(error);
            showError(errorText(error), code === "invalid_name" ? "name" : undefined);
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
      editor.dingtalkEnabled.addEventListener("change", renderDingtalkEnabled);
      editor.dingtalkSection.addEventListener("change", () => {
        fillProjectOptions(editor.dingtalkSection.value || null, null);
      });
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
      void loadDispatch();
      void loadTargets();
      void loadDispatchStatus();
      dispatchStatusTimer = view.setInterval(() => void loadDispatchStatus(), 10_000);

      return () => {
        disposed = true;
        listGeneration += 1;
        catalogGeneration += 1;
        if (dispatchStatusTimer !== null) view.clearInterval(dispatchStatusTimer);
        dispatchStatusTimer = null;
        closeRowMenu();
        document.removeEventListener("keydown", onKey, true);
      };
    },
  });
}
