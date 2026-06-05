/**
 * Ask Tool Extension - Interactive question UI for pi-coding-agent
 *
 * Refactored to use built-in TUI primitives (Container/Text/Spacer/SelectList/Editor)
 * and a custom box border instead of manual ANSI box drawing.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Type, type TUnsafe } from "@sinclair/typebox";
import {
   Container,
   type Component,
   decodeKittyPrintable,
   Editor,
   type EditorTheme,
   fuzzyFilter,
   Key,
   type Keybinding,
   type KeybindingsManager,
   Markdown,
   type MarkdownTheme,
   matchesKey,
   type OverlayHandle,
   type SizeValue,
   Spacer,
   Text,
   type TUI,
   truncateToWidth,
   wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { renderSingleSelectRows } from "./single-select-layout";

import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
const ASK_USER_VERSION: string = (_require("./package.json") as { version: string }).version;

/**
 * Emit a flat `{ type: "string", enum: [...] }` JSON Schema instead of the
 * `anyOf`/`oneOf` shape that `Type.Union([Type.Literal()])` produces. Google's
 * function-calling API rejects the union form. Local copy of pi-ai's StringEnum
 * to avoid a peer dependency for one helper.
 */
function StringEnum<const T extends readonly string[]>(
   values: T,
   options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
   return Type.Unsafe<T[number]>({
      type: "string",
      enum: [...values],
      ...(options?.description ? { description: options.description } : {}),
      ...(options?.default !== undefined ? { default: options.default } : {}),
   });
}

/**
 * `getMarkdownTheme()` returns a bag of closures that read through a Proxy
 * over the host's theme singleton. The Proxy only throws on property access,
 * not when the bag itself is constructed — so a naive
 * `try { getMarkdownTheme() } catch {}` silently lets a broken bag escape
 * and crashes mid-render the first time pi-tui's Markdown calls
 * `mdTheme.bold(...)`.
 *
 * That broken-bag scenario shows up whenever this extension's bundled copy
 * of `@earendil-works/pi-coding-agent` is a different module instance than
 * the host's — e.g. an older Pi still on the legacy
 * `@mariozechner/pi-coding-agent` scope (≤ 0.73.1) where npm cannot dedupe
 * across scopes, so our copy's theme singleton is never initialised
 * (`globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")]` is
 * undefined). See https://github.com/edlsh/pi-ask-user/issues/17.
 *
 * Probe `bold("")` to force the Proxy lookup eagerly; on throw, callers
 * fall back to plain `Text` rendering for context blocks.
 */
function safeMarkdownTheme(): MarkdownTheme | undefined {
   try {
      const md = getMarkdownTheme();
      if (!md) return undefined;
      md.bold("");
      return md;
   } catch {
      return undefined;
   }
}

type AskOptionInput = QuestionOption | string;

interface QuestionOption {
   title: string;
   description?: string;
}

interface AskQuestionInput {
   question: string;
   header?: string;
   context?: string;
   options?: AskOptionInput[];
   allowMultiple?: boolean;
   allowFreeform?: boolean;
   allowComment?: boolean;
}

interface NormalizedAskQuestion {
   question: string;
   header: string;
   context?: string;
   options: QuestionOption[];
   allowMultiple: boolean;
   allowFreeform: boolean;
   allowComment: boolean;
}

type AskDisplayMode = "overlay" | "inline";

interface AskParams {
   question?: string;
   header?: string;
   context?: string;
   options?: AskOptionInput[];
   allowMultiple?: boolean;
   allowFreeform?: boolean;
   allowComment?: boolean;
   questions?: AskQuestionInput[];
   displayMode?: AskDisplayMode;
   overlayToggleKey?: string | null;
   commentToggleKey?: string | null;
   timeout?: number;
}

type AskResponse =
   | {
      kind: "selection";
      selections: string[];
      comment?: string;
   }
   | {
      kind: "freeform";
      text: string;
   };

interface AskWizardResponse {
   kind: "questions";
   responses: Record<string, AskResponse | null>;
}

interface AskSingleToolDetails {
   question: string;
   context?: string;
   options: QuestionOption[];
   response: AskResponse | null;
   cancelled: boolean;
}

interface AskQuestionDetails extends NormalizedAskQuestion { }

interface AskWizardToolDetails {
   questions: AskQuestionDetails[];
   responses: Record<string, AskResponse | null>;
   cancelled: boolean;
}

type AskToolDetails = AskSingleToolDetails | AskWizardToolDetails;

type AskUIResult = AskResponse | AskWizardResponse;

const MAX_WIZARD_QUESTIONS = 4;

function normalizeOptions(options: AskOptionInput[]): QuestionOption[] {
   return options
      .map((option) => {
         if (typeof option === "string") {
            return { title: option };
         }
         if (option && typeof option === "object" && typeof option.title === "string") {
            return { title: option.title, description: option.description };
         }
         return null;
      })
      .filter((option): option is QuestionOption => option !== null);
}

function normalizeQuestionContext(context: string | undefined): string | undefined {
   return context?.trim() || undefined;
}

function normalizeQuestionInput(
   input: Partial<AskQuestionInput>,
   index: number,
   defaults: Partial<AskQuestionInput> = {},
): NormalizedAskQuestion | null {
   const question = input.question?.trim();
   if (!question) return null;

   const options = normalizeOptions(input.options ?? defaults.options ?? []);
   const allowFreeform = input.allowFreeform ?? defaults.allowFreeform ?? true;

   return {
      question,
      header: input.header?.trim() || `Q${index + 1}`,
      context: normalizeQuestionContext(input.context) ?? normalizeQuestionContext(defaults.context),
      options,
      allowMultiple: input.allowMultiple ?? defaults.allowMultiple ?? false,
      allowFreeform: options.length === 0 ? true : allowFreeform,
      allowComment: input.allowComment ?? defaults.allowComment ?? false,
   };
}

function normalizeAskQuestions(params: AskParams): { questions: NormalizedAskQuestion[] } | { error: string } {
   if (Array.isArray(params.questions)) {
      if (params.questions.length === 0) {
         return { error: "ask_user requires at least one question" };
      }
      if (params.questions.length > MAX_WIZARD_QUESTIONS) {
         return { error: `ask_user supports at most ${MAX_WIZARD_QUESTIONS} questions per call` };
      }

      const defaults: Partial<AskQuestionInput> = {
         context: params.context,
         options: params.options,
         allowMultiple: params.allowMultiple,
         allowFreeform: params.allowFreeform,
         allowComment: params.allowComment,
      };
      const questions = params.questions.map((question, index) => normalizeQuestionInput(question, index, defaults));
      const invalidIndex = questions.findIndex((question) => question === null);
      if (invalidIndex !== -1) {
         return { error: `Question ${invalidIndex + 1} is missing question text` };
      }

      const normalized = questions as NormalizedAskQuestion[];
      const questionTexts = normalized.map((question) => question.question);
      if (questionTexts.length !== new Set(questionTexts).size) {
         return { error: "Question texts must be unique when using questions[]" };
      }
      return { questions: normalized };
   }

   const question = normalizeQuestionInput(params, 0);
   if (!question) {
      return { error: "ask_user requires a question or questions[]" };
   }
   return { questions: [question] };
}

function questionToDetails(question: NormalizedAskQuestion): AskQuestionDetails {
   return {
      question: question.question,
      header: question.header,
      context: question.context,
      options: question.options,
      allowMultiple: question.allowMultiple,
      allowFreeform: question.allowFreeform,
      allowComment: question.allowComment,
   };
}

function createWizardResponse(questions: NormalizedAskQuestion[], responses: Record<string, AskResponse | null>): AskWizardResponse {
   return {
      kind: "questions",
      responses: Object.fromEntries(
         questions.map((question) => [question.question, responses[question.question] ?? null]),
      ),
   };
}

function isWizardResponse(response: AskUIResult): response is AskWizardResponse {
   return response.kind === "questions";
}

function isWizardToolDetails(details: unknown): details is AskWizardToolDetails {
   return !!details
      && typeof details === "object"
      && Array.isArray((details as { questions?: unknown }).questions)
      && !!(details as { responses?: unknown }).responses;
}

function formatOptionsForMessage(options: QuestionOption[]): string {
   return options
      .map((option, index) => {
         const desc = option.description ? ` — ${option.description}` : "";
         return `${index + 1}. ${option.title}${desc}`;
      })
      .join("\n");
}

function normalizeOptionalComment(text: string | null | undefined): string | undefined {
   const trimmed = text?.trim();
   return trimmed ? trimmed : undefined;
}

function createFreeformResponse(text: string | null | undefined): AskResponse | null {
   const trimmed = text?.trim();
   return trimmed ? { kind: "freeform", text: trimmed } : null;
}

function createSelectionResponse(selections: string[], comment?: string | null): AskResponse | null {
   const normalizedSelections = selections.map((selection) => selection.trim()).filter(Boolean);
   if (normalizedSelections.length === 0) return null;

   const normalizedComment = normalizeOptionalComment(comment);
   return normalizedComment
      ? { kind: "selection", selections: normalizedSelections, comment: normalizedComment }
      : { kind: "selection", selections: normalizedSelections };
}

function formatResponseSummary(response: AskResponse): string {
   if (response.kind === "freeform") return response.text;

   const selections = response.selections.join(", ");
   return response.comment ? `${selections} — ${response.comment}` : selections;
}

function formatWizardResponseSummary(response: AskWizardResponse, questions: NormalizedAskQuestion[]): string {
   return questions
      .map((question) => {
         const answer = response.responses[question.question];
         return `- ${question.question}: ${answer ? formatResponseSummary(answer) : "Skipped"}`;
      })
      .join("\n");
}

function formatQuestionPrompt(question: NormalizedAskQuestion): string {
   const optionText = question.options.length > 0 ? `\n\nOptions:\n${formatOptionsForMessage(question.options)}` : "";
   const freeformHint = question.allowFreeform ? "\n\nYou can also answer freely." : "";
   const commentHint = question.allowComment ? "\n\nAfter choosing an option, you may add an optional comment." : "";
   const contextText = question.context ? `\n\nContext:\n${question.context}` : "";
   return `${question.question}${contextText}${optionText}${freeformHint}${commentHint}`;
}

function formatQuestionsPrompt(questions: NormalizedAskQuestion[]): string {
   if (questions.length === 1) return formatQuestionPrompt(questions[0]);

   return questions
      .map((question, index) => `Question ${index + 1}:\n${formatQuestionPrompt(question)}`)
      .join("\n\n---\n\n");
}

function buildCommentPrompt(prompt: string, selections: string[]): string {
   const label = selections.length === 1 ? "Selected option" : "Selected options";
   const lines = selections.map((selection) => `- ${selection}`).join("\n");
   return `${prompt}\n\n${label}:\n${lines}`;
}

function parseDialogSelections(input: string): string[] {
   return input
      .split(",")
      .map((selection) => selection.trim())
      .filter(Boolean);
}

function isCancelledInput(value: unknown): value is null | undefined {
   return value === null || value === undefined;
}

function isSelectionResponse(response: AskResponse): response is Extract<AskResponse, { kind: "selection" }> {
   return response.kind === "selection";
}

function createSelectListTheme(theme: Theme) {
   return {
      selectedPrefix: (t: string) => theme.fg("accent", t),
      selectedText: (t: string) => theme.fg("accent", t),
      description: (t: string) => theme.fg("muted", t),
      scrollInfo: (t: string) => theme.fg("dim", t),
      noMatch: (t: string) => theme.fg("warning", t),
   };
}

function createEditorTheme(theme: Theme): EditorTheme {
   return {
      borderColor: (s: string) => theme.fg("accent", s),
      selectList: createSelectListTheme(theme),
   };
}

const BOX_BORDER_LEFT = "│ ";
const BOX_BORDER_RIGHT = " │";
const BOX_BORDER_OVERHEAD = BOX_BORDER_LEFT.length + BOX_BORDER_RIGHT.length;

class BoxBorderTop implements Component {
   private color: (s: string) => string;
   private title?: string;
   private titleColor?: (s: string) => string;
   constructor(color: (s: string) => string, title?: string, titleColor?: (s: string) => string) {
      this.color = color;
      this.title = title;
      this.titleColor = titleColor;
   }
   invalidate(): void { }
   render(width: number): string[] {
      const inner = Math.max(0, width - 2);
      if (!this.title || inner < this.title.length + 4) {
         return [this.color(`╭${"─".repeat(inner)}╮`)];
      }
      const label = ` ${this.title} `;
      const remaining = inner - 1 - label.length;
      const titleStyle = this.titleColor ?? this.color;
      return [
         this.color("╭─") + titleStyle(label) + this.color("─".repeat(Math.max(0, remaining)) + "╮"),
      ];
   }
}

class BoxBorderBottom implements Component {
   private color: (s: string) => string;
   private label?: string;
   private labelColor?: (s: string) => string;
   constructor(color: (s: string) => string, label?: string, labelColor?: (s: string) => string) {
      this.color = color;
      this.label = label;
      this.labelColor = labelColor;
   }
   invalidate(): void { }
   render(width: number): string[] {
      const inner = Math.max(0, width - 2);
      if (!this.label || inner < this.label.length + 4) {
         return [this.color(`╰${"─".repeat(inner)}╯`)];
      }
      const tag = ` ${this.label} `;
      const leftDashes = inner - tag.length - 1;
      const style = this.labelColor ?? this.color;
      return [
         this.color("╰" + "─".repeat(Math.max(0, leftDashes))) + style(tag) + this.color("─╯"),
      ];
   }
}

function formatKeyList(keys: string[]): string {
   return keys.join("/");
}

function keybindingHint(
   theme: Theme,
   keybindings: KeybindingsManager,
   keybinding: Keybinding,
   description: string,
): string {
   return `${theme.fg("dim", formatKeyList(keybindings.getKeys(keybinding)))}${theme.fg("muted", ` ${description}`)}`;
}

function literalHint(theme: Theme, key: string, description: string): string {
   return `${theme.fg("dim", key)}${theme.fg("muted", ` ${description}`)}`;
}

type ResolvedShortcut =
   | { disabled: false; spec: string; matches: (data: string) => boolean }
   | { disabled: true; spec: null; matches: (data: string) => false };

interface ResolvedAskShortcuts {
   overlayToggle: ResolvedShortcut;
   commentToggle: ResolvedShortcut;
}

const DISABLED_SHORTCUT: ResolvedShortcut = {
   disabled: true,
   spec: null,
   matches: ((_data: string) => false) as (data: string) => false,
};

const SHORTCUT_DISABLE_VALUES = new Set(["off", "none", "disabled", ""]);

function normalizeShortcutSpec(value: string | null | undefined): string | null | undefined {
   if (value === undefined) return undefined;
   if (value === null) return null;
   const trimmed = value.trim().toLowerCase();
   if (SHORTCUT_DISABLE_VALUES.has(trimmed)) return null;
   return trimmed;
}

function isValidShortcutSpec(spec: string): boolean {
   // KeyId is canonical lowercase: modifiers (`ctrl|shift|alt|super`) joined by `+`,
   // plus a base key. We do a light syntactic sanity check; matchesKey() does the rest.
   if (!spec) return false;
   if (!/^[a-z0-9+_\-!@#$%^&*()|~`'":;,./<>?[\]{}=\\]+$/i.test(spec)) return false;
   if (spec.startsWith("+") || spec.endsWith("+")) return false;
   if (spec.includes("++")) return false;
   return true;
}

function buildShortcut(spec: string): ResolvedShortcut {
   return {
      disabled: false,
      spec,
      matches: (data: string) => matchesKey(data, spec as any),
   };
}

function resolveShortcut(
   paramValue: string | null | undefined,
   envValue: string | undefined,
   defaultSpec: string,
): ResolvedShortcut {
   const candidates: Array<string | null | undefined> = [paramValue, envValue, defaultSpec];
   for (const raw of candidates) {
      const normalized = normalizeShortcutSpec(raw);
      if (normalized === undefined) continue; // not provided, fall through
      if (normalized === null) return DISABLED_SHORTCUT; // explicit disable
      if (isValidShortcutSpec(normalized)) return buildShortcut(normalized);
      // Invalid spec: silently fall through to next candidate.
   }
   return DISABLED_SHORTCUT;
}

type AskMode = "select" | "freeform" | "comment";

const ASK_OVERLAY_MAX_HEIGHT_RATIO = 0.85;
const ASK_OVERLAY_WIDTH: SizeValue = "92%";
const ASK_OVERLAY_MAX_HEIGHT: SizeValue = "85%";
const ASK_OVERLAY_MIN_WIDTH = 40;
const SINGLE_SELECT_SPLIT_PANE_MIN_WIDTH = 84;
const SINGLE_SELECT_SPLIT_PANE_LEFT_MIN_WIDTH = 32;
const SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH = 28;
const SINGLE_SELECT_SPLIT_PANE_SEPARATOR = " │ ";
const FREEFORM_SENTINEL = "\u270f\ufe0f Type custom response...";
const COMMENT_TOGGLE_LABEL = "Add extra context after selection";
const DEFAULT_OVERLAY_TOGGLE_KEY = "alt+o";
const DEFAULT_COMMENT_TOGGLE_KEY = "ctrl+g";

// Vim-style aliases for navigating option lists. ctrl+j/k are safe in the
// searchable single-select because they don't collide with fuzzy-search input.
const VIM_SELECT_UP_KEY = Key.ctrl("k");
const VIM_SELECT_DOWN_KEY = Key.ctrl("j");

function matchesSelectUp(data: string, keybindings: KeybindingsManager): boolean {
   return (
      keybindings.matches(data, "tui.select.up") ||
      matchesKey(data, Key.shift("tab")) ||
      matchesKey(data, VIM_SELECT_UP_KEY)
   );
}

function matchesSelectDown(data: string, keybindings: KeybindingsManager): boolean {
   return (
      keybindings.matches(data, "tui.select.down") ||
      matchesKey(data, Key.tab) ||
      matchesKey(data, VIM_SELECT_DOWN_KEY)
   );
}

function matchesSubmit(data: string, keybindings: KeybindingsManager): boolean {
   return keybindings.matches(data, "tui.select.confirm")
      || keybindings.matches(data, "tui.input.submit")
      || matchesKey(data, Key.enter)
      || matchesKey(data, Key.return);
}

function buildCustomUIOptions(
   displayMode: AskDisplayMode,
   onHandle?: (handle: OverlayHandle) => void,
) {
   switch (displayMode) {
      case "inline":
         return undefined;
      case "overlay":
         return {
            overlay: true,
            overlayOptions: {
               anchor: "center" as const,
               width: ASK_OVERLAY_WIDTH,
               minWidth: ASK_OVERLAY_MIN_WIDTH,
               maxHeight: ASK_OVERLAY_MAX_HEIGHT,
               margin: 1,
            },
            ...(onHandle ? { onHandle } : {}),
         };
      default: {
         const _exhaustive: never = displayMode;
         void _exhaustive;
         return {
            overlay: true,
            overlayOptions: {
               anchor: "center" as const,
               width: ASK_OVERLAY_WIDTH,
               minWidth: ASK_OVERLAY_MIN_WIDTH,
               maxHeight: ASK_OVERLAY_MAX_HEIGHT,
               margin: 1,
            },
            ...(onHandle ? { onHandle } : {}),
         };
      }
   }
}

class MultiSelectList implements Component {
   private options: QuestionOption[];
   private allowFreeform: boolean;
   private allowComment: boolean;
   private theme: Theme;
   private keybindings: KeybindingsManager;
   private commentToggle: ResolvedShortcut;
   private selectedIndex = 0;
   private checked = new Set<number>();
   private commentEnabled = false;
   private cachedWidth?: number;
   private cachedLines?: string[];

   public onCancel?: () => void;
   public onSubmit?: (result: string[]) => void;
   public onEnterFreeform?: () => void;

   constructor(
      options: QuestionOption[],
      allowFreeform: boolean,
      allowComment: boolean,
      theme: Theme,
      keybindings: KeybindingsManager,
      commentToggle: ResolvedShortcut,
   ) {
      this.options = options;
      this.allowFreeform = allowFreeform;
      this.allowComment = allowComment;
      this.theme = theme;
      this.keybindings = keybindings;
      this.commentToggle = commentToggle;
   }

   public isCommentEnabled(): boolean {
      return this.commentEnabled;
   }

   invalidate(): void {
      this.cachedWidth = undefined;
      this.cachedLines = undefined;
   }

   private getItemCount(): number {
      return this.options.length + (this.allowComment ? 1 : 0) + (this.allowFreeform ? 1 : 0);
   }

   private getCommentToggleIndex(): number | null {
      return this.allowComment ? this.options.length : null;
   }

   private getFreeformIndex(): number {
      return this.options.length + (this.allowComment ? 1 : 0);
   }

   private isCommentToggleRow(index: number): boolean {
      const toggleIndex = this.getCommentToggleIndex();
      return toggleIndex !== null && index === toggleIndex;
   }

   private isFreeformRow(index: number): boolean {
      return this.allowFreeform && index === this.getFreeformIndex();
   }

   private toggle(index: number): void {
      if (index < 0 || index >= this.options.length) return;
      if (this.checked.has(index)) this.checked.delete(index);
      else this.checked.add(index);
   }

   private toggleComment(): void {
      if (!this.allowComment) return;
      this.commentEnabled = !this.commentEnabled;
      this.invalidate();
   }

   handleInput(data: string): void {
      if (this.keybindings.matches(data, "tui.select.cancel")) {
         this.onCancel?.();
         return;
      }

      const count = this.getItemCount();
      if (count === 0) {
         this.onCancel?.();
         return;
      }

      if (this.allowComment && !this.commentToggle.disabled && this.commentToggle.matches(data)) {
         this.toggleComment();
         return;
      }

      if (matchesSelectUp(data, this.keybindings)) {
         this.selectedIndex = this.selectedIndex === 0 ? count - 1 : this.selectedIndex - 1;
         this.invalidate();
         return;
      }

      if (matchesSelectDown(data, this.keybindings)) {
         this.selectedIndex = this.selectedIndex === count - 1 ? 0 : this.selectedIndex + 1;
         this.invalidate();
         return;
      }

      const numMatch = data.match(/^[1-9]$/);
      if (numMatch) {
         const idx = Number.parseInt(numMatch[0], 10) - 1;
         if (idx >= 0 && idx < this.options.length) {
            this.toggle(idx);
            this.selectedIndex = Math.min(idx, count - 1);
            this.invalidate();
         }
         return;
      }

      if (matchesKey(data, Key.space)) {
         if (this.isCommentToggleRow(this.selectedIndex)) {
            this.toggleComment();
            return;
         }
         if (this.isFreeformRow(this.selectedIndex)) {
            this.onEnterFreeform?.();
            return;
         }
         this.toggle(this.selectedIndex);
         this.invalidate();
         return;
      }

      if (this.keybindings.matches(data, "tui.select.confirm")) {
         if (this.isCommentToggleRow(this.selectedIndex)) {
            this.toggleComment();
            return;
         }
         if (this.isFreeformRow(this.selectedIndex)) {
            this.onEnterFreeform?.();
            return;
         }

         const selectedTitles = Array.from(this.checked)
            .sort((a, b) => a - b)
            .map((i) => this.options[i]?.title)
            .filter((t): t is string => !!t);

         const fallback = this.options[this.selectedIndex]?.title;
         const result = selectedTitles.length > 0 ? selectedTitles : fallback ? [fallback] : [];

         if (result.length > 0) this.onSubmit?.(result);
         else this.onCancel?.();
      }
   }

   render(width: number): string[] {
      if (this.cachedLines && this.cachedWidth === width) {
         return this.cachedLines;
      }

      const theme = this.theme;
      const count = this.getItemCount();
      const maxVisible = Math.min(count, 10);

      if (count === 0) {
         this.cachedLines = [theme.fg("warning", "No options")];
         this.cachedWidth = width;
         return this.cachedLines;
      }

      const startIndex = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), count - maxVisible));
      const endIndex = Math.min(startIndex + maxVisible, count);

      const lines: string[] = [];

      for (let i = startIndex; i < endIndex; i++) {
         const isSelected = i === this.selectedIndex;
         const prefix = isSelected ? theme.fg("accent", "→") : " ";

         if (this.isCommentToggleRow(i)) {
            const checkbox = this.commentEnabled ? theme.fg("success", "[✓]") : theme.fg("dim", "[ ]");
            const label = isSelected
               ? theme.fg("accent", theme.bold(COMMENT_TOGGLE_LABEL))
               : theme.fg("text", theme.bold(COMMENT_TOGGLE_LABEL));
            lines.push(truncateToWidth(`${prefix}   ${checkbox} ${label}`, width, ""));
            continue;
         }

         if (this.isFreeformRow(i)) {
            const label = theme.fg("text", theme.bold("Type something."));
            const desc = theme.fg("muted", "Enter a custom response");
            const line = `${prefix}   ${label} ${theme.fg("dim", "—")} ${desc}`;
            lines.push(truncateToWidth(line, width, ""));
            continue;
         }

         const option = this.options[i];
         if (!option) continue;

         const checkbox = this.checked.has(i) ? theme.fg("success", "[✓]") : theme.fg("dim", "[ ]");
         const num = theme.fg("dim", `${i + 1}.`);
         const title = isSelected
            ? theme.fg("accent", theme.bold(option.title))
            : theme.fg("text", theme.bold(option.title));

         const firstLine = `${prefix} ${num} ${checkbox} ${title}`;
         lines.push(truncateToWidth(firstLine, width, ""));

         if (option.description) {
            const indent = "      ";
            const wrapWidth = Math.max(10, width - indent.length);
            const wrapped = wrapTextWithAnsi(option.description, wrapWidth);
            for (const w of wrapped) {
               lines.push(truncateToWidth(indent + theme.fg("muted", w), width, ""));
            }
         }
      }

      if (startIndex > 0 || endIndex < count) {
         lines.push(theme.fg("dim", truncateToWidth(`  (${this.selectedIndex + 1}/${count})`, width, "")));
      }

      this.cachedWidth = width;
      this.cachedLines = lines;
      return lines;
   }
}

class WrappedSingleSelectList implements Component {
   private options: QuestionOption[];
   private allowFreeform: boolean;
   private allowComment: boolean;
   private theme: Theme;
   private keybindings: KeybindingsManager;
   private commentToggle: ResolvedShortcut;
   private selectedIndex = 0;
   private searchQuery = "";
   private commentEnabled = false;
   private maxVisibleRows = 12;
   private cachedWidth?: number;
   private cachedLines?: string[];

   public onCancel?: () => void;
   public onSubmit?: (result: string) => void;
   public onEnterFreeform?: () => void;

   constructor(
      options: QuestionOption[],
      allowFreeform: boolean,
      allowComment: boolean,
      theme: Theme,
      keybindings: KeybindingsManager,
      commentToggle: ResolvedShortcut,
   ) {
      this.options = options;
      this.allowFreeform = allowFreeform;
      this.allowComment = allowComment;
      this.theme = theme;
      this.keybindings = keybindings;
      this.commentToggle = commentToggle;
   }

   public isCommentEnabled(): boolean {
      return this.commentEnabled;
   }

   setMaxVisibleRows(rows: number): void {
      const next = Math.max(1, Math.floor(rows));
      if (next !== this.maxVisibleRows) {
         this.maxVisibleRows = next;
         this.invalidate();
      }
   }

   invalidate(): void {
      this.cachedWidth = undefined;
      this.cachedLines = undefined;
   }

   private getFilteredOptions(): QuestionOption[] {
      return fuzzyFilter(this.options, this.searchQuery, (option) => `${option.title} ${option.description ?? ""}`);
   }

   private getItemCount(filteredOptions: QuestionOption[]): number {
      return filteredOptions.length + (this.allowComment ? 1 : 0) + (this.allowFreeform ? 1 : 0);
   }

   private isCommentToggleRow(index: number, filteredOptions: QuestionOption[]): boolean {
      return this.allowComment && index === filteredOptions.length;
   }

   private isFreeformRow(index: number, filteredOptions: QuestionOption[]): boolean {
      return this.allowFreeform && index === filteredOptions.length + (this.allowComment ? 1 : 0);
   }

   private toggleComment(): void {
      if (!this.allowComment) return;
      this.commentEnabled = !this.commentEnabled;
      this.invalidate();
   }

   private setSearchQuery(query: string): void {
      this.searchQuery = query;
      this.selectedIndex = 0;
      this.invalidate();
   }

   private popSearchCharacter(): void {
      if (!this.searchQuery) return;
      const characters = [...this.searchQuery];
      characters.pop();
      this.setSearchQuery(characters.join(""));
   }

   private getPrintableInput(data: string): string | null {
      const kittyPrintable = decodeKittyPrintable(data);
      if (kittyPrintable !== undefined) return kittyPrintable;

      const characters = [...data];
      if (characters.length !== 1) return null;

      const [character] = characters;
      if (!character) return null;

      const code = character.charCodeAt(0);
      if (code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
         return null;
      }

      return character;
   }

   private styleListLine(line: string, width: number, isSelected: boolean): string {
      const trimmed = line.trim();

      if (trimmed.startsWith("(")) {
         return truncateToWidth(this.theme.fg("dim", line), width, "");
      }

      if (isSelected) {
         return truncateToWidth(this.theme.fg("accent", this.theme.bold(line)), width, "");
      }

      if (line.startsWith("      ")) {
         return truncateToWidth(this.theme.fg("muted", line), width, "");
      }

      if (line.startsWith("→")) {
         return truncateToWidth(this.theme.fg("accent", this.theme.bold(line)), width, "");
      }

      return truncateToWidth(this.theme.fg("text", line), width, "");
   }

   private getSplitPaneWidths(width: number): { left: number; right: number } | null {
      if (width < SINGLE_SELECT_SPLIT_PANE_MIN_WIDTH) return null;

      const availableWidth = width - SINGLE_SELECT_SPLIT_PANE_SEPARATOR.length;
      if (availableWidth < SINGLE_SELECT_SPLIT_PANE_LEFT_MIN_WIDTH + SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH) {
         return null;
      }

      const preferredLeftWidth = Math.floor(availableWidth * 0.42);
      const left = Math.max(
         SINGLE_SELECT_SPLIT_PANE_LEFT_MIN_WIDTH,
         Math.min(preferredLeftWidth, availableWidth - SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH),
      );
      const right = availableWidth - left;

      if (right < SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH) return null;
      return { left, right };
   }

   private buildListLines(width: number, filteredOptions: QuestionOption[], hideDescriptions = false): string[] {
      const lines: string[] = [];
      const count = this.getItemCount(filteredOptions);
      const searchValue = this.searchQuery ? this.theme.fg("text", this.searchQuery) : this.theme.fg("dim", "type to filter");
      lines.push(truncateToWidth(`${this.theme.fg("accent", "Filter:")} ${searchValue}`, width, ""));

      if (this.searchQuery && filteredOptions.length === 0) {
         lines.push(truncateToWidth(this.theme.fg("warning", "No matching options"), width, ""));
      }

      if (count === 0) {
         if (!this.searchQuery) {
            lines.push(truncateToWidth(this.theme.fg("warning", "No options"), width, ""));
         }
         return lines.slice(0, this.maxVisibleRows);
      }

      const maxRows = Math.max(1, this.maxVisibleRows - lines.length);
      const optionRows = renderSingleSelectRows({
         options: filteredOptions,
         selectedIndex: this.selectedIndex,
         width,
         allowFreeform: this.allowFreeform,
         allowComment: this.allowComment,
         commentEnabled: this.commentEnabled,
         maxRows,
         hideDescriptions,
      });
      const optionLines = optionRows.map((row) => this.styleListLine(row.line, width, row.selected));

      lines.push(...optionLines);
      return lines.slice(0, this.maxVisibleRows);
   }

   private buildPreviewLines(width: number, filteredOptions: QuestionOption[], maxLines: number): string[] {
      if (maxLines <= 0) return [];

      const mdTheme = safeMarkdownTheme();

      let md = "";

      if (this.isCommentToggleRow(this.selectedIndex, filteredOptions)) {
         md += "## Additional context\n\n";
         md += `Currently: **${this.commentEnabled ? "Enabled" : "Disabled"}**\n\n`;
         md += "Turn this on when the selected option needs extra explanation before the tool submits.\n";
      } else if (this.isFreeformRow(this.selectedIndex, filteredOptions)) {
         md += "## Custom response\n\n";
         md += "Open the editor to write **any** answer.\n\n";
         md += "*Use this when none of the listed options fit.*\n";
         if (this.searchQuery) {
            md += `\n> Current filter: \`${this.searchQuery}\`\n`;
         }
      } else {
         const selected = filteredOptions[this.selectedIndex];
         if (!selected) {
            md += "*No option selected*\n";
         } else {
            md += `## ${selected.title}\n\n`;
            if (selected.description?.trim()) {
               md += `${selected.description}\n`;
            } else {
               md += "*No additional details provided for this option.*\n";
            }
            md += `\n---\n\nPress \`Enter\` to select this option.\n`;
            if (this.searchQuery) {
               md += `\n> Filter: \`${this.searchQuery}\`\n`;
            }
         }
      }

      let lines: string[];
      if (mdTheme) {
         const mdComponent = new Markdown(md.trim(), 0, 0, mdTheme);
         lines = mdComponent.render(width);
      } else {
         lines = [];
         for (const line of wrapTextWithAnsi(md.trim(), Math.max(10, width))) {
            lines.push(truncateToWidth(line, width, ""));
         }
      }

      while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") {
         lines.pop();
      }

      if (lines.length <= maxLines) return lines;
      if (maxLines === 1) return [truncateToWidth(this.theme.fg("dim", "…"), width, "")];

      const visibleLines = lines.slice(0, maxLines - 1);
      visibleLines.push(truncateToWidth(this.theme.fg("dim", "…"), width, ""));
      return visibleLines;
   }

   handleInput(data: string): void {
      if (this.searchQuery && matchesKey(data, Key.escape)) {
         this.setSearchQuery("");
         return;
      }

      if (this.keybindings.matches(data, "tui.select.cancel")) {
         this.onCancel?.();
         return;
      }

      if (this.allowComment && !this.commentToggle.disabled && this.commentToggle.matches(data)) {
         this.toggleComment();
         return;
      }

      const filteredOptions = this.getFilteredOptions();
      const count = this.getItemCount(filteredOptions);

      if (matchesSelectUp(data, this.keybindings) && count > 0) {
         this.selectedIndex = this.selectedIndex === 0 ? count - 1 : this.selectedIndex - 1;
         this.invalidate();
         return;
      }

      if (matchesSelectDown(data, this.keybindings) && count > 0) {
         this.selectedIndex = this.selectedIndex === count - 1 ? 0 : this.selectedIndex + 1;
         this.invalidate();
         return;
      }

      const numMatch = data.match(/^[1-9]$/);
      if (numMatch && filteredOptions.length > 0) {
         const idx = Number.parseInt(numMatch[0], 10) - 1;
         if (idx >= 0 && idx < filteredOptions.length) {
            this.selectedIndex = idx;
            this.invalidate();
            return;
         }
      }

      if (matchesKey(data, Key.space) && count > 0 && this.isCommentToggleRow(this.selectedIndex, filteredOptions)) {
         this.toggleComment();
         return;
      }

      if (this.keybindings.matches(data, "tui.select.confirm") && count > 0) {
         if (this.isCommentToggleRow(this.selectedIndex, filteredOptions)) {
            this.toggleComment();
            return;
         }
         if (this.isFreeformRow(this.selectedIndex, filteredOptions)) {
            this.onEnterFreeform?.();
            return;
         }

         const result = filteredOptions[this.selectedIndex]?.title;
         if (result) this.onSubmit?.(result);
         else this.onCancel?.();
         return;
      }

      if (this.keybindings.matches(data, "tui.editor.deleteCharBackward") || matchesKey(data, Key.backspace)) {
         this.popSearchCharacter();
         return;
      }

      const printableInput = this.getPrintableInput(data);
      if (printableInput) {
         this.setSearchQuery(this.searchQuery + printableInput);
      }
   }

   render(width: number): string[] {
      if (this.cachedLines && this.cachedWidth === width) {
         return this.cachedLines;
      }

      const filteredOptions = this.getFilteredOptions();
      const count = this.getItemCount(filteredOptions);
      this.selectedIndex = count > 0 ? Math.max(0, Math.min(this.selectedIndex, count - 1)) : 0;

      const splitPane = this.getSplitPaneWidths(width);
      let lines: string[];

      if (!splitPane) {
         lines = this.buildListLines(width, filteredOptions);
      } else {
         const listLines = this.buildListLines(splitPane.left, filteredOptions, true);
         const previewLines = this.buildPreviewLines(splitPane.right, filteredOptions, this.maxVisibleRows);
         const rowCount = Math.min(this.maxVisibleRows, Math.max(listLines.length, previewLines.length));
         const separator = this.theme.fg("dim", SINGLE_SELECT_SPLIT_PANE_SEPARATOR);
         lines = Array.from({ length: rowCount }, (_, index) => {
            const left = truncateToWidth(listLines[index] ?? "", splitPane.left, "", true);
            const right = truncateToWidth(previewLines[index] ?? "", splitPane.right, "");
            return `${left}${separator}${right}`;
         });
      }

      this.cachedWidth = width;
      this.cachedLines = lines;
      return lines;
   }
}

/**
 * Interactive ask UI. Uses a root Container for layout and swaps the center
 * component between SelectList/MultiSelectList and an Editor (freeform mode).
 */
class AskComponent extends Container {
   private question: string;
   private context?: string;
   private options: QuestionOption[];
   private allowMultiple: boolean;
   private allowFreeform: boolean;
   private allowComment: boolean;
   private displayMode: AskDisplayMode;
   private tui: TUI;
   private theme: Theme;
   private keybindings: KeybindingsManager;
   private shortcuts: ResolvedAskShortcuts;
   private onDone: (result: AskUIResult | null) => void;

   private mode: AskMode = "select";
   private pendingSelections: string[] = [];
   private freeformDraft = "";
   private commentDraft = "";

   // Static layout components
   private titleText: Text;
   private questionText: Text;
   private contextComponent?: Component;
   private modeContainer: Container;
   private helpText: Text;

   // Mode components
   private singleSelectList?: WrappedSingleSelectList;
   private multiSelectList?: MultiSelectList;
   private editor?: Editor;

   // Focusable - propagate to Editor for IME cursor positioning
   private _focused = false;
   get focused(): boolean {
      return this._focused;
   }
   set focused(value: boolean) {
      this._focused = value;
      if (this.editor && (this.mode === "freeform" || this.mode === "comment")) {
         (this.editor as any).focused = value;
      }
   }

   constructor(
      question: string,
      context: string | undefined,
      options: QuestionOption[],
      allowMultiple: boolean,
      allowFreeform: boolean,
      allowComment: boolean,
      displayMode: AskDisplayMode,
      tui: TUI,
      theme: Theme,
      keybindings: KeybindingsManager,
      shortcuts: ResolvedAskShortcuts,
      onDone: (result: AskUIResult | null) => void,
   ) {
      super();

      this.question = question;
      this.context = context;
      this.options = options;
      this.allowMultiple = allowMultiple;
      this.allowFreeform = allowFreeform;
      this.allowComment = allowComment;
      this.displayMode = displayMode;
      this.tui = tui;
      this.theme = theme;
      this.keybindings = keybindings;
      this.shortcuts = shortcuts;
      this.onDone = onDone;

      // Layout skeleton
      this.addChild(new BoxBorderTop(
         (s: string) => theme.fg("accent", s),
         "ask_user",
         (s: string) => theme.fg("dim", theme.bold(s)),
      ));
      this.addChild(new Spacer(1));

      this.titleText = new Text("", 1, 0);
      this.addChild(this.titleText);
      this.addChild(new Spacer(1));

      this.questionText = new Text("", 1, 0);
      this.addChild(this.questionText);

      if (this.context) {
         this.addChild(new Spacer(1));
         const mdTheme = safeMarkdownTheme();
         if (mdTheme) {
            this.contextComponent = new Markdown("", 1, 0, mdTheme);
         } else {
            this.contextComponent = new Text("", 1, 0);
         }
         this.addChild(this.contextComponent);
      }

      this.addChild(new Spacer(1));

      this.modeContainer = new Container();
      this.addChild(this.modeContainer);

      this.addChild(new Spacer(1));
      this.helpText = new Text("", 1, 0);
      this.addChild(this.helpText);

      this.addChild(new Spacer(1));
      this.addChild(new BoxBorderBottom(
         (s: string) => theme.fg("accent", s),
         `v${ASK_USER_VERSION}`,
         (s: string) => theme.fg("dim", s),
      ));

      this.updateStaticText();
      this.showSelectMode();
   }

   override invalidate(): void {
      super.invalidate();
      this.updateStaticText();
      this.updateHelpText();
   }

   override render(width: number): string[] {
      const innerWidth = Math.max(1, width - BOX_BORDER_OVERHEAD);

      if (this.mode === "select" && !this.allowMultiple) {
         const overlayMaxHeight = Math.max(12, Math.floor(this.tui.terminal.rows * ASK_OVERLAY_MAX_HEIGHT_RATIO));
         const staticLines = this.countStaticLines(innerWidth);
         const availableOptionRows = Math.max(4, overlayMaxHeight - staticLines);
         this.ensureSingleSelectList().setMaxVisibleRows(availableOptionRows);
      }

      // Render children at the inner width (excluding side border characters)
      const rawLines = super.render(innerWidth);

      // First and last lines are the top/bottom box borders — pass through at full width.
      // All inner lines get wrapped with side borders.
      const borderColor = (s: string) => this.theme.fg("accent", s);
      const titleColor = (s: string) => this.theme.fg("dim", this.theme.bold(s));
      return rawLines.map((line, index) => {
         if (index === 0 || index === rawLines.length - 1) {
            // Box top/bottom borders already rendered at innerWidth — re-render at full width
            if (index === 0) return new BoxBorderTop(borderColor, "ask_user", titleColor).render(width)[0];
            return new BoxBorderBottom(borderColor, `v${ASK_USER_VERSION}`, (s: string) => this.theme.fg("dim", s)).render(width)[0];
         }
         const padded = truncateToWidth(line, innerWidth, "", true);
         return `${borderColor(BOX_BORDER_LEFT)}${padded}${borderColor(BOX_BORDER_RIGHT)}`;
      });
   }

   private countWrappedLines(text: string, width: number): number {
      return Math.max(1, wrapTextWithAnsi(text, Math.max(10, width - 2)).length);
   }

   private countStaticLines(width: number): number {
      const titleLines = 1;
      const questionLines = this.countWrappedLines(this.question, width);
      const contextLines = this.context ? 1 + this.countWrappedLines(this.context, width) : 0;
      const helpLines = 1;
      const borderLines = 2;
      const spacerLines = this.context ? 6 : 5;
      return borderLines + spacerLines + titleLines + questionLines + contextLines + helpLines;
   }

   private updateStaticText(): void {
      const theme = this.theme;
      const title = this.mode === "comment" ? "Optional comment" : "Question";
      this.titleText.setText(theme.fg("accent", theme.bold(title)));
      this.questionText.setText(theme.fg("text", theme.bold(this.question)));
      if (this.contextComponent && this.context) {
         if (this.contextComponent instanceof Markdown) {
            (this.contextComponent as Markdown).setText(
               `**Context:**\n${this.context}`,
            );
         } else {
            (this.contextComponent as Text).setText(
               `${theme.fg("accent", theme.bold("Context:"))}\n${theme.fg("dim", this.context)}`,
            );
         }
      }
   }

   private updateHelpText(): void {
      const theme = this.theme;
      const overlayHint = this.displayMode === "overlay" && !this.shortcuts.overlayToggle.disabled
         ? literalHint(theme, this.shortcuts.overlayToggle.spec, "hide")
         : null;
      const commentHint = this.allowComment && !this.shortcuts.commentToggle.disabled
         ? literalHint(theme, this.shortcuts.commentToggle.spec, "toggle context")
         : null;
      if (this.mode === "freeform" || this.mode === "comment") {
         const alternateCancelKeys = this.keybindings
            .getKeys("tui.select.cancel")
            .filter((key) => key !== "escape" && key !== "esc");
         const hints = [
            keybindingHint(theme, this.keybindings, "tui.input.submit", this.mode === "comment" ? "submit/skip" : "submit"),
            keybindingHint(theme, this.keybindings, "tui.input.newLine", "newline"),
            literalHint(theme, "esc", "back"),
            overlayHint,
            alternateCancelKeys.length > 0 ? literalHint(theme, formatKeyList(alternateCancelKeys), "cancel") : null,
         ]
            .filter((hint): hint is string => !!hint)
            .join(" • ");
         this.helpText.setText(theme.fg("dim", hints));
         return;
      }

      if (this.allowMultiple) {
         const hints = [
            literalHint(theme, "↑↓", "navigate"),
            literalHint(theme, "space", "toggle"),
            commentHint,
            overlayHint,
            keybindingHint(theme, this.keybindings, "tui.select.confirm", "submit"),
            keybindingHint(theme, this.keybindings, "tui.select.cancel", "cancel"),
         ]
            .filter((hint): hint is string => !!hint)
            .join(" • ");
         this.helpText.setText(theme.fg("dim", hints));
      } else {
         const alternateCancelKeys = this.keybindings
            .getKeys("tui.select.cancel")
            .filter((key) => key !== "escape" && key !== "esc");
         const hints = [
            literalHint(theme, "type", "filter"),
            keybindingHint(theme, this.keybindings, "tui.editor.deleteCharBackward", "erase"),
            literalHint(theme, "↑↓", "navigate"),
            commentHint,
            overlayHint,
            keybindingHint(theme, this.keybindings, "tui.select.confirm", "select"),
            literalHint(theme, "esc", "clear/cancel"),
            alternateCancelKeys.length > 0
               ? literalHint(theme, formatKeyList(alternateCancelKeys), "cancel")
               : null,
         ]
            .filter((hint): hint is string => !!hint)
            .join(" • ");
         this.helpText.setText(theme.fg("dim", hints));
      }
   }

   private ensureSingleSelectList(): WrappedSingleSelectList {
      if (this.singleSelectList) return this.singleSelectList;

      const list = new WrappedSingleSelectList(
         this.options,
         this.allowFreeform,
         this.allowComment,
         this.theme,
         this.keybindings,
         this.shortcuts.commentToggle,
      );
      list.onSubmit = (result) => this.handleSelectionSubmit([result], list.isCommentEnabled());
      list.onCancel = () => this.onDone(null);
      list.onEnterFreeform = () => this.showFreeformMode();

      this.singleSelectList = list;
      return list;
   }

   private ensureMultiSelectList(): MultiSelectList {
      if (this.multiSelectList) return this.multiSelectList;

      const list = new MultiSelectList(
         this.options,
         this.allowFreeform,
         this.allowComment,
         this.theme,
         this.keybindings,
         this.shortcuts.commentToggle,
      );
      list.onCancel = () => this.onDone(null);
      list.onSubmit = (result) => this.handleSelectionSubmit(result, list.isCommentEnabled());
      list.onEnterFreeform = () => this.showFreeformMode();

      this.multiSelectList = list;
      return list;
   }

   private ensureEditor(): Editor {
      if (this.editor) return this.editor;
      const editor = new Editor(this.tui, createEditorTheme(this.theme));
      editor.disableSubmit = false;
      editor.onSubmit = (text: string) => {
         this.handleEditorSubmit(text);
      };
      this.editor = editor;
      return editor;
   }

   private saveEditorDraft(): void {
      if (!this.editor) return;
      const getText = (this.editor as any).getText;
      if (typeof getText !== "function") return;

      const currentText = String(getText.call(this.editor) ?? "");
      if (this.mode === "freeform") {
         this.freeformDraft = currentText;
      } else if (this.mode === "comment") {
         this.commentDraft = currentText;
      }
   }

   private setEditorText(text: string): void {
      const editor = this.ensureEditor();
      const setText = (editor as any).setText;
      if (typeof setText === "function") {
         setText.call(editor, text);
      }
   }

   private handleSelectionSubmit(selections: string[], wantsComment: boolean): void {
      if (this.allowComment && wantsComment) {
         this.pendingSelections = selections;
         this.commentDraft = "";
         this.showCommentMode();
         return;
      }

      this.onDone(createSelectionResponse(selections));
   }

   private handleEditorSubmit(text: string): void {
      if (this.mode === "freeform") {
         this.onDone(createFreeformResponse(text));
         return;
      }

      if (this.mode === "comment") {
         this.commentDraft = text;
         this.onDone(createSelectionResponse(this.pendingSelections, text));
      }
   }

   private showSelectMode(): void {
      if (this.mode === "freeform" || this.mode === "comment") {
         this.saveEditorDraft();
      }

      this.mode = "select";
      this.pendingSelections = [];
      this.modeContainer.clear();

      if (this.allowMultiple) {
         this.modeContainer.addChild(this.ensureMultiSelectList());
      } else {
         this.modeContainer.addChild(this.ensureSingleSelectList());
      }

      this.updateHelpText();
      this.invalidate();
      this.tui.requestRender();
   }

   private showFreeformMode(): void {
      if (this.mode === "comment") {
         this.saveEditorDraft();
      }

      this.mode = "freeform";
      this.modeContainer.clear();

      const editor = this.ensureEditor();
      this.setEditorText(this.freeformDraft);
      (editor as any).focused = this._focused;

      this.modeContainer.addChild(new Text(this.theme.fg("accent", this.theme.bold("Custom response")), 1, 0));
      this.modeContainer.addChild(new Spacer(1));
      this.modeContainer.addChild(editor);

      this.updateHelpText();
      this.invalidate();
      this.tui.requestRender();
   }

   private showCommentMode(): void {
      if (this.mode === "freeform") {
         this.saveEditorDraft();
      }

      this.mode = "comment";
      this.modeContainer.clear();

      const editor = this.ensureEditor();
      this.setEditorText(this.commentDraft);
      (editor as any).focused = this._focused;

      const selectedLabel = this.pendingSelections.length === 1 ? "Selected option:" : "Selected options:";
      this.modeContainer.addChild(new Text(this.theme.fg("accent", this.theme.bold(selectedLabel)), 1, 0));
      this.modeContainer.addChild(new Text(this.theme.fg("text", this.pendingSelections.join(", ")), 1, 0));
      this.modeContainer.addChild(new Spacer(1));
      this.modeContainer.addChild(editor);

      this.updateHelpText();
      this.invalidate();
      this.tui.requestRender();
   }

   handleInput(data: string): void {
      if (this.mode === "freeform" || this.mode === "comment") {
         if (matchesKey(data, Key.escape)) {
            this.showSelectMode();
            return;
         }

         if (this.keybindings.matches(data, "tui.select.cancel")) {
            this.onDone(null);
            return;
         }

         this.ensureEditor().handleInput(data);
         this.tui.requestRender();
         return;
      }

      if (this.allowMultiple) {
         this.ensureMultiSelectList().handleInput?.(data);
         this.tui.requestRender();
         return;
      }

      this.ensureSingleSelectList().handleInput?.(data);
      this.tui.requestRender();
   }

   public isTextInputMode(): boolean {
      return this.mode === "freeform" || this.mode === "comment";
   }
}

class WizardAskComponent implements Component {
   private questions: NormalizedAskQuestion[];
   private displayMode: AskDisplayMode;
   private tui: TUI;
   private theme: Theme;
   private keybindings: KeybindingsManager;
   private shortcuts: ResolvedAskShortcuts;
   private onDone: (result: AskWizardResponse | null) => void;
   private currentIndex = 0;
   private responses: Record<string, AskResponse> = {};
   private currentQuestionComponent?: AskComponent;
   private cachedWidth?: number;
   private cachedSubmitLines?: string[];
   private _focused = false;

   get focused(): boolean {
      return this._focused;
   }

   set focused(value: boolean) {
      this._focused = value;
      if (this.currentQuestionComponent) {
         (this.currentQuestionComponent as any).focused = value;
      }
   }

   constructor(
      questions: NormalizedAskQuestion[],
      displayMode: AskDisplayMode,
      tui: TUI,
      theme: Theme,
      keybindings: KeybindingsManager,
      shortcuts: ResolvedAskShortcuts,
      onDone: (result: AskWizardResponse | null) => void,
   ) {
      this.questions = questions;
      this.displayMode = displayMode;
      this.tui = tui;
      this.theme = theme;
      this.keybindings = keybindings;
      this.shortcuts = shortcuts;
      this.onDone = onDone;
      this.ensureQuestionComponent();
   }

   invalidate(): void {
      this.currentQuestionComponent?.invalidate();
      this.cachedWidth = undefined;
      this.cachedSubmitLines = undefined;
   }

   handleInput(data: string): void {
      if (this.currentIndex === this.questions.length) {
         this.handleSubmitInput(data);
         return;
      }

      const child = this.ensureQuestionComponent();
      if (!child.isTextInputMode() && this.handleNavigationInput(data)) {
         return;
      }

      child.handleInput(data);
   }

   render(width: number): string[] {
      const body = this.currentIndex === this.questions.length
         ? this.renderSubmit(width)
         : this.ensureQuestionComponent().render(width);
      return this.renderWithNavigationInsideBox(body, width);
   }

   private ensureQuestionComponent(): AskComponent {
      const question = this.questions[Math.min(this.currentIndex, this.questions.length - 1)];
      if (this.currentQuestionComponent) return this.currentQuestionComponent;

      const component = new AskComponent(
         question.question,
         question.context,
         question.options,
         question.allowMultiple,
         question.allowFreeform,
         question.allowComment,
         this.displayMode,
         this.tui,
         this.theme,
         this.keybindings,
         this.shortcuts,
         (result) => this.handleQuestionResult(question, result),
      );
      (component as any).focused = this._focused;
      this.currentQuestionComponent = component;
      return component;
   }

   private handleQuestionResult(question: NormalizedAskQuestion, result: AskUIResult | null): void {
      if (result === null) {
         this.onDone(null);
         return;
      }
      if (isWizardResponse(result)) {
         return;
      }

      this.responses[question.question] = result;
      if (this.currentIndex < this.questions.length - 1) {
         this.currentIndex += 1;
      } else {
         this.currentIndex = this.questions.length;
      }
      this.currentQuestionComponent = undefined;
      this.invalidate();
      this.tui.requestRender();
   }

   private handleSubmitInput(data: string): void {
      if (this.handleNavigationInput(data)) return;

      if (matchesSubmit(data, this.keybindings)) {
         this.onDone(createWizardResponse(this.questions, { ...this.responses }));
         return;
      }

      if (this.keybindings.matches(data, "tui.select.cancel")) {
         this.onDone(null);
      }
   }

   private handleNavigationInput(data: string): boolean {
      if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
         this.goToIndex((this.currentIndex + 1) % (this.questions.length + 1));
         return true;
      }
      if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
         this.goToIndex((this.currentIndex - 1 + this.questions.length + 1) % (this.questions.length + 1));
         return true;
      }
      return false;
   }

   private goToIndex(index: number): void {
      this.currentIndex = index;
      this.currentQuestionComponent = undefined;
      this.invalidate();
      this.tui.requestRender();
   }

   private hasAnyAnswer(): boolean {
      return this.questions.some((question) => !!this.responses[question.question]);
   }

   private renderNavigationLine(width: number): string {
      const parts = [this.theme.fg("dim", "←")];
      for (let index = 0; index < this.questions.length; index += 1) {
         const question = this.questions[index];
         const answered = !!this.responses[question.question];
         const marker = answered ? "✓" : "□";
         const label = `${marker} ${question.header}`;
         parts.push(index === this.currentIndex
            ? this.theme.fg("accent", `[${label}]`)
            : this.theme.fg(answered ? "success" : "muted", label)
         );
      }
      const submitLabel = `${this.hasAnyAnswer() ? "✓" : "□"} Submit`;
      parts.push(this.currentIndex === this.questions.length
         ? this.theme.fg("accent", `[${submitLabel}]`)
         : this.theme.fg(this.hasAnyAnswer() ? "success" : "muted", submitLabel)
      );
      parts.push(this.theme.fg("dim", "→"));
      return truncateToWidth(parts.join(" "), width, "", true);
   }

   private renderWithNavigationInsideBox(lines: string[], width: number): string[] {
      if (lines.length < 2) return lines;

      const borderColor = (s: string) => this.theme.fg("accent", s);
      const innerWidth = Math.max(1, width - BOX_BORDER_OVERHEAD);
      const nav = `${borderColor(BOX_BORDER_LEFT)}${this.renderNavigationLine(innerWidth)}${borderColor(BOX_BORDER_RIGHT)}`;
      const spacer = `${borderColor(BOX_BORDER_LEFT)}${truncateToWidth("", innerWidth, "", true)}${borderColor(BOX_BORDER_RIGHT)}`;
      return [lines[0], nav, spacer, ...lines.slice(1)];
   }

   private renderSubmit(width: number): string[] {
      if (this.cachedSubmitLines && this.cachedWidth === width) {
         return this.cachedSubmitLines;
      }

      const borderColor = (s: string) => this.theme.fg("accent", s);
      const innerWidth = Math.max(1, width - BOX_BORDER_OVERHEAD);
      const body: string[] = [
         this.theme.fg("accent", this.theme.bold("Review answers")),
         "",
      ];

      for (const question of this.questions) {
         const response = this.responses[question.question];
         const answer = response ? formatResponseSummary(response) : this.theme.fg("muted", "Skipped");
         body.push(`${this.theme.fg("muted", question.header + ":")} ${this.theme.fg("text", question.question)}`);
         body.push(`  ${answer}`);
      }

      body.push("");
      body.push(this.theme.fg("dim", "Enter submit • unanswered questions are skipped • Tab/←→ navigate • Esc cancel"));

      const lines = [new BoxBorderTop(borderColor, "ask_user", (s: string) => this.theme.fg("dim", this.theme.bold(s))).render(width)[0]];
      for (const line of body) {
         lines.push(`${borderColor(BOX_BORDER_LEFT)}${truncateToWidth(line, innerWidth, "", true)}${borderColor(BOX_BORDER_RIGHT)}`);
      }
      lines.push(new BoxBorderBottom(borderColor, `v${ASK_USER_VERSION}`, (s: string) => this.theme.fg("dim", s)).render(width)[0]);

      this.cachedWidth = width;
      this.cachedSubmitLines = lines;
      return lines;
   }
}

/**
 * RPC/headless fallback: use dialog methods (select/input) instead of the rich TUI overlay.
 * ctx.ui.custom() returns undefined in RPC mode, so we degrade gracefully.
 */
async function askViaDialogs(
   ui: { select: Function; input: Function },
   question: string,
   context: string | undefined,
   options: QuestionOption[],
   allowMultiple: boolean,
   allowFreeform: boolean,
   allowComment: boolean,
   timeout?: number,
): Promise<AskResponse | null> {
   const dialogOpts = timeout ? { timeout } : undefined;
   const prompt = context ? `${question}\n\nContext:\n${context}` : question;

   if (allowMultiple) {
      const optionList = formatOptionsForMessage(options);
      const rawSelections = await ui.input(
         `${prompt}\n\nOptions (select one or more):\n${optionList}`,
         "Type your selection(s)...",
         dialogOpts,
      ) as string | undefined;
      if (isCancelledInput(rawSelections)) return null;

      const selections = parseDialogSelections(rawSelections);
      if (selections.length === 0) return null;

      if (!allowComment) {
         return createSelectionResponse(selections);
      }

      const comment = await ui.input(
         buildCommentPrompt(prompt, selections),
         "Optional comment (press Enter to skip)...",
         dialogOpts,
      ) as string | undefined;
      return createSelectionResponse(selections, comment);
   }

   const selectOptions = options.map((o) => o.title);
   if (allowFreeform) selectOptions.push(FREEFORM_SENTINEL);

   const selected = await ui.select(prompt, selectOptions, dialogOpts) as string | undefined;
   if (isCancelledInput(selected)) return null;

   if (selected === FREEFORM_SENTINEL) {
      const answer = await ui.input(prompt, "Type your answer...", dialogOpts) as string | undefined;
      if (isCancelledInput(answer)) return null;
      return createFreeformResponse(answer);
   }

   if (!allowComment) {
      return createSelectionResponse([selected]);
   }

   const comment = await ui.input(
      buildCommentPrompt(prompt, [selected]),
      "Optional comment (press Enter to skip)...",
      dialogOpts,
   ) as string | undefined;
   return createSelectionResponse([selected], comment);
}

async function askQuestionsViaDialogs(
   ui: { select: Function; input: Function },
   questions: NormalizedAskQuestion[],
   timeout?: number,
): Promise<AskWizardResponse | null> {
   const responses: Record<string, AskResponse | null> = {};

   for (const question of questions) {
      const response = await askViaDialogs(
         ui,
         question.question,
         question.context,
         question.options,
         question.allowMultiple,
         question.allowFreeform,
         question.allowComment,
         timeout,
      );
      responses[question.question] = response;
   }

   if (!Object.values(responses).some(Boolean)) return null;
   return createWizardResponse(questions, responses);
}

export default function(pi: ExtensionAPI) {
   pi.registerTool({
      name: "ask_user",
      label: "Ask User",
      description:
         "Ask the user one question or a short wizard of up to four related questions with optional multiple-choice answers. Use this to gather information interactively. Before calling, gather context with tools (read/web/ref) and pass a short summary via the context field.",
      promptSnippet:
         "Ask the user focused questions with optional multiple-choice answers to gather information interactively",
      promptGuidelines: [
         "Before calling ask_user, gather context with tools (read/web/ref) and pass a short summary via the context field.",
         "Use ask_user when the user's intent is ambiguous, when a decision requires explicit user input, or when multiple valid options exist.",
         `Ask one focused question by default; use questions[] only for related clarification batches with at most ${MAX_WIZARD_QUESTIONS} questions.`,
         "Keep each questions[] item focused and independent; do not combine unrelated or multipart prompts into one question.",
      ],
      // Block other tool calls in the same assistant turn until the user answers,
      // so the model can't batch ask_user with bash/edit/write and let those run
      // (potentially with side effects) before the user sees the prompt.
      executionMode: "sequential",
      parameters: Type.Object({
         question: Type.Optional(Type.String({ description: "The question to ask the user. Use this for single-question calls." })),
         header: Type.Optional(
            Type.String({ description: "Short label for this question in wizard navigation, e.g. 'Scope' or 'Library'." }),
         ),
         context: Type.Optional(
            Type.String({
               description: "Relevant context to show before the question (summary of findings)",
            }),
         ),
         options: Type.Optional(
            Type.Array(
               Type.Union([
                  Type.String({ description: "Short title for this option" }),
                  Type.Object({
                     title: Type.String({ description: "Short title for this option" }),
                     description: Type.Optional(
                        Type.String({ description: "Longer description explaining this option" }),
                     ),
                  }),
               ]),
               { description: "List of options for the user to choose from" },
            ),
         ),
         allowMultiple: Type.Optional(
            Type.Boolean({ description: "Allow selecting multiple options. Default: false" }),
         ),
         allowFreeform: Type.Optional(
            Type.Boolean({ description: "Add a freeform text option. Default: true" }),
         ),
         allowComment: Type.Optional(
            Type.Boolean({ description: "Collect an optional comment after selecting one or more options. Default: false" }),
         ),
         questions: Type.Optional(
            Type.Array(
               Type.Object({
                  question: Type.String({ description: "The focused question to ask the user" }),
                  header: Type.Optional(
                     Type.String({ description: "Short label for this question in wizard navigation" }),
                  ),
                  context: Type.Optional(
                     Type.String({ description: "Relevant context to show before this question" }),
                  ),
                  options: Type.Optional(
                     Type.Array(
                        Type.Union([
                           Type.String({ description: "Short title for this option" }),
                           Type.Object({
                              title: Type.String({ description: "Short title for this option" }),
                              description: Type.Optional(
                                 Type.String({ description: "Longer description explaining this option" }),
                              ),
                           }),
                        ]),
                        { description: "List of options for the user to choose from" },
                     ),
                  ),
                  allowMultiple: Type.Optional(
                     Type.Boolean({ description: "Allow selecting multiple options for this question. Default: false" }),
                  ),
                  allowFreeform: Type.Optional(
                     Type.Boolean({ description: "Add a freeform text option for this question. Default: true" }),
                  ),
                  allowComment: Type.Optional(
                     Type.Boolean({ description: "Collect an optional comment for this question. Default: false" }),
                  ),
               }),
               {
                  minItems: 1,
                  maxItems: MAX_WIZARD_QUESTIONS,
                  description: `Related questions to ask as a wizard. Limit ${MAX_WIZARD_QUESTIONS}. Omit for a single-question call.`,
               },
            ),
         ),
         displayMode: Type.Optional(
            StringEnum(["overlay", "inline"] as const, {
               description: "UI rendering mode. 'overlay' shows a centered modal, 'inline' renders in-place. Default: PI_ASK_USER_DISPLAY_MODE env var if set, otherwise 'overlay'. Omit to respect the user's configured preference.",
            }),
         ),
         overlayToggleKey: Type.Optional(
            Type.String({
               description:
                  "Shortcut for hiding/showing the overlay popup (overlay mode only), e.g. 'alt+o' or 'ctrl+shift+h'. Pass 'off' to disable. Default: PI_ASK_USER_OVERLAY_TOGGLE_KEY env var if set, otherwise 'alt+o'.",
            }),
         ),
         commentToggleKey: Type.Optional(
            Type.String({
               description:
                  "Shortcut for toggling the optional comment/extra-context row when allowComment is true, e.g. 'ctrl+g'. Pass 'off' to disable. Default: PI_ASK_USER_COMMENT_TOGGLE_KEY env var if set, otherwise 'ctrl+g'.",
            }),
         ),
         timeout: Type.Optional(
            Type.Number({ description: "Auto-dismiss after N milliseconds. Returns null (cancelled) when expired." }),
         ),
      }),

      async execute(_toolCallId, params, signal, onUpdate, ctx) {
         const rawParams = params as AskParams;
         if (signal?.aborted) {
            return {
               content: [{ type: "text", text: "Cancelled" }],
               details: { question: rawParams.question ?? "", options: [], response: null, cancelled: true } as AskToolDetails,
            };
         }

         const normalized = normalizeAskQuestions(rawParams);
         if ("error" in normalized) {
            return {
               content: [{ type: "text", text: normalized.error }],
               isError: true,
               details: { error: normalized.error },
            };
         }

         const questions = normalized.questions;
         const isWizard = questions.length > 1;
         const activeQuestion = questions[0];
         const {
            displayMode,
            overlayToggleKey,
            commentToggleKey,
            timeout,
         } = rawParams;
         const envMode = process.env.PI_ASK_USER_DISPLAY_MODE;
         const envDisplayMode: AskDisplayMode | undefined =
            envMode === "overlay" || envMode === "inline" ? envMode : undefined;
         const effectiveDisplayMode: AskDisplayMode = displayMode ?? envDisplayMode ?? "overlay";
         const shortcuts: ResolvedAskShortcuts = {
            overlayToggle: resolveShortcut(
               overlayToggleKey,
               process.env.PI_ASK_USER_OVERLAY_TOGGLE_KEY,
               DEFAULT_OVERLAY_TOGGLE_KEY,
            ),
            commentToggle: resolveShortcut(
               commentToggleKey,
               process.env.PI_ASK_USER_COMMENT_TOGGLE_KEY,
               DEFAULT_COMMENT_TOGGLE_KEY,
            ),
         };
         const {
            question,
            context: normalizedContext,
            options,
            allowMultiple,
            allowFreeform,
            allowComment,
         } = activeQuestion;

         if (!ctx.hasUI || !ctx.ui) {
            const details = isWizard
               ? {
                  questions: questions.map(questionToDetails),
                  responses: Object.fromEntries(questions.map((question) => [question.question, null])),
                  cancelled: true,
               } as AskToolDetails
               : { question, context: normalizedContext, options, response: null, cancelled: true } as AskToolDetails;
            return {
               content: [
                  {
                     type: "text",
                     text: `Ask requires interactive mode. Please answer:\n\n${formatQuestionsPrompt(questions)}`,
                  },
               ],
               isError: true,
               details,
            };
         }

         if (!isWizard && options.length === 0) {
            const prompt = normalizedContext ? `${question}\n\nContext:\n${normalizedContext}` : question;
            const answer = await ctx.ui.input(prompt, "Type your answer...", timeout ? { timeout } : undefined);
            const response = createFreeformResponse(answer);

            if (!response) {
               return {
                  content: [{ type: "text", text: "User cancelled the question" }],
                  details: { question, context: normalizedContext, options, response: null, cancelled: true } as AskToolDetails,
               };
            }

            pi.events.emit("ask:answered", { question, context: normalizedContext, response });
            return {
               content: [{ type: "text", text: `User answered: ${formatResponseSummary(response)}` }],
               details: { question, context: normalizedContext, options, response, cancelled: false } as AskToolDetails,
            };
         }

         onUpdate?.({
            content: [{ type: "text", text: "Waiting for user input..." }],
            details: isWizard
               ? {
                  questions: questions.map(questionToDetails),
                  responses: Object.fromEntries(questions.map((question) => [question.question, null])),
                  cancelled: false,
               }
               : { question, context: normalizedContext, options, response: null, cancelled: false },
         });

         let result: AskUIResult | null;
         let overlayHandle: OverlayHandle | undefined;
         let removeOverlayInputListener: (() => void) | undefined;
         let hasAnnouncedHide = false;
         try {
            const customFactory = (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: AskUIResult | null) => void) => {
               if (signal) {
                  const onAbort = () => done(null);
                  signal.addEventListener("abort", onAbort, { once: true });
               }

               if (timeout && timeout > 0) {
                  setTimeout(() => done(null), timeout);
               }

               if (isWizard) {
                  return new WizardAskComponent(
                     questions,
                     effectiveDisplayMode,
                     tui,
                     theme,
                     keybindings,
                     shortcuts,
                     done,
                  );
               }

               return new AskComponent(
                  question,
                  normalizedContext,
                  options,
                  allowMultiple,
                  allowFreeform,
                  allowComment,
                  effectiveDisplayMode,
                  tui,
                  theme,
                  keybindings,
                  shortcuts,
                  done,
               );
            };

            // Register a raw terminal input listener for the overlay-toggle key so the
            // overlay can be toggled even while it is hidden (hidden overlays do not
            // receive input). Inline mode does not need this because the prompt is
            // already non-modal. Skipped entirely if the user disabled the shortcut.
            const overlayToggle = shortcuts.overlayToggle;
            if (
               effectiveDisplayMode === "overlay"
               && !overlayToggle.disabled
               && typeof ctx.ui.onTerminalInput === "function"
            ) {
               removeOverlayInputListener = ctx.ui.onTerminalInput((data) => {
                  if (!overlayToggle.matches(data) || !overlayHandle) return undefined;
                  const nextHidden = !overlayHandle.isHidden();
                  overlayHandle.setHidden(nextHidden);
                  if (nextHidden && !hasAnnouncedHide) {
                     hasAnnouncedHide = true;
                     ctx.ui.notify?.(`ask_user hidden — press ${overlayToggle.spec} to reopen`, "info");
                  }
                  return { consume: true };
               });
            }

            const customResult = await ctx.ui.custom<AskUIResult | null>(
               customFactory,
               buildCustomUIOptions(effectiveDisplayMode, (handle) => {
                  overlayHandle = handle;
               }),
            );

            if (customResult !== undefined) {
               result = customResult;
            } else {
               // RPC/headless mode: degrade to select()/input() dialog protocol
               result = isWizard
                  ? await askQuestionsViaDialogs(ctx.ui, questions, timeout)
                  : await askViaDialogs(ctx.ui, question, normalizedContext, options, allowMultiple, allowFreeform, allowComment, timeout);
            }
         } catch (error) {
            const message =
               error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
            return {
               content: [{ type: "text", text: `Ask tool failed: ${message}` }],
               isError: true,
               details: { error: message },
            };
         } finally {
            removeOverlayInputListener?.();
         }

         if (result === null) {
            pi.events.emit("ask:cancelled", isWizard
               ? { questions: questions.map(questionToDetails) }
               : { question, context: normalizedContext, options });
            const details = isWizard
               ? {
                  questions: questions.map(questionToDetails),
                  responses: Object.fromEntries(questions.map((question) => [question.question, null])),
                  cancelled: true,
               } as AskToolDetails
               : { question, context: normalizedContext, options, response: null, cancelled: true } as AskToolDetails;
            return {
               content: [{ type: "text", text: isWizard ? "User cancelled the questions" : "User cancelled the question" }],
               details,
            };
         }

         if (isWizardResponse(result)) {
            pi.events.emit("ask:answered", {
               questions: questions.map(questionToDetails),
               responses: result.responses,
            });
            return {
               content: [{ type: "text", text: `User answered questions:\n${formatWizardResponseSummary(result, questions)}` }],
               details: {
                  questions: questions.map(questionToDetails),
                  responses: result.responses,
                  cancelled: false,
               } as AskToolDetails,
            };
         }

         pi.events.emit("ask:answered", {
            question,
            context: normalizedContext,
            response: result,
         });
         return {
            content: [{ type: "text", text: `User answered: ${formatResponseSummary(result)}` }],
            details: {
               question,
               context: normalizedContext,
               options,
               response: result,
               cancelled: false,
            } as AskToolDetails,
         };
      },

      renderCall(args, theme) {
         if (Array.isArray(args.questions) && args.questions.length > 0) {
            const labels = args.questions.map((q: { header?: string; question?: string }, index: number) =>
               q.header || q.question || `Q${index + 1}`,
            );
            let text = theme.fg("toolTitle", theme.bold("ask_user "));
            text += theme.fg("muted", `${args.questions.length} questions`);
            text += "\n" + theme.fg("dim", `  ${truncateToWidth(labels.join(", "), 80)}`);
            return new Text(text, 0, 0);
         }

         const question = (args.question as string) || "";
         const rawOptions = Array.isArray(args.options) ? args.options : [];
         let text = theme.fg("toolTitle", theme.bold("ask_user "));
         text += theme.fg("muted", question);
         if (rawOptions.length > 0) {
            const labels = rawOptions.map((o: unknown) =>
               typeof o === "string" ? o : (o as QuestionOption)?.title ?? "",
            );
            text += "\n" + theme.fg("dim", `  ${rawOptions.length} option(s): ${labels.join(", ")}`);
         }
         if (args.allowMultiple) {
            text += theme.fg("dim", " [multi-select]");
         }
         if (args.allowComment) {
            text += theme.fg("dim", " [optional comment]");
         }
         return new Text(text, 0, 0);
      },

      renderResult(result, options, theme) {
         const details = result.details as (AskToolDetails & { error?: string }) | undefined;

         if (details?.error) {
            return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
         }

         if (options.isPartial) {
            const waitingText = result.content
               ?.filter((part) => part?.type === "text")
               .map((part) => part.text ?? "")
               .join("\n")
               .trim() || "Waiting for user input...";
            return new Text(theme.fg("muted", waitingText), 0, 0);
         }

         if (isWizardToolDetails(details)) {
            if (details.cancelled) {
               return new Text(theme.fg("warning", "Cancelled"), 0, 0);
            }

            const lines: string[] = [];
            for (const question of details.questions) {
               const response = details.responses[question.question];
               if (!response) {
                  lines.push(`${theme.fg("muted", "○ ")}${theme.fg("muted", question.header)}: skipped`);
                  continue;
               }
               const prefix = response.kind === "freeform" ? "(wrote) " : "";
               lines.push(`${theme.fg("success", "✓ ")}${theme.fg("accent", question.header)}: ${theme.fg("muted", prefix)}${formatResponseSummary(response)}`);
               if (options.expanded) {
                  lines.push(theme.fg("dim", `  Q: ${question.question}`));
                  if (question.context) {
                     lines.push(theme.fg("dim", `  Context: ${question.context}`));
                  }
               }
            }
            return new Text(lines.join("\n"), 0, 0);
         }

         if (!details || details.cancelled || !details.response) {
            return new Text(theme.fg("warning", "Cancelled"), 0, 0);
         }

         const response = details.response;
         let text = theme.fg("success", "✓ ");
         if (response.kind === "freeform") {
            text += theme.fg("muted", "(wrote) ");
         }
         text += theme.fg("accent", formatResponseSummary(response));

         if (options.expanded) {
            text += "\n" + theme.fg("dim", `Q: ${details.question}`);
            if (details.context) {
               text += "\n" + theme.fg("dim", details.context);
            }

            if (isSelectionResponse(response) && details.options.length > 0) {
               const selectedTitles = new Set(response.selections);
               text += "\n" + theme.fg("dim", "Options:");
               for (const opt of details.options) {
                  const desc = opt.description ? ` — ${opt.description}` : "";
                  const marker = selectedTitles.has(opt.title) ? theme.fg("success", "●") : theme.fg("dim", "○");
                  text += `\n  ${marker} ${theme.fg("dim", opt.title)}${theme.fg("dim", desc)}`;
               }
               if (response.comment) {
                  text += `\n${theme.fg("dim", "Comment:")} ${theme.fg("dim", response.comment)}`;
               }
            }
         }

         return new Text(text, 0, 0);
      },
   });
}
