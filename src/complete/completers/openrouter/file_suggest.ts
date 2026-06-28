import { App, FuzzySuggestModal, TFile } from "obsidian";

// A fuzzy file picker over the vault's markdown files. Used by the OpenRouter
// provider settings to let the user choose context files to attach to the
// prompt.
export class FileSuggestModal extends FuzzySuggestModal<TFile> {
	on_choose: (file: TFile) => void;

	constructor(app: App, on_choose: (file: TFile) => void) {
		super(app);
		this.on_choose = on_choose;
		this.setPlaceholder("Select a note to add as context…");
	}

	getItems(): TFile[] {
		return this.app.vault.getMarkdownFiles();
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		this.on_choose(file);
	}
}
