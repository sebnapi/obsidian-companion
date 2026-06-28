import * as React from "react";
import SettingsItem from "../../../components/SettingsItem";
import { z } from "zod";

export const settings_schema = z.object({
	api_key: z.string(),
	// A comma- or newline-separated list of OpenRouter model ids to expose in
	// the model dropdown (e.g. "anthropic/claude-3.5-sonnet"). OpenRouter has
	// hundreds of models, so rather than fetching all of them we let the user
	// pick the handful they care about.
	models: z.string(),
});

export type Settings = z.infer<typeof settings_schema>;

export const default_models =
	"anthropic/claude-3.5-sonnet, openai/gpt-4o-mini, meta-llama/llama-3.1-70b-instruct";

const default_settings: Settings = {
	api_key: "",
	models: default_models,
};

export const parse_settings = (data: string | null): Settings => {
	if (data === null) {
		return default_settings;
	}
	try {
		const settings: unknown = JSON.parse(data);
		return settings_schema.parse(settings);
	} catch (e) {
		return default_settings;
	}
};

export function SettingsUI({
	settings,
	saveSettings,
}: {
	settings: string | null;
	saveSettings: (settings: string) => void;
}) {
	const parsed_settings = parse_settings(settings);

	return (
		<>
			<SettingsItem
				name="API key"
				description={
					<>
						Your OpenRouter{" "}
						<a href="https://openrouter.ai/keys">API key</a>
					</>
				}
			>
				<input
					type="text"
					value={parsed_settings.api_key}
					onChange={(e) =>
						saveSettings(
							JSON.stringify({
								...parsed_settings,
								api_key: e.target.value,
							})
						)
					}
				/>
			</SettingsItem>
			<SettingsItem
				name="Models"
				description={
					<>
						A comma- or newline-separated list of{" "}
						<a href="https://openrouter.ai/models">
							OpenRouter model ids
						</a>{" "}
						to make available (e.g. "anthropic/claude-3.5-sonnet").
					</>
				}
			/>
			<textarea
				className="ai-complete-openrouter-full-width"
				value={parsed_settings.models}
				onChange={(e) =>
					saveSettings(
						JSON.stringify({
							...parsed_settings,
							models: e.target.value,
						})
					)
				}
			/>
		</>
	);
}
