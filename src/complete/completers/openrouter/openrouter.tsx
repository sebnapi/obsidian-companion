import { Notice, TFile } from "obsidian";
import { Completer, Model, Prompt } from "../../complete";
import { get_plugin_app } from "../../../obsidian_app";
import {
	SettingsUI as ProviderSettingsUI,
	Settings as ProviderSettings,
	parse_settings as parse_provider_settings,
} from "./provider_settings";
import {
	SettingsUI as ModelSettingsUI,
	parse_settings as parse_model_settings,
	Settings as ModelSettings,
} from "./model_settings";
import OpenAI from "openai";
import Mustache from "mustache";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

// Optional headers OpenRouter uses for its public leaderboard rankings. They
// are not required for completions to work, but it's polite to identify the
// client.
const OPENROUTER_HEADERS = {
	"HTTP-Referer": "https://github.com/rizerphe/obsidian-companion",
	"X-Title": "Obsidian Companion",
};

export default class OpenRouter implements Model {
	id: string;
	name: string;
	description: string;
	rate_limit_notice: Notice | null = null;
	rate_limit_notice_timeout: number | null = null;
	Settings = ModelSettingsUI;

	provider_settings: ProviderSettings;

	constructor(
		provider_settings: string,
		id: string,
		name: string,
		description: string
	) {
		this.id = id;
		this.name = name;
		this.description = description;
		this.provider_settings = parse_provider_settings(provider_settings);
	}

	async prepare(prompt: Prompt, settings: ModelSettings): Promise<Prompt> {
		return {
			prefix: prompt.prefix.slice(-(settings.prompt_length || 6000)),
			suffix: prompt.suffix.slice(0, settings.prompt_length || 6000),
		};
	}

	async read_context_files(
		paths: string[] | undefined
	): Promise<{ path: string; contents: string }[]> {
		if (!paths || paths.length === 0) return [];
		const app = get_plugin_app();
		if (!app) return [];

		const files = await Promise.all(
			paths.map(async (path) => {
				const file = app.vault.getAbstractFileByPath(path);
				if (!(file instanceof TFile)) return null;
				try {
					const contents = await app.vault.cachedRead(file);
					return { path, contents };
				} catch (e) {
					return null;
				}
			})
		);

		return files.filter(
			(f): f is { path: string; contents: string } => f !== null
		);
	}

	async generate_messages(
		prompt: Prompt,
		model_settings: {
			system_prompt: string;
			user_prompt: string;
			context_files?: string[];
		}
	): Promise<{ role: "system" | "user"; content: string }[]> {
		const context_files = await this.read_context_files(
			model_settings.context_files
		);
		return [
			{
				role: "system",
				content: model_settings.system_prompt,
			},
			{
				role: "user",
				content: Mustache.render(model_settings.user_prompt, {
					...(await this.prepare(prompt, model_settings)),
					context_files,
					has_context: context_files.length > 0,
				}),
			},
		];
	}

	model_parameters(model_settings: {
		user_prompt: string;
		system_prompt: string;
		presence_penalty?: number;
		frequency_penalty?: number;
		top_p?: number;
		temperature?: number;
	}): {
		presence_penalty?: number;
		frequency_penalty?: number;
		top_p?: number;
		temperature?: number;
	} {
		return {
			presence_penalty: model_settings.presence_penalty,
			frequency_penalty: model_settings.frequency_penalty,
			top_p: model_settings.top_p,
			temperature: model_settings.temperature,
		};
	}

	create_rate_limit_notice() {
		if (this.rate_limit_notice) {
			window.clearTimeout(this.rate_limit_notice_timeout!);
			this.rate_limit_notice_timeout = window.setTimeout(() => {
				this.rate_limit_notice?.hide();
				this.rate_limit_notice = null;
				this.rate_limit_notice_timeout = null;
			}, 5000);
		} else {
			this.rate_limit_notice = new Notice(
				"Rate limit exceeded. OpenRouter is throttling your requests; check your account's rate limits and credits.",
				250000
			);
			this.rate_limit_notice_timeout = window.setTimeout(() => {
				this.rate_limit_notice?.hide();
				this.rate_limit_notice = null;
				this.rate_limit_notice_timeout = null;
			}, 5000);
		}
	}

	create_api_key_notice() {
		const notice: any = new Notice("", 5000);
		const notice_element = notice.noticeEl as HTMLElement;
		notice_element.createEl("span", {
			text: "OpenRouter API key is invalid. Please double-check your ",
		});
		notice_element.createEl("a", {
			text: "API key",
			href: "https://openrouter.ai/keys",
		});
		notice_element.createEl("span", {
			text: " in the plugin settings.",
		});
	}

	parse_api_error(e: { status?: number }) {
		if (e.status === 429) {
			this.create_rate_limit_notice();
			throw new Error();
		} else if (e.status === 401) {
			this.create_api_key_notice();
			throw new Error();
		}
		throw e;
	}

	get_api() {
		return new OpenAI({
			apiKey: this.provider_settings.api_key,
			baseURL: OPENROUTER_BASE_URL,
			defaultHeaders: OPENROUTER_HEADERS,
			dangerouslyAllowBrowser: true,
		});
	}

	async complete(prompt: Prompt, settings: string): Promise<string> {
		const model_settings = parse_model_settings(settings);

		try {
			const response = await this.get_api().chat.completions.create({
				...this.model_parameters(model_settings),
				messages: await this.generate_messages(prompt, model_settings),
				model: this.id,
				max_tokens: 64,
			});

			return this.interpret(
				prompt,
				response.choices[0]?.message.content || ""
			);
		} catch (e) {
			this.parse_api_error(e);
			throw e;
		}
	}

	async *iterate(prompt: Prompt, settings: string): AsyncGenerator<string> {
		const model_settings = parse_model_settings(settings);

		try {
			const completion = await this.get_api().chat.completions.create({
				...this.model_parameters(model_settings),
				messages: await this.generate_messages(prompt, model_settings),
				model: this.id,
				max_tokens: 64,
				stream: true,
			});

			let initialized = false;
			for await (const chunk of completion) {
				const token = chunk.choices[0]?.delta?.content || "";
				if (!initialized) {
					yield this.interpret(prompt, token);
					initialized = true;
				} else {
					yield token;
				}
			}
		} catch (e) {
			this.parse_api_error(e);
			throw e;
		}
	}

	interpret(prompt: Prompt, completion: string) {
		const response_punctuation = " \n.,?!:;";
		const prompt_punctuation = " \n";

		if (
			prompt.prefix.length !== 0 &&
			!prompt_punctuation.includes(
				prompt.prefix[prompt.prefix.length - 1]
			) &&
			completion.length !== 0 &&
			!response_punctuation.includes(completion[0])
		) {
			completion = " " + completion;
		}

		return completion;
	}
}

export class OpenRouterComplete implements Completer {
	id: string = "openrouter";
	name: string = "OpenRouter";
	description: string =
		"OpenRouter, a unified API for many models (Claude, GPT, Llama, and more)";

	async get_models(settings: string) {
		const provider_settings = parse_provider_settings(settings);

		const model_ids = provider_settings.models
			.split(/[\n,]/)
			.map((id) => id.trim())
			.filter((id) => id.length > 0);

		return model_ids.map(
			(id) =>
				new OpenRouter(
					settings,
					id,
					id,
					`OpenRouter model "${id}"`
				)
		);
	}

	Settings = ProviderSettingsUI;
}
