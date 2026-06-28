import {
	App,
	MarkdownView,
	FuzzySuggestModal,
	Notice,
	Plugin,
	PluginSettingTab,
	Editor,
} from "obsidian";
import { createRoot } from "react-dom/client";
import React from "react";
import {
	forceableInlineSuggestion,
	Suggestion,
} from "codemirror-companion-extension";
import SettingsComponent from "./settings/settings";
import { CompletionCacher } from "./cache";
import { available } from "./complete/completers";
import { Model } from "./complete/complete";
import { set_plugin_app } from "./obsidian_app";

interface CompanionModelSettings {
	name: string;
	provider: string;
	model: string;
	provider_settings: string;
	model_settings: string;
	enable_editor_command: boolean;
}

export interface AcceptSettings {
	splitter_regex: string;
	display_splitter_regex: string;
	completion_completeness_regex: string;
	min_accept_length: number;
	min_display_length: number;
	retrigger_threshold: number;
}

interface CompanionSettings {
	provider: string;
	model: string;
	enable_by_default: boolean;
	keybind: string | null;
	delay_ms: number;
	stream: boolean;
	accept: AcceptSettings;
	provider_settings: {
		[provider: string]: {
			settings: string;
			models: {
				[model: string]: string;
			};
		};
	};
	presets: CompanionModelSettings[];
	fallback: string | null;
}

const DEFAULT_SETTINGS: CompanionSettings = {
	provider: "openai-chatgpt",
	model: "gpt3.5-turbo",
	enable_by_default: false,
	keybind: "Tab",
	delay_ms: 2000,
	stream: true,
	accept: {
		splitter_regex: " ",
		display_splitter_regex: "[.?!:;]",
		completion_completeness_regex: ".*(?!p{L})[^d]$",
		min_accept_length: 4,
		min_display_length: 50,
		retrigger_threshold: 48,
	},
	provider_settings: {},
	presets: [],
	fallback: null,
};

export default class Companion extends Plugin {
	settings: CompanionSettings;
	enabled: boolean = false;
	force_fetch: () => void = () => {};
	last_used_model: CompletionCacher | null = null;
	models: {
		provider: string;
		model: string;
		cacher: CompletionCacher;
	}[] = [];
	statusBarItemEl: HTMLElement | null = null;

	// Stable-and-cycle suggestion state. A suggestion is generated once per
	// (prefix, suffix) and frozen — editor updates that don't change the prefix
	// reuse it instead of regenerating. Ctrl+Space cycles alternatives, lazily
	// generating a new one when you move past the ones already seen.
	suggestion_state: {
		prefix: string;
		suffix: string;
		alternatives: string[];
		index: number;
	} | null = null;
	// Monotonic token so a slow generation that finishes after the prefix has
	// moved on is discarded instead of clobbering a newer suggestion.
	gen_seq: number = 0;

	async setupModelChoice() {
		await this.loadSettings();
		this.enabled = this.settings.enable_by_default;

		this.addCommand({
			id: "load-preset",
			name: "Load preset",
			callback: () => {
				new PresetChooserModal(this).open();
			},
		});

		for (const preset of this.settings.presets) {
			if (!preset.enable_editor_command) continue;
			this.addCommand({
				id: `load-preset-${preset.name}`,
				name: `Load preset: ${preset.name}`,
				callback: () => {
					this.loadPreset(preset.name);
				},
			});
		}
	}

	async setupToggle() {
		this.addRibbonIcon(
			"terminal",
			"Toggle completion",
			(_evt: MouseEvent) => {
				this.enabled = !this.enabled;
				this.fillStatusbar();
				new Notice(
					`Completion is now ${this.enabled ? "enabled" : "disabled"}`
				);
			}
		);
		this.addCommand({
			id: "toggle",
			name: "Toggle completion",
			callback: () => {
				this.enabled = !this.enabled;
				this.fillStatusbar();
				new Notice(
					`Completion is now ${this.enabled ? "enabled" : "disabled"}`
				);
			},
		});
	}

	async setupSuggestions() {
		const { extension, force_fetch } = forceableInlineSuggestion({
			fetchFn: () => this.triggerCompletion(),
			delay: this.settings.delay_ms,
			continue_suggesting: true,
			accept_shortcut: this.settings.keybind,
		});
		this.force_fetch = force_fetch;
		this.registerEditorExtension(extension);
	}

	async setupStatusbar() {
		this.statusBarItemEl = this.addStatusBarItem();
		this.fillStatusbar();
	}

	async setupSuggestionCommands() {
		this.addCommand({
			id: "accept",
			name: "Accept completion",
			editorCallback: (editor: Editor) => this.acceptCompletion(editor),
		});
		this.addCommand({
			id: "suggest",
			name: "Generate completion",
			editorCallback: () => this.force_fetch(),
		});
		this.addCommand({
			id: "cycle-alternative",
			name: "Cycle to next completion alternative",
			hotkeys: [{ modifiers: ["Ctrl"], key: " " }],
			editorCallback: (editor: Editor) =>
				this.cycleCompletion(editor),
		});
	}

	async onload() {
		set_plugin_app(this.app);
		await this.setupModelChoice();
		await this.setupToggle();
		await this.setupSuggestions();
		await this.setupStatusbar();
		await this.setupSuggestionCommands();

		this.addSettingTab(new CompanionSettingsTab(this.app, this));
	}

	onunload() {}

	fillStatusbar() {
		if (!this.statusBarItemEl) return;
		this.statusBarItemEl.setText(
			`Completion: ${this.enabled ? "enabled" : "disabled"}`
		);
	}

	loadPreset(name: string) {
		const preset = this.settings.presets.find(
			(preset) => preset.name == name
		);
		if (!preset) return;

		this.settings.provider = preset.provider;
		this.settings.model = preset.model;
		this.settings.provider_settings[preset.provider] = {
			settings: preset.provider_settings,
			models: {
				[preset.model]: preset.model_settings,
			},
		};
		this.saveSettings();
	}

	savePreset(name: string) {
		const preset = this.settings.presets.find(
			(preset) => preset.name == name
		);
		if (preset) {
			preset.provider = this.settings.provider;
			preset.model = this.settings.model;
			preset.provider_settings =
				this.settings.provider_settings[
					this.settings.provider
				].settings;
			preset.model_settings =
				this.settings.provider_settings[this.settings.provider].models[
					this.settings.model
				];
		} else {
			this.settings.presets.push({
				name: name,
				provider: this.settings.provider,
				model: this.settings.model,
				provider_settings:
					this.settings.provider_settings[this.settings.provider]
						.settings,
				model_settings:
					this.settings.provider_settings[this.settings.provider]
						.models[this.settings.model],
				enable_editor_command: false,
			});
		}
		this.saveSettings();
	}

	deletePreset(name: string) {
		this.settings.presets = this.settings.presets.filter(
			(preset) => preset.name != name
		);
		this.saveSettings();
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// Pull the prefix/suffix around the cursor for the active markdown view, or
	// null if completion shouldn't run (no view, disabled, vim mode, empty line).
	current_context(): { prefix: string; suffix: string } | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return null;
		if (!this.enabled) return null;
		if ((view.editor as any)?.cm?.cm?.state?.keyMap === "vim") {
			// Don't complete if vim mode is enabled
			return null;
		}

		const cursor = view.editor.getCursor();
		const currentLine = view.editor.getLine(cursor.line);
		if (!currentLine.length) return null; // Don't complete on empty lines

		const prefix = view.editor.getRange({ line: 0, ch: 0 }, cursor);
		const suffix = view.editor.getRange(cursor, {
			line: view.editor.lastLine(),
			ch: view.editor.getLine(view.editor.lastLine()).length,
		});
		return { prefix, suffix };
	}

	make_suggestion(completion: string): Suggestion {
		// The whole completion is offered as one block: it's shown as the ghost
		// text and accepted in full (no word-by-word splitting), which keeps the
		// frozen suggestion stable and predictable.
		return {
			display_suggestion: completion,
			complete_suggestion: completion,
		};
	}

	// Generate a single full completion for the given context. `temperature`,
	// when provided, overrides the model setting (used while cycling so each
	// alternative differs). Returns null on failure.
	async generate_completion(
		prefix: string,
		suffix: string,
		temperature?: number
	): Promise<string | null> {
		let provider = this.settings.provider;
		let model = this.settings.model;
		let cacher = await this.get_model(provider, model);
		if (!cacher) {
			await this.select_first_available_model();
			cacher = await this.get_model(provider, this.settings.model);
			if (!cacher) return null;
		}
		await this.load_model(cacher);
		this.last_used_model = cacher;

		let model_settings = cacher.model_settings;
		if (temperature !== undefined) {
			try {
				const parsed = JSON.parse(model_settings || "{}");
				parsed.temperature = temperature;
				model_settings = JSON.stringify(parsed);
			} catch (e) {
				// settings weren't JSON; leave them as-is
			}
		}

		try {
			const completion = await cacher.model.complete(
				{ prefix, suffix },
				model_settings
			);
			return completion ?? null;
		} catch (e) {
			if (e && e.message) {
				new Notice(`Error completing: ${e.message}`);
			}
			return null;
		}
	}

	async *triggerCompletion(): AsyncGenerator<Suggestion, void, unknown> {
		const ctx = this.current_context();
		if (!ctx) {
			yield { display_suggestion: "", complete_suggestion: "" };
			return;
		}
		const { prefix, suffix } = ctx;

		// Frozen: same prefix/suffix as the live suggestion → reuse it, no
		// regeneration. This is what makes the suggestion stable across editor
		// updates that don't change the text.
		const st = this.suggestion_state;
		if (
			st &&
			st.prefix === prefix &&
			st.suffix === suffix &&
			st.alternatives.length > 0
		) {
			yield this.make_suggestion(st.alternatives[st.index]);
			return;
		}

		// Prefix changed (or first run) → generate one fresh alternative.
		const seq = ++this.gen_seq;
		const completion = await this.generate_completion(prefix, suffix);
		// Discard if a newer trigger superseded us while we were waiting.
		if (seq !== this.gen_seq) return;

		this.suggestion_state = {
			prefix,
			suffix,
			alternatives: completion ? [completion] : [],
			index: 0,
		};
		if (completion) {
			yield this.make_suggestion(completion);
		} else {
			yield { display_suggestion: "", complete_suggestion: "" };
		}
	}

	// Ctrl+Space: advance to the next alternative for the current prefix,
	// generating a fresh one on demand when we've reached the end.
	async cycleCompletion(_editor: Editor) {
		const ctx = this.current_context();
		if (!ctx) return;
		const { prefix, suffix } = ctx;

		let st = this.suggestion_state;
		if (!st || st.prefix !== prefix || st.suffix !== suffix) {
			st = this.suggestion_state = {
				prefix,
				suffix,
				alternatives: [],
				index: 0,
			};
		}

		if (st.index < st.alternatives.length - 1) {
			// Cycle forward through alternatives we already generated.
			st.index += 1;
		} else {
			// Generate a new alternative on demand, with raised temperature so
			// it differs from the ones already shown.
			const seq = ++this.gen_seq;
			const completion = await this.generate_completion(
				prefix,
				suffix,
				0.9
			);
			if (seq !== this.gen_seq) return;
			if (!completion) return;
			st.alternatives.push(completion);
			st.index = st.alternatives.length - 1;
		}
		// Re-render: triggerCompletion will now yield the frozen current alt.
		this.force_fetch();
	}

	async acceptCompletion(editor: Editor) {
		const st = this.suggestion_state;
		const suggestion = st?.alternatives[st.index];
		if (suggestion) {
			editor.replaceRange(suggestion, editor.getCursor());
			editor.setCursor({
				ch:
					suggestion.split("\n").length > 1
						? suggestion.split("\n")[
								suggestion.split("\n").length - 1
						  ].length
						: editor.getCursor().ch + suggestion.length,
				line:
					editor.getCursor().line + suggestion.split("\n").length - 1,
			});
			// Clear so the next prefix generates fresh.
			this.suggestion_state = null;
			this.force_fetch();
		}
	}

	async get_model(
		provider: string,
		model: string
	): Promise<CompletionCacher | null> {
		for (const cached_model of this.models) {
			if (
				cached_model.provider === provider &&
				cached_model.model === model
			) {
				return cached_model.cacher;
			}
		}
		const available_provider = available.find(
			(available_provider) => available_provider.id === provider
		);
		if (!available_provider) return null;
		const provider_settings = this.settings.provider_settings[provider];
		const available_models = await available_provider.get_models(
			provider_settings ? provider_settings.settings : ""
		);
		const available_model: Model | undefined = available_models.find(
			(available_model: Model) => available_model.id == model
		);
		if (!available_model) return null;
		const cached = new CompletionCacher(
			available_model,
			provider_settings
				? provider_settings.models[available_model.id]
				: "",
			this.settings.accept,
			this.settings.keybind == null
		);
		this.models.push({
			provider: provider,
			model: available_model.id,
			cacher: cached,
		});
		return cached;
	}

	async load_model(model: CompletionCacher) {
		if (this.last_used_model?.model.id === model.model.id) return;
		await this.last_used_model?.model?.unload?.();
		await model?.model?.load?.();
	}

	async *_complete(
		prefix: string,
		suffix: string,
		provider: string,
		model: string
	): AsyncGenerator<Suggestion> {
		const cacher = await this.get_model(provider, model);
		if (!cacher) throw { name: "ModelNotFound" };
		await this.load_model(cacher);
		for await (let completion of cacher.complete(
			{
				prefix: prefix,
				suffix: suffix,
			},
			this.settings.stream
		)) {
			this.last_used_model = cacher;
			yield completion;
		}
	}

	async select_first_available_model() {
		const provider = available.find(
			(provider) => provider.id === this.settings.provider
		);
		const provider_settings =
			this.settings.provider_settings[this.settings.provider];
		this.settings.model =
			(await provider
				?.get_models(
					provider_settings ? provider_settings.settings : ""
				)
				.then((models) => models[0].id)) || "";
	}

	async *fallback_complete(
		prefix: string,
		suffix: string
	): AsyncGenerator<Suggestion> {
		if (this.settings.fallback) {
			try {
				const fallback = this.settings.presets.find(
					(preset) => preset.name === this.settings.fallback
				);
				if (!fallback) return;
				const completion = this._complete(
					prefix,
					suffix,
					fallback.provider,
					fallback.model
				);
				if (!completion) return;
				yield* completion;
			} catch (e) {
				new Notice(`Error completing (fallback): ${e.message}`);
			}
		}
	}

	async *complete(
		prefix: string,
		suffix: string
	): AsyncGenerator<Suggestion> {
		try {
			try {
				const completion = this._complete(
					prefix,
					suffix,
					this.settings.provider,
					this.settings.model
				);
				yield* completion;
			} catch (e) {
				if (e.name === "ModelNotFound") {
					this.select_first_available_model();
					yield* this.complete(prefix, suffix);
					return;
				}
				throw e;
			}
		} catch (e) {
			if (e.message) {
				new Notice(`Error completing: ${e.message}`);
			}
			return this.fallback_complete(prefix, suffix);
		}
	}
}

class PresetChooserModal extends FuzzySuggestModal<CompanionModelSettings> {
	plugin: Companion;

	constructor(plugin: Companion) {
		super(plugin.app);
		this.plugin = plugin;
	}

	getItems(): CompanionModelSettings[] {
		return this.plugin.settings.presets;
	}

	getItemText(item: CompanionModelSettings): string {
		return item.name;
	}

	onChooseItem(
		preset: CompanionModelSettings,
		_evt: MouseEvent | KeyboardEvent
	) {
		this.plugin.loadPreset(preset.name);
		new Notice("Loaded preset " + preset.name);
	}
}

class CompanionSettingsTab extends PluginSettingTab {
	plugin: Companion;
	root: any;
	reload_signal: { reload: boolean };

	constructor(app: App, plugin: Companion) {
		super(app, plugin);
		this.plugin = plugin;
		this.reload_signal = { reload: false };
	}

	display(): void {
		const { containerEl } = this;
		this.reload_signal.reload = false;
		this.root = createRoot(containerEl);
		this.root.render(
			<React.StrictMode>
				<SettingsComponent
					plugin={this.plugin}
					reload_signal={this.reload_signal}
				/>
			</React.StrictMode>
		);
	}

	hide(): void {
		this.root.unmount();
		super.hide();

		if (this.reload_signal.reload) {
			this.reload_signal.reload = false;
			const reload = async () => {
				const app: any = this.plugin.app; // Otherwise typescript complains
				const id = this.plugin.manifest.id;
				await app.plugins.disablePlugin(id);
				await app.plugins.enablePlugin(id);
			};
			reload();
		}
	}
}
