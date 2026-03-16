import * as vscode from 'vscode';

// Possible positions when C-l is invoked consequtively
enum RecenterPosition {
  Middle,
  Top,
  Bottom
};

export class Editor {
	private lastKill: vscode.Position // if kill position stays the same, append to clipboard
	private justDidKill: boolean
	private centerState: RecenterPosition

	constructor() {
		this.justDidKill = false
		this.lastKill = null
		this.centerState = RecenterPosition.Middle

		vscode.window.onDidChangeActiveTextEditor(event => {
			this.lastKill = null
		})
		vscode.workspace.onDidChangeTextDocument(event => {
			if (!this.justDidKill) {
				this.lastKill = null
			}
			this.justDidKill = false
		})
		vscode.window.onDidChangeTextEditorSelection(event => {
			this.centerState = RecenterPosition.Middle
		})
	}

	static isOnLastLine(): boolean {
		return vscode.window.activeTextEditor.selection.active.line == vscode.window.activeTextEditor.document.lineCount - 1
	}

	setStatusBarMessage(text: string): vscode.Disposable {
		return vscode.window.setStatusBarMessage(text, 1000);
	}

	setStatusBarPermanentMessage(text: string): vscode.Disposable {
		return vscode.window.setStatusBarMessage(text);
	}

	getSelectionRange(): vscode.Range {
		let selection = vscode.window.activeTextEditor.selection,
			start = selection.start,
			end = selection.end;

		return (start.character !== end.character || start.line !== end.line) ? new vscode.Range(start, end) : null;
	}

	getSelection(): vscode.Selection {
		return vscode.window.activeTextEditor.selection;
	}

	getSelectionText(): string {
		let r = this.getSelectionRange()
		return r ? vscode.window.activeTextEditor.document.getText(r) : ''
	}

	setSelection(start: vscode.Position, end: vscode.Position): void {
		let editor = vscode.window.activeTextEditor;
		editor.selection = new vscode.Selection(start, end);
	}

	getCurrentPos(): vscode.Position {
		return vscode.window.activeTextEditor.selection.active
	}

	exchangePointAndMark(): void {
		const editor = vscode.window.activeTextEditor,
			selection = editor.selection;

		editor.selection = new vscode.Selection(selection.active, selection.anchor);
	}

	// Kill to end of line
	async kill(): Promise<boolean> {
		// Ignore whatever we have selected before
		await vscode.commands.executeCommand("emacs.exitMarkMode")

		let startPos = this.getCurrentPos(),
			isOnLastLine = Editor.isOnLastLine()

		// Move down an entire line (not just the wrapped part), and to the beginning.
		await vscode.commands.executeCommand("cursorMove", { to: "down", by: "line", select: false })
		if (!isOnLastLine) {
			await vscode.commands.executeCommand("cursorMove", { to: "wrappedLineStart" })
		}

		let endPos = this.getCurrentPos(),
			range = new vscode.Range(startPos, endPos),
			txt = vscode.window.activeTextEditor.document.getText(range)

		// If there is something other than whitespace in the selection, we do not cut the EOL too
		if (!isOnLastLine && !txt.match(/^\s*$/)) {
			await vscode.commands.executeCommand("cursorMove", {to: "left", by: "character"})
			endPos = this.getCurrentPos()
		}

		// Select it now, cut the selection, remember the position in case of multiple cuts from same spot
		this.setSelection(startPos, endPos)
		let promise = this.cut(this.lastKill != null && startPos.isEqual(this.lastKill))

		promise.then(() => {
			this.justDidKill = true
			this.lastKill = startPos
		})

		return promise
	}

	private skipWhitespaces(document: vscode.TextDocument, from: vscode.Position): vscode.Position {
		const text = document.getText()
		let offset = document.offsetAt(from)
		while (offset < text.length && /\s/.test(text[offset])) {
			offset += 1
		}
		return document.positionAt(offset)
	}

	private skipWhitespacesBackward(document: vscode.TextDocument, from: vscode.Position): vscode.Position {
		const text = document.getText()
		let offset = document.offsetAt(from)
		while (offset > 0 && /\s/.test(text[offset - 1])) {
			offset -= 1
		}
		return document.positionAt(offset)
	}

	private async getSmartSelectionRangeAt(position: vscode.Position): Promise<vscode.Range> {
		const editor = vscode.window.activeTextEditor
		const previousSelection = editor.selection

		editor.selection = new vscode.Selection(position, position)
		await vscode.commands.executeCommand("editor.action.smartSelect.expand")

		const expanded = editor.selection
		editor.selection = previousSelection

		if (expanded.isEmpty) {
			return null
		}

		return new vscode.Range(expanded.start, expanded.end)
	}

	private findDelimitedRange(document: vscode.TextDocument, startOffset: number, open: string, close: string): vscode.Range {
		const text = document.getText()
		let depth = 1
		let offset = startOffset + 1

		while (offset < text.length) {
			if (text[offset] === open) {
				depth += 1
			} else if (text[offset] === close) {
				depth -= 1
				if (depth === 0) {
					return new vscode.Range(document.positionAt(startOffset), document.positionAt(offset + 1))
				}
			}
			offset += 1
		}

		return new vscode.Range(document.positionAt(startOffset), document.positionAt(text.length))
	}

	private findQuotedRange(document: vscode.TextDocument, startOffset: number, quote: string): vscode.Range {
		const text = document.getText()
		let offset = startOffset + quote.length

		while (offset < text.length) {
			if (quote.length === 1 && text[offset] === "\\") {
				offset += 2
				continue
			}
			if (text.substr(offset, quote.length) === quote) {
				return new vscode.Range(document.positionAt(startOffset), document.positionAt(offset + quote.length))
			}
			offset += 1
		}

		return new vscode.Range(document.positionAt(startOffset), document.positionAt(text.length))
	}

	private async getBlockRangeAt(position: vscode.Position): Promise<vscode.Range> {
		const editor = vscode.window.activeTextEditor
		const document = editor.document
		const line = document.lineAt(position.line)
		const firstNonWhitespace = line.firstNonWhitespaceCharacterIndex

		if (firstNonWhitespace !== position.character) {
			return null
		}

		const foldingRanges = await vscode.commands.executeCommand<vscode.FoldingRange[]>(
			"vscode.executeFoldingRangeProvider",
			document.uri
		)

		if (!foldingRanges || foldingRanges.length === 0) {
			return null
		}

		let best: vscode.FoldingRange = null
		for (let range of foldingRanges) {
			if (range.start !== position.line || range.end <= range.start) {
				continue
			}
			if (!best || range.end < best.end) {
				best = range
			}
		}

		if (!best) {
			return null
		}

		const start = line.range.start
		const end = document.lineAt(best.end).rangeIncludingLineBreak.end
		return new vscode.Range(start, end)
	}

	private async findNextExpressionRange(from: vscode.Position): Promise<vscode.Range> {
		const editor = vscode.window.activeTextEditor
		const document = editor.document
		const text = document.getText()
		const start = this.skipWhitespaces(document, from)
		const startOffset = document.offsetAt(start)

		if (startOffset >= text.length) {
			return null
		}

		const nextToken = text[startOffset]
		if (nextToken === '(') {
			return this.findDelimitedRange(document, startOffset, '(', ')')
		}
		if (nextToken === '[') {
			return this.findDelimitedRange(document, startOffset, '[', ']')
		}
		if (nextToken === '{') {
			return this.findDelimitedRange(document, startOffset, '{', '}')
		}
		if (text.substr(startOffset, 3) === '"""') {
			return this.findQuotedRange(document, startOffset, '"""')
		}
		if (nextToken === '"' || nextToken === "'") {
			return this.findQuotedRange(document, startOffset, nextToken)
		}

		// Prefer a language-defined foldable block (Python def/for/if, etc.) when applicable.
		const blockRange = await this.getBlockRangeAt(start)
		if (blockRange) {
			return blockRange
		}

		const wordRange = document.getWordRangeAtPosition(start)
		if (wordRange && !wordRange.isEmpty) {
			return wordRange
		}

		const smartRange = await this.getSmartSelectionRangeAt(start)
		if (smartRange && !smartRange.start.isBefore(start)) {
			return smartRange
		}

		const next = document.positionAt(startOffset + 1)
		return new vscode.Range(start, next)
	}

	private findNextStructuralExpressionRange(from: vscode.Position): vscode.Range {
		const document = vscode.window.activeTextEditor.document
		const text = document.getText()
		let offset = document.offsetAt(from)

		while (offset < text.length) {
			if (text.substr(offset, 3) === '"""') {
				return this.findQuotedRange(document, offset, '"""')
			}

			const token = text[offset]
			if (token === '(') {
				return this.findDelimitedRange(document, offset, '(', ')')
			}
			if (token === '[') {
				return this.findDelimitedRange(document, offset, '[', ']')
			}
			if (token === '{') {
				return this.findDelimitedRange(document, offset, '{', '}')
			}
			if (token === '"' || token === "'") {
				return this.findQuotedRange(document, offset, token)
			}

			offset += 1
		}

		return null
	}

	private findDelimitedRangeBackward(document: vscode.TextDocument, endOffset: number, open: string, close: string): vscode.Range {
		const text = document.getText()
		let depth = 1
		let offset = endOffset - 2

		while (offset >= 0) {
			if (text[offset] === close) {
				depth += 1
			} else if (text[offset] === open) {
				depth -= 1
				if (depth === 0) {
					return new vscode.Range(document.positionAt(offset), document.positionAt(endOffset))
				}
			}
			offset -= 1
		}

		return new vscode.Range(document.positionAt(0), document.positionAt(endOffset))
	}

	private findQuotedRangeBackward(document: vscode.TextDocument, endOffset: number, quote: string): vscode.Range {
		const text = document.getText()
		let offset = endOffset - quote.length - 1

		while (offset >= 0) {
			if (text.substr(offset, quote.length) === quote) {
				// Ignore escaped single-character quotes.
				if (quote.length === 1) {
					let backslashes = 0
					let cursor = offset - 1
					while (cursor >= 0 && text[cursor] === "\\") {
						backslashes += 1
						cursor -= 1
					}
					if (backslashes % 2 === 1) {
						offset -= 1
						continue
					}
				}

				return new vscode.Range(document.positionAt(offset), document.positionAt(endOffset))
			}
			offset -= 1
		}

		return new vscode.Range(document.positionAt(0), document.positionAt(endOffset))
	}

	private async findPreviousExpressionRange(from: vscode.Position): Promise<vscode.Range> {
		const editor = vscode.window.activeTextEditor
		const document = editor.document
		const text = document.getText()
		const end = this.skipWhitespacesBackward(document, from)
		const endOffset = document.offsetAt(end)

		if (endOffset <= 0) {
			return null
		}

		const previousToken = text[endOffset - 1]
		if (previousToken === ')') {
			return this.findDelimitedRangeBackward(document, endOffset, '(', ')')
		}
		if (previousToken === ']') {
			return this.findDelimitedRangeBackward(document, endOffset, '[', ']')
		}
		if (previousToken === '}') {
			return this.findDelimitedRangeBackward(document, endOffset, '{', '}')
		}
		if (endOffset >= 3 && text.substr(endOffset - 3, 3) === '"""') {
			return this.findQuotedRangeBackward(document, endOffset, '"""')
		}
		if (previousToken === '"' || previousToken === "'") {
			return this.findQuotedRangeBackward(document, endOffset, previousToken)
		}

		let startOffset = endOffset - 1
		if (/\w/.test(text[startOffset])) {
			while (startOffset > 0 && /\w/.test(text[startOffset - 1])) {
				startOffset -= 1
			}
		}

		return new vscode.Range(document.positionAt(startOffset), document.positionAt(endOffset))
	}

	private findContainingDelimitedExpression(document: vscode.TextDocument, cursorOffset: number): { start: vscode.Position, inside: vscode.Position } {
		const text = document.getText()
		const closeByOpen: { [key: string]: string } = {
			'(': ')',
			'[': ']',
			'{': '}'
		}
		const stack: { open: string, offset: number }[] = []

		for (let i = 0; i < cursorOffset; i += 1) {
			const token = text[i]
			if (token === '(' || token === '[' || token === '{') {
				stack.push({ open: token, offset: i })
				continue
			}

			if (token === ')' || token === ']' || token === '}') {
				if (stack.length === 0) {
					continue
				}

				const top = stack[stack.length - 1]
				if (closeByOpen[top.open] === token) {
					stack.pop()
				}
			}
		}

		if (stack.length === 0) {
			return null
		}

		const container = stack[stack.length - 1]
		const range = this.findDelimitedRange(document, container.offset, container.open, closeByOpen[container.open])
		const endOffset = document.offsetAt(range.end)
		if (cursorOffset > endOffset) {
			return null
		}

		return {
			start: range.start,
			inside: document.positionAt(container.offset + 1)
		}
	}

	private async findContainingExpressionPositions(from: vscode.Position): Promise<{ start: vscode.Position, inside: vscode.Position }> {
		const document = vscode.window.activeTextEditor.document
		const cursorOffset = document.offsetAt(from)

		const delimited = this.findContainingDelimitedExpression(document, cursorOffset)
		if (delimited) {
			return delimited
		}

		const wordProbe = cursorOffset > 0 ? document.positionAt(cursorOffset - 1) : from
		const wordRange = document.getWordRangeAtPosition(from) || document.getWordRangeAtPosition(wordProbe)
		if (wordRange && !wordRange.isEmpty) {
			const startOffset = document.offsetAt(wordRange.start)
			const endOffset = document.offsetAt(wordRange.end)
			if (cursorOffset >= startOffset && cursorOffset <= endOffset) {
				return {
					start: wordRange.start,
					inside: document.positionAt(Math.min(endOffset, startOffset + 1))
				}
			}
		}

		const smartRange = await this.getSmartSelectionRangeAt(from)
		if (smartRange && !smartRange.isEmpty && smartRange.contains(from)) {
			const startOffset = document.offsetAt(smartRange.start)
			const endOffset = document.offsetAt(smartRange.end)
			return {
				start: smartRange.start,
				inside: document.positionAt(Math.min(endOffset, startOffset + 1))
			}
		}

		return null
	}

	async killNextExpression(): Promise<boolean> {
		await vscode.commands.executeCommand("emacs.exitMarkMode")

		const startPos = this.getCurrentPos(),
			range = await this.findNextExpressionRange(startPos)

		if (!range) {
			return false
		}

		this.setSelection(range.start, range.end)
		const promise = this.cut(this.lastKill != null && range.start.isEqual(this.lastKill))

		promise.then(() => {
			this.justDidKill = true
			this.lastKill = range.start
		})

		return promise
	}

	async selectNextExpression(): Promise<boolean> {
		const range = await this.findNextExpressionRange(this.getCurrentPos())
		if (!range) {
			return false
		}

		const selection = this.getSelection()
		if (!selection.isEmpty) {
			const start = selection.start.isBefore(range.start) ? selection.start : range.start,
				end = selection.end.isAfter(range.end) ? selection.end : range.end
			this.setSelection(start, end)
			return true
		}

		this.setSelection(range.start, range.end)
		return true
	}

	async moveAfterNextExpression(): Promise<boolean> {
		const range = await this.findNextExpressionRange(this.getCurrentPos())
		if (!range) {
			return false
		}

		this.setSelection(range.end, range.end)
		return true
	}

	async selectAfterNextExpression(): Promise<boolean> {
		const range = await this.findNextExpressionRange(this.getCurrentPos())
		if (!range) {
			return false
		}

		const selection = this.getSelection()
		const anchor = selection.isEmpty ? selection.active : selection.anchor
		this.setSelection(anchor, range.end)
		return true
	}

	async moveBeforePreviousExpression(): Promise<boolean> {
		const range = await this.findPreviousExpressionRange(this.getCurrentPos())
		if (!range) {
			return false
		}

		this.setSelection(range.start, range.start)
		return true
	}

	async selectBeforePreviousExpression(): Promise<boolean> {
		const range = await this.findPreviousExpressionRange(this.getCurrentPos())
		if (!range) {
			return false
		}

		const selection = this.getSelection()
		const anchor = selection.isEmpty ? selection.active : selection.anchor
		this.setSelection(anchor, range.start)
		return true
	}

	async leaveParentExpression(): Promise<boolean> {
		const positions = await this.findContainingExpressionPositions(this.getCurrentPos())
		if (!positions) {
			return false
		}

		this.setSelection(positions.start, positions.start)
		return true
	}

	async enterNextExpression(): Promise<boolean> {
		const range = this.findNextStructuralExpressionRange(this.getCurrentPos())
		if (!range) {
			return false
		}

		const document = vscode.window.activeTextEditor.document
		const text = document.getText()
		const startOffset = document.offsetAt(range.start)
		const endOffset = document.offsetAt(range.end)

		let insideOffset = startOffset
		if (text.substr(startOffset, 3) === '"""') {
			insideOffset = Math.min(endOffset, startOffset + 3)
		} else {
			insideOffset = Math.min(endOffset, startOffset + 1)
		}

		this.setSelection(document.positionAt(insideOffset), document.positionAt(insideOffset))
		return true
	}

	async copy(): Promise<void> {
		await vscode.env.clipboard.writeText(this.getSelectionText())
		vscode.commands.executeCommand("emacs.exitMarkMode")
	}

	async cut(appendClipboard?: boolean): Promise<boolean> {
		if (appendClipboard) {
			const clipboardText = await vscode.env.clipboard.readText()
			await vscode.env.clipboard.writeText(clipboardText + this.getSelectionText())
		} else {
			await vscode.env.clipboard.writeText(this.getSelectionText())
		}
		let t = Editor.delete(this.getSelectionRange());
		vscode.commands.executeCommand("emacs.exitMarkMode");
		return t
	}

	yank(): Thenable<{}> {
		this.justDidKill = false
		return Promise.all([
			vscode.commands.executeCommand("editor.action.clipboardPasteAction"),
			vscode.commands.executeCommand("emacs.exitMarkMode")])
	}

	undo(): void {
		vscode.commands.executeCommand("undo");
	}

	private getFirstBlankLine(range: vscode.Range): vscode.Range {
		let doc = vscode.window.activeTextEditor.document;

		if (range.start.line === 0) {
			return range;
		}
		range = doc.lineAt(range.start.line - 1).range;
		while (range.start.line > 0 && range.isEmpty) {
			range = doc.lineAt(range.start.line - 1).range;
		}
		if (range.isEmpty) {
			return range;
		} else {
			return doc.lineAt(range.start.line + 1).range;
		}
	}

	async deleteBlankLines() {
		let selection = this.getSelection(),
			anchor = selection.anchor,
			doc = vscode.window.activeTextEditor.document,
			range = doc.lineAt(selection.start.line).range,
			nextLine: vscode.Position;

		if (range.isEmpty) {
			range = this.getFirstBlankLine(range);
			anchor = range.start;
			nextLine = range.start;
		} else {
			nextLine = range.start.translate(1, 0);
		}
		selection = new vscode.Selection(nextLine, nextLine);
		vscode.window.activeTextEditor.selection = selection;

		for (let line = selection.start.line;
				line < doc.lineCount - 1  && doc.lineAt(line).range.isEmpty;
		    	++line) {

			await vscode.commands.executeCommand("deleteRight")
		}
		vscode.window.activeTextEditor.selection = new vscode.Selection(anchor, anchor)
	}

	static delete(range: vscode.Range = null): Thenable<boolean> {
		if (range) {
			return vscode.window.activeTextEditor.edit(editBuilder => {
				editBuilder.delete(range);
			});
		}
	}

	deleteLine() : void {
		vscode.commands.executeCommand("emacs.exitMarkMode"); // emulate Emacs
		vscode.commands.executeCommand("editor.action.deleteLines");
	}


	/**
	 * The <backspace> and <delete> keys should always leave
	 * the MarkMode whenever.
	 */
	deleteLeft() : void {
		const selectionText = this.getSelectionText();
		// if nothing is selected we should deleteLeft
		if (selectionText.length == 0) {
			vscode.commands.executeCommand('deleteLeft');
		} else {
			// or else we delete the selection
			Editor.delete(this.getSelectionRange());
		}
		// in both case we should leave the MarkMode (this is very important)
		vscode.commands.executeCommand('emacs.exitMarkMode');
	}
	deleteRight() : void {
		const selectionText = this.getSelectionText();
		// if nothing is selected we should deleteRight
		if (selectionText.length == 0) {
			vscode.commands.executeCommand('deleteRight');
		} else {
			// or else we delete the selection
			Editor.delete(this.getSelectionRange());
		}
		// in both case we should leave the MarkMode (this is very important)
		vscode.commands.executeCommand('emacs.exitMarkMode');
	}

	scrollLineToCenterTopBottom = () => {
		const editor = vscode.window.activeTextEditor
		const selection = editor.selection

		switch (this.centerState) {
			case RecenterPosition.Middle:
				this.centerState = RecenterPosition.Top;
				editor.revealRange(selection, vscode.TextEditorRevealType.InCenter);
				break;
			case RecenterPosition.Top:
				this.centerState = RecenterPosition.Bottom;
				editor.revealRange(selection, vscode.TextEditorRevealType.AtTop);
				break;
			case RecenterPosition.Bottom:
				this.centerState = RecenterPosition.Middle;
				// There is no AtBottom, so instead scroll a page up (without moving cursor).
				// The current line then ends up as the last line of the window (more or less)
				vscode.commands.executeCommand("scrollPageUp");
				break;
		}
	}

	breakLine() {
		vscode.commands.executeCommand("lineBreakInsert");
		vscode.commands.executeCommand("emacs.cursorHome");
		vscode.commands.executeCommand("emacs.cursorDown");
	}
}
