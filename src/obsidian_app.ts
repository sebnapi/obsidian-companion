import { App } from "obsidian";

// A tiny module-level holder for the Obsidian App instance. The completer
// architecture (Completer/Model) doesn't receive the App, but some providers
// (e.g. OpenRouter context files) need vault access to read notes. The plugin
// sets this on load.
let plugin_app: App | null = null;

export function set_plugin_app(app: App) {
	plugin_app = app;
}

export function get_plugin_app(): App | null {
	return plugin_app;
}
